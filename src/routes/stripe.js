const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { authenticate } = require("../middleware/auth");
const logger = require("../services/logger");

const router = express.Router();

// ── POST /api/stripe/checkout ──
// Create a Stripe checkout session
router.post("/checkout", authenticate, async (req, res) => {
  const { plan } = req.body; // "PRO" or "AGENCY"
  const priceId = plan === "AGENCY"
    ? process.env.STRIPE_AGENCY_PRICE_ID
    : process.env.STRIPE_PRO_PRICE_ID;

  if (!priceId) return res.status(400).json({ error: "Invalid plan" });

  try {
    const user = await req.prisma.user.findUnique({ where: { id: req.userId } });

    // Create or retrieve Stripe customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name || user.companyName || undefined,
        metadata: { userId: user.id },
      });
      customerId = customer.id;
      await req.prisma.user.update({
        where: { id: req.userId },
        data: { stripeCustomerId: customerId },
      });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "subscription",
      success_url: `${process.env.FRONTEND_URL}/settings?upgraded=true`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
      metadata: { userId: req.userId, plan },
    });

    res.json({ url: session.url });
  } catch (err) {
    logger.error("Stripe checkout error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ── POST /api/stripe/portal ──
// Customer portal for managing subscription
router.post("/portal", authenticate, async (req, res) => {
  try {
    const user = await req.prisma.user.findUnique({ where: { id: req.userId } });
    if (!user.stripeCustomerId) return res.status(400).json({ error: "No active subscription" });

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${process.env.FRONTEND_URL}/settings`,
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: "Failed to open billing portal" });
  }
});

// ── POST /api/stripe/webhook ──
// Handle Stripe events (subscription created, cancelled, etc.)
router.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.error("Stripe webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // FIX: use shared prisma instance from request instead of creating a new connection pool
  const prisma = req.prisma;

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const { userId, plan } = session.metadata;
        await prisma.user.update({
          where: { id: userId },
          data: {
            plan,
            stripeSubscriptionId: session.subscription,
          },
        });
        logger.info(`User ${userId} upgraded to ${plan}`);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await prisma.user.updateMany({
          where: { stripeSubscriptionId: sub.id },
          data: { plan: "FREE", stripeSubscriptionId: null },
        });
        logger.info(`Subscription ${sub.id} cancelled — user downgraded to FREE`);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        logger.warn(`Payment failed for customer ${invoice.customer}`);
        // Could send an email here
        break;
      }

      default:
        logger.info(`Unhandled Stripe event: ${event.type}`);
    }
  } catch (err) {
    logger.error("Webhook handler error:", err);
  }

  res.json({ received: true });
});

module.exports = router;
