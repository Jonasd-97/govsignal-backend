const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { body } = require('express-validator');
const { authenticate, requirePlan, checkAiLimit } = require('../middleware/auth');
const logger = require('../services/logger');
const { handleValidation } = require('../utils/validation');
const { parseModelJson, coerceAnalyzeResponse, coerceScoreResponse } = require('../utils/ai');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function extractTextFromBuffer(buffer, mimetype) {
  if (mimetype === 'application/pdf') {
    const data = await pdfParse(buffer);
    return data.text || '';
  }
  if (
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimetype === 'application/msword'
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }
  throw new Error('Unsupported file type. Please upload a PDF or Word document.');
}

const router = express.Router();

async function callClaude(system, userMessage, maxTokens = 1200) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('AI features are not yet enabled. Please check back soon.');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text || '';
}

router.post('/analyze', authenticate, requirePlan('PRO', 'AGENCY'), checkAiLimit, [body('opportunity').isObject()], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { opportunity, profile = {} } = req.body;
  const intel = opportunity.intel || {};
  const profileContext = [
    profile.companyName && `Company: ${profile.companyName}`,
    profile.naics && `Primary NAICS: ${profile.naics}${profile.naicsLabel ? ' — ' + profile.naicsLabel : ''}`,
    profile.setAside && `Set-Aside Certification: ${profile.setAside}`,
    profile.agency && `Target Agency: ${profile.agency}`,
    profile.pastPerfCount > 0 && `Past Performance: ${profile.pastPerfCount} contracts (${profile.pastPerfWins} won)`,
  ].filter(Boolean).join('\n') || 'No company profile set.';

  const oppContext = `Title: ${opportunity.title}\nAgency: ${opportunity.agency || 'Unknown'}\nNAICS Code: ${opportunity.naicsCode || 'Not specified'}\nSet-Aside: ${opportunity.setAside || 'None'}\nType: ${opportunity.type || 'Notice'}\nPosted: ${opportunity.postedDate || 'Unknown'}\nResponse Deadline: ${opportunity.responseDeadline || 'Unknown'}\nNotice ID: ${opportunity.noticeId || 'Unknown'}\nEstimated Value: ${intel.estimatedValue ? '$' + Number(intel.estimatedValue).toLocaleString() + ' (' + intel.valueConfidence + ' confidence)' : 'Not found'}\nCompetition Type: ${intel.competitionType || 'Unknown'}\nClearance Required: ${intel.clearanceRequired || 'None detected'}\nIncumbent Risk: ${intel.incumbentRisk || 'Unknown'}${intel.incumbentSignals?.length ? ' — ' + intel.incumbentSignals.join(', ') : ''}\nComplexity: ${intel.complexityLevel || 'Unknown'}${intel.complexityFlags?.length ? ' (' + intel.complexityFlags.join(', ') + ')' : ''}\nNew Firm Suitability: ${intel.newFirmSuitability || 'Unknown'}\nDescription: ${opportunity.description || 'No description available.'}`.trim();

  try {
    const text = await callClaude(
      'You are a GovCon expert analyst helping small government contracting firms decide whether to bid on federal opportunities. Be direct, specific, and actionable. Respond ONLY in JSON — no markdown, no preamble.',
      `Analyze this federal contract opportunity and return a JSON object with exactly these keys:\n- "verdict": one of "Strong Fit" | "Potential Fit" | "Weak Fit" | "Not Recommended"\n- "verdict_reason": 1 sentence explaining the verdict\n- "win_probability": number 1-100\n- "estimated_value_analysis": 1-2 sentences on contract value, profit potential, and capital requirements\n- "key_requirements": array of 3-5 short strings\n- "strengths": array of 2-4 short strings\n- "risks": array of 2-4 short strings\n- "new_firm_assessment": 2-3 sentences\n- "next_steps": array of 3 short actionable strings\n- "teaming_suggestion": string or null\n\nCOMPANY PROFILE:\n${profileContext}\n\nOPPORTUNITY:\n${oppContext}`,
      1200
    );
    res.json(coerceAnalyzeResponse(parseModelJson(text)));
  } catch (err) {
    logger.error('AI analyze error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/proposal', authenticate, requirePlan('PRO', 'AGENCY'), checkAiLimit, [body('docType').notEmpty(), body('opportunity').isObject()], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { docType, opportunity, profile = {}, pastPerf = [] } = req.body;
  const profileContext = [
    profile.companyName && `Company Name: ${profile.companyName}`,
    profile.naics && `Primary NAICS: ${profile.naics}${profile.naicsLabel ? ' — ' + profile.naicsLabel : ''}`,
    profile.setAside && `Set-Aside Certification: ${profile.setAside}`,
    profile.agency && `Target Agency Focus: ${profile.agency}`,
  ].filter(Boolean).join('\n') || 'No company profile configured.';

  const perfContext = pastPerf?.length > 0 ? pastPerf.map((p) => `- ${p.title} | ${p.agency} | $${Number(p.value || 0).toLocaleString()} | ${p.year} | ${p.outcome}`).join('\n') : 'No past performance entries logged.';
  const oppContext = `Title: ${opportunity.title}\nAgency: ${opportunity.agency || 'Unknown'}\nNAICS: ${opportunity.naicsCode || 'Not specified'}\nSet-Aside: ${opportunity.setAside || 'None'}\nType: ${opportunity.type || 'Notice'}\nDeadline: ${opportunity.deadline || 'Unknown'}\nNotice ID: ${opportunity.noticeId || 'Unknown'}\nDescription: ${opportunity.description || 'No description available.'}`.trim();

  const prompts = {
    capability: 'You are an expert GovCon proposal writer. Write a professional, tailored Capability Statement for this federal opportunity. Use ALL CAPS section headers for CORE COMPETENCIES, DIFFERENTIATORS, PAST PERFORMANCE, COMPANY DATA, VALUE PROPOSITION.',
    executive: 'You are an expert GovCon proposal writer. Write a compelling Executive Summary with sections: UNDERSTANDING OF REQUIREMENT, PROPOSED APPROACH, KEY PERSONNEL, PAST PERFORMANCE HIGHLIGHTS, WHY US, COMMITMENT STATEMENT.',
    technical: 'You are an expert GovCon proposal writer. Create a detailed Technical Approach outline with sections: TECHNICAL APPROACH OVERVIEW, PHASE-BY-PHASE METHODOLOGY, STAFFING PLAN, MANAGEMENT APPROACH, QUALITY ASSURANCE PLAN, RISK MITIGATION TABLE, TOOLS & TECHNOLOGY.',
    questions: 'You are an expert GovCon BD professional. Generate strategic CO questions under SCOPE & REQUIREMENTS, EVALUATION CRITERIA, PAST PERFORMANCE, CONTRACT TERMS, and TEAMING.',
  };

  if (!prompts[docType]) return res.status(400).json({ error: 'Invalid docType' });

  try {
    const text = await callClaude(
      'You are a senior GovCon proposal writer with 15 years of experience. Write professional, specific, winning proposal content. Never use generic filler.',
      `${prompts[docType]}\n\nCOMPANY PROFILE:\n${profileContext}\n\nPAST PERFORMANCE:\n${perfContext}\n\nOPPORTUNITY:\n${oppContext}\n\nWrite the document now. Use clear ALL CAPS section headers. Be specific, professional, and ready to submit.`,
      1500
    );
    res.json({ output: text });
  } catch (err) {
    logger.error('AI proposal error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/score', authenticate, requirePlan('PRO', 'AGENCY'), checkAiLimit, [body('document').isString(), body('opportunity').isObject()], async (req, res) => {
  if (!handleValidation(req, res)) return;
  const { docType, docTypeLabel, document, opportunity } = req.body;
  const oppContext = `Title: ${opportunity.title}\nAgency: ${opportunity.agency || 'Unknown'}\nNAICS: ${opportunity.naicsCode || 'Not specified'}\nSet-Aside: ${opportunity.setAside || 'None'}\nDescription: ${opportunity.description || 'Not available'}`.trim();
  try {
    const text = await callClaude(
      'You are a federal proposal evaluator with 20 years of experience. You evaluate proposals exactly as a real CO would. Respond ONLY in JSON — no markdown, no preamble.',
      `Score this proposal document. Return a JSON object with exactly these keys:\n- "overall_score": number 0-100\n- "grade": one of "A" | "B" | "C" | "D" | "F"\n- "summary": 2 sentences\n- "dimensions": array of 5 objects each with "name", "score", "feedback"\n- "critical_fixes": array of 3-5 specific actionable fixes\n- "strengths": array of 2-3 things done well\n- "submission_ready": boolean\n\nOPPORTUNITY:\n${oppContext}\n\nDOCUMENT TYPE: ${docTypeLabel || docType}\n\nPROPOSAL TO SCORE:\n${document}`,
      1000
    );
    res.json(coerceScoreResponse(parseModelJson(text)));
  } catch (err) {
    logger.error('AI score error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/extract-performance', authenticate, requirePlan('PRO', 'AGENCY'), checkAiLimit, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const rawText = await extractTextFromBuffer(req.file.buffer, req.file.mimetype);
    if (!rawText || rawText.trim().length < 50) {
      return res.status(422).json({ error: 'Could not extract readable text from this document.' });
    }

    const prompt = `You are a GovCon expert. The following is text extracted from a government contract document, award notice, or past performance record.

Extract the following fields. If a field is not clearly present, return an empty string — do not guess.

Return ONLY a JSON object with these exact keys:
- title: project or contract title
- agency: government agency name
- contractValue: numeric value as a string (e.g. "450000"), no symbols
- contractValueNum: the contract value as a number (e.g. 450000), or null if not found
- year: 4-digit year the contract was awarded or performed (e.g. "2023")
- outcome: one of "Won", "Completed", "Ongoing", or "Lost"
- naicsCode: 6-digit NAICS code if mentioned
- description: a clean 2-4 sentence summary of what work was performed, suitable for a past performance record
- capabilityTags: array of 3-6 short strings describing the firm's demonstrated capabilities (e.g. ["IT services", "DoD experience", "systems integration"])
- technicalAreas: array of 2-4 short strings for technical domains (e.g. ["cybersecurity", "cloud migration"])

Document text:
---
${rawText.slice(0, 6000)}
---

Return ONLY valid JSON. No markdown, no explanation.`;

    const text = await callClaude(
      'You are a GovCon expert that extracts structured data from contract documents. Respond ONLY in JSON — no markdown, no preamble.',
      prompt,
      1000
    );

    const extracted = parseModelJson(text);

    // ── Build and merge capability profile ──────────────────────────────────
    // Fetch existing profile so we accumulate data across multiple docs dropped
    const currentUser = await req.prisma.user.findUnique({
      where: { id: req.userId },
      select: { capabilityProfile: true, naicsCode: true, targetAgency: true },
    });

    const existing = currentUser.capabilityProfile || {};
    const mergedProfile = {
      capabilityTags: [...new Set([...(existing.capabilityTags || []), ...(extracted.capabilityTags || [])])].slice(0, 20),
      naicsCodes: [...new Set([...(existing.naicsCodes || []), ...(extracted.naicsCode ? [extracted.naicsCode] : [])])].slice(0, 10),
      agencies: [...new Set([...(existing.agencies || []), ...(extracted.agency ? [extracted.agency] : [])])].slice(0, 10),
      technicalAreas: [...new Set([...(existing.technicalAreas || []), ...(extracted.technicalAreas || [])])].slice(0, 15),
      contractValues: [...(existing.contractValues || []), ...(extracted.contractValueNum ? [extracted.contractValueNum] : [])].slice(-20),
      lastUpdated: new Date().toISOString(),
      docsAnalyzed: (existing.docsAnalyzed || 0) + 1,
    };

    // Compute average contract value for scoring context
    if (mergedProfile.contractValues.length > 0) {
      mergedProfile.avgContractValue = Math.round(
        mergedProfile.contractValues.reduce((a, b) => a + b, 0) / mergedProfile.contractValues.length
      );
    }

    // Save capability profile + auto-fill standard profile fields if they're blank
    const profileUpdates = { capabilityProfile: mergedProfile };
    if (!currentUser.naicsCode && extracted.naicsCode) profileUpdates.naicsCode = extracted.naicsCode;
    if (!currentUser.targetAgency && extracted.agency) profileUpdates.targetAgency = extracted.agency;

    await req.prisma.user.update({
      where: { id: req.userId },
      data: profileUpdates,
    });

    res.json({ ...extracted, capabilityProfile: mergedProfile });
  } catch (err) {
    logger.error('extract-performance error:', err);
    res.status(500).json({ error: err.message || 'Failed to extract document.' });
  }
});

router.post('/extract-text', authenticate, requirePlan('PRO', 'AGENCY'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const text = await extractTextFromBuffer(req.file.buffer, req.file.mimetype);
    if (!text || text.trim().length < 50) {
      return res.status(422).json({ error: 'Could not extract readable text from this document.' });
    }

    res.json({ text: text.slice(0, 20000) });
  } catch (err) {
    logger.error('extract-text error:', err);
    res.status(500).json({ error: err.message || 'Failed to extract text.' });
  }
});

module.exports = router;
