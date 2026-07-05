const { requestWithRetry } = require('../utils/request');

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_ITEMS = 10;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRisk(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'LOW' || normalized === 'MEDIUM' || normalized === 'HIGH') {
    return normalized;
  }
  return 'MEDIUM';
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toAiSummary(item) {
  return {
    url: item && item.url ? item.url : '',
    title: item && item.title ? item.title : '',
    score: Number(item && item.score) || 0,
    confidenceLevel: String(item && item.confidenceLevel || ''),
    manipulated: Boolean(item && item.manipulated),
    sources: asArray(item && item.sources),
    domains: asArray(item && item.domains),
    detectedText: String(item && item.detectedText || '').slice(0, 500),
    logicAnalysis: item && item.logicAnalysis ? item.logicAnalysis : null
  };
}

function normalizeAiResult(raw) {
  const data = raw && typeof raw === 'object'
    ? (raw.result && typeof raw.result === 'object' ? raw.result : raw)
    : {};

  return {
    conclusion: String(data.conclusion || 'Uncertain').trim() || 'Uncertain',
    reasoning: String(data.reasoning || 'AI analysis did not return reasoning.').trim(),
    risk: normalizeRisk(data.risk)
  };
}

async function callAiApi(item, options = {}) {
  const apiUrl = String(options.apiUrl || '').trim();
  const apiKey = String(options.apiKey || '').trim();
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;

  const payload = {
    instruction: 'Analyze OSINT result summary and return strict JSON: {"conclusion":"Likely authentic|Uncertain|Possibly manipulated","reasoning":"...","risk":"LOW|MEDIUM|HIGH"}.',
    item: toAiSummary(item)
  };

  const headers = {
    'content-type': 'application/json'
  };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const response = await requestWithRetry(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    timeoutMs,
    maxRetries: 1,
    serviceName: 'AI analysis API'
  });

  if (!response || !response.ok) {
    throw new Error(`AI analysis API failed with status ${response ? response.status : 'unknown'}`);
  }

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    const body = await response.json();
    return normalizeAiResult(body);
  }

  const text = await response.text();
  const parsed = parseJsonSafe(text);
  if (parsed) {
    return normalizeAiResult(parsed);
  }

  return {
    conclusion: 'Uncertain',
    reasoning: text.slice(0, 800) || 'AI response was not JSON.',
    risk: 'MEDIUM'
  };
}

async function enrichItemsWithAiAnalysis(items, options = {}) {
  const list = asArray(items);
  const enabled = options.enabled === true;
  const apiUrl = String(options.apiUrl || '').trim();

  if (!enabled || !apiUrl) {
    return list;
  }

  const maxItems = Math.max(1, Number(options.maxItems) || DEFAULT_MAX_ITEMS);
  const result = [];

  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];

    if (i >= maxItems) {
      result.push({
        ...item,
        aiAnalysis: {
          conclusion: 'Uncertain',
          reasoning: 'AI analysis skipped due to maxItems limit.',
          risk: 'MEDIUM'
        }
      });
      continue;
    }

    try {
      const aiAnalysis = await callAiApi(item, options);
      result.push({
        ...item,
        aiAnalysis
      });
    } catch (error) {
      result.push({
        ...item,
        aiAnalysis: {
          conclusion: 'Uncertain',
          reasoning: `AI analysis unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`,
          risk: 'MEDIUM'
        }
      });
    }
  }

  return result;
}

module.exports = {
  enrichItemsWithAiAnalysis
};
