const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns');

const { requestWithRetry } = require('../utils/request');

function withMockedDnsLookup(t, implementation) {
  const originalLookup = dns.promises.lookup;
  dns.promises.lookup = implementation;
  t.after(() => {
    dns.promises.lookup = originalLookup;
  });
}

test('blocks direct RFC1918 IPv4 targets before fetch', async () => {
  let called = false;

  await assert.rejects(
    () =>
      requestWithRetry('http://192.168.1.25/resource', {
        maxRetries: 0,
        fetchFn: async () => {
          called = true;
          return new Response('', { status: 200 });
        }
      }),
    /zablokován|privátní/i
  );

  assert.equal(called, false);
});

test('blocks localhost loopback targets', async () => {
  await assert.rejects(
    () =>
      requestWithRetry('http://localhost:8080/health', {
        maxRetries: 0,
        fetchFn: async () => new Response('', { status: 200 })
      }),
    /zablokován|loopback/i
  );
});

test('blocks unsupported URL scheme before DNS lookup', async () => {
  await assert.rejects(
    () =>
      requestWithRetry('file:///etc/hosts', {
        timeoutMs: 100,
        maxRetries: 0,
        disableDelay: true,
        fetchFn: async () => {
          throw new Error('fetch should not be called for blocked scheme');
        }
      }),
    /bezpecnostni validaci|bezpečnostní validací/i
  );
});

test('blocks DNS-resolved IPv4 link-local targets', async (t) => {
  withMockedDnsLookup(t, async () => [{ address: '169.254.10.10', family: 4 }]);

  await assert.rejects(
    () =>
      requestWithRetry('https://safe.example/path', {
        maxRetries: 0,
        fetchFn: async () => new Response('', { status: 200 })
      }),
    /zablokován|link-local/i
  );
});

test('blocks DNS-resolved IPv6 unique-local targets (fc00::/7)', async (t) => {
  withMockedDnsLookup(t, async () => [{ address: 'fd12:3456::1', family: 6 }]);

  await assert.rejects(
    () =>
      requestWithRetry('https://ipv6-private.example/path', {
        maxRetries: 0,
        fetchFn: async () => new Response('', { status: 200 })
      }),
    /zablokován|privátní/i
  );
});

test('blocks public target when IP is explicitly blacklisted', async (t) => {
  withMockedDnsLookup(t, async () => [{ address: '93.184.216.34', family: 4 }]);

  await assert.rejects(
    () =>
      requestWithRetry('https://example.com', {
        maxRetries: 0,
        ipBlockList: ['93.184.216.34'],
        fetchFn: async () => new Response('', { status: 200 })
      }),
    /blacklist/i
  );
});

test('enforces whitelist strictly for all resolved IPs', async (t) => {
  withMockedDnsLookup(t, async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '151.101.1.140', family: 4 }
  ]);

  await assert.rejects(
    () =>
      requestWithRetry('https://example.com', {
        maxRetries: 0,
        ipAllowList: ['93.184.216.34'],
        fetchFn: async () => new Response('', { status: 200 })
      }),
    /whitelist/i
  );
});

test('allows public target when all policy checks pass', async (t) => {
  withMockedDnsLookup(t, async () => [{ address: '93.184.216.34', family: 4 }]);

  let called = 0;
  const response = await requestWithRetry('https://example.com', {
    maxRetries: 0,
    ipAllowList: ['93.184.216.34'],
    fetchFn: async () => {
      called += 1;
      return new Response('ok', { status: 200 });
    }
  });

  assert.equal(called, 1);
  assert.equal(response.status, 200);
});
