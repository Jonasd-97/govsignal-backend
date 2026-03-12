const axios = require("axios");
const logger = require("./logger");

const SAM_BASE = "https://api.sam.gov/prod/opportunities/v2/search";

const SET_ASIDE_MAP = {
  SBA: "small business", "8AN": "8(a)", HZC: "hubzone",
  SDVOSBC: "sdvosb", WOSB: "wosb", EDWOSB: "edwosb", VSB: "veteran",
};

// ── FETCH from SAM.gov ──
async function fetchOpportunities(filters = {}, apiKey) {
  const key = apiKey || process.env.SAM_GOV_API_KEY;
  if (!key) throw new Error("No SAM.gov API key available");

  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - (filters.daysBack || 30));

  const fmt = (d) =>
    `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;

  const params = {
    api_key: key,
    limit: filters.limit || 100,
    postedFrom: fmt(from),
    postedTo: fmt(today),
  };

  if (filters.naicsCode) params.naicsCode = filters.naicsCode;
  if (filters.type)      params.ptype = filters.type;
  if (filters.keyword)   params.title = filters.keyword;

  logger.info(`Fetching SAM.gov opportunities with filters: ${JSON.stringify({ ...params, api_key: "[REDACTED]" })}`);

  const res = await axios.get(SAM_BASE, { params, timeout: 15000 });
  return res.data?.opportunitiesData || [];
}

// ── NORMALIZE SAM.gov opp to our schema ──
function normalizeOpportunity(raw) {
  return {
    noticeId:             raw.noticeId,
    title:                raw.title || "Untitled",
    agency:               raw.fullParentPathName?.split(">")[0]?.trim() || null,
    subAgency:            raw.fullParentPathName?.split(">")[1]?.trim() || null,
    naicsCode:            raw.naicsCode || null,
    opportunityType:      raw.type || null,
    setAsideType:         raw.typeOfSetAside || null,
    setAsideDescription:  raw.typeOfSetAsideDescription || null,
    postedDate:           raw.postedDate ? new Date(raw.postedDate) : null,
    responseDeadline:     raw.responseDeadLine ? new Date(raw.responseDeadLine) : null,
    archiveDate:          raw.archiveDate ? new Date(raw.archiveDate) : null,
    description:          raw.description || null,
    uiLink:               raw.uiLink || null,
    solicitationNumber:   raw.solicitationNumber || null,
    placeOfPerformance:   raw.placeOfPerformance?.city?.name || null,
    rawJson:              raw,
  };
}

// ── AI SCORING ENGINE ──
function scoreOpportunity(opp, profile) {
  let score = 45;
  const reasons = [];
  const flags = [];

  // NAICS match (+25)
  if (profile?.naicsCode && opp.naicsCode === profile.naicsCode) {
    score += 25;
    reasons.push("NAICS code match");
  } else if (profile?.naicsCode && opp.naicsCode?.startsWith(profile.naicsCode.slice(0, 3))) {
    score += 10;
    reasons.push("Related NAICS sector");
  }

  // Set-aside match (+20)
  if (profile?.setAside && opp.setAsideDescription) {
    const profileLabel = SET_ASIDE_MAP[profile.setAside] || "";
    if (opp.setAsideDescription.toLowerCase().includes(profileLabel)) {
      score += 20;
      reasons.push("Set-aside certification match");
    }
  }

  // Target agency match (+15)
  if (profile?.targetAgency && opp.agency?.includes(profile.targetAgency)) {
    score += 15;
    reasons.push("Target agency match");
  }

  // Opportunity type scoring
  if (opp.opportunityType === "o" || opp.opportunityType === "k") {
    score += 5; // Solicitation or Combined — actionable
  } else if (opp.opportunityType === "r") {
    score += 3; // Sources Sought — early intelligence
    reasons.push("Sources Sought — early intel");
  }

  // Deadline scoring
  const daysLeft = opp.responseDeadline
    ? Math.ceil((new Date(opp.responseDeadline) - new Date()) / 86400000)
    : null;

  if (daysLeft !== null) {
    if (daysLeft > 21) { score += 5; reasons.push("Good lead time"); }
    else if (daysLeft >= 7) { score += 2; }
    else if (daysLeft < 5 && daysLeft > 0) { score -= 10; flags.push("Tight deadline"); }
    else if (daysLeft <= 0) { score -= 30; flags.push("Deadline passed"); }
  }

  // Past performance bonus would go here if integrated
  // (match agency or NAICS to user's past performance log)

  return {
    score: Math.min(99, Math.max(5, Math.round(score))),
    reasons,
    flags,
    daysLeft,
  };
}

// ── FETCH + SCORE in one call ──
async function fetchAndScore(filters, profile, apiKey) {
  const raw = await fetchOpportunities(filters, apiKey);
  return raw.map((r) => {
    const normalized = normalizeOpportunity(r);
    const scoring = scoreOpportunity(normalized, profile);
    return { ...normalized, ...scoring };
  }).sort((a, b) => b.score - a.score);
}

module.exports = { fetchOpportunities, normalizeOpportunity, scoreOpportunity, fetchAndScore };
