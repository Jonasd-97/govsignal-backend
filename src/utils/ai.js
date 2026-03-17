function extractJsonCandidate(text = '') {
  const trimmed = String(text).replace(/```json|```/gi, '').trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function parseModelJson(text) {
  const candidate = extractJsonCandidate(text);
  return JSON.parse(candidate);
}

function coerceAnalyzeResponse(parsed = {}) {
  return {
    verdict: ['Strong Fit', 'Potential Fit', 'Weak Fit', 'Not Recommended'].includes(parsed.verdict) ? parsed.verdict : 'Potential Fit',
    verdict_reason: String(parsed.verdict_reason || 'Analysis generated successfully.'),
    win_probability: Math.max(1, Math.min(100, Number(parsed.win_probability) || 50)),
    estimated_value_analysis: String(parsed.estimated_value_analysis || ''),
    key_requirements: Array.isArray(parsed.key_requirements) ? parsed.key_requirements.slice(0, 5).map(String) : [],
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 4).map(String) : [],
    risks: Array.isArray(parsed.risks) ? parsed.risks.slice(0, 4).map(String) : [],
    new_firm_assessment: String(parsed.new_firm_assessment || ''),
    next_steps: Array.isArray(parsed.next_steps) ? parsed.next_steps.slice(0, 3).map(String) : [],
    teaming_suggestion: parsed.teaming_suggestion == null ? null : String(parsed.teaming_suggestion),
  };
}

function coerceScoreResponse(parsed = {}) {
  const allowedGrades = ['A', 'B', 'C', 'D', 'F'];
  return {
    overall_score: Math.max(0, Math.min(100, Number(parsed.overall_score) || 0)),
    grade: allowedGrades.includes(parsed.grade) ? parsed.grade : 'C',
    summary: String(parsed.summary || ''),
    dimensions: Array.isArray(parsed.dimensions)
      ? parsed.dimensions.slice(0, 5).map((d) => ({
          name: String(d?.name || 'Dimension'),
          score: Math.max(0, Math.min(100, Number(d?.score) || 0)),
          feedback: String(d?.feedback || ''),
        }))
      : [],
    critical_fixes: Array.isArray(parsed.critical_fixes) ? parsed.critical_fixes.slice(0, 5).map(String) : [],
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 3).map(String) : [],
    submission_ready: Boolean(parsed.submission_ready),
  };
}

module.exports = { parseModelJson, coerceAnalyzeResponse, coerceScoreResponse };
