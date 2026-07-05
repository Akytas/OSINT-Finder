const test = require('node:test');
const assert = require('node:assert/strict');
const { runSearchDetailed } = require('../core/engine');

test('runSearchDetailed exposes provider metrics summary', async () => {
  const result = await runSearchDetailed(
    {},
    {
      useCache: false,
      timeoutMs: 1000,
      sourceRetries: 0,
      maxConcurrency: 2,
      mode: 'standard',
      normalizerOptions: {
        computeImageHash: false,
        computeOcr: false
      },
      aiAnalysis: {
        enabled: false
      }
    }
  );

  assert.ok(result && typeof result === 'object');
  assert.ok(result.providerMetrics && typeof result.providerMetrics === 'object');
  assert.equal(typeof result.providerMetrics.durationMs, 'number');
  assert.ok(result.providerMetrics.durationMs >= 0);
  assert.equal(
    Number(result.providerMetrics.totalSources),
    Number(result.providerMetrics.fulfilledCount) + Number(result.providerMetrics.rejectedCount)
  );
});
