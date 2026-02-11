/**
 * Tolerant JSON parser for LLM output.
 * Handles markdown fences, surrounding text, and trailing commas.
 */
function safeJsonParse(raw) {
  const text = String(raw || '').trim();

  // Strip markdown fences if present
  const unfenced = text
    .replace(/```json\s*/gi, '```')
    .replace(/```/g, '')
    .trim();

  // Try direct parse first (fast path)
  try { return JSON.parse(unfenced); } catch {}

  // Extract first JSON object block
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in model response');
  }

  let candidate = unfenced.slice(start, end + 1);

  // Remove trailing commas before } or ]
  candidate = candidate.replace(/,\s*([}\]])/g, '$1');

  return JSON.parse(candidate);
}

module.exports = { safeJsonParse };
