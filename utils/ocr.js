const Tesseract = require('tesseract.js');

const DEFAULT_TIMEOUT_MS = 15000;

function isTestRuntime() {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'test') return true;
  if (Array.isArray(process.argv) && process.argv.includes('--test')) return true;
  return Array.isArray(process.execArgv) && process.execArgv.includes('--test');
}

function isOcrEnabled() {
  return String(process.env.OSINT_ENABLE_OCR || '0') === '1';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function extractTextFromImage(imageUrl, options = {}) {
  if (!isOcrEnabled() || isTestRuntime()) {
    return { text: '', confidence: 0 };
  }

  const targetUrl = toText(imageUrl);
  if (!targetUrl) {
    return { text: '', confidence: 0 };
  }

  const lang = toText(options.lang) || 'eng';
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Number(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;

  const timeoutPromise = new Promise((_, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      reject(new Error(`OCR timeout after ${timeoutMs} ms.`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      Tesseract.recognize(targetUrl, lang),
      timeoutPromise
    ]);

    const text = toText(result && result.data ? result.data.text : '');
    const confidenceRaw = Number(result && result.data ? result.data.confidence : 0);
    const confidence = Number.isFinite(confidenceRaw)
      ? clamp(Number((confidenceRaw / 100).toFixed(4)), 0, 1)
      : 0;

    return {
      text,
      confidence
    };
  } catch {
    return {
      text: '',
      confidence: 0
    };
  }
}

module.exports = {
  extractTextFromImage
};
