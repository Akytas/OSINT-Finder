const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const normalizeResults = require('../core/normalizer');
const { computeDHashFromBuffer, compareHashes } = require('../utils/imageHash');

function tinyPngBuffer() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6XgCwAAAAASUVORK5CYII=',
    'base64'
  );
}

function loadServerWithEnv(extraEnv = {}) {
  const modulePath = require.resolve('../server');
  delete require.cache[modulePath];

  const effectiveEnv = { ...extraEnv };
  if (typeof effectiveEnv.LOG_LEVEL === 'undefined') {
    effectiveEnv.LOG_LEVEL = 'fatal';
  }
  if (typeof effectiveEnv.OSINT_DETERMINISTIC_TESTS === 'undefined') {
    effectiveEnv.OSINT_DETERMINISTIC_TESTS = '1';
  }
  if (typeof effectiveEnv.SAFE_MODE === 'undefined') {
    effectiveEnv.SAFE_MODE = 'false';
  }

  const backup = {};
  Object.keys(effectiveEnv).forEach((key) => {
    backup[key] = process.env[key];
    process.env[key] = String(effectiveEnv[key]);
  });

  const serverModule = require('../server');

  return {
    app: serverModule.app,
    restoreEnv: () => {
      Object.keys(effectiveEnv).forEach((key) => {
        if (typeof backup[key] === 'undefined') {
          delete process.env[key];
        } else {
          process.env[key] = backup[key];
        }
      });
    }
  };
}

function withFetchMock(t, mockFn) {
  const originalFetch = global.fetch;
  global.fetch = mockFn;
  t.after(() => {
    global.fetch = originalFetch;
  });
}

function normalizeForMatch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

test('rejects unsupported MIME type', async () => {
  const { app } = loadServerWithEnv();

  const response = await request(app)
    .post('/api/reverse-image')
    .attach('image', Buffer.from('hello'), {
      filename: 'bad.txt',
      contentType: 'text/plain'
    });

  assert.equal(response.status, 400);
  assert.match(
    normalizeForMatch(response.body.error),
    /nepovoleny typ souboru|unsupported file type/i
  );
});

test('reverse-image requires uploaded file', async () => {
  const { app } = loadServerWithEnv();

  const response = await request(app).post('/api/reverse-image').send({ hints: 'John Doe' });

  assert.equal(response.status, 400);
  assert.match(normalizeForMatch(response.body.error), /chybi soubor obrazku|missing image/i);
});

test('rejects files larger than 12 MB', async () => {
  const { app } = loadServerWithEnv();
  const oversized = Buffer.alloc(12 * 1024 * 1024 + 1, 0);

  const response = await request(app).post('/api/reverse-image').attach('image', oversized, {
    filename: 'big.png',
    contentType: 'image/png'
  });

  assert.equal(response.status, 400);
  assert.match(
    normalizeForMatch(response.body.error),
    /prilis velky|maximalni velikost|file too large/i
  );
});

test('rate limiter returns 429 after threshold', async () => {
  const { app, restoreEnv } = loadServerWithEnv({ RATE_LIMIT_MAX: 2, RATE_LIMIT_WINDOW_MS: 60000 });
  try {
    const first = await request(app).get('/api/not-found');
    const second = await request(app).get('/api/not-found');
    const third = await request(app).get('/api/not-found');

    assert.notEqual(first.status, 429);
    assert.notEqual(second.status, 429);
    assert.equal(third.status, 429);
    assert.match(
      normalizeForMatch(third.body.error),
      /rate limit|limit pozadavku|prekrocen limit/i
    );
  } finally {
    restoreEnv();
  }
});

test('username search returns normalized query and result links', async () => {
  const { app } = loadServerWithEnv();

  const response = await request(app).post('/api/username-search').send({ username: '@novak_123' });

  assert.equal(response.status, 200);
  assert.equal(response.body.queryType, 'username');
  assert.equal(response.body.query, 'novak_123');
  assert.ok(Array.isArray(response.body.results));
  assert.ok(response.body.results.length >= 5);
  assert.equal(typeof response.body.results[0].score, 'number');
  assert.ok(response.body.analysis && Array.isArray(response.body.analysis.byDomain));
});

test('email osint validates email format', async () => {
  const { app } = loadServerWithEnv();

  const response = await request(app).post('/api/email-osint').send({ email: 'not-an-email' });

  assert.equal(response.status, 400);
  assert.match(
    normalizeForMatch(response.body.error),
    /invalid email|neplatny e-mail|neplatny email/i
  );
});

test('domain intel returns links for valid domain', async () => {
  const { app } = loadServerWithEnv();

  const response = await request(app)
    .post('/api/domain-intel')
    .send({ domain: 'https://www.example.com/path' });

  assert.equal(response.status, 200);
  assert.equal(response.body.queryType, 'domain');
  assert.equal(response.body.query, 'example.com');
  assert.ok(Array.isArray(response.body.results));
  assert.ok(response.body.results.some((item) => /whois/i.test(String(item.source || ''))));
  assert.equal(typeof response.body.results[0].qualityScore, 'number');
  assert.ok(response.body.metadata && response.body.metadata.antiBot);
});

test('email osint returns unified result scoring and analysis', async () => {
  const { app } = loadServerWithEnv();

  const response = await request(app)
    .post('/api/email-osint')
    .send({ email: 'kontakt@example.com' });

  assert.equal(response.status, 200);
  assert.equal(response.body.queryType, 'email');
  assert.ok(Array.isArray(response.body.results));
  assert.ok(response.body.results.length >= 3);
  assert.equal(typeof response.body.results[0].score, 'number');
  assert.ok(response.body.analysis && response.body.analysis.frequentMatches);
});

test('metadata extractor returns hashes and exif info', async () => {
  const { app } = loadServerWithEnv();

  const response = await request(app)
    .post('/api/metadata-extract')
    .attach('image', tinyPngBuffer(), {
      filename: 'meta.png',
      contentType: 'image/png'
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.queryType, 'metadata-extract');
  assert.ok(response.body.hashes && response.body.hashes.sha256);
  assert.ok(response.body.exif && typeof response.body.exif === 'object');
});

test('handles external timeouts with meaningful warning', async (t) => {
  const { app } = loadServerWithEnv({ FETCH_TIMEOUT_MS: 50 });

  withFetchMock(
    t,
    (url, options = {}) =>
      new Promise((resolve, reject) => {
        const signal = options.signal;
        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        }
      })
  );

  const response = await request(app).post('/api/reverse-image').attach('image', tinyPngBuffer(), {
    filename: 'photo.png',
    contentType: 'image/png'
  });

  assert.equal(response.status, 502);
  assert.ok(Array.isArray(response.body.warnings));
  assert.ok(response.body.warnings.some((item) => /timeout/i.test(String(item))));
});

test('returns hashes and exif object even when external providers fail', async (t) => {
  const { app } = loadServerWithEnv({ FETCH_TIMEOUT_MS: 50 });

  withFetchMock(
    t,
    (url, options = {}) =>
      new Promise((resolve, reject) => {
        const signal = options.signal;
        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        }
      })
  );

  const response = await request(app).post('/api/reverse-image').attach('image', tinyPngBuffer(), {
    filename: 'photo.png',
    contentType: 'image/png'
  });

  assert.equal(response.status, 502);
  assert.ok(response.body.hashes && response.body.hashes.sha256);
  assert.ok(response.body.hashes && response.body.hashes.md5);
  assert.ok(response.body.exif && typeof response.body.exif === 'object');
  assert.ok(Object.prototype.hasOwnProperty.call(response.body.exif, 'hasExif'));
});

test('successful flow returns results, candidates and image metadata', async (t) => {
  const { app } = loadServerWithEnv({
    FETCH_TIMEOUT_MS: 5000,
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000
  });

  withFetchMock(t, async (url, options = {}) => {
    const urlText = String(url);

    if (/catbox\.moe/.test(urlText)) {
      return new Response('https://files.catbox.moe/example.jpg', { status: 200 });
    }

    if (/0x0\.st/.test(urlText)) {
      return new Response('https://0x0.st/example.jpg', { status: 200 });
    }

    if (/searchbyimage\/upload/.test(urlText)) {
      return new Response('', {
        status: 302,
        headers: {
          location: '/search?q=John+Doe'
        }
      });
    }

    if (/google\.com\/search\?/.test(urlText)) {
      return new Response('<title>John Doe - Google Search</title>', { status: 200 });
    }

    return new Response('', { status: 404 });
  });

  const response = await request(app)
    .post('/api/reverse-image')
    .field('mode', 'forensic')
    .field('hints', 'John Doe')
    .attach('image', tinyPngBuffer(), {
      filename: 'photo.png',
      contentType: 'image/png'
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.queryType, 'image-upload');
  assert.ok(Array.isArray(response.body.results));
  assert.ok(response.body.results.length > 0);
  assert.equal(typeof response.body.results[0].score, 'number');
  assert.equal(typeof response.body.results[0].qualityScore, 'number');
  assert.equal(typeof response.body.results[0].sourceCount, 'number');
  assert.equal(typeof response.body.results[0].similarityComponent, 'number');
  assert.ok(Array.isArray(response.body.candidates));
  assert.ok(response.body.analysis && typeof response.body.analysis === 'object');
  assert.ok(Array.isArray(response.body.analysis.byDomain));
  assert.ok(
    response.body.analysis.frequentMatches &&
      typeof response.body.analysis.frequentMatches === 'object'
  );
  assert.ok(response.body.hashes && response.body.hashes.sha256);
  assert.ok(response.body.hashes && response.body.hashes.md5);
});

test('reverse-image attaches logic and optional AI analysis to result items', async (t) => {
  const { app, restoreEnv } = loadServerWithEnv({
    LOG_LEVEL: 'error',
    FETCH_TIMEOUT_MS: 5000,
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    SAFE_MODE: 'false',
    MIN_SCORE_THRESHOLD: 0,
    OSINT_ENABLE_AI_ANALYSIS: 1,
    OSINT_AI_ANALYSIS_API_URL: 'https://ai.example.local/analyze',
    OSINT_AI_ANALYSIS_API_KEY: 'test-key'
  });
  t.after(restoreEnv);

  withFetchMock(t, async (url, options = {}) => {
    const urlText = String(url);

    if (/ai\.example\.local\/analyze/.test(urlText)) {
      assert.equal(options.method, 'POST');
      return new Response(
        JSON.stringify({
          conclusion: 'Likely authentic',
          reasoning: 'Signals are consistent across sources and domains.',
          risk: 'LOW'
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json'
          }
        }
      );
    }

    if (/catbox\.moe/.test(urlText)) {
      return new Response('https://files.catbox.moe/example.jpg', { status: 200 });
    }

    if (/0x0\.st/.test(urlText)) {
      return new Response('https://0x0.st/example.jpg', { status: 200 });
    }

    if (/searchbyimage\/upload/.test(urlText)) {
      return new Response('', {
        status: 302,
        headers: {
          location: '/search?q=John+Doe'
        }
      });
    }

    if (/google\.com\/search\?/.test(urlText)) {
      return new Response('<title>John Doe - Google Search</title>', { status: 200 });
    }

    return new Response('', { status: 404 });
  });

  const response = await request(app)
    .post('/api/reverse-image')
    .field('mode', 'forensic')
    .field('hints', 'John Doe')
    .attach('image', tinyPngBuffer(), {
      filename: 'photo.png',
      contentType: 'image/png'
    });

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.results));
  assert.ok(response.body.results.length > 0);
  assert.ok(Array.isArray(response.body.providerScoredResults));

  const combinedItems = [
    ...(Array.isArray(response.body.providerScoredResults)
      ? response.body.providerScoredResults
      : []),
    ...(Array.isArray(response.body.results) ? response.body.results : [])
  ];
  const item =
    combinedItems.find((entry) => entry && entry.logicAnalysis && entry.aiAnalysis) ||
    combinedItems.find((entry) => entry && entry.logicAnalysis) ||
    combinedItems.find((entry) => entry && typeof entry === 'object');
  assert.ok(item);
  assert.ok(item.logicAnalysis && typeof item.logicAnalysis === 'object');
  assert.equal(typeof item.logicAnalysis.conclusion, 'string');
  assert.ok(item.logicAnalysis.consistency && typeof item.logicAnalysis.consistency === 'object');
  assert.ok(
    item.logicAnalysis.contradictions && typeof item.logicAnalysis.contradictions === 'object'
  );

  assert.ok(item.aiAnalysis && typeof item.aiAnalysis === 'object');
  assert.equal(typeof item.aiAnalysis.conclusion, 'string');
  assert.equal(typeof item.aiAnalysis.reasoning, 'string');
  assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(String(item.aiAnalysis.risk || '').toUpperCase()));
});

test('safe mode blocks temporary host upload and keeps fallback flow', async (t) => {
  const { app, restoreEnv } = loadServerWithEnv({
    LOG_LEVEL: 'error',
    FETCH_TIMEOUT_MS: 5000,
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    SAFE_MODE: 'true'
  });
  t.after(restoreEnv);

  let temporaryHostCalls = 0;

  withFetchMock(t, async (url) => {
    const urlText = String(url);

    if (/catbox\.moe|0x0\.st/.test(urlText)) {
      temporaryHostCalls += 1;
      return new Response('https://files.catbox.moe/example.jpg', { status: 200 });
    }

    if (/searchbyimage\/upload/.test(urlText)) {
      return new Response('', {
        status: 302,
        headers: {
          location: '/search?q=John+Doe'
        }
      });
    }

    if (/google\.com\/search\?/.test(urlText)) {
      return new Response('<title>John Doe - Google Search</title>', { status: 200 });
    }

    return new Response('', { status: 404 });
  });

  const response = await request(app)
    .post('/api/reverse-image')
    .field('mode', 'forensic')
    .field('hints', 'John Doe')
    .attach('image', tinyPngBuffer(), {
      filename: 'photo.png',
      contentType: 'image/png'
    });

  assert.equal(response.status, 200);
  assert.equal(temporaryHostCalls, 0);
  assert.ok(Array.isArray(response.body.warnings));
  assert.ok(
    response.body.warnings.some((item) =>
      /safe_mode aktivni|docasne externe hostingy je zakazan/.test(normalizeForMatch(item))
    )
  );
  assert.ok(Array.isArray(response.body.results));
  assert.ok(
    response.body.results.some((item) =>
      /google reverzni vyhledavani/.test(normalizeForMatch(item && item.source))
    )
  );
});

test('normalizer computes perceptual hash from thumbnail URL', async () => {
  const samplePath = path.join(__dirname, '..', 'sample-test.jpg');
  const imageBuffer = fs.readFileSync(samplePath);
  const expectedHash = await computeDHashFromBuffer(imageBuffer);

  const normalized = await normalizeResults(
    [
      {
        source: 'test-source',
        items: [
          {
            title: 'Sample',
            url: 'https://example.com/item',
            thumbnail: 'https://images.example.com/sample-test.jpg'
          }
        ]
      }
    ],
    {
      fetchFn: async () =>
        new Response(imageBuffer, {
          status: 200,
          headers: {
            'content-type': 'image/jpeg'
          }
        }),
      hashTimeoutMs: 5000,
      disableDelay: true,
      computeOcr: false
    }
  );

  assert.equal(normalized.length, 1);
  assert.equal(typeof normalized[0].hash, 'string');
  assert.equal(compareHashes(normalized[0].hash, expectedHash), 0);
});
