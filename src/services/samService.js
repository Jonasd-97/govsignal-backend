const axios = require('axios');
const logger = require('./logger');
const { decryptIfPossible } = require('../utils/crypto');

const SAM_BASE = 'https://api.sam.gov/prod/opportunities/v2/search';

const SET_ASIDE_MAP = {
  SBA: 'small business', '8AN': '8(a)', HZC: 'hubzone',
  SDVOSBC: 'sdvosb', WOSB: 'wosb', EDWOSB: 'edwosb', VSB: 'veteran',
};

function getEffectiveApiKey(apiKey) {
  return decryptIfPossible(apiKey) || process.env.SAM_GOV_API_KEY;
}

function formatDate(d) {
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

async function fetchOpportunities(filters = {}, apiKey) {
  const key = getEffectiveApiKey(apiKey);
  if (!key) throw new Error('No SAM.gov API key available');

  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - (filters.daysBack || 30));

  const params = {
    api_key: key,
    limit: Math.min(Number(filters.limit) || 100, 100),
    postedFrom: formatDate(from),
    postedTo: formatDate(today),
  };

  if (filters.naicsCode) params.naicsCode = filters.naicsCode;
  if (filters.type) params.ptype = filters.type;
  if (filters.keyword) params.title = filters.keyword;
  if (filters.noticeId) params.noticeid = filters.noticeId;
  if (filters.solicitationNumber) params.solicitationNumber = filters.solicitationNumber;

  logger.info(`Fetching SAM.gov opportunities with filters: ${JSON.stringify({ ...params, api_key: '[REDACTED]' })}`);

  const res = await axios.get(SAM_BASE, {
    params,
    timeout: 20000,
    validateStatus: (status) => status >= 200 && status < 500,
  });

  if (res.status >= 400) {
    throw new Error(`SAM.gov returned ${res.status}`);
  }

  return res.data?.opportunitiesData || [];
}

function normalizeOpportunity(raw) {
  return {
    noticeId: raw.noticeId,
    title: raw.title || 'Untitled',
    agency: raw.fullParentPathName?.split('>')[0]?.trim() || null,
    subAgency: raw.fullParentPathName?.split('>')[1]?.trim() || null,
    naicsCode: raw.naicsCode || null,
    opportunityType: raw.type || null,
    setAsideType: raw.typeOfSetAside || null,
    setAsideDescription: raw.typeOfSetAsideDescription || null,
    postedDate: raw.postedDate ? new Date(raw.postedDate) : null,
    responseDeadline: raw.responseDeadLine ? new Date(raw.responseDeadLine) : null,
    archiveDate: raw.archiveDate ? new Date(raw.archiveDate) : null,
    description: raw.description || null,
    uiLink: raw.uiLink || null,
    solicitationNumber: raw.solicitationNumber || null,
    placeOfPerformance: raw.placeOfPerformance?.city?.name || raw.placeOfPerformance?.state?.name || null,
    rawJson: raw,
  };
}

function scoreOpportunity(opp, profile) {
  let score = 45;
  const reasons = [];
  const flags = [];

  if (profile?.naicsCode && opp.naicsCode === profile.naicsCode) {
    score += 25;
    reasons.push('NAICS code match');
  } else if (profile?.naicsCode && opp.naicsCode?.startsWith(profile.naicsCode.slice(0, 3))) {
    score += 10;
    reasons.push('Related NAICS sector');
  }

  if (profile?.setAside && opp.setAsideDescription) {
    const profileLabel = SET_ASIDE_MAP[profile.setAside] || '';
    if (opp.setAsideDescription.toLowerCase().includes(profileLabel)) {
      score += 20;
      reasons.push('Set-aside certification match');
    }
  }

  if (profile?.targetAgency && opp.agency?.toLowerCase().includes(String(profile.targetAgency).toLowerCase())) {
    score += 15;
    reasons.push('Target agency match');
  }

  if (opp.opportunityType === 'o' || opp.opportunityType === 'k') {
    score += 5;
  } else if (opp.opportunityType === 'r') {
    score += 3;
    reasons.push('Sources Sought — early intel');
  }

  const daysLeft = opp.responseDeadline
    ? Math.ceil((new Date(opp.responseDeadline) - new Date()) / 86400000)
    : null;

  if (daysLeft !== null) {
    if (daysLeft > 21) {
      score += 5;
      reasons.push('Good lead time');
    } else if (daysLeft >= 7) {
      score += 2;
    } else if (daysLeft < 5 && daysLeft > 0) {
      score -= 10;
      flags.push('Tight deadline');
    } else if (daysLeft <= 0) {
      score -= 30;
      flags.push('Deadline passed');
    }
  }

  return {
    score: Math.min(99, Math.max(5, Math.round(score))),
    reasons,
    flags,
    daysLeft,
  };
}

async function fetchAndScore(filters, profile, apiKey) {
  const raw = await fetchOpportunities(filters, apiKey);
  return raw
    .map((r) => {
      const normalized = normalizeOpportunity(r);
      const scoring = scoreOpportunity(normalized, profile);
      return { ...normalized, ...scoring };
    })
    .sort((a, b) => b.score - a.score);
}

async function fetchOpportunityByNoticeId(noticeId, apiKey) {
  const direct = await fetchOpportunities({ noticeId, limit: 5, daysBack: 3650 }, apiKey);
  let match = direct.find((item) => item.noticeId === noticeId);

  if (!match) {
    const fallback = await fetchOpportunities({ keyword: noticeId, limit: 20, daysBack: 3650 }, apiKey);
    match = fallback.find((item) => item.noticeId === noticeId);
  }

  return match ? normalizeOpportunity(match) : null;
}

module.exports = {
  fetchOpportunities,
  fetchOpportunityByNoticeId,
  normalizeOpportunity,
  scoreOpportunity,
  fetchAndScore,
  getEffectiveApiKey,
};
