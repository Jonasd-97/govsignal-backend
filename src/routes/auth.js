const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { handleValidation } = require('../utils/validation');
const emailService = require('../services/emailService');
const logger = require('../services/logger');

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { userId: user.id, plan: user.plan },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// ── REGISTER ──────────────────────────────────────────────────────────────────
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('name').optional().trim().isLength({ max: 100 }),
  body('companyName').optional().trim().isLength({ max: 200 }),
], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { email, password, name, companyName } = req.body;
  try {
    const existing = await req.prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await req.prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
        companyName: companyName || null,
        plan: 'FREE',
        emailVerified: false,
      },
    });

    await req.prisma.digestSettings.create({ data: { userId: user.id } });

    // Skip verification in development/testing mode
    if (process.env.SKIP_EMAIL_VERIFICATION === 'true') {
      await req.prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
      });
      emailService.sendWelcome(user).catch(err => console.error('Welcome email failed:', err));
      const token = signToken(user);
      logger.info(`New user registered (verification skipped): ${email}`);
      return res.status(201).json({
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          plan: user.plan,
          companyName: user.companyName,
        },
      });
    }

    // Generate 24-hour verification token
    const verifyToken = crypto.randomBytes(32).toString('hex');
    await req.prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        token: verifyToken,
        type: 'verify_email',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    // Fire-and-forget — don't block the response on email sending
    emailService.sendVerificationEmail(user, verifyToken).catch(err =>
      console.error('Verification email failed:', err)
    );

    logger.info(`New user registered (unverified): ${email}`);

    // Return immediately — no token until verified
    res.status(201).json({
      requiresVerification: true,
      message: 'Account created. Please check your email to verify your address before signing in.',
    });
  } catch (err) {
    console.error('REGISTER ERROR:', err);
    return res.status(500).json({ error: 'Registration failed', details: err.message });
  }
});

// ── VERIFY EMAIL ──────────────────────────────────────────────────────────────
router.get('/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing verification token' });

  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

  try {
    const record = await req.prisma.emailVerificationToken.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!record) {
      return res.redirect(`${FRONTEND_URL}/verify-error?reason=invalid`);
    }
    if (record.usedAt) {
      return res.redirect(`${FRONTEND_URL}/verify-error?reason=used`);
    }
    if (record.expiresAt < new Date()) {
      return res.redirect(`${FRONTEND_URL}/verify-error?reason=expired`);
    }
    if (record.type !== 'verify_email') {
      return res.redirect(`${FRONTEND_URL}/verify-error?reason=invalid`);
    }

    // Mark email as verified
    await req.prisma.user.update({
      where: { id: record.userId },
      data: { emailVerified: true },
    });

    // Mark token as used
    await req.prisma.emailVerificationToken.update({
      where: { token },
      data: { usedAt: new Date() },
    });

    // Fire-and-forget welcome email
    emailService.sendWelcome(record.user).catch(err =>
      console.error('Welcome email failed:', err)
    );

    // Issue JWT and redirect to frontend onboarding
    const jwtToken = signToken(record.user);
    logger.info(`Email verified: ${record.user.email}`);

    res.redirect(`${FRONTEND_URL}/verify-success?token=${encodeURIComponent(jwtToken)}`);
  } catch (err) {
    console.error('VERIFY EMAIL ERROR:', err);
    res.redirect(`${FRONTEND_URL}/verify-error?reason=server`);
  }
});

// ── RESEND VERIFICATION ───────────────────────────────────────────────────────
router.post('/resend-verification', [
  body('email').isEmail().normalizeEmail(),
], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { email } = req.body;
  try {
    const user = await req.prisma.user.findUnique({ where: { email } });

    // Always return 200 to avoid email enumeration
    if (!user) return res.status(200).json({ message: 'If that email exists, a new verification link has been sent.' });
    if (user.emailVerified) return res.status(200).json({ message: 'Your email is already verified. You can sign in.' });

    // Invalidate existing unused tokens
    await req.prisma.emailVerificationToken.updateMany({
      where: { userId: user.id, type: 'verify_email', usedAt: null },
      data: { usedAt: new Date() },
    });

    // Create fresh token
    const verifyToken = crypto.randomBytes(32).toString('hex');
    await req.prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        token: verifyToken,
        type: 'verify_email',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    // Fire-and-forget
    emailService.sendVerificationEmail(user, verifyToken).catch(err =>
      console.error('Resend verification email failed:', err)
    );

    res.status(200).json({ message: 'A new verification link has been sent to your email.' });
  } catch (err) {
    console.error('RESEND VERIFY ERROR:', err);
    return res.status(500).json({ error: 'Failed to resend verification email' });
  }
});

// ── LOGIN ─────────────────────────────────────────────────────────────────────
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { email, password } = req.body;
  try {
    const user = await req.prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    // Block login if email not verified (unless in skip mode)
    if (!user.emailVerified && process.env.SKIP_EMAIL_VERIFICATION !== 'true') {
      return res.status(403).json({
        error: 'Email not verified. Please check your inbox for the verification link.',
        requiresVerification: true,
      });
    }

    const token = signToken(user);
    logger.info(`User logged in: ${email}`);
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan,
        companyName: user.companyName,
        naicsCode: user.naicsCode,
        setAside: user.setAside,
        targetAgency: user.targetAgency,
      },
    });
  } catch (err) {
    console.error('LOGIN ERROR:', err);
    return res.status(500).json({ error: 'Login failed', details: err.message });
  }
});

// ── GET CURRENT USER ──────────────────────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await req.prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        email: true,
        name: true,
        plan: true,
        companyName: true,
        naicsCode: true,
        setAside: true,
        targetAgency: true,
        yearsInBusiness: true,
        emailVerified: true,
        createdAt: true,
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error('ME ERROR:', err);
    return res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ── UPDATE PROFILE ────────────────────────────────────────────────────────────
router.patch('/profile', authenticate, [
  body('name').optional().trim().isLength({ max: 100 }),
  body('companyName').optional().trim().isLength({ max: 200 }),
  body('naicsCode').optional().trim().isLength({ max: 20 }),
  body('setAside').optional().trim().isLength({ max: 20 }),
  body('targetAgency').optional().trim().isLength({ max: 200 }),
  body('yearsInBusiness').optional().trim().isLength({ max: 20 }),
], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { name, companyName, naicsCode, setAside, targetAgency, yearsInBusiness } = req.body;
  try {
    const updated = await req.prisma.user.update({
      where: { id: req.userId },
      data: {
        ...(name !== undefined && { name }),
        ...(companyName !== undefined && { companyName }),
        ...(naicsCode !== undefined && { naicsCode }),
        ...(setAside !== undefined && { setAside }),
        ...(targetAgency !== undefined && { targetAgency }),
        ...(yearsInBusiness !== undefined && { yearsInBusiness }),
      },
      select: {
        id: true,
        email: true,
        name: true,
        plan: true,
        companyName: true,
        naicsCode: true,
        setAside: true,
        targetAgency: true,
        yearsInBusiness: true,
        emailVerified: true,
      },
    });
    res.json({ user: updated });
  } catch (err) {
    console.error('PROFILE UPDATE ERROR:', err);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ── FORGOT PASSWORD ───────────────────────────────────────────────────────────
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail(),
], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { email } = req.body;
  try {
    const user = await req.prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(200).json({ message: 'If that email exists, a reset link has been sent.' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    await req.prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        token: resetToken,
        type: 'reset_password',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
      },
    });

    // Fire-and-forget
    emailService.sendPasswordReset(user, resetToken).catch(err =>
      console.error('Password reset email failed:', err)
    );

    res.status(200).json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    console.error('FORGOT PASSWORD ERROR:', err);
    return res.status(500).json({ error: 'Failed to send reset email' });
  }
});

// ── RESET PASSWORD ────────────────────────────────────────────────────────────
router.post('/reset-password', [
  body('token').notEmpty(),
  body('password').isLength({ min: 8 }),
], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { token, password } = req.body;
  try {
    const record = await req.prisma.emailVerificationToken.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!record || record.type !== 'reset_password') return res.status(400).json({ error: 'Invalid reset link' });
    if (record.usedAt) return res.status(400).json({ error: 'Reset link already used' });
    if (record.expiresAt < new Date()) return res.status(400).json({ error: 'Reset link has expired' });

    const passwordHash = await bcrypt.hash(password, 12);
    await req.prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash },
    });

    await req.prisma.emailVerificationToken.update({
      where: { token },
      data: { usedAt: new Date() },
    });

    logger.info(`Password reset for: ${record.user.email}`);
    res.json({ message: 'Password reset successfully. You can now sign in.' });
  } catch (err) {
    console.error('RESET PASSWORD ERROR:', err);
    return res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
