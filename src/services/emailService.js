const logger = require('./logger');
const { signUnsubscribeToken } = require('../utils/tokens');

const APP_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const API_URL = process.env.BACKEND_URL || process.env.API_URL || APP_URL;
const FROM = process.env.EMAIL_FROM || 'HelixGov <no-reply@helixgov.com>';
const RESEND_API_KEY = process.env.SMTP_PASS; // reuse existing env var

async function sendEmail({ to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API error: ${res.status} ${err}`);
  }

  return res.json();
}

function wrap(content, userId) {
  const unsubUrl = userId ? `${API_URL}/api/digest/unsubscribe?token=${encodeURIComponent(signUnsubscribeToken(userId))}` : null;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#0f172a;-webkit-text-size-adjust:100%;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f8fafc;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">

          <!-- Header -->
          <tr>
            <td style="padding-bottom:20px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="width:10px;height:10px;background-color:#2563eb;border-radius:50%;vertical-align:middle;"></td>
                  <td style="padding-left:8px;vertical-align:middle;">
                    <span style="font-size:18px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Helix</span><span style="font-size:18px;font-weight:700;color:#2563eb;letter-spacing:-0.3px;">Gov</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background-color:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:36px 40px;">
              ${content}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding-top:24px;text-align:center;font-size:12px;color:#94a3b8;">
              HelixGov · Federal Contract Intelligence
              ${unsubUrl ? ` · <a href="${unsubUrl}" style="color:#94a3b8;text-decoration:underline;">Unsubscribe</a>` : ''}
              · <a href="${APP_URL}" style="color:#94a3b8;text-decoration:underline;">Dashboard</a>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendWelcome(user) {
  try {
    await sendEmail({
      to: user.email,
      subject: 'Welcome to HelixGov — Your federal bid intelligence platform',
      html: wrap(`
        <h1 style="margin:0 0 12px;font-size:24px;font-weight:700;color:#0f172a;letter-spacing:-0.5px;">Welcome to HelixGov${user.name ? `, ${user.name}` : ''}!</h1>
        <p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.6;">You now have access to federal contract opportunities from SAM.gov, scored and ranked by how well they match your company profile.</p>
        <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#0f172a;">Get started in 3 steps:</p>
        <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.8;">1. Complete your company profile<br>2. Browse and save high-fit opportunities<br>3. Run AI bid analysis on your best matches</p>
        <a href="${APP_URL}" style="display:inline-block;background-color:#2563eb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:-0.1px;">Go to Dashboard →</a>
      `),
    });
    logger.info(`Welcome email sent to ${user.email}`);
  } catch (err) {
    logger.error('Failed to send welcome email:', err);
  }
}

async function sendDigest(user, opportunities) {
  if (!opportunities.length) return;
  const oppHtml = opportunities.slice(0, 10).map((o) => {
    const days = o.responseDeadline ? Math.ceil((new Date(o.responseDeadline) - new Date()) / 86400000) : null;
    const deadlineBg = days <= 5 ? '#fef2f2' : days <= 14 ? '#fffbeb' : '#f0fdf4';
    const deadlineColor = days <= 5 ? '#991b1b' : days <= 14 ? '#92400e' : '#065f46';
    return `
      <div style="border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:12px 0;background:#f8fafc;">
        <div style="font-weight:600;font-size:14px;color:#0f172a;margin-bottom:4px;">${o.title}</div>
        <div style="font-size:12px;color:#64748b;margin-bottom:8px;">${o.agency || 'Federal Agency'}${o.naicsCode ? ` · NAICS ${o.naicsCode}` : ''}</div>
        <span style="display:inline-block;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;">▲ ${o.score} Match</span>
        ${days !== null ? `<span style="display:inline-block;background:${deadlineBg};color:${deadlineColor};padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;margin-left:6px;">${days > 0 ? `${days}d left` : 'Expired'}</span>` : ''}
        ${o.uiLink ? `<div style="margin-top:10px;"><a href="${o.uiLink}" style="color:#2563eb;font-size:12px;text-decoration:none;font-weight:500;">View on SAM.gov →</a></div>` : ''}
      </div>`;
  }).join('');

  try {
    await sendEmail({
      to: user.email,
      subject: `HelixGov Daily Digest — ${opportunities.length} new opportunities`,
      html: wrap(`
        <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#0f172a;letter-spacing:-0.5px;">Your Daily Opportunity Digest</h1>
        <p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.6;">Here are today's top-scoring federal contract opportunities based on your company profile.</p>
        ${oppHtml}
        <div style="margin-top:24px;">
          <a href="${APP_URL}/opportunities" style="display:inline-block;background-color:#2563eb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">View All Opportunities →</a>
        </div>
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
    await sendEmail({
      to: user.email,
      subject: 'HelixGov — Reset your password',
      html: wrap(`
        <h1 style="margin:0 0 12px;font-size:24px;font-weight:700;color:#0f172a;letter-spacing:-0.5px;">Reset your password</h1>
        <p style="margin:0 0 28px;font-size:15px;color:#475569;line-height:1.6;">You requested a password reset. Click below to create a new password. This link expires in 1 hour.</p>
        <a href="${resetUrl}" style="display:inline-block;background-color:#2563eb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:-0.1px;">Reset Password →</a>
        <p style="margin:28px 0 0;font-size:13px;color:#94a3b8;">If you didn't request a password reset, you can safely ignore this email.</p>
      `),
    });
    logger.info(`Password reset email sent to ${user.email}`);
  } catch (err) {
    logger.error('Failed to send password reset email:', err);
  }
}

async function sendSearchAlert(user, searchName, newOpportunities) {
  if (!newOpportunities.length) return;
  try {
    await sendEmail({
      to: user.email,
      subject: `HelixGov Alert — ${newOpportunities.length} new match${newOpportunities.length > 1 ? 'es' : ''} for "${searchName}"`,
      html: wrap(`
        <h1 style="margin:0 0 12px;font-size:24px;font-weight:700;color:#0f172a;letter-spacing:-0.5px;">New Opportunities Matching "${searchName}"</h1>
        <p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.6;">${newOpportunities.length} new federal contract opportunit${newOpportunities.length > 1 ? 'ies match' : 'y matches'} your saved search.</p>
        ${newOpportunities.slice(0, 5).map((o) => `
          <div style="border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:12px 0;background:#f8fafc;">
            <div style="font-weight:600;font-size:14px;color:#0f172a;margin-bottom:4px;">${o.title}</div>
            <div style="font-size:12px;color:#64748b;margin-bottom:8px;">${o.agency || ''}</div>
            <span style="display:inline-block;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;">▲ ${o.score} Match</span>
            ${o.uiLink ? `<div style="margin-top:10px;"><a href="${o.uiLink}" style="color:#2563eb;font-size:12px;text-decoration:none;font-weight:500;">View on SAM.gov →</a></div>` : ''}
          </div>`).join('')}
        <div style="margin-top:24px;">
          <a href="${APP_URL}/opportunities" style="display:inline-block;background-color:#2563eb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;">View All →</a>
        </div>
      `, user.id),
    });
  } catch (err) {
    logger.error('Failed to send search alert:', err);
  }
}

async function sendVerificationEmail(user, token) {
  const verifyUrl = `${API_URL}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  try {
    await sendEmail({
      to: user.email,
      subject: 'HelixGov — Verify your email address',
      html: wrap(`
        <h1 style="margin:0 0 12px;font-size:24px;font-weight:700;color:#0f172a;letter-spacing:-0.5px;">Verify your email${user.name ? `, ${user.name}` : ''}</h1>
        <p style="margin:0 0 8px;font-size:15px;color:#475569;line-height:1.6;">Thanks for signing up for HelixGov. Click below to verify your email address and activate your 14-day free trial.</p>
        <p style="margin:0 0 28px;font-size:13px;color:#94a3b8;">This link expires in 24 hours.</p>
        <a href="${verifyUrl}" style="display:inline-block;background-color:#2563eb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:-0.1px;">Verify Email →</a>
        <p style="margin:28px 0 0;font-size:13px;color:#94a3b8;">If you didn't create an account, you can safely ignore this email.</p>
      `),
    });
    logger.info(`Verification email sent to ${user.email}`);
  } catch (err) {
    logger.error('Failed to send verification email:', err);
  }
}

module.exports = { sendWelcome, sendDigest, sendPasswordReset, sendSearchAlert, sendVerificationEmail };
