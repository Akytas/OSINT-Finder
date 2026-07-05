const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeItemsLogical } = require('../core/analysisEngine');

test('logic analysis marks high-consistency item as likely authentic', () => {
  const items = [
    {
      url: 'https://example.com/a',
      manipulated: false,
      sources: ['Google', 'Bing', 'Yandex'],
      domains: ['example.com'],
      detectedText: 'John Doe profile card'
    },
    {
      url: 'https://example.com/b',
      manipulated: false,
      sources: ['Google', 'Bing'],
      domains: ['example.com'],
      detectedText: 'John Doe profile card'
    }
  ];

  const out = analyzeItemsLogical(items);
  assert.equal(out.length, 2);
  assert.equal(out[0].logicAnalysis.conclusion, 'Likely authentic');
  assert.equal(out[0].logicAnalysis.contradictions.count, 0);
  assert.ok(Number(out[0].logicAnalysis.consistency.score) >= 0.7);
});

test('logic analysis detects OCR contradictions and flags uncertainty/manipulation', () => {
  const items = [
    {
      url: 'https://same.example/a',
      manipulated: false,
      sources: ['Google'],
      domains: ['same.example'],
      detectedText: 'Invoice approved amount 1400'
    },
    {
      url: 'https://same.example/b',
      manipulated: false,
      sources: ['Google'],
      domains: ['same.example'],
      detectedText: 'Completely different phrase and content'
    }
  ];

  const out = analyzeItemsLogical(items);
  assert.equal(out.length, 2);
  assert.ok(out[0].logicAnalysis.contradictions.count >= 1);
  assert.ok(['Uncertain', 'Possibly manipulated'].includes(out[0].logicAnalysis.conclusion));
});
