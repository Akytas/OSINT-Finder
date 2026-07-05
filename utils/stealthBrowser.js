let sessionPromise = null;

async function createSession(options = {}) {
  const puppeteerExtra = require('puppeteer-extra');
  const stealthPlugin = require('puppeteer-extra-plugin-stealth');

  puppeteerExtra.use(stealthPlugin());

  const headless = typeof options.headless === 'boolean'
    ? options.headless
    : String(process.env.OSINT_STEALTH_HEADLESS || '1') === '1';

  const browser = await puppeteerExtra.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...(options.launchOptions || {})
  });

  return {
    browser,
    viewport: options.viewport || { width: 1366, height: 768 }
  };
}

async function getSession(options = {}) {
  if (!sessionPromise) {
    sessionPromise = createSession(options);
  }
  return sessionPromise;
}

function toHeadersObject(headersLike) {
  const headers = new Headers(headersLike || {});
  const out = {};
  for (const [key, value] of headers.entries()) {
    out[key] = value;
  }
  return out;
}

async function createStealthFetch(options = {}) {
  const session = await getSession(options);

  return async function stealthFetch(url, init = {}) {
    const page = await session.browser.newPage();

    try {
      await page.setViewport(session.viewport);
      const headers = toHeadersObject(init.headers || {});
      if (Object.keys(headers).length) {
        await page.setExtraHTTPHeaders(headers);
      }

      const response = await page.goto(String(url), {
        waitUntil: 'domcontentloaded',
        timeout: typeof init.timeoutMs === 'number' ? init.timeoutMs : 30000
      });

      const status = response ? response.status() : 599;
      const responseHeaders = response ? response.headers() : {};
      const body = await page.content();

      return new Response(body, {
        status,
        headers: responseHeaders
      });
    } finally {
      await page.close().catch(() => {});
    }
  };
}

async function closeStealthBrowser() {
  if (!sessionPromise) return;

  try {
    const session = await sessionPromise;
    if (session && session.browser) {
      await session.browser.close();
    }
  } finally {
    sessionPromise = null;
  }
}

module.exports = {
  createStealthFetch,
  closeStealthBrowser
};
