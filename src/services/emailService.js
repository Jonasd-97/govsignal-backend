const nodemailer = require("nodemailer");
const logger = require("./logger");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 465,
  secure: true,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const FROM = process.env.EMAIL_FROM || "GovSignal <noreply@govsignal.io>";
const APP_URL = process.env.FRONTEND_URL || "https://govsignal.io";

// ── SHARED HTML WRAPPER ──
function wrap(content, userId = "") {
  const unsubUrl = userId
    ? `${APP_URL}/api/digest/unsubscribe?token=${userId}`
    : `${APP_URL}/settings`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;margin:0;padding:0}
    .outer{padding:40px 20px}.card{background:#1e293b;border-radius:12px;max-width:600px;margin:0 auto;overflow:hidden}
    .header{background:#1e293b;padding:28px 32px;border-bottom:1px solid #334155}
    .logo{font-size:20px;font-weight:800;color:#f59e0b;letter-spacing:-0.02em}
    .logo span{color:#94a3b8;font-weight:400;font-size:14px;margin-left:8px}
    .body{padding:28px 32px;color:#e2e8f0}
    h1{font-size:22px;font-weight:700;color:#f1f5f9;margin:0 0 12px}
    p{font-size:14px;line-height:1.7;color:#94a3b8;margin:0 0 16px}
    .btn{display:inline-block;background:#f59e0b;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;margin:8px 0}
    .opp{background:#0f172a;border-radius:8px;padding:16px;margin-bottom:12px;border:1px solid #334155}
    .opp-title{font-size:14px;font-weight:600;color:#f1f5f9;margin:0 0 6px}
    .opp-meta{font-size:12px;color:#64748b;margin:0 0 10px}
    .score{display:inline-block;background:#fef3c7;color:#d97706;border-radius:12px;padding:2px 8px;font-size:11px;font-weight:700;margin-right:8px}
    .deadline{display:inline-block;border-radius:12px;padding:2px 8px;font-size:11px;font-weight:600}
    .footer{padding:20px 32px;border-top:1px solid #334155;font-size:11px;color:#475569;text-align:center}
  </style></head><body><div class="outer"><div class="card">
    <div class="header"><div class="logo">◈ GovSignal<span>Federal Bid Intelligence</span></div></div>
    <div class="body">${content}</div>
    <div class="footer">GovSignal · <a href="${unsubUrl}" style="color:#64748b">Unsubscribe</a> · <a href="${APP_URL}" style="color:#64748b">Dashboard</a></div>
  </div></div></body></html>`;
}

// ── SEND WELCOME ──
async function sendWelcome(user) {
  try {
    await transporter.sendMail({
      from: FROM, to: user.email,
      subject: "Welcome to GovSignal — Your federal bid intelligence platform",
      html: wrap(`
        <h1>Welcome to GovSignal${user.name ? `, ${user.name}` : ""}!</h1>
        <p>You now have access to federal contract opportunities from SAM.gov, scored and ranked by how well they match your company profile.</p>
        <p><strong style="color:#f1f5f9">Get started in 3 steps:</strong></p>
        <p>1. Set up your company profile (NAICS code, set-aside certifications)<br>
           2. Add your free SAM.gov API key in Settings<br>
           3. Save opportunities to your watchlist and set up your daily digest</p>
        <a href="${APP_URL}" class="btn">Go to Dashboard →</a>
        <p style="margin-top:20px">On the free plan you get 10 opportunities per search. Upgrade to Pro for unlimited access, daily email digests, and competitor award history.</p>
      `),
    });
  } catch (err) {
    logger.error("Failed to send welcome email:", err);
  }
}

// ── SEND DAILY DIGEST ──
async function sendDigest(user, opportunities) {
  if (!opportunities.length) return;
  const oppHtml = opportunities.slice(0, 10).map(o => {
    const days = o.responseDeadline
      ? Math.ceil((new Date(o.responseDeadline) - new Date()) / 86400000)
      : null;
    const deadlineColor = days <= 5 ? "#fef2f2" : days <= 14 ? "#fffbeb" : "#f0fdf4";
    const deadlineTextColor = days <= 5 ? "#991b1b" : days <= 14 ? "#92400e" : "#065f46";
    return `<div class="opp">
      <div class="opp-title">${o.title}</div>
      <div class="opp-meta">${o.agency || "Federal Agency"}${o.naicsCode ? ` · NAICS ${o.naicsCode}` : ""}</div>
      <span class="score">▲ ${o.score} Match</span>
      ${days !== null ? `<span class="deadline" style="background:${deadlineColor};color:${deadlineTextColor}">${days > 0 ? `${days}d left` : "Expired"}</span>` : ""}
      ${o.uiLink ? `<div style="margin-top:10px"><a href="${o.uiLink}" style="color:#f59e0b;font-size:12px;text-decoration:none">View on SAM.gov →</a></div>` : ""}
    </div>`;
  }).join("");

  try {
    await transporter.sendMail({
      from: FROM, to: user.email,
      subject: `GovSignal Daily Digest — ${opportunities.length} new opportunities`,
      html: wrap(`
        <h1>Your Daily Opportunity Digest</h1>
        <p>Here are today's top-scoring federal contract opportunities based on your company profile.</p>
        ${oppHtml}
        <a href="${APP_URL}/opportunities" class="btn">View All Opportunities →</a>
        <p style="margin-top:16px;font-size:12px">Showing top ${Math.min(10, opportunities.length)} of ${opportunities.length} opportunities. 
        <a href="${APP_URL}/settings" style="color:#f59e0b">Update your preferences</a></p>
      `, user.id),
    });
    logger.info(`Digest sent to ${user.email} with ${opportunities.length} opportunities`);
  } catch (err) {
    logger.error(`Failed to send digest to ${user.email}:`, err);
  }
}

// ── SEND PASSWORD RESET ──
async function sendPasswordReset(user, token) {
  const resetUrl = `${APP_URL}/reset-password?token=${token}`;
  try {
    await transporter.sendMail({
      from: FROM, to: user.email,
      subject: "GovSignal — Reset your password",
      html: wrap(`
        <h1>Reset Your Password</h1>
        <p>You requested a password reset. Click the button below to create a new password. This link expires in 1 hour.</p>
        <a href="${resetUrl}" class="btn">Reset Password →</a>
        <p style="margin-top:16px">If you didn't request this, you can safely ignore this email.</p>
      `),
    });
  } catch (err) {
    logger.error("Failed to send password reset email:", err);
  }
}

// ── SEND NEW MATCH ALERT (for saved searches) ──
async function sendSearchAlert(user, searchName, newOpportunities) {
  if (!newOpportunities.length) return;
  try {
    await transporter.sendMail({
      from: FROM, to: user.email,
      subject: `GovSignal Alert — ${newOpportunities.length} new match${newOpportunities.length > 1 ? "es" : ""} for "${searchName}"`,
      html: wrap(`
        <h1>New Opportunities Matching "${searchName}"</h1>
        <p>${newOpportunities.length} new federal contract opportunit${newOpportunities.length > 1 ? "ies match" : "y matches"} your saved search.</p>
        ${newOpportunities.slice(0, 5).map(o => `<div class="opp">
          <div class="opp-title">${o.title}</div>
          <div class="opp-meta">${o.agency || ""}</div>
          <span class="score">▲ ${o.score} Match</span>
          ${o.uiLink ? `<div style="margin-top:8px"><a href="${o.uiLink}" style="color:#f59e0b;font-size:12px">View on SAM.gov →</a></div>` : ""}
        </div>`).join("")}
        <a href="${APP_URL}/opportunities" class="btn">View All →</a>
      `),
    });
  } catch (err) {
    logger.error("Failed to send search alert:", err);
  }
}

module.exports = { sendWelcome, sendDigest, sendPasswordReset, sendSearchAlert };
