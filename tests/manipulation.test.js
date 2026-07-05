const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  computeImageFingerprintFromBuffer,
  compareHashes
} = require('../utils/imageHash');
const aggregate = require('../core/aggregator');
const scoreItems = require('../core/scorer');

function tinyPngBuffer() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6XgCwAAAAASUVORK5CYII=',
    'base64'
  );
}

test('image fingerprint contains hash, dimensions and segments', async () => {
  const samplePath = path.join(__dirname, '..', 'sample-test.jpg');
  const sampleBuffer = fs.readFileSync(samplePath);
  const fingerprint = await computeImageFingerprintFromBuffer(sampleBuffer);

  assert.equal(typeof fingerprint.hash, 'string');
  assert.ok(fingerprint.hash.length > 0);
  assert.ok(fingerprint.width > 0);
  assert.ok(fingerprint.height > 0);
  assert.ok(Array.isArray(fingerprint.segments));
  assert.equal(fingerprint.segments.length, 4);
  assert.equal(compareHashes(fingerprint.hash, fingerprint.hash), 0);
});

test('aggregator marks manipulated images for resize/crop signals', () => {
  const normalizedItems = [
    {
      source: 'alpha',
      title: 'A',
      url: 'https://example.com/a',
      similarity: 0.8,
      domain: 'example.com',
      hash: '0123456789abcdef',
      hashSegments: ['0123', '4567', '89ab', 'cdef'],
      imageWidth: 100,
      imageHeight: 100,
      detectedText: '',
      ocrConfidence: 0
    },
    {
      source: 'beta',
      title: 'B',
      url: 'https://example.org/b',
      similarity: 0.75,
      domain: 'example.org',
      hash: '0123456789abcdef',
      hashSegments: ['0123', '4567', '89ab', 'cdef'],
      imageWidth: 300,
      imageHeight: 180,
      detectedText: '',
      ocrConfidence: 0
    }
  ];

  const aggregated = aggregate(normalizedItems);
  assert.equal(aggregated.length, 1);
  assert.equal(aggregated[0].manipulated, true);
  assert.ok(Array.isArray(aggregated[0].manipulation.reasons));
  assert.ok(aggregated[0].manipulation.reasons.includes('resized') || aggregated[0].manipulation.reasons.includes('cropped'));
});

test('scorer penalizes manipulated results', () => {
  const baseItem = {
    url: 'https://example.com/a',
    title: 'Item',
    sources: ['alpha', 'beta'],
    occurrences: 2,
    similarityAvg: 0.8,
    domains: ['example.com'],
    hashes: ['0123456789abcdef'],
    textRepeatScore: 0.4,
    detectedTexts: []
  };

  const scored = scoreItems([
    {
      ...baseItem,
      manipulated: false,
      manipulation: { reasons: [] }
    },
    {
      ...baseItem,
      url: 'https://example.com/b',
      manipulated: true,
      manipulation: { reasons: ['resized'] }
    }
  ]);

  const clean = scored.find((item) => item.url === 'https://example.com/a');
  const manipulated = scored.find((item) => item.url === 'https://example.com/b');

  assert.ok(clean);
  assert.ok(manipulated);
  assert.ok(clean.score > manipulated.score);
  assert.equal(manipulated.manipulated, true);
  assert.ok(Array.isArray(manipulated.scoreNotes));
  assert.ok(manipulated.scoreNotes[0].includes('Manipulation signal'));
});
