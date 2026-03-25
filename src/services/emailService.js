const nodemailer = require('nodemailer');
const logger = require('./logger');
const { signUnsubscribeToken } = require('../utils/tokens');

const APP_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const API_URL = process.env.BACKEND_URL || process.env.API_URL || APP_URL;
const FROM = process.env.EMAIL_FROM || 'HelixGov <no-reply@helixgov.com>';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: process.env.SMTP_USER ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  } : undefined,
});

function wrap(content, userId) {
  const unsubUrl = userId ? `${API_URL}/api/digest/unsubscribe?token=${encodeURIComponent(signUnsubscribeToken(userId))}` : null;
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body{font-family:Inter,Arial,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:0}
    .shell{max-width:720px;margin:0 auto;padding:32px 16px}.card{background:#111827;border:1px solid #1f2937;border-radius:16px;padding:28px}
    .brand{color:#2563eb;font-weight:700;font-size:20px;margin-bottom:16px}.btn{display:inline-block;background:#2563eb;color:#ffffff!important;text-decoration:none;padding:12px 16px;border-radius:10px;font-weight:700}
    .opp{border:1px solid #243041;border-radius:12px;padding:14px;margin:12px 0}.opp-title{font-weight:700;margin-bottom:6px}.opp-meta{font-size:13px;color:#94a3b8}.score{display:inline-block;background:#1d4ed8;color:#dbeafe;padding:4px 8px;border-radius:999px;font-size:12px;margin-top:10px}.deadline{display:inline-block;padding:4px 8px;border-radius:999px;font-size:12px;margin-top:10px;margin-left:8px}.footer{margin-top:18px;color:#94a3b8;font-size:12px}
  </style></head><body><div class="shell"><div class="card"><div class="brand">HelixGov</div>${content}<div class="footer">HelixGov · ${unsubUrl ? `<a href="${unsubUrl}" style="color:#94a3b8">Unsubscribe</a> · ` : ''}<a href="${APP_URL}" style="color:#94a3b8">Dashboard</a></div></div></div></body></html>`;
}

async function sendWelcome(user) {
  try {
    await transporter.sendMail({
      from: FROM,
      to: user.email,
      subject: 'Welcome to HelixGov — Your federal bid intelligence platform',
      html: wrap(`
        <h1>Welcome to HelixGov${user.name ? `, ${user.name}` : ''}!</h1>
        <p>You now have access to federal contract opportunities from SAM.gov, scored and ranked by how well they match your company profile.</p>
        <p><strong>Get started in 3 steps:</strong></p>
        <p>1. Set up your company profile<br>2. Add your SAM.gov API key in Settings<br>3. Save opportunities and turn on your digest</p>
        <a href="${APP_URL}" class="btn">Go to Dashboard →</a>
      `),
    });
  } catch (err) {
    logger.error('Failed to send welcome email:', err);
  }
}

async function sendDigest(user, opportunities) {
  if (!opportunities.length) return;
  const oppHtml = opportunities.slice(0, 10).map((o) => {
    const days = o.responseDeadline ? Math.ceil((new Date(o.responseDeadline) - new Date()) / 86400000) : null;
    const deadlineColor = days <= 5 ? '#fef2f2' : days <= 14 ? '#fffbeb' : '#f0fdf4';
    const deadlineTextColor = days <= 5 ? '#991b1b' : days <= 14 ? '#92400e' : '#065f46';
    return `<div class="opp"><div class="opp-title">${o.title}</div><div class="opp-meta">${o.agency || 'Federal Agency'}${o.naicsCode ? ` · NAICS ${o.naicsCode}` : ''}</div><span class="score">▲ ${o.score} Match</span>${days !== null ? `<span class="deadline" style="background:${deadlineColor};color:${deadlineTextColor}">${days > 0 ? `${days}d left` : 'Expired'}</span>` : ''}${o.uiLink ? `<div style="margin-top:10px"><a href="${o.uiLink}" style="color:#f59e0b;font-size:12px;text-decoration:none">View on SAM.gov →</a></div>` : ''}</div>`;
  }).join('');

  try {
    await transporter.sendMail({
      from: FROM,
      to: user.email,
      subject: `HelixGov Daily Digest — ${opportunities.length} new opportunities`,
      html: wrap(`
        <h1>Your Daily Opportunity Digest</h1>
        <p>Here are today's top-scoring federal contract opportunities based on your company profile.</p>
        ${oppHtml}
        <a href="${APP_URL}/opportunities" class="btn">View All Opportunities →</a>
      `, user.id),
    });
    logger.info(`Digest sent to ${user.email} with ${opportunities.length} opportunities`);
  } catch (err) {
    logger.error(`Failed to send digest to ${user.email}:`, err);
  }
}

async function sendPasswordReset(user, token) {
  const resetUrl = `${APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  try {
    await transporter.sendMail({
      from: FROM,
      to: user.email,
      subject: 'HelixGov — Reset your password',
      html: wrap(`
        <h1>Reset Your Password</h1>
        <p>You requested a password reset. Click below to create a new password. This link expires in 1 hour.</p>
        <a href="${resetUrl}" class="btn">Reset Password →</a>
      `),
    });
  } catch (err) {
    logger.error('Failed to send password reset email:', err);
  }
}

async function sendSearchAlert(user, searchName, newOpportunities) {
  if (!newOpportunities.length) return;
  try {
    await transporter.sendMail({
      from: FROM,
      to: user.email,
      subject: `HelixGov Alert — ${newOpportunities.length} new match${newOpportunities.length > 1 ? 'es' : ''} for "${searchName}"`,
      html: wrap(`
        <h1>New Opportunities Matching "${searchName}"</h1>
        <p>${newOpportunities.length} new federal contract opportunit${newOpportunities.length > 1 ? 'ies match' : 'y matches'} your saved search.</p>
        ${newOpportunities.slice(0, 5).map((o) => `<div class="opp"><div class="opp-title">${o.title}</div><div class="opp-meta">${o.agency || ''}</div><span class="score">▲ ${o.score} Match</span>${o.uiLink ? `<div style="margin-top:8px"><a href="${o.uiLink}" style="color:#f59e0b;font-size:12px">View on SAM.gov →</a></div>` : ''}</div>`).join('')}
        <a href="${APP_URL}/opportunities" class="btn">View All →</a>
      `, user.id),
    });
  } catch (err) {
    logger.error('Failed to send search alert:', err);
  }
}

async function sendVerificationEmail(user, token) {
  const verifyUrl = `${API_URL}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  try {
    await transporter.sendMail({
      from: FROM,
      to: user.email,
      subject: 'HelixGov — Verify your email address',
      html: wrap(`
        <h1>Verify your email${user.name ? `, ${user.name}` : ''}</h1>
        <p>Thanks for signing up for HelixGov. Click below to verify your email address and activate your 14-day free trial.</p>
        <p>This link expires in 24 hours.</p>
        <a href="${verifyUrl}" class="btn">Verify Email →</a>
        <p style="margin-top:16px;font-size:13px;color:#94a3b8">If you didn't create an account, you can safely ignore this email.</p>
      `),
    });
    logger.info(`Verification email sent to ${user.email}`);
  } catch (err) {
    logger.error('Failed to send verification email:', err);
  }
}

module.exports = { sendWelcome, sendDigest, sendPasswordReset, sendSearchAlert, sendVerificationEmail };
