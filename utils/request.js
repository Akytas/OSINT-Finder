const dns = require('dns');
const net = require('net');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MIN_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 3000;
const USE_PROXY = String(process.env.USE_PROXY || '').toLowerCase() === 'true';
const DEFAULT_PROXY_LIST = String(process.env.OSINT_PROXY_LIST || '');
const DEFAULT_IP_ALLOW_LIST = String(
  process.env.OSINT_IP_ALLOWLIST || process.env.OSINT_IP_WHITELIST || ''
);
const DEFAULT_IP_BLOCK_LIST = String(
  process.env.OSINT_IP_BLOCKLIST || process.env.OSINT_IP_BLACKLIST || ''
);
const DEFAULT_BLOCKED_STATUSES = new Set([403, 429, 503]);

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0'
];

let userAgentIndex = Math.floor(Math.random() * USER_AGENTS.length);
let headerProfileIndex = Math.floor(Math.random() * 1000);
let delayQueue = Promise.resolve();
let nextAllowedAt = 0;
let nextProxyIndex = Math.floor(Math.random() * 1000);

let ProxyAgentCtor = null;
try {
  ({ ProxyAgent: ProxyAgentCtor } = require('undici'));
} catch {
  ProxyAgentCtor = null;
}

const proxyAgentCache = new Map();

class SimpleCookieJar {
  constructor() {
    this.store = new Map();
  }

  _getDomainStore(hostname) {
    const key = String(hostname || '')
      .toLowerCase()
      .trim();
    if (!key) return null;
    if (!this.store.has(key)) {
      this.store.set(key, new Map());
    }
    return this.store.get(key);
  }

  setCookie(url, rawCookie) {
    let hostname = '';
    try {
      hostname = new URL(url).hostname;
    } catch {
      hostname = '';
    }

    const domainStore = this._getDomainStore(hostname);
    if (!domainStore) return;

    const firstPart = String(rawCookie || '').split(';')[0] || '';
    const eqIndex = firstPart.indexOf('=');
    if (eqIndex <= 0) return;

    const name = firstPart.slice(0, eqIndex).trim();
    const value = firstPart.slice(eqIndex + 1).trim();
    if (!name) return;

    domainStore.set(name, value);
  }

  storeFromResponse(url, response) {
    if (!response || !response.headers) return;

    const getSetCookie =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie.bind(response.headers)
        : null;

    const setCookies = getSetCookie
      ? getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);

    setCookies.forEach((raw) => {
      this.setCookie(url, raw);
    });
  }

  getCookieHeader(url) {
    let hostname = '';
    try {
      hostname = new URL(url).hostname;
    } catch {
      hostname = '';
    }

    const domainStore = this._getDomainStore(hostname);
    if (!domainStore || domainStore.size === 0) return '';

    return Array.from(domainStore.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
}

const globalCookieJar = new SimpleCookieJar();

const HEADER_PROFILES = [
  {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,cs;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none'
  },
  {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'cs-CZ,cs;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'max-age=0',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none'
  },
  {
    Accept: 'application/json,text/plain,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin'
  }
];

function isTestRuntime() {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'test') return true;
  return process.argv.includes('--test');
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

function toInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function random(min, max) {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function jitter(minDelayMs, maxDelayMs, signal) {
  const delayMs = random(minDelayMs, maxDelayMs);
  return wait(delayMs, signal);
}

function wait(ms, signal) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    let onAbort = null;
    if (signal && typeof signal.addEventListener === 'function') {
      onAbort = () => {
        clearTimeout(id);
        reject(Object.assign(new Error('Request aborted.'), { name: 'AbortError' }));
      };

      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}

function nextUserAgent() {
  if (USER_AGENTS.length <= 1) {
    return USER_AGENTS[0] || 'Mozilla/5.0';
  }

  let nextIndex = userAgentIndex;
  while (nextIndex === userAgentIndex) {
    nextIndex = Math.floor(Math.random() * USER_AGENTS.length);
  }

  userAgentIndex = nextIndex;
  return USER_AGENTS[userAgentIndex];
}

function nextHeaderProfile() {
  if (HEADER_PROFILES.length <= 1) {
    return HEADER_PROFILES[0] || {};
  }

  const index = Math.abs(headerProfileIndex) % HEADER_PROFILES.length;
  headerProfileIndex += 1;
  return HEADER_PROFILES[index];
}

function parseProxyList(rawValue) {
  if (!rawValue) return [];
  return String(rawValue)
    .split(/[;,\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function resolveProxyRotationList(options = {}) {
  if (Array.isArray(options.proxyList)) {
    return options.proxyList.map((value) => String(value || '').trim()).filter(Boolean);
  }

  if (typeof options.proxyList === 'string') {
    return parseProxyList(options.proxyList);
  }

  return parseProxyList(DEFAULT_PROXY_LIST);
}

function pickInitialProxy(proxyList) {
  if (!Array.isArray(proxyList) || proxyList.length === 0) return '';
  const index = Math.abs(nextProxyIndex) % proxyList.length;
  nextProxyIndex += 1;
  return proxyList[index] || '';
}

function rotateProxyFromPool(proxyList, previousProxy) {
  if (!Array.isArray(proxyList) || proxyList.length === 0) return '';
  if (proxyList.length === 1) return proxyList[0];

  const normalizedPrev = String(previousProxy || '').trim();
  for (let guard = 0; guard < proxyList.length; guard += 1) {
    const candidate = pickInitialProxy(proxyList);
    if (candidate && candidate !== normalizedPrev) {
      return candidate;
    }
  }

  return proxyList[0];
}

function getProxyDispatcher(proxyUrl) {
  const normalized = String(proxyUrl || '').trim();
  if (!normalized || !ProxyAgentCtor) return null;

  const existing = proxyAgentCache.get(normalized);
  if (existing) return existing;

  const created = new ProxyAgentCtor(normalized);
  proxyAgentCache.set(normalized, created);
  return created;
}

function createFetchInitFromOptions(options = {}) {
  const init = {};
  const passThroughKeys = [
    'method',
    'body',
    'redirect',
    'cache',
    'credentials',
    'integrity',
    'keepalive',
    'mode',
    'priority',
    'referrer',
    'referrerPolicy',
    'duplex'
  ];

  passThroughKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(options, key)) {
      init[key] = options[key];
    }
  });

  return init;
}

async function applyInterRequestDelay(options = {}) {
  const delayDisabled =
    options.disableDelay === true ||
    String(process.env.OSINT_REQUEST_DELAY_DISABLE || '') === '1' ||
    isTestRuntime();

  if (delayDisabled) return;

  const minDelayMs = clamp(
    toInt(options.minDelayMs, toInt(process.env.OSINT_REQUEST_DELAY_MIN_MS, DEFAULT_MIN_DELAY_MS)),
    0,
    60000
  );
  const maxDelayMs = clamp(
    toInt(options.maxDelayMs, toInt(process.env.OSINT_REQUEST_DELAY_MAX_MS, DEFAULT_MAX_DELAY_MS)),
    minDelayMs,
    60000
  );

  delayQueue = delayQueue
    .catch(() => {})
    .then(async () => {
      const now = Date.now();
      const mustWait = Math.max(0, nextAllowedAt - now);
      if (mustWait > 0) {
        await wait(mustWait, options.signal);
      }

      const nextDelay = random(minDelayMs, maxDelayMs);
      nextAllowedAt = Date.now() + nextDelay;
      await jitter(nextDelay, nextDelay, options.signal);
    });

  return delayQueue;
}

function createMergedHeaders(inputHeaders, rotatedUserAgent, options = {}) {
  const merged = new Headers(inputHeaders || {});
  const profile = options.disableHeaderRotation ? {} : nextHeaderProfile();

  Object.keys(profile).forEach((key) => {
    if (!merged.has(key)) {
      merged.set(key, profile[key]);
    }
  });

  if (!merged.has('User-Agent')) {
    merged.set('User-Agent', rotatedUserAgent);
  }
  if (!merged.has('Accept')) {
    merged.set('Accept', '*/*');
  }
  if (!merged.has('Accept-Language')) {
    merged.set('Accept-Language', 'en-US,en;q=0.9,cs;q=0.8');
  }
  if (!merged.has('Cache-Control')) {
    merged.set('Cache-Control', 'no-cache');
  }

  return merged;
}

function isBlockedStatus(status) {
  return DEFAULT_BLOCKED_STATUSES.has(Number(status));
}

async function resolveFetchFn(options = {}, fetchFn) {
  if (!options.useStealthBrowser) return fetchFn;

  const method = String(options.method || 'GET').toUpperCase();
  const hasBody = typeof options.body !== 'undefined' && options.body !== null;
  if (method !== 'GET' || hasBody) {
    return fetchFn;
  }

  try {
    const { createStealthFetch } = require('./stealthBrowser');
    return await createStealthFetch({
      headless: options.stealthHeadless,
      launchOptions: options.stealthLaunchOptions,
      viewport: options.stealthViewport
    });
  } catch {
    return fetchFn;
  }
}

function resolveCookieJar(options = {}) {
  if (options.cookieJar === null || options.cookieJar === false) return null;
  if (options.cookieJar && typeof options.cookieJar.getCookieHeader === 'function') {
    return options.cookieJar;
  }

  if (String(process.env.OSINT_COOKIE_JAR_DISABLE || '') === '1') {
    return null;
  }

  return globalCookieJar;
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function parseIpList(rawValue) {
  if (!rawValue) return [];
  return String(rawValue)
    .split(/[;,\n\s]+/)
    .map((value) => value.trim().toLowerCase())
    .filter((value) => net.isIP(value) !== 0);
}

function normalizeIp(ip) {
  const raw = String(ip || '')
    .trim()
    .toLowerCase();
  if (!raw) return '';

  const mappedPrefix = '::ffff:';
  if (raw.startsWith(mappedPrefix)) {
    const mapped = raw.slice(mappedPrefix.length);
    if (net.isIP(mapped) === 4) {
      return mapped;
    }
  }

  return net.isIP(raw) ? raw : '';
}

function ipv4ToInt(ip) {
  const parts = String(ip || '')
    .split('.')
    .map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return -1;
  }

  return (
    (((parts[0] << 24) >>> 0) +
      ((parts[1] << 16) >>> 0) +
      ((parts[2] << 8) >>> 0) +
      (parts[3] >>> 0)) >>>
    0
  );
}

function ipv4InCidr(ip, cidrBase, prefixLength) {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(cidrBase);
  if (ipInt < 0 || baseInt < 0 || prefixLength < 0 || prefixLength > 32) return false;

  if (prefixLength === 0) return true;
  const mask = (0xffffffff << (32 - prefixLength)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isForbiddenPrivateIp(ip) {
  const normalized = normalizeIp(ip);
  if (!normalized) return true;

  const family = net.isIP(normalized);
  if (family === 4) {
    return (
      ipv4InCidr(normalized, '10.0.0.0', 8) ||
      ipv4InCidr(normalized, '172.16.0.0', 12) ||
      ipv4InCidr(normalized, '192.168.0.0', 16) ||
      ipv4InCidr(normalized, '127.0.0.0', 8) ||
      ipv4InCidr(normalized, '169.254.0.0', 16)
    );
  }

  if (family === 6) {
    const compact = normalized;
    return (
      compact === '::1' ||
      compact.startsWith('fe8') ||
      compact.startsWith('fe9') ||
      compact.startsWith('fea') ||
      compact.startsWith('feb') ||
      compact.startsWith('fc') ||
      compact.startsWith('fd')
    );
  }

  return true;
}

async function resolveTargetIps(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Neplatná URL adresa pro síťový požadavek.');
  }

  const hostname = String(parsed.hostname || '').trim();
  if (!hostname) {
    throw new Error('URL neobsahuje cílový hostname.');
  }

  const directIp = normalizeIp(hostname);
  if (directIp) {
    return [directIp];
  }

  if (hostname.toLowerCase() === 'localhost') {
    return ['127.0.0.1', '::1'];
  }

  let records = [];
  try {
    records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    const reason = toErrorMessage(error);
    throw new Error(`DNS lookup pro ${hostname} selhal: ${reason}`);
  }

  const resolved = records.map((entry) => normalizeIp(entry && entry.address)).filter(Boolean);

  if (!resolved.length) {
    throw new Error(`DNS lookup pro ${hostname} nevrátil žádnou IP adresu.`);
  }

  return Array.from(new Set(resolved));
}

function resolveIpPolicy(options = {}) {
  const allowRaw = Array.isArray(options.ipAllowList)
    ? options.ipAllowList.join(',')
    : options.ipAllowList || DEFAULT_IP_ALLOW_LIST;
  const blockRaw = Array.isArray(options.ipBlockList)
    ? options.ipBlockList.join(',')
    : options.ipBlockList || DEFAULT_IP_BLOCK_LIST;

  const allowSet = new Set(
    parseIpList(allowRaw)
      .map((ip) => normalizeIp(ip))
      .filter(Boolean)
  );
  const blockSet = new Set(
    parseIpList(blockRaw)
      .map((ip) => normalizeIp(ip))
      .filter(Boolean)
  );

  return { allowSet, blockSet };
}

function isSafeUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return false;
  }

  const protocol = String(parsed.protocol || '').toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return false;
  }

  const hostname = String(parsed.hostname || '')
    .trim()
    .toLowerCase();
  if (!hostname) return false;
  if (hostname === 'localhost') return false;

  return true;
}

async function assertIpPolicy(url, options = {}) {
  if (!isSafeUrl(url)) {
    throw new Error('Požadavek zablokován: URL neprošla bezpečnostní validací.');
  }

  const ips = await resolveTargetIps(url);
  const { allowSet, blockSet } = resolveIpPolicy(options);

  for (const ip of ips) {
    if (isForbiddenPrivateIp(ip)) {
      throw new Error(`Požadavek zablokován: cílová IP ${ip} je privátní/loopback/link-local.`);
    }

    if (blockSet.has(ip)) {
      throw new Error(`Požadavek zablokován: cílová IP ${ip} je na blacklistu.`);
    }
  }

  if (allowSet.size > 0) {
    const allAllowed = ips.every((ip) => allowSet.has(ip));
    if (!allAllowed) {
      throw new Error(`Požadavek zablokován: cílové IP nejsou na whitelistu (${ips.join(', ')}).`);
    }
  }
}

async function requestWithRetry(url, options = {}) {
  if (options.skipIpPolicy !== true) {
    await assertIpPolicy(url, options);
  }

  const timeoutMs = clamp(toInt(options.timeoutMs, DEFAULT_TIMEOUT_MS), 1, 120000);
  const maxRetries = clamp(toInt(options.maxRetries, DEFAULT_MAX_RETRIES), 0, 5);
  const serviceName =
    typeof options.serviceName === 'string' && options.serviceName.trim()
      ? options.serviceName.trim()
      : 'External service';
  const baseFetchFn = typeof options.fetchFn === 'function' ? options.fetchFn : globalThis.fetch;
  const fetchFn = await resolveFetchFn(options, baseFetchFn);
  const retryStatuses = Array.isArray(options.retryOnStatuses)
    ? new Set(options.retryOnStatuses.map((value) => Number(value)).filter(Number.isFinite))
    : null;
  const cookieJar = resolveCookieJar(options);

  const proxyList = resolveProxyRotationList(options);
  let proxyUrl = typeof options.proxyUrl === 'string' ? options.proxyUrl.trim() : '';
  if (!proxyUrl) {
    proxyUrl = pickInitialProxy(proxyList);
  }

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const parentSignal = options.signal;
    let onParentAbort = null;
    if (parentSignal && typeof parentSignal.addEventListener === 'function') {
      if (parentSignal.aborted) {
        controller.abort();
      } else {
        onParentAbort = () => controller.abort();
        parentSignal.addEventListener('abort', onParentAbort, { once: true });
      }
    }

    try {
      await applyInterRequestDelay({
        disableDelay: options.disableDelay,
        minDelayMs: options.minDelayMs,
        maxDelayMs: options.maxDelayMs,
        signal: controller.signal
      });

      const fetchInit = createFetchInitFromOptions(options);
      fetchInit.headers = createMergedHeaders(options.headers, nextUserAgent(), {
        disableHeaderRotation: options.disableHeaderRotation
      });

      if (cookieJar && !fetchInit.headers.has('Cookie')) {
        const cookieHeader = cookieJar.getCookieHeader(url);
        if (cookieHeader) {
          fetchInit.headers.set('Cookie', cookieHeader);
        }
      }

      fetchInit.signal = controller.signal;

      const dispatcher = getProxyDispatcher(proxyUrl);
      if (dispatcher) {
        fetchInit.dispatcher = dispatcher;
      }

      const response = await fetchFn(url, fetchInit);
      if (cookieJar) {
        cookieJar.storeFromResponse(url, response);
      }

      if (isBlockedStatus(response.status) && typeof options.onBlocked === 'function') {
        options.onBlocked({
          url,
          serviceName,
          status: response.status,
          attempt: attempt + 1,
          maxRetries,
          proxyUrl
        });
      }

      const retryable = retryStatuses
        ? retryStatuses.has(response.status)
        : isRetryableStatus(response.status);
      if (retryable && attempt < maxRetries) {
        if (typeof options.onFailure === 'function') {
          options.onFailure({
            url,
            serviceName,
            attempt: attempt + 1,
            maxRetries,
            status: response.status,
            proxyUrl,
            error: `HTTP ${response.status}`
          });
        }

        if (typeof options.nextProxy === 'function') {
          try {
            const next = options.nextProxy({
              url,
              serviceName,
              attempt: attempt + 1,
              maxRetries,
              previousProxy: proxyUrl,
              status: response.status
            });
            if (typeof next === 'string') {
              proxyUrl = next;
            }
          } catch {
            // ignore proxy callback errors and keep previous proxy
          }
        } else if (proxyList.length > 0) {
          proxyUrl = rotateProxyFromPool(proxyList, proxyUrl);
        }
        continue;
      }

      return response;
    } catch (error) {
      const isAbort = error && error.name === 'AbortError';
      const message = isAbort
        ? `${serviceName} timeout po ${timeoutMs} ms.`
        : toErrorMessage(error);

      if (attempt < maxRetries) {
        if (typeof options.onFailure === 'function') {
          options.onFailure({
            url,
            serviceName,
            attempt: attempt + 1,
            maxRetries,
            proxyUrl,
            error: message
          });
        }

        if (typeof options.nextProxy === 'function') {
          try {
            const next = options.nextProxy({
              url,
              serviceName,
              attempt: attempt + 1,
              maxRetries,
              previousProxy: proxyUrl,
              error: message
            });
            if (typeof next === 'string') {
              proxyUrl = next;
            }
          } catch {
            // ignore proxy callback errors and keep previous proxy
          }
        } else if (proxyList.length > 0) {
          proxyUrl = rotateProxyFromPool(proxyList, proxyUrl);
        }
        continue;
      }

      if (typeof options.onFailure === 'function') {
        options.onFailure({
          url,
          serviceName,
          attempt: attempt + 1,
          maxRetries,
          proxyUrl,
          error: message,
          final: true
        });
      } else {
        console.warn(`[request] ${serviceName} failed: ${message}`);
      }

      throw new Error(message);
    } finally {
      clearTimeout(timeoutId);
      if (parentSignal && onParentAbort) {
        parentSignal.removeEventListener('abort', onParentAbort);
      }
    }
  }

  throw new Error(`${serviceName} request failed.`);
}

module.exports = {
  requestWithRetry,
  random,
  USER_AGENTS,
  USE_PROXY,
  createCookieJar: () => new SimpleCookieJar()
};
