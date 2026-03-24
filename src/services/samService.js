const axios = require('axios');
const logger = require('./logger');
const { decryptIfPossible } = require('../utils/crypto');
const { DUMMY_OPPORTUNITIES } = require('./dummyData');

const SAM_BASE = 'https://api.sam.gov/prod/opportunities/v2/search';

const SET_ASIDE_MAP = {
  SBA: 'small business', '8AN': '8(a)', HZC: 'hubzone',
  SDVOSBC: 'sdvosb', WOSB: 'wosb', EDWOSB: 'edwosb', VSB: 'veteran',
};

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(String(value).replace(/[$,]/g, '').trim());
  return Number.isFinite(num) ? num : null;
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

function compactLabel(min, max) {
  if (min !== null && max !== null) {
    if (min === max) return formatCurrency(min);
    return `${formatCurrency(min)} - ${formatCurrency(max)}`;
  }
  if (min !== null) return `From ${formatCurrency(min)}`;
  if (max !== null) return `Up to ${formatCurrency(max)}`;
  return null;
}

function scaleAmount(numberPart, unitPart) {
  const base = Number(String(numberPart).replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;

  const unit = String(unitPart || '').toLowerCase();
  if (unit === 'b' || unit === 'billion') return base * 1_000_000_000;
  if (unit === 'm' || unit === 'million') return base * 1_000_000;
  if (unit === 'k' || unit === 'thousand') return base * 1_000;
  return base;
}

function extractValueInfo(raw = {}) {
  const candidates = [
    { min: raw.award?.amount, max: raw.award?.amount, source: 'award.amount' },
    { min: raw.awardAmount, max: raw.awardAmount, source: 'awardAmount' },
    { min: raw.baseAndAllOptionsValue, max: raw.baseAndAllOptionsValue, source: 'baseAndAllOptionsValue' },
    { min: raw.baseAndAllOptionsEstimatedValue, max: raw.baseAndAllOptionsEstimatedValue, source: 'baseAndAllOptionsEstimatedValue' },
    { min: raw.estimatedValue, max: raw.estimatedValue, source: 'estimatedValue' },
    { min: raw.minimumAwardAmount, max: raw.maximumAwardAmount, source: 'minimumAwardAmount/maximumAwardAmount' },
    { min: raw.minAwardAmount, max: raw.maxAwardAmount, source: 'minAwardAmount/maxAwardAmount' },
  ];

  for (const candidate of candidates) {
    const min = toNumber(candidate.min);
    const max = toNumber(candidate.max);

    if (min !== null || max !== null) {
      const normalizedMin = min !== null ? min : max;
      const normalizedMax = max !== null ? max : min;

      return {
        valueMin: normalizedMin,
        valueMax: normalizedMax,
        valueLabel: compactLabel(normalizedMin, normalizedMax),
        valueSource: candidate.source,
      };
    }
  }

  const text = `${raw.description || ''} ${raw.title || ''}`;

  const rangeMatch = text.match(
    /\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?\s*(?:to|-)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?/i
  );

  if (rangeMatch) {
    const min = scaleAmount(rangeMatch[1], rangeMatch[2]);
    const max = scaleAmount(rangeMatch[3], rangeMatch[4]);

    return {
      valueMin: min,
      valueMax: max,
      valueLabel: compactLabel(min, max),
      valueSource: 'description_range',
    };
  }

  const singleMatch = text.match(
    /\$?\s*([\d,]+(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)\b/i
  );

  if (singleMatch) {
    const value = scaleAmount(singleMatch[1], singleMatch[2]);

    return {
      valueMin: value,
      valueMax: value,
      valueLabel: compactLabel(value, value),
      valueSource: 'description_single',
    };
  }

  return {
    valueMin: null,
    valueMax: null,
    valueLabel: null,
    valueSource: null,
  };
}

function getEffectiveApiKey(apiKey) {
  return decryptIfPossible(apiKey) || process.env.SAM_GOV_API_KEY;
}

function formatDate(d) {
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

async function fetchOpportunities(filters = {}, apiKey) {
  const key = getEffectiveApiKey(apiKey);

  console.log('SAM KEY PRESENT:', Boolean(key));
  console.log('SAM KEY PREFIX:', key ? `${String(key).slice(0, 6)}...` : 'NONE');

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

  console.log('SAM PARAMS:', { ...params, api_key: '[REDACTED]' });

  logger.info(`Fetching SAM.gov opportunities with filters: ${JSON.stringify({ ...params, api_key: '[REDACTED]' })}`);

  const res = await axios.get(SAM_BASE, {
    params,
    timeout: 20000,
    validateStatus: (status) => status >= 200 && status < 500,
  });

  console.log('SAM STATUS:', res.status);
  console.log('SAM RESPONSE KEYS:', Object.keys(res.data || {}));
  console.log('SAM TOTAL RECORDS:', res.data?.totalRecords);
  console.log('SAM OPPS COUNT:', Array.isArray(res.data?.opportunitiesData) ? res.data.opportunitiesData.length : 'NOT_ARRAY');
  console.log('SAM FIRST ITEM:', Array.isArray(res.data?.opportunitiesData) && res.data.opportunitiesData.length ? {
    noticeId: res.data.opportunitiesData[0].noticeId,
    title: res.data.opportunitiesData[0].title,
    type: res.data.opportunitiesData[0].type,
  } : null);

  if (res.status >= 400) {
    throw new Error(`SAM.gov returned ${res.status}: ${JSON.stringify(res.data)}`);
  }

  return res.data?.opportunitiesData || [];
}

function normalizeOpportunity(raw) {
  const valueInfo = extractValueInfo(raw);

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
    valueMin: valueInfo.valueMin,
    valueMax: valueInfo.valueMax,
    valueLabel: valueInfo.valueLabel,
    valueSource: valueInfo.valueSource,
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
  if (process.env.USE_DUMMY_DATA === 'true') {
    logger.info('Using dummy data mode');
    return DUMMY_OPPORTUNITIES
      .map((opp) => {
        const scoring = scoreOpportunity(opp, profile);
        return { ...opp, ...scoring };
      })
      .sort((a, b) => b.score - a.score);
  }

  const raw = await fetchOpportunities(filters, apiKey);
  console.log('RAW BEFORE NORMALIZE:', raw.length);

  const normalized = raw.map((r) => {
    const opp = normalizeOpportunity(r);
    const scoring = scoreOpportunity(opp, profile);
    return { ...opp, ...scoring };
  });

  console.log('NORMALIZED COUNT:', normalized.length);

  return normalized.sort((a, b) => b.score - a.score);
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
  extractValueInfo,
};