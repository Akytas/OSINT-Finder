const sources = require('./sources');
const normalizeResults = require('./normalizer');
const aggregateResults = require('./aggregator');
const scoreItems = require('./scorer');
const { analyzeItemsLogical } = require('./analysisEngine');
const { enrichItemsWithAiAnalysis } = require('./aiAnalysis');
const pLimit = require('p-limit');

const MIN_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 12000;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_CONCURRENCY = 3;
const MAX_CONCURRENCY_LIMIT = 10;
const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SOURCE_RETRIES = 1;
const SOURCE_FAILURE_THRESHOLD = 3;
const SOURCE_DISABLE_MS = 5 * 60 * 1000;

const detailedSearchCache = new Map();
const sourceRuntimeState = new Map();

function isTestRuntime() {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'test') return true;
  if (Array.isArray(process.argv) && process.argv.includes('--test')) return true;
  return Array.isArray(process.execArgv) && process.execArgv.includes('--test');
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

function normalizeTimeout(timeoutMs) {
  const value = Number(timeoutMs);
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)));
}

function normalizeConcurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_MAX_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY_LIMIT, Math.floor(num)));
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const keys = Object.keys(value).sort();
  const body = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',');
  return `{${body}}`;
}

function cloneJsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeSourceRetries(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_SOURCE_RETRIES;
  return Math.max(0, Math.min(3, Math.floor(num)));
}

function isForensicMode(options = {}) {
  return String((options && options.mode) || '').toLowerCase() === 'forensic';
}

function getSourceState(sourceName) {
  const key = String(sourceName || 'unknown');
  const existing = sourceRuntimeState.get(key);
  if (existing) return existing;

  const fresh = {
    consecutiveFailures: 0,
    disabledUntil: 0,
    lastError: ''
  };
  sourceRuntimeState.set(key, fresh);
  return fresh;
}

function isSourceDisabled(sourceName, now = Date.now()) {
  if (isTestRuntime()) return false;
  const state = getSourceState(sourceName);
  return state.disabledUntil > now;
}

function markSourceSuccess(sourceName) {
  const state = getSourceState(sourceName);
  state.consecutiveFailures = 0;
  state.disabledUntil = 0;
  state.lastError = '';
}

function markSourceFailure(sourceName, errorMessage, now = Date.now()) {
  const state = getSourceState(sourceName);
  if (isTestRuntime()) {
    state.lastError = String(errorMessage || 'Unknown error');
    return state;
  }

  state.consecutiveFailures += 1;
  state.lastError = String(errorMessage || 'Unknown error');

  if (state.consecutiveFailures >= SOURCE_FAILURE_THRESHOLD) {
    state.disabledUntil = now + SOURCE_DISABLE_MS;
  }

  return state;
}

function cleanupDetailedCache(now = Date.now()) {
  detailedSearchCache.forEach((entry, key) => {
    if (!entry || entry.expiresAt <= now) {
      detailedSearchCache.delete(key);
    }
  });
}

function buildDetailedCacheKey(input, options = {}) {
  return stableStringify({
    input,
    mode: options.mode || 'standard',
    normalizerOptions: options.normalizerOptions || {},
    aggregatorOptions: options.aggregatorOptions || {},
    scorerOptions: options.scorerOptions || {},
    aiAnalysis: {
      enabled: Boolean(options.aiAnalysis && options.aiAnalysis.enabled),
      apiUrl: String((options.aiAnalysis && options.aiAnalysis.apiUrl) || ''),
      maxItems: Number(options.aiAnalysis && options.aiAnalysis.maxItems) || 0
    }
  });
}

function validateSourceResult(name, result) {
  if (!result || typeof result !== 'object') {
    throw new Error(`Source ${name} returned invalid result.`);
  }

  const sourceName =
    typeof result.source === 'string' && result.source.trim() ? result.source.trim() : name;

  return {
    source: sourceName,
    items: Array.isArray(result.items) ? result.items : []
  };
}

async function runWithTimeout(source, input, timeoutMs, parentSignal, contextExtras = {}) {
  const controller = new AbortController();
  const { signal } = controller;

  let onParentAbort = null;
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      onParentAbort = () => controller.abort();
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  let timerId;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      controller.abort();
      reject(new Error(`Source timeout after ${timeoutMs} ms.`));
    }, timeoutMs);
  });

  const sourcePromise = Promise.resolve().then(() =>
    source.run(input, {
      signal,
      timeoutMs,
      ...contextExtras
    })
  );

  try {
    const result = await Promise.race([sourcePromise, timeoutPromise]);
    return validateSourceResult(source.name || 'unknown', result);
  } finally {
    clearTimeout(timerId);
    if (parentSignal && onParentAbort) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

async function runSourceWithFallback(source, input, options = {}) {
  const sourceName = source && source.name ? source.name : 'unknown';
  const forensicMode = isForensicMode(options);
  const timeoutMs = normalizeTimeout(
    forensicMode
      ? Math.max(Number(options.timeoutMs || DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS + 2000)
      : options.timeoutMs
  );
  const retries = forensicMode
    ? Math.max(2, normalizeSourceRetries(options.sourceRetries))
    : normalizeSourceRetries(options.sourceRetries);

  const now = Date.now();
  if (!forensicMode && isSourceDisabled(sourceName, now)) {
    const state = getSourceState(sourceName);
    const untilIso = new Date(state.disabledUntil).toISOString();
    throw new Error(`Source temporarily disabled until ${untilIso}.`);
  }

  let proxyUrl = typeof options.proxyUrl === 'string' ? options.proxyUrl : '';

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await runWithTimeout(
        source,
        input,
        timeoutMs,
        options.signal,
        proxyUrl ? { proxyUrl } : {}
      );
      markSourceSuccess(sourceName);
      return result;
    } catch (error) {
      const message = toErrorMessage(error);
      console.error('Source failed:', sourceName, message);

      const state = markSourceFailure(sourceName, message);
      if (typeof options.onSourceFallback === 'function') {
        options.onSourceFallback({
          source: sourceName,
          attempt: attempt + 1,
          maxAttempts: retries + 1,
          error: message,
          strategy: attempt < retries ? 'retry' : 'disable',
          disabledUntil: state.disabledUntil || null
        });
      }

      if (attempt >= retries) {
        throw error;
      }

      if (typeof options.nextProxy === 'function') {
        try {
          const nextProxyValue = options.nextProxy({
            source: sourceName,
            attempt: attempt + 1,
            previousProxy: proxyUrl,
            error: message
          });
          proxyUrl = typeof nextProxyValue === 'string' ? nextProxyValue : proxyUrl;
        } catch {
          // Keep previous proxy when rotation callback fails.
        }
      }
    }
  }

  throw new Error(`Source ${sourceName} failed after retries.`);
}

async function executeRawSearch(input, options = {}) {
  const startedPerf = Date.now();
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const concurrency = normalizeConcurrency(options.maxConcurrency);
  const sourceList = Object.values(sources).filter(
    (src) => src && typeof src.name === 'string' && typeof src.run === 'function'
  );

  const limit = pLimit(concurrency);
  const sourceRunMeta = [];
  const settled = await Promise.allSettled(
    sourceList.map((src) =>
      limit(async () => {
        const startedAt = new Date().toISOString();
        const startedPerf = Date.now();
        try {
          const result = await runSourceWithFallback(src, input, {
            timeoutMs,
            signal: options.signal,
            sourceRetries: options.sourceRetries,
            nextProxy: options.nextProxy,
            proxyUrl: options.proxyUrl,
            onSourceFallback: options.onSourceFallback,
            mode: options.mode
          });
          sourceRunMeta.push({
            source: src && src.name ? src.name : 'unknown',
            startedAt,
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - startedPerf,
            success: true,
            itemCount: Array.isArray(result && result.items) ? result.items.length : 0
          });
          return result;
        } catch (error) {
          sourceRunMeta.push({
            source: src && src.name ? src.name : 'unknown',
            startedAt,
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - startedPerf,
            success: false,
            error: toErrorMessage(error)
          });
          throw error;
        }
      })
    )
  );

  const rawResults = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      rawResults.push(result.value);
      return;
    }

    const sourceName =
      sourceList[index] && sourceList[index].name ? sourceList[index].name : `source_${index}`;
    if (typeof options.onSourceError === 'function') {
      options.onSourceError({
        source: sourceName,
        error: toErrorMessage(result.reason)
      });
    }
  });

  const fulfilledCount = settled.filter((result) => result.status === 'fulfilled').length;
  const rejectedCount = settled.length - fulfilledCount;
  const providerMetrics = {
    totalSources: sourceList.length,
    fulfilledCount,
    rejectedCount,
    durationMs: Date.now() - startedPerf
  };

  if (typeof options.onExecutionMetrics === 'function') {
    options.onExecutionMetrics(providerMetrics);
  }

  return {
    rawResults,
    sourceRunMeta,
    providerMetrics
  };
}

async function runSearch(input, options = {}) {
  const executed = await executeRawSearch(input, options);
  return executed.rawResults;
}

async function runSearchNormalized(input, options = {}) {
  const executed = await executeRawSearch(input, options);
  const rawResults = executed.rawResults;
  return normalizeResults(rawResults, options.normalizerOptions || {});
}

async function runSearchDetailed(input, options = {}) {
  const now = Date.now();
  cleanupDetailedCache(now);

  if (options.useCache !== false) {
    const cacheKey = buildDetailedCacheKey(input, options);
    const cached = detailedSearchCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cloneJsonSafe(cached.value);
    }
  }

  const executed = await executeRawSearch(input, options);
  const rawResults = executed.rawResults;
  const normalizedResults = await normalizeResults(rawResults, options.normalizerOptions || {});
  const aggregatedResults = aggregateResults(normalizedResults, options.aggregatorOptions || {});
  const scoredResultsRaw = scoreItems(aggregatedResults, {
    ...(options.scorerOptions || {}),
    mode: options.mode
  });
  const scoredResultsWithLogic = analyzeItemsLogical(scoredResultsRaw);
  const scoredResults = await enrichItemsWithAiAnalysis(
    scoredResultsWithLogic,
    options.aiAnalysis || {}
  );

  const detailed = {
    rawResults,
    normalizedResults,
    aggregatedResults,
    scoredResults,
    sourceRunMeta: Array.isArray(executed.sourceRunMeta) ? executed.sourceRunMeta : [],
    providerMetrics: executed.providerMetrics || null
  };

  if (options.useCache !== false) {
    const cacheKey = buildDetailedCacheKey(input, options);
    detailedSearchCache.set(cacheKey, {
      createdAt: now,
      expiresAt: now + CACHE_TTL_MS,
      value: cloneJsonSafe(detailed)
    });
  }

  return detailed;
}

module.exports = {
  runSearch,
  runSearchNormalized,
  runSearchDetailed,
  constants: {
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_CONCURRENCY,
    CACHE_TTL_MS,
    DEFAULT_SOURCE_RETRIES,
    SOURCE_FAILURE_THRESHOLD,
    SOURCE_DISABLE_MS
  }
};
