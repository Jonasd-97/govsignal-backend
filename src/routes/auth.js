const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { body, validationResult } = require("express-validator");
const { authenticate } = require("../middleware/auth");
const emailService = require("../services/emailService");
const logger = require("../services/logger");

const router = express.Router();

const signToken = (user) =>
  jwt.sign(
    { userId: user.id, email: user.email, plan: user.plan },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );

// ── POST /api/auth/register ──
router.post("/register", [
  body("email").isEmail().normalizeEmail(),
  body("password").isLength({ min: 8 }).withMessage("Password must be at least 8 characters"),
  body("name").optional().trim().isLength({ max: 100 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password, name } = req.body;
  try {
    const existing = await req.prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: "Email already registered" });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await req.prisma.user.create({
      data: { email, passwordHash, name, plan: "FREE" },
    });

    // Create default digest settings
    await req.prisma.digestSettings.create({ data: { userId: user.id } });

    // Send welcome email
    await emailService.sendWelcome(user);

    const token = signToken(user);
    logger.info(`New user registered: ${email}`);
    res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
  } catch (err) {
    logger.error("Register error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// ── POST /api/auth/login ──
router.post("/login", [
  body("email").isEmail().normalizeEmail(),
  body("password").notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password } = req.body;
  try {
    const user = await req.prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: "Invalid email or password" });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "Invalid email or password" });

    const token = signToken(user);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
  } catch (err) {
    logger.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// ── GET /api/auth/me ──
router.get("/me", authenticate, async (req, res) => {
  try {
    const user = await req.prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, email: true, name: true, plan: true, companyName: true, naicsCode: true, setAside: true, targetAgency: true, createdAt: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// ── PATCH /api/auth/profile ──
router.patch("/profile", authenticate, [
  body("name").optional().trim().isLength({ max: 100 }),
  body("companyName").optional().trim().isLength({ max: 200 }),
  body("naicsCode").optional().trim(),
  body("setAside").optional().trim(),
  body("targetAgency").optional().trim(),
  body("samApiKey").optional().trim(),
], async (req, res) => {
  const { name, companyName, naicsCode, setAside, targetAgency, samApiKey } = req.body;
  try {
    const user = await req.prisma.user.update({
      where: { id: req.userId },
      data: { name, companyName, naicsCode, setAside, targetAgency, samApiKey },
      select: { id: true, email: true, name: true, plan: true, companyName: true, naicsCode: true, setAside: true, targetAgency: true },
    });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: "Profile update failed" });
  }
});

// ── POST /api/auth/forgot-password ──
router.post("/forgot-password", [body("email").isEmail().normalizeEmail()], async (req, res) => {
  const { email } = req.body;
  try {
    const user = await req.prisma.user.findUnique({ where: { email } });
    // Always return 200 to prevent email enumeration
    if (!user) return res.json({ message: "If that email exists, a reset link has been sent." });

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await req.prisma.emailVerificationToken.create({
      data: { userId: user.id, token, type: "reset_password", expiresAt },
    });

    await emailService.sendPasswordReset(user, token);
    res.json({ message: "If that email exists, a reset link has been sent." });
  } catch (err) {
    logger.error("Forgot password error:", err);
    res.status(500).json({ error: "Failed to process request" });
  }
});

// ── POST /api/auth/reset-password ──
router.post("/reset-password", [
  body("token").notEmpty(),
  body("password").isLength({ min: 8 }),
], async (req, res) => {
  const { token, password } = req.body;
  try {
    const record = await req.prisma.emailVerificationToken.findUnique({ where: { token } });
    if (!record || record.type !== "reset_password" || record.usedAt || record.expiresAt < new Date()) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await req.prisma.user.update({ where: { id: record.userId }, data: { passwordHash } });
    await req.prisma.emailVerificationToken.update({ where: { token }, data: { usedAt: new Date() } });

    res.json({ message: "Password reset successfully" });
  } catch (err) {
    res.status(500).json({ error: "Password reset failed" });
  }
});

module.exports = router;
