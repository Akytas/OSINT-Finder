const { computeImageFingerprintFromUrl, splitHashSegments } = require('../utils/imageHash');
const { extractTextFromImage } = require('../utils/ocr');
const { isValidUrl } = require('../utils/url');
const pLimit = require('p-limit');

function toStringOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toNullableString(value) {
  const text = toStringOrEmpty(value);
  return text || null;
}

function toSimilarity(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0.5;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

function extractDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname || '';
  } catch {
    return '';
  }
}

function toIsoTimestamp(value) {
  const text = toStringOrEmpty(value);
  if (!text) return null;

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function toDimension(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const int = Math.floor(num);
  return int > 0 ? int : null;
}

function isTestRuntime() {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'test') return true;
  if (Array.isArray(process.argv) && process.argv.includes('--test')) return true;
  return Array.isArray(process.execArgv) && process.execArgv.includes('--test');
}

async function normalizeItem(sourceName, rawItem, options = {}) {
  if (!rawItem || typeof rawItem !== 'object') return null;

  const source = toStringOrEmpty(sourceName) || toStringOrEmpty(rawItem.source) || 'unknown';
  const title =
    toStringOrEmpty(rawItem.title) ||
    toStringOrEmpty(rawItem.name) ||
    toStringOrEmpty(rawItem.label) ||
    toStringOrEmpty(rawItem.source) ||
    source;

  const url = toStringOrEmpty(rawItem.url) || toStringOrEmpty(rawItem.link);
  if (!url) return null;
  if (!isValidUrl(url)) return null;

  const thumbnail = toNullableString(rawItem.thumbnail) || toNullableString(rawItem.image);
  const similarity = toSimilarity(rawItem.similarity);
  const domain = extractDomain(url);
  let hash = toNullableString(rawItem.hash);
  let hashSegments = Array.isArray(rawItem.hashSegments)
    ? rawItem.hashSegments.map((segment) => toStringOrEmpty(segment)).filter(Boolean)
    : [];
  let imageWidth = toDimension(rawItem.imageWidth || rawItem.width);
  let imageHeight = toDimension(rawItem.imageHeight || rawItem.height);
  let detectedText = toNullableString(rawItem.detectedText);
  const timestamp = toIsoTimestamp(rawItem.timestamp) || new Date().toISOString();
  let ocrConfidence = Number.isFinite(Number(rawItem.ocrConfidence))
    ? Math.max(0, Math.min(1, Number(rawItem.ocrConfidence)))
    : 0;

  const ocrTarget =
    thumbnail || toNullableString(rawItem.imageUrl) || toNullableString(rawItem.image);
  const shouldComputeHash = !hash && thumbnail && options.computeImageHash !== false;
  const shouldComputeOcr =
    options.computeOcr === true || (options.computeOcr !== false && !isTestRuntime());
  const extractTextFn =
    typeof options.extractTextFn === 'function' ? options.extractTextFn : extractTextFromImage;
  const runImageTask =
    typeof options.imageTaskLimiter === 'function'
      ? (task) => options.imageTaskLimiter(task)
      : (task) => task();

  const [fingerprintResult, ocrResult] = await Promise.all([
    shouldComputeHash
      ? runImageTask(() =>
          computeImageFingerprintFromUrl(thumbnail, {
            timeoutMs: options.hashTimeoutMs,
            fetchFn: options.fetchFn,
            disableDelay: options.disableDelay
          })
        ).catch(() => null)
      : Promise.resolve(null),
    !detectedText && ocrTarget && shouldComputeOcr
      ? runImageTask(() =>
          extractTextFn(ocrTarget, {
            timeoutMs: options.ocrTimeoutMs,
            lang: options.ocrLang
          })
        ).catch(() => null)
      : Promise.resolve(null)
  ]);

  if (shouldComputeHash) {
    if (fingerprintResult) {
      hash = toNullableString(fingerprintResult && fingerprintResult.hash);
      imageWidth = toDimension(fingerprintResult && fingerprintResult.width);
      imageHeight = toDimension(fingerprintResult && fingerprintResult.height);
      hashSegments = Array.isArray(fingerprintResult && fingerprintResult.segments)
        ? fingerprintResult.segments.map((segment) => toStringOrEmpty(segment)).filter(Boolean)
        : [];
    } else {
      hash = null;
    }
  }

  if (!hashSegments.length && hash) {
    hashSegments = splitHashSegments(hash);
  }

  if (!detectedText && ocrTarget && shouldComputeOcr) {
    if (ocrResult) {
      detectedText = toNullableString(ocrResult && ocrResult.text);
      const confidenceValue = Number(ocrResult && ocrResult.confidence);
      ocrConfidence = Number.isFinite(confidenceValue)
        ? Math.max(0, Math.min(1, confidenceValue))
        : 0;
    } else {
      detectedText = null;
      ocrConfidence = 0;
    }
  }

  return {
    source,
    title,
    url,
    thumbnail,
    similarity,
    domain,
    hash,
    hashSegments,
    imageWidth,
    imageHeight,
    timestamp,
    detectedText,
    ocrConfidence
  };
}

async function normalize(rawResults, options = {}) {
  const list = Array.isArray(rawResults) ? rawResults : [];
  const tasks = [];
  const configuredImageTaskConcurrency = Number(options.imageTaskConcurrency);
  const imageTaskLimiter =
    typeof options.imageTaskLimiter === 'function'
      ? options.imageTaskLimiter
      : Number.isFinite(configuredImageTaskConcurrency) && configuredImageTaskConcurrency > 0
        ? pLimit(Math.max(1, Math.floor(configuredImageTaskConcurrency)))
        : null;
  const normalizedOptions = imageTaskLimiter
    ? {
        ...options,
        imageTaskLimiter
      }
    : options;

  list.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;

    const sourceName = toStringOrEmpty(entry.source);
    const items = Array.isArray(entry.items) ? entry.items : [];

    items.forEach((item) => {
      tasks.push(normalizeItem(sourceName, item, normalizedOptions));
    });
  });

  const normalizedItems = await Promise.all(tasks);
  return normalizedItems.filter(Boolean);
}

module.exports = normalize;
