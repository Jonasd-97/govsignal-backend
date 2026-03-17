const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const emailService = require('../services/emailService');
const logger = require('../services/logger');
const { handleValidation } = require('../utils/validation');
const { encryptIfPossible } = require('../utils/crypto');

const router = express.Router();

const signToken = (user) =>
  jwt.sign({ userId: user.id, email: user.email, plan: user.plan }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('name').optional().trim().isLength({ max: 100 }),
], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { email, password, name } = req.body;
  try {
    const existing = await req.prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await req.prisma.user.create({ data: { email, passwordHash, name, plan: 'FREE' } });
    await req.prisma.digestSettings.create({ data: { userId: user.id } });
    await emailService.sendWelcome(user);
    const token = signToken(user);
    logger.info(`New user registered: ${email}`);
    res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
  } catch (err) {
    console.error('REGISTER ERROR:', err);
    return res.status(500).json({
      error: 'Registration failed',
      details: err.message,
   });
}
});
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
    const token = signToken(user);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
  } catch (err) {
    logger.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await req.prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true, email: true, name: true, plan: true,
        companyName: true, naicsCode: true, setAside: true, targetAgency: true,
        createdAt: true, samApiKey: true,
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ ...user, samApiKey: undefined, hasSamApiKey: Boolean(user.samApiKey) });
  } catch {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

router.patch('/profile', authenticate, [
  body('name').optional().trim().isLength({ max: 100 }),
  body('companyName').optional().trim().isLength({ max: 200 }),
  body('naicsCode').optional().trim().isLength({ min: 2, max: 10 }),
  body('setAside').optional().trim().isLength({ max: 50 }),
  body('targetAgency').optional().trim().isLength({ max: 120 }),
  body('samApiKey').optional().isString().isLength({ max: 500 }),
], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { name, companyName, naicsCode, setAside, targetAgency, samApiKey } = req.body;
  try {
    const user = await req.prisma.user.update({
      where: { id: req.userId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(companyName !== undefined ? { companyName } : {}),
        ...(naicsCode !== undefined ? { naicsCode } : {}),
        ...(setAside !== undefined ? { setAside } : {}),
        ...(targetAgency !== undefined ? { targetAgency } : {}),
        ...(samApiKey !== undefined ? { samApiKey: samApiKey ? encryptIfPossible(samApiKey) : null } : {}),
      },
      select: { id: true, email: true, name: true, plan: true, companyName: true, naicsCode: true, setAside: true, targetAgency: true },
    });
    res.json({ ...user, hasSamApiKey: samApiKey !== undefined ? Boolean(samApiKey) : true });
  } catch {
    res.status(500).json({ error: 'Profile update failed' });
  }
});

router.post('/forgot-password', [body('email').isEmail().normalizeEmail()], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { email } = req.body;
  try {
    const user = await req.prisma.user.findUnique({ where: { email } });
    if (!user) return res.json({ message: 'If that email exists, a reset link has been sent.' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await req.prisma.emailVerificationToken.create({
      data: { userId: user.id, token, type: 'reset_password', expiresAt },
    });

    await emailService.sendPasswordReset(user, token);
    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    logger.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

router.post('/reset-password', [
  body('token').notEmpty(),
  body('password').isLength({ min: 8 }),
], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { token, password } = req.body;
  try {
    const record = await req.prisma.emailVerificationToken.findUnique({ where: { token } });
    if (!record || record.type !== 'reset_password' || record.usedAt || record.expiresAt < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await req.prisma.user.update({ where: { id: record.userId }, data: { passwordHash } });
    await req.prisma.emailVerificationToken.update({ where: { token }, data: { usedAt: new Date() } });
    res.json({ message: 'Password reset successfully' });
  } catch {
    res.status(500).json({ error: 'Password reset failed' });
  }
});

module.exports = router;
