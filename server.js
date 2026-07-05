require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { createClient } = require('redis');
const pLimit = require('p-limit');
const crypto = require('crypto');
const fsNative = require('fs');
const fs = require('fs/promises');
const path = require('path');
const exifr = require('exifr');
const Jimp = require('jimp');
const pino = require('pino');
const { runImageSearch } = require('./services/imageSearchService');
const { detectManipulation } = require('./core/manipulationDetector');
const { buildEvidence } = require('./core/evidenceBuilder');
const { buildForensicReport, buildForensicReportJson } = require('./core/reportGenerator');
const { generateVerdict } = require('./core/verdict');
const {
  calculateScore,
  decorateResultWithAnalysisScore,
  filterProviderItems
} = require('./services/scoringService');
const {
  pickPrimaryDomain,
  buildEnrichmentMap,
  buildClusters
} = require('./services/analysisService');
const { requestWithRetry, createCookieJar } = require('./utils/request');
const {
  groupByDomain,
  findMostFrequentMatches,
  normalizeUrl,
  extractDomainFromUrl
} = require('./utils/resultAnalysis');

const googleProvider = require('./providers/google');

const app = express();
const port = process.env.PORT || 8787;
const IS_NODE_TEST_RUNTIME =
  String(process.env.NODE_ENV || '').toLowerCase() === 'test' ||
  (Array.isArray(process.argv) && process.argv.includes('--test')) ||
  (Array.isArray(process.execArgv) && process.execArgv.includes('--test'));
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 10000);
const DEFAULT_MIN_SCORE_THRESHOLD = Number(process.env.MIN_SCORE_THRESHOLD || 30);
const AI_ENABLED = process.env.AI === 'true';
const AI_ANALYSIS_ENABLED = String(process.env.OSINT_ENABLE_AI_ANALYSIS || '0') === '1';
const OCR_ENABLED = String(process.env.OSINT_ENABLE_OCR || '0') === '1';
const AI_ANALYSIS_API_URL = String(process.env.OSINT_AI_ANALYSIS_API_URL || '').trim();
const AI_ANALYSIS_API_KEY = String(process.env.OSINT_AI_ANALYSIS_API_KEY || '').trim();
const AI_ANALYSIS_TIMEOUT_MS = Number(process.env.OSINT_AI_ANALYSIS_TIMEOUT_MS || 8000);
let SAFE_MODE = String(process.env.SAFE_MODE || 'false').toLowerCase() === 'true';
const OSINT_MAX_CONCURRENCY = Number(process.env.OSINT_MAX_CONCURRENCY || 0);
const DETERMINISTIC_TESTS = String(process.env.OSINT_DETERMINISTIC_TESTS || '0') === '1';
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 50);
const RATE_LIMIT_PREFIX = process.env.RATE_LIMIT_PREFIX || 'osint:rl:';
const LOG_LEVEL = String(
  process.env.LOG_LEVEL || (IS_NODE_TEST_RUNTIME ? 'fatal' : 'info')
).toLowerCase();
const LOG_TO_FILE = String(process.env.LOG_TO_FILE || (IS_NODE_TEST_RUNTIME ? '0' : '1')) === '1';
const DATA_PATH = process.env.DATA_PATH || './data';
const DATA_DIR = path.resolve(__dirname, DATA_PATH);
const APP_LOG_PATH = path.join(DATA_DIR, 'app.log');
const LOG_FILE_PATH = String(process.env.LOG_FILE_PATH || path.join(DATA_DIR, 'debug.log'));
const ENABLE_STEALTH = String(process.env.OSINT_USE_PUPPETEER_STEALTH || '0') === '1';
const GLOBAL_COOKIE_JAR = createCookieJar();
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SPAM_DOMAIN_PATTERNS = [
  /(^|\.)spam/i,
  /(^|\.)clickbait/i,
  /(^|\.)ad[sx]?\b/i,
  /(^|\.)tracker/i,
  /(^|\.)affiliate/i,
  /(^|\.)seo-/i,
  /(^|\.)junk/i,
  /(^|\.)fake/i
];
const EXPORTS_DIR = path.join(DATA_DIR, 'exports');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

try {
  fsNative.mkdirSync(DATA_DIR, { recursive: true });
  fsNative.mkdirSync(UPLOADS_DIR, { recursive: true });
} catch {
  // Folder creation fallback handled by multer on first write.
}

const LOG_LEVEL_WEIGHT = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

let redisClient = null;
const loggerStreams = [{ stream: process.stdout }];
if (LOG_TO_FILE) {
  try {
    loggerStreams.push({
      stream: pino.destination({
        dest: LOG_FILE_PATH,
        mkdir: true,
        sync: false
      })
    });
  } catch {
    // Fallback to console-only logging if file destination cannot be created.
  }
}

const logger = pino(
  {
    level: LOG_LEVEL,
    base: {
      service: 'osint-finder-image-backend'
    },
    timestamp: pino.stdTimeFunctions.isoTime
  },
  pino.multistream(loggerStreams)
);

function logEvent(level, event, meta) {
  const method =
    typeof logger[level] === 'function' ? logger[level].bind(logger) : logger.info.bind(logger);
  method({
    event,
    ...meta
  });
}

function appendPortableLog(message) {
  try {
    fsNative.appendFileSync(APP_LOG_PATH, message, 'utf8');
  } catch {
    // Keep startup resilient even when portable log file cannot be written.
  }
}

function serializeProcessError(errorLike) {
  if (errorLike instanceof Error) {
    return {
      message: errorLike.message,
      stack: errorLike.stack || ''
    };
  }

  return {
    message: String(errorLike || 'Neznámá chyba procesu'),
    stack: ''
  };
}

function registerProcessErrorHandlers() {
  process.on('unhandledRejection', (reason) => {
    const parsed = serializeProcessError(reason);
    logEvent('error', 'process_unhandled_rejection', {
      error: parsed.message,
      stack: parsed.stack
    });
  });

  process.on('uncaughtException', (error) => {
    const parsed = serializeProcessError(error);
    logEvent('error', 'process_uncaught_exception', {
      error: parsed.message,
      stack: parsed.stack
    });

    if (!IS_NODE_TEST_RUNTIME) {
      setTimeout(() => {
        process.exit(1);
      }, 10).unref();
    }
  });
}

function makeRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toErrorMessage(error, fallback = 'Neznámá chyba') {
  return error instanceof Error ? error.message : fallback;
}

function isNodeTestRuntime() {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'test') return true;
  if (Array.isArray(process.argv) && process.argv.includes('--test')) return true;
  return Array.isArray(process.execArgv) && process.execArgv.includes('--test');
}

function sanitizeCaseExportFilename(fileName) {
  const requested = String(fileName || '').trim();
  if (!requested) {
    return `case-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  }

  const base = path
    .basename(requested)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_');

  if (!base.endsWith('.json')) {
    return `${base}.json`;
  }

  return base;
}

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  const requestId = makeRequestId();

  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logEvent(level, 'http_request', {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      ip: req.ip
    });
  });

  next();
});

function buildRateLimiterStore() {
  const redisUrl = String(process.env.REDIS_URL || '').trim();
  if (!redisUrl) return null;

  try {
    redisClient = createClient({ url: redisUrl });
    redisClient.connect().catch((error) => {
      logEvent('warn', 'redis_connect_warning', {
        error: error.message,
        redisUrl: redisUrl.replace(/:\/\/[^@]+@/, '://***@')
      });
    });

    return new RedisStore({
      prefix: RATE_LIMIT_PREFIX,
      sendCommand: (...args) => redisClient.sendCommand(args)
    });
  } catch (error) {
    logEvent('warn', 'redis_rate_limit_store_disabled', {
      error: error.message,
      redisUrl: redisUrl.replace(/:\/\/[^@]+@/, '://***@')
    });
    return null;
  }
}

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/app.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.js'));
});

app.get('/style.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'style.css'));
});

const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildRateLimiterStore() || undefined,
  handler: (req, res) => {
    logEvent('warn', 'rate_limit_exceeded', {
      requestId: req.requestId || null,
      ip: req.ip,
      method: req.method,
      path: req.path,
      max: RATE_LIMIT_MAX,
      windowMs: RATE_LIMIT_WINDOW_MS
    });

    res.status(429).json({
      error: 'Byl překročen limit požadavků pro API.',
      details: `Maximálně ${RATE_LIMIT_MAX} požadavků za ${(RATE_LIMIT_WINDOW_MS / 60000).toFixed(0)} minut na jednu IP adresu.`
    });
  }
});

app.use('/api', apiLimiter);

function sanitizeUploadBaseName(fileName) {
  return (
    String(fileName || 'image')
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_{2,}/g, '_')
      .slice(0, 80) || 'image'
  );
}

function buildUploadTempFileName(originalName) {
  const cleaned = sanitizeUploadBaseName(originalName);
  const ext = path.extname(cleaned).slice(0, 10) || '.img';
  const randomSuffix = crypto.randomBytes(6).toString('hex');
  return `${Date.now()}-${randomSuffix}${ext}`;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, buildUploadTempFileName(file && file.originalname))
  }),
  limits: {
    fileSize: 12 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
      return;
    }

    const err = new Error('Nepovolený typ souboru. Povolen je pouze JPEG, PNG nebo WEBP.');
    err.code = 'UNSUPPORTED_FILE_TYPE';
    cb(err);
  }
});

function decodePlus(value) {
  return String(value || '').replace(/\+/g, ' ');
}

function normalizeTerm(value) {
  return String(value || '')
    .replace(/["'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUsername(value) {
  return normalizeTerm(value).replace(/^@+/, '').toLowerCase();
}

function normalizeEmail(value) {
  return normalizeTerm(value).toLowerCase();
}

function normalizeDomain(value) {
  const raw = normalizeTerm(value).toLowerCase();
  if (!raw) return '';

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    return String(parsed.hostname || '')
      .replace(/^www\./i, '')
      .trim();
  } catch {
    return raw
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .trim();
  }
}

function isValidUsername(value) {
  return /^[a-z0-9._-]{2,64}$/i.test(String(value || '').trim());
}

function buildUsernameResults(username) {
  const encoded = encodeURIComponent(username);
  return [
    { source: 'Google', url: `https://www.google.com/search?q=${encoded}` },
    { source: 'Bing', url: `https://www.bing.com/search?q=${encoded}` },
    { source: 'X / Twitter', url: `https://x.com/${encoded}` },
    { source: 'Instagram', url: `https://www.instagram.com/${encoded}` },
    { source: 'GitHub', url: `https://github.com/${encoded}` },
    { source: 'Reddit', url: `https://www.reddit.com/search/?q=${encoded}` }
  ];
}

function buildEmailResults(email) {
  const encoded = encodeURIComponent(email);
  const domain = normalizeDomain(email.split('@')[1] || '');
  return [
    { source: 'Google', url: `https://www.google.com/search?q=${encoded}` },
    { source: 'HaveIBeenPwned', url: `https://haveibeenpwned.com/account/${encoded}` },
    { source: 'Hunter', url: `https://hunter.io/email-verifier/${encoded}` },
    {
      source: 'Domain search',
      url: `https://www.google.com/search?q=${encodeURIComponent(domain || email)}`
    }
  ];
}

function buildDomainResults(domain) {
  const encoded = encodeURIComponent(domain);
  return [
    { source: 'WHOIS', url: `https://www.whois.com/whois/${encoded}` },
    { source: 'DNS checker', url: `https://dnschecker.org/#A/${encoded}` },
    { source: 'VirusTotal', url: `https://www.virustotal.com/gui/domain/${encoded}` },
    { source: 'Google', url: `https://www.google.com/search?q=${encoded}` }
  ];
}

function isUsefulCandidate(term) {
  if (!term) return false;
  if (term.length < 3) return false;
  if (/^https?:\/\//i.test(term)) return false;
  if (/^[\d\W_]+$/.test(term)) return false;
  return true;
}

function parseHints(rawHints) {
  if (!rawHints) return [];

  return normalizeTerm(decodePlus(rawHints))
    .split(/[;,]/)
    .map((part) => normalizeTerm(part))
    .filter(Boolean);
}

function uniqueCandidates(list) {
  const uniq = [];
  const seen = new Set();

  (Array.isArray(list) ? list : []).forEach((term) => {
    const normalized = normalizeTerm(term);
    if (!isUsefulCandidate(normalized)) return;

    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    uniq.push(normalized);
  });

  return uniq;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidDomain(value) {
  return /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value);
}

function normalizeVerificationTerms(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();

  return source
    .map((term) => normalizeTerm(term).toLowerCase())
    .map((term) => term.replace(/[^\p{L}\p{N}_@.+-]/gu, '').trim())
    .filter((term) => term.length >= 3)
    .filter((term) => {
      if (seen.has(term)) return false;
      seen.add(term);
      return true;
    })
    .slice(0, 12);
}

function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bitmapLumaAt(bitmap, x, y) {
  const clampedX = Math.max(0, Math.min(bitmap.width - 1, x));
  const clampedY = Math.max(0, Math.min(bitmap.height - 1, y));
  const index = (clampedY * bitmap.width + clampedX) * 4;
  const r = bitmap.data[index] || 0;
  const g = bitmap.data[index + 1] || 0;
  const b = bitmap.data[index + 2] || 0;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function bitsToHex(bits) {
  const padded = bits.padEnd(Math.ceil(bits.length / 4) * 4, '0');
  let hex = '';

  for (let i = 0; i < padded.length; i += 4) {
    hex += Number.parseInt(padded.slice(i, i + 4), 2).toString(16);
  }

  return hex;
}

function computeCompactPerceptualHash(bitmap, targetSize = 8) {
  if (!bitmap || !bitmap.width || !bitmap.height || !bitmap.data) return '';

  const values = [];
  for (let y = 0; y < targetSize; y += 1) {
    const srcY = Math.floor(((y + 0.5) * bitmap.height) / targetSize);
    for (let x = 0; x < targetSize; x += 1) {
      const srcX = Math.floor(((x + 0.5) * bitmap.width) / targetSize);
      values.push(bitmapLumaAt(bitmap, srcX, srcY));
    }
  }

  const avg = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const bits = values.map((value) => (value >= avg ? '1' : '0')).join('');
  return bitsToHex(bits);
}

function hashFileWithAlgorithm(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fsNative.createReadStream(filePath);

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function fileToBlob(file) {
  const mimeType = file && file.mimetype ? file.mimetype : 'application/octet-stream';

  if (file && file.path && typeof fsNative.openAsBlob === 'function') {
    return fsNative.openAsBlob(file.path, { type: mimeType });
  }

  if (file && file.buffer) {
    return new Blob([file.buffer], { type: mimeType });
  }

  if (file && file.path) {
    const buffer = await fs.readFile(file.path);
    return new Blob([buffer], { type: mimeType });
  }

  throw new Error('Chybí data souboru pro vytvoření blobu.');
}

async function cleanupUploadedFile(file, requestId) {
  const filePath = file && typeof file.path === 'string' ? file.path : '';
  if (!filePath) return;

  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      logEvent('debug', 'upload_temp_cleanup_failed', {
        requestId,
        filePath,
        error: toErrorMessage(error)
      });
    }
  }
}

async function verifySingleLinkMatch(link, terms, requestId) {
  const label = normalizeTerm(link && link.label);
  const url = normalizeTerm(link && link.url);
  if (!label || !url) return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!/^https?:$/i.test(parsed.protocol)) {
    return null;
  }

  try {
    const response = await requestWithRetry(url, {
      timeoutMs: 7000,
      maxRetries: 1,
      serviceName: `verify-link ${label}`,
      cookieJar: GLOBAL_COOKIE_JAR,
      onFailure: ({ error, status, attempt }) => {
        if (attempt >= 2) {
          logEvent('debug', 'verify_link_failed', {
            requestId,
            label,
            url,
            status: Number.isFinite(Number(status)) ? Number(status) : null,
            error
          });
        }
      }
    });

    if (!response || !response.ok) {
      return null;
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!/html|text|json|xml/.test(contentType)) {
      return null;
    }

    const body = await response.text();
    const normalizedBody = String(body || '').toLowerCase();
    const matchedTerms = (Array.isArray(terms) ? terms : [])
      .map((term) => normalizeTerm(term).toLowerCase())
      .filter((term) => term && normalizedBody.includes(term));

    if (!matchedTerms.length) {
      return null;
    }

    const matchScore = Math.round((matchedTerms.length / Math.max(1, terms.length)) * 100);
    return {
      ...link,
      label,
      url,
      matchScore,
      matchedTerms
    };
  } catch (error) {
    logEvent('debug', 'verify_link_error', {
      requestId,
      label,
      url,
      error: toErrorMessage(error)
    });
    return null;
  }
}

function sourceReputationWeight(source) {
  const value = String(source || '').toLowerCase();
  if (!value) return 0.55;
  if (/google|bing|duckduckgo|startpage|qwant|seznam|yandex|yahoo/.test(value)) return 0.85;
  if (/whois|virustotal|dns|interpol|europol|fbi|ofac|sanctions/.test(value)) return 0.8;
  if (/github|gitlab|reddit|linkedin|twitter|x\s*\//.test(value)) return 0.72;
  return 0.62;
}

function normalizedMatchSignal(query, url, source) {
  const terms = normalizeTerm(query)
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length >= 2);
  if (!terms.length) return 0.5;

  const haystack = `${url || ''} ${source || ''}`.toLowerCase();
  const matchedTerms = terms.filter((term) => haystack.includes(term));
  return Math.max(0, Math.min(1, matchedTerms.length / terms.length));
}

function buildResultExplanation(item) {
  const sourceCount = Number(item && item.sourceCount) || 0;
  const score = Number(item && (item.qualityScore ?? item.score)) || 0;
  const domain = String(item && item.domain ? item.domain : '').trim() || 'neznamy web';
  return `${score}% relevance | ${sourceCount} zdroju | ${domain}`;
}

function buildRuntimeStrategyInfo() {
  return {
    antiBot: {
      headerRotation: true,
      cookieJar: true,
      proxyRotation: true,
      stealthBrowserEnabled: ENABLE_STEALTH
    },
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
    deterministicTests: DETERMINISTIC_TESTS,
    aiAnalysisEnabled: AI_ANALYSIS_ENABLED,
    ocrEnabled: OCR_ENABLED,
    stealthBrowserEnabled: ENABLE_STEALTH
  };
}

function decorateOsintLinks(links, query) {
  return (Array.isArray(links) ? links : []).map((item) => {
    const source = normalizeTerm(item && item.source);
    const url = normalizeTerm(item && item.url);
    const domain = extractDomainFromUrl(url);
    const matchSignal = normalizedMatchSignal(query, url, source);
    const reputation = sourceReputationWeight(source);
    const qualityScore = Math.round((reputation * 0.7 + matchSignal * 0.3) * 100);

    const base = {
      source,
      url,
      title: source,
      domain,
      sources: source ? [source] : [],
      similarityAvg: matchSignal,
      qualityScore
    };

    return {
      ...item,
      ...base,
      ...calculateScore(base)
    };
  });
}

function buildUnifiedOsintPayload(queryType, query, links, metadata = {}) {
  const results = decorateOsintLinks(links, query);
  return {
    queryType,
    query,
    results,
    analysis: {
      byDomain: groupByDomain(results),
      frequentMatches: findMostFrequentMatches(results)
    },
    metadata: {
      ...metadata,
      ...buildRuntimeStrategyInfo()
    }
  };
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = FETCH_TIMEOUT_MS,
  serviceName = 'Externi sluzba'
) {
  const isGoogleResultPage = /Google result page/i.test(serviceName);
  const useStealthBrowser = ENABLE_STEALTH && isGoogleResultPage;

  try {
    return await requestWithRetry(url, {
      ...options,
      timeoutMs,
      maxRetries: DETERMINISTIC_TESTS ? 0 : 2,
      disableDelay: DETERMINISTIC_TESTS,
      serviceName,
      cookieJar: GLOBAL_COOKIE_JAR,
      useStealthBrowser,
      onFailure: (meta) => {
        logEvent('warn', 'external_request_failed', {
          requestId: null,
          serviceName,
          url,
          attempt: meta.attempt,
          maxRetries: meta.maxRetries,
          status: meta.status || null,
          final: Boolean(meta.final),
          error: meta.error || 'požadavek selhal'
        });
      },
      onBlocked: (meta) => {
        logEvent('warn', 'external_request_blocked', {
          requestId: null,
          serviceName,
          url,
          status: meta.status,
          attempt: meta.attempt,
          maxRetries: meta.maxRetries,
          proxyUrl: meta.proxyUrl || null
        });
      }
    });
  } catch (error) {
    throw new Error(toErrorMessage(error, `${serviceName}: požadavek selhal.`));
  }
}

async function uploadTo0x0(file) {
  const form = new FormData();
  const blob = await fileToBlob(file);
  form.append('file', blob, file.originalname || 'image.jpg');

  const response = await fetchWithTimeout(
    'https://0x0.st',
    {
      method: 'POST',
      body: form
    },
    FETCH_TIMEOUT_MS,
    '0x0.st upload'
  );

  if (!response.ok) {
    throw new Error(`Nahrání na 0x0.st selhalo (stav ${response.status}).`);
  }

  const text = (await response.text()).trim();
  if (!/^https?:\/\//i.test(text)) {
    throw new Error('0x0.st nevrátil validní URL.');
  }

  return text;
}

async function uploadToCatbox(file) {
  const form = new FormData();
  const blob = await fileToBlob(file);
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', blob, file.originalname || 'image.jpg');

  const response = await fetchWithTimeout(
    'https://catbox.moe/user/api.php',
    {
      method: 'POST',
      body: form
    },
    FETCH_TIMEOUT_MS,
    'catbox.moe upload'
  );

  if (!response.ok) {
    throw new Error(`Nahrání na catbox.moe selhalo (stav ${response.status}).`);
  }

  const text = (await response.text()).trim();
  if (!/^https?:\/\//i.test(text)) {
    throw new Error('catbox.moe nevrátil validní URL.');
  }

  return text;
}

async function uploadToTemporaryHost(file) {
  const providers = [
    {
      name: 'catbox.moe',
      run: () => uploadToCatbox(file)
    },
    {
      name: '0x0.st',
      run: () => uploadTo0x0(file)
    }
  ];

  const tasks = providers.map(({ name, run }) =>
    run()
      .then((url) => ({ url, provider: name }))
      .catch((error) => {
        throw new Error(`${name}: ${error instanceof Error ? error.message : 'nahrání selhalo'}`);
      })
  );

  try {
    return await Promise.any(tasks);
  } catch (aggregateError) {
    const details = (
      aggregateError && Array.isArray(aggregateError.errors) ? aggregateError.errors : []
    )
      .map((err) => (err instanceof Error ? err.message : String(err || 'Neznámá chyba nahrání')))
      .filter(Boolean);
    throw new Error(`Upload selhal na všech službách: ${details.join(' | ')}`);
  }
}

async function computeImageMeta(file) {
  const filePath = file && typeof file.path === 'string' ? file.path : '';
  const sha256 = filePath
    ? await hashFileWithAlgorithm(filePath, 'sha256')
    : crypto.createHash('sha256').update(file.buffer).digest('hex');
  const md5 = filePath
    ? await hashFileWithAlgorithm(filePath, 'md5')
    : crypto.createHash('md5').update(file.buffer).digest('hex');

  let perceptualHash = '';
  try {
    const imageInput = filePath || file.buffer;
    const image = await Jimp.read(imageInput);
    perceptualHash = computeCompactPerceptualHash(image && image.bitmap ? image.bitmap : null);
  } catch {
    perceptualHash = '';
  }

  let exif = null;
  try {
    const parsed = await exifr.parse(filePath || file.buffer, {
      gps: true,
      tiff: true,
      exif: true
    });

    if (parsed) {
      const lat = typeof parsed.latitude === 'number' ? parsed.latitude : null;
      const lon = typeof parsed.longitude === 'number' ? parsed.longitude : null;

      exif = {
        hasExif: true,
        dateTimeOriginal: parsed.DateTimeOriginal || parsed.CreateDate || null,
        model: parsed.Model || null,
        make: parsed.Make || null,
        software: parsed.Software || null,
        gps: lat !== null && lon !== null ? { lat, lon } : null
      };
    }
  } catch {
    exif = null;
  }

  const geoLinks = exif && exif.gps ? buildGeoLinks(exif.gps.lat, exif.gps.lon) : [];

  return {
    hashes: {
      sha256,
      md5,
      perceptualHash
    },
    exif: exif || { hasExif: false },
    geoLinks
  };
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'osint-finder-image-backend',
    safeMode: SAFE_MODE
  });
});

app.get('/api/safe-mode', (req, res) => {
  res.json({
    ok: true,
    safeMode: SAFE_MODE
  });
});

app.post('/api/safe-mode', (req, res) => {
  const next = req.body && typeof req.body === 'object' ? req.body.enabled : undefined;

  if (typeof next !== 'boolean') {
    res.status(400).json({
      error: 'Neplatna hodnota safe mode.',
      details: 'Poslete JSON objekt s polem enabled: true|false.'
    });
    return;
  }

  SAFE_MODE = next;
  logEvent('info', 'safe_mode_toggled', {
    requestId: req.requestId || null,
    safeMode: SAFE_MODE
  });

  res.json({
    ok: true,
    safeMode: SAFE_MODE
  });
});

app.post('/api/case/export', async (req, res) => {
  const requestId = req.requestId || null;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const caseBundle =
    body.caseBundle && typeof body.caseBundle === 'object' ? body.caseBundle : null;

  if (!caseBundle) {
    res.status(400).json({
      error: 'Chybí data pro export spisu.',
      details: 'Pošlete JSON objekt v poli caseBundle.'
    });
    return;
  }

  const fileName = sanitizeCaseExportFilename(body.fileName);
  const absolutePath = path.join(EXPORTS_DIR, fileName);

  try {
    await fs.mkdir(EXPORTS_DIR, { recursive: true });
    await fs.writeFile(absolutePath, `${JSON.stringify(caseBundle, null, 2)}\n`, 'utf8');

    logEvent('info', 'case_export_saved', {
      requestId,
      fileName,
      relativePath: `data/exports/${fileName}`
    });

    res.json({
      ok: true,
      fileName,
      relativePath: `data/exports/${fileName}`
    });
  } catch (error) {
    logEvent('error', 'case_export_failed', {
      requestId,
      fileName,
      error: toErrorMessage(error)
    });

    res.status(500).json({
      error: 'Export spisu selhal.',
      details: toErrorMessage(error)
    });
  }
});

app.post('/api/username-search', (req, res) => {
  const requestId = req.requestId || null;
  const username = normalizeUsername(req.body && req.body.username);

  if (!username || !isValidUsername(username)) {
    logEvent('warn', 'username_search_invalid_input', {
      requestId,
      usernameLength: username.length
    });
    res.status(400).json({
      error: 'Neplatné uživatelské jméno.',
      details: 'Použijte username 2-64 znaků: písmena, čísla, tečka, podtržítko nebo pomlčka.'
    });
    return;
  }

  const results = buildUsernameResults(username);
  logEvent('info', 'username_search_success', {
    requestId,
    username,
    resultCount: results.length
  });

  res.json({
    ...buildUnifiedOsintPayload('username', username, results, {
      normalizedUsername: username
    })
  });
});

app.post('/api/email-osint', (req, res) => {
  const requestId = req.requestId || null;
  const email = normalizeEmail(req.body && req.body.email);

  if (!email || !isValidEmail(email)) {
    logEvent('warn', 'email_osint_invalid_input', { requestId, emailLength: email.length });
    res.status(400).json({
      error: 'Neplatný e-mail.',
      details: 'Použijte validní e-mail ve formátu uzivatel@domena.tld.'
    });
    return;
  }

  const domain = email.split('@')[1] || '';
  const results = buildEmailResults(email);

  logEvent('info', 'email_osint_success', {
    requestId,
    domain,
    resultCount: results.length
  });

  res.json({
    ...buildUnifiedOsintPayload('email', email, results, {
      domain,
      md5: crypto.createHash('md5').update(email).digest('hex')
    })
  });
});

app.post('/api/domain-intel', (req, res) => {
  const requestId = req.requestId || null;
  const domain = normalizeDomain(req.body && req.body.domain);

  if (!domain || !isValidDomain(domain)) {
    logEvent('warn', 'domain_intel_invalid_input', { requestId, domainLength: domain.length });
    res.status(400).json({
      error: 'Neplatná doména.',
      details: 'Použijte validní doménu, např. example.com.'
    });
    return;
  }

  const results = buildDomainResults(domain);

  logEvent('info', 'domain_intel_success', {
    requestId,
    domain,
    resultCount: results.length
  });

  res.json({
    ...buildUnifiedOsintPayload('domain', domain, results, {
      domain
    })
  });
});

app.post('/api/verify-links', async (req, res) => {
  const requestId = req.requestId || null;
  const terms = normalizeVerificationTerms(req.body && req.body.queryTerms);
  const links = Array.isArray(req.body && req.body.links) ? req.body.links : [];

  if (!terms.length) {
    res.status(400).json({
      error: 'Chybí ověřovací výrazy.',
      details: 'Pošlete queryTerms jako pole klíčových slov (min. délka 3).'
    });
    return;
  }

  if (!links.length) {
    res.json({
      queryTerms: terms,
      checkedCount: 0,
      resultCount: 0,
      results: []
    });
    return;
  }

  const cappedLinks = links.slice(0, 35);
  const verifyConcurrencyRaw = Number(process.env.VERIFY_LINKS_CONCURRENCY || 6);
  const verifyConcurrency = Number.isFinite(verifyConcurrencyRaw)
    ? Math.min(12, Math.max(1, Math.round(verifyConcurrencyRaw)))
    : 6;

  const limiter = pLimit(verifyConcurrency);
  const settled = await Promise.allSettled(
    cappedLinks.map((link) => limiter(() => verifySingleLinkMatch(link, terms, requestId)))
  );

  const verified = settled
    .map((result) => (result.status === 'fulfilled' ? result.value : null))
    .filter(Boolean);

  verified.sort((a, b) => b.matchScore - a.matchScore || a.label.localeCompare(b.label));

  logEvent('info', 'verify_links_completed', {
    requestId,
    checkedCount: cappedLinks.length,
    resultCount: verified.length,
    termCount: terms.length,
    verifyConcurrency
  });

  res.json({
    queryTerms: terms,
    checkedCount: cappedLinks.length,
    resultCount: verified.length,
    results: verified
  });
});

app.post('/api/metadata-extract', upload.single('image'), async (req, res) => {
  const requestId = req.requestId || null;

  if (!req.file) {
    logEvent('warn', 'metadata_extract_missing_file', {
      requestId,
      contentType: req.headers['content-type'] || ''
    });

    res.status(400).json({
      error: 'Chybí soubor obrázku. Pošlete multipart/form-data s polem image.'
    });
    return;
  }

  try {
    const imageMeta = await computeImageMeta(req.file);

    logEvent('info', 'metadata_extract_success', {
      requestId,
      fileName: req.file.originalname || 'neznámé',
      mimeType: req.file.mimetype || 'neznámý',
      fileSize: req.file.size || 0,
      hasExif: Boolean(imageMeta.exif && imageMeta.exif.hasExif),
      hasGeoLinks: Array.isArray(imageMeta.geoLinks) && imageMeta.geoLinks.length > 0
    });

    res.json({
      queryType: 'metadata-extract',
      fileName: req.file.originalname || 'neznámé',
      mimeType: req.file.mimetype || 'neznámý',
      size: req.file.size || 0,
      results: [],
      analysis: {
        byDomain: [],
        frequentMatches: {
          duplicateUrls: [],
          duplicateHashes: [],
          duplicateTexts: []
        }
      },
      hashes: imageMeta.hashes,
      exif: imageMeta.exif,
      geoLinks: imageMeta.geoLinks,
      metadata: buildRuntimeStrategyInfo()
    });
  } catch (error) {
    logEvent('error', 'metadata_extract_failed', {
      requestId,
      error: toErrorMessage(error)
    });

    res.status(502).json({
      error: 'Extrakce metadat selhala.',
      details: toErrorMessage(error)
    });
  } finally {
    await cleanupUploadedFile(req.file, requestId);
  }
});

app.post('/api/reverse-image', upload.single('image'), async (req, res) => {
  const requestId = req.requestId || null;
  const requestStartedAt = process.hrtime.bigint();
  const forensicMode = String((req.body && req.body.mode) || '').toLowerCase() === 'forensic';

  if (!req.file) {
    logEvent('warn', 'reverse_image_missing_file', {
      requestId,
      contentType: req.headers['content-type'] || ''
    });

    res.status(400).json({
      error: 'Chybí soubor obrázku. Pošlete multipart/form-data s polem image.'
    });
    return;
  }

  logEvent('info', 'reverse_image_start', {
    requestId,
    fileName: req.file.originalname || 'neznámé',
    mimeType: req.file.mimetype || 'neznámý',
    fileSize: req.file.size || 0
  });

  try {
    const warnings = [];
    const imageMetaStartedAt = process.hrtime.bigint();
    const imageMeta = await computeImageMeta(req.file);
    logEvent('info', 'reverse_image_perf_image_meta', {
      requestId,
      durationMs: Number((Number(process.hrtime.bigint() - imageMetaStartedAt) / 1e6).toFixed(2)),
      hasExif: Boolean(imageMeta.exif && imageMeta.exif.hasExif),
      hasGeoLinks: Array.isArray(imageMeta.geoLinks) && imageMeta.geoLinks.length > 0
    });
    let providerRawResults = [];
    let providerNormalizedResults = [];
    let providerAggregatedResults = [];
    let providerScoredResults = [];
    let sourceRunMeta = [];
    let providerMetrics = null;

    let publicImageUrl = '';
    let publicImageProvider = '';

    if (SAFE_MODE) {
      const safeModeMessage = 'SAFE_MODE aktivni: upload na docasne externe hostingy je zakazan.';
      warnings.push(safeModeMessage);
      logEvent('warn', 'provider_upload_blocked_safe_mode', {
        requestId,
        provider: 'temporary-hosts'
      });
    } else {
      const uploadStartedAt = Date.now();
      try {
        const hosted = await uploadToTemporaryHost(req.file);
        publicImageUrl = hosted.url;
        publicImageProvider = hosted.provider;

        logEvent('info', 'provider_upload_success', {
          requestId,
          provider: publicImageProvider,
          durationMs: Date.now() - uploadStartedAt
        });
      } catch (error) {
        const message = toErrorMessage(error, 'Nahrání na dočasný hosting selhalo.');
        warnings.push(message);
        logEvent('warn', 'provider_upload_failed', {
          requestId,
          provider: 'temporary-hosts',
          durationMs: Date.now() - uploadStartedAt,
          error: message
        });
      }
    }

    const hints = parseHints(req.body && req.body.hints);
    const results = [];
    let clusters = [];
    let analysis = {
      byDomain: [],
      frequentMatches: {
        duplicateUrls: [],
        duplicateHashes: [],
        duplicateTexts: []
      }
    };
    let fromUrl = [];
    let fromHtml = [];

    if (publicImageUrl) {
      results.push({ source: `Dočasná URL obrázku (${publicImageProvider})`, url: publicImageUrl });

      const providerSearchStartedAt = process.hrtime.bigint();
      const providerLookup = await runImageSearch({
        payload: { imageUrl: publicImageUrl },
        options: {
          mode: forensicMode ? 'forensic' : 'standard',
          timeoutMs: FETCH_TIMEOUT_MS,
          maxConcurrency:
            Number.isFinite(OSINT_MAX_CONCURRENCY) && OSINT_MAX_CONCURRENCY > 0
              ? OSINT_MAX_CONCURRENCY
              : undefined,
          normalizerOptions: {
            computeOcr: OCR_ENABLED && !isNodeTestRuntime()
          },
          aiAnalysis: {
            enabled: AI_ANALYSIS_ENABLED && Boolean(AI_ANALYSIS_API_URL),
            apiUrl: AI_ANALYSIS_API_URL,
            apiKey: AI_ANALYSIS_API_KEY,
            timeoutMs: AI_ANALYSIS_TIMEOUT_MS
          },
          onSourceError: ({ source, error }) => {
            warnings.push(`provider_${source}: ${error}`);
          },
          onExecutionMetrics: (metrics) => {
            providerMetrics = metrics;
          }
        }
      });
      if (!providerMetrics && providerLookup && providerLookup.providerMetrics) {
        providerMetrics = providerLookup.providerMetrics;
      }
      logEvent('info', 'reverse_image_perf_provider_search', {
        requestId,
        durationMs: Number(
          (Number(process.hrtime.bigint() - providerSearchStartedAt) / 1e6).toFixed(2)
        ),
        rawResultCount: Array.isArray(providerLookup.rawResults)
          ? providerLookup.rawResults.length
          : 0,
        normalizedResultCount: Array.isArray(providerLookup.normalizedResults)
          ? providerLookup.normalizedResults.length
          : 0,
        scoredResultCount: Array.isArray(providerLookup.scoredResults)
          ? providerLookup.scoredResults.length
          : 0,
        providerDurationMs:
          providerMetrics && Number.isFinite(Number(providerMetrics.durationMs))
            ? Number(providerMetrics.durationMs)
            : null,
        providerFulfilledCount:
          providerMetrics && Number.isFinite(Number(providerMetrics.fulfilledCount))
            ? Number(providerMetrics.fulfilledCount)
            : null,
        providerRejectedCount:
          providerMetrics && Number.isFinite(Number(providerMetrics.rejectedCount))
            ? Number(providerMetrics.rejectedCount)
            : null
      });

      providerRawResults = providerLookup.rawResults;
      providerNormalizedResults = providerLookup.normalizedResults;
      providerAggregatedResults = Array.isArray(providerLookup.aggregatedResults)
        ? providerLookup.aggregatedResults
        : [];
      providerScoredResults = Array.isArray(providerLookup.scoredResults)
        ? providerLookup.scoredResults
        : [];
      sourceRunMeta = Array.isArray(providerLookup.sourceRunMeta)
        ? providerLookup.sourceRunMeta
        : [];

      const scoredOrNormalized = providerScoredResults.length
        ? providerScoredResults.map((item) => {
            const topText =
              Array.isArray(item.detectedTexts) && item.detectedTexts.length
                ? item.detectedTexts[0]
                : null;
            const sources = Array.isArray(item.sources) ? item.sources.filter(Boolean) : [];
            const domain = pickPrimaryDomain(item);
            const normalizedItem = {
              url: item.url,
              title: item.title || (sources.length ? sources.join(', ') : 'Výsledek poskytovatele'),
              score: Number.isFinite(Number(item.score)) ? Number(item.score) : 0,
              qualityScore: Number.isFinite(Number(item.score)) ? Number(item.score) : 0,
              confidenceLevel: item.confidenceLevel || 'LOW',
              occurrences: Number.isFinite(Number(item.occurrences)) ? Number(item.occurrences) : 1,
              sources,
              domain,
              domains: Array.isArray(item && item.domains)
                ? item.domains.filter(Boolean)
                : domain
                  ? [domain]
                  : [],
              hashSimilarity: Number.isFinite(Number(item && item.hashSimilarity))
                ? Number(item.hashSimilarity)
                : undefined,
              hashes: Array.isArray(item && item.hash)
                ? item.hash
                : Array.isArray(item && item.hashes)
                  ? item.hashes
                  : [],
              similarityAvg: Number.isFinite(Number(item.similarityAvg))
                ? Number(item.similarityAvg)
                : 0,
              detectedText: topText && typeof topText.text === 'string' ? topText.text : '',
              manipulated: Boolean(item.manipulated)
            };

            return {
              ...normalizedItem,
              ...calculateScore(normalizedItem),
              source: normalizedItem.title,
              textRepeatScore: Number.isFinite(Number(item.textRepeatScore))
                ? Number(item.textRepeatScore)
                : 0,
              manipulationReasons: Array.isArray(
                item && item.manipulation && item.manipulation.reasons
              )
                ? item.manipulation.reasons
                : [],
              ocrConfidence:
                topText && Number.isFinite(Number(topText.confidence))
                  ? Number(topText.confidence)
                  : 0,
              explanation: buildResultExplanation(normalizedItem),
              confidence: Number.isFinite(Number(item.confidence))
                ? Number(item.confidence)
                : undefined,
              confidencePercent: Number.isFinite(Number(item.confidencePercent))
                ? Number(item.confidencePercent)
                : undefined,
              confidenceLabel:
                typeof item.confidenceLabel === 'string' ? item.confidenceLabel : undefined,
              scoreBreakdown:
                item && item.scoreBreakdown && typeof item.scoreBreakdown === 'object'
                  ? item.scoreBreakdown
                  : undefined,
              logicAnalysis:
                item && item.logicAnalysis && typeof item.logicAnalysis === 'object'
                  ? item.logicAnalysis
                  : undefined,
              aiAnalysis:
                item && item.aiAnalysis && typeof item.aiAnalysis === 'object'
                  ? item.aiAnalysis
                  : undefined
            };
          })
        : providerNormalizedResults.map((item) => {
            const sourceName = item.title || item.source || 'Výsledek poskytovatele';
            const domain = pickPrimaryDomain(item);
            const fallbackScore = Number.isFinite(Number(item.similarity))
              ? Math.round(Math.max(0, Math.min(1, Number(item.similarity))) * 100)
              : 0;

            const normalizedItem = {
              url: item.url,
              title: sourceName,
              score: fallbackScore,
              qualityScore: fallbackScore,
              confidenceLevel: 'LOW',
              occurrences: 1,
              sources: sourceName ? [sourceName] : [],
              domain,
              domains: domain ? [domain] : [],
              similarityAvg: Number.isFinite(Number(item.similarity)) ? Number(item.similarity) : 0,
              detectedText: item.detectedText || '',
              manipulated: false
            };

            return {
              ...normalizedItem,
              ...calculateScore(normalizedItem),
              source: normalizedItem.title,
              textRepeatScore: 0,
              manipulationReasons: [],
              ocrConfidence: Number.isFinite(Number(item.ocrConfidence))
                ? Number(item.ocrConfidence)
                : 0,
              explanation: buildResultExplanation(normalizedItem)
            };
          });

      const minThreshold = forensicMode ? -1 : DEFAULT_MIN_SCORE_THRESHOLD;
      const filteredProvider = filterProviderItems(scoredOrNormalized, minThreshold);
      const filteredProviderItems = filteredProvider.items;
      logEvent('info', 'reverse_image_filter_stats', {
        requestId,
        threshold: minThreshold,
        ...filteredProvider.stats,
        keptCount: filteredProviderItems.length,
        blockedCount: Math.max(0, filteredProvider.stats.inputCount - filteredProviderItems.length)
      });
      results.push(...filteredProviderItems);

      const enrichmentMap = buildEnrichmentMap(providerScoredResults, providerNormalizedResults);
      clusters = buildClusters(filteredProviderItems, enrichmentMap);

      analysis = {
        byDomain: groupByDomain(filteredProviderItems),
        frequentMatches: findMostFrequentMatches(filteredProviderItems)
      };

      results.push(...imageMeta.geoLinks);
    }

    const googleStartedAt = Date.now();
    try {
      const googleResult = await googleProvider.uploadImageAndGetResultUrl(
        req.file,
        fetchWithTimeout,
        FETCH_TIMEOUT_MS
      );
      results.push({ source: 'Google reverzní vyhledávání (nahrání)', url: googleResult });
      fromUrl = googleProvider.extractCandidatesFromResultUrl(googleResult);
      fromHtml = await googleProvider.extractCandidatesFromResultHtml(
        googleResult,
        fetchWithTimeout,
        FETCH_TIMEOUT_MS
      );

      logEvent('info', 'provider_google_success', {
        requestId,
        durationMs: Date.now() - googleStartedAt,
        candidateCount: [...fromUrl, ...fromHtml].length
      });
    } catch (error) {
      const message = toErrorMessage(error, 'Google reverzní nahrání obrázku selhalo.');
      warnings.push(message);
      logEvent('warn', 'provider_google_failed', {
        requestId,
        durationMs: Date.now() - googleStartedAt,
        error: message
      });
    }

    const candidates = uniqueCandidates([...hints, ...fromUrl, ...fromHtml]);

    if (!results.length) {
      logEvent('warn', 'reverse_image_no_results', {
        requestId,
        warningCount: warnings.length,
        candidateCount: candidates.length
      });

      res.status(502).json({
        error: 'Reverzní vyhledávání obrázků selhalo.',
        details: 'Nepodařilo se získat výsledky z externích služeb.',
        warnings,
        hashes: imageMeta.hashes,
        exif: imageMeta.exif,
        geoLinks: imageMeta.geoLinks
      });
      return;
    }

    const scoredResults = results.map(decorateResultWithAnalysisScore);
    const forensicResults = forensicMode
      ? scoredResults.map((item) => {
          if (!item || typeof item !== 'object') return item;
          const manipulation = detectManipulation(item);
          return {
            ...item,
            manipulation
          };
        })
      : scoredResults;

    const verdict = generateVerdict(forensicResults);

    const evidence = forensicMode ? buildEvidence(forensicResults) : [];
    const forensicReport = forensicMode
      ? buildForensicReport({
          results: forensicResults,
          analysis,
          candidates,
          warnings,
          hashes: imageMeta.hashes,
          exif: imageMeta.exif
        })
      : null;

    logEvent('info', 'reverse_image_perf_total', {
      requestId,
      durationMs: Number((Number(process.hrtime.bigint() - requestStartedAt) / 1e6).toFixed(2)),
      resultCount: forensicResults.length,
      warningCount: warnings.length,
      providerRejectedCount:
        providerMetrics && Number.isFinite(Number(providerMetrics.rejectedCount))
          ? Number(providerMetrics.rejectedCount)
          : null
    });

    res.json({
      queryType: 'image-upload',
      mode: forensicMode ? 'forensic' : 'standard',
      results: forensicResults,
      verdict,
      candidates,
      warnings,
      providerRawResults,
      providerNormalizedResults,
      providerAggregatedResults,
      providerScoredResults,
      sourceRunMeta,
      providerMetrics,
      clusters,
      analysis,
      evidence,
      report: forensicReport,
      hashes: imageMeta.hashes,
      exif: imageMeta.exif,
      geoLinks: imageMeta.geoLinks
    });

    logEvent('info', 'reverse_image_success', {
      requestId,
      resultCount: results.length,
      candidateCount: candidates.length,
      warningCount: warnings.length,
      hasGeoLinks: imageMeta.geoLinks.length > 0
    });
  } catch (error) {
    logEvent('error', 'reverse_image_failed', {
      requestId,
      error: toErrorMessage(error)
    });

    res.status(502).json({
      error: 'Reverzní vyhledávání obrázků selhalo.',
      details: toErrorMessage(error)
    });
  } finally {
    await cleanupUploadedFile(req.file, requestId);
  }
});

app.post('/api/report-generate', async (req, res) => {
  const requestId = req.requestId || null;
  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const report = buildForensicReportJson(payload);
    res.json(report);
  } catch (error) {
    logEvent('error', 'report_generate_failed', {
      requestId,
      error: toErrorMessage(error)
    });

    res.status(400).json({
      error: 'Generování forenzní zprávy selhalo.',
      details: toErrorMessage(error)
    });
  }
});

app.use((err, req, res, next) => {
  const requestId = req.requestId || null;

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      logEvent('warn', 'upload_limit_exceeded', {
        requestId,
        errorCode: err.code
      });

      res.status(400).json({
        error: 'Soubor je příliš velký. Maximální velikost je 12 MB.'
      });
      return;
    }

    logEvent('warn', 'upload_multer_error', {
      requestId,
      errorCode: err.code,
      error: err.message
    });

    res.status(400).json({
      error: 'Nahrání souboru selhalo.',
      details: err.message
    });
    return;
  }

  if (err && err.code === 'UNSUPPORTED_FILE_TYPE') {
    logEvent('warn', 'upload_unsupported_type', {
      requestId,
      error: err.message
    });

    res.status(400).json({
      error: err.message
    });
    return;
  }

  logEvent('error', 'unhandled_error', {
    requestId,
    error: toErrorMessage(err)
  });

  next(err);
});

function startServer(listenPort = port) {
  const server = app.listen(listenPort, () => {
    appendPortableLog(`Start aplikace (${new Date().toISOString()})\n`);
    logger.info({
      event: 'server_listening',
      port: listenPort,
      url: `http://localhost:${listenPort}`
    });
  });

  server.on('close', () => {
    if (redisClient && typeof redisClient.quit === 'function') {
      redisClient.quit().catch(() => {});
    }
  });

  return server;
}

if (require.main === module) {
  registerProcessErrorHandlers();
  startServer();
}

module.exports = {
  app,
  startServer,
  config: {
    FETCH_TIMEOUT_MS,
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX
  }
};
