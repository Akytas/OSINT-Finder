const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeResultsModeValue,
  getVerdictMeta,
  getResultsFilters,
  updateResultsFilterUi,
  computeFakeScore
} = require('../app');

test('normalizes legacy advanced mode to forensic', () => {
  assert.equal(normalizeResultsModeValue('advanced'), 'forensic');
  assert.equal(normalizeResultsModeValue('forensic'), 'forensic');
  assert.equal(normalizeResultsModeValue('simple'), 'simple');
  assert.equal(normalizeResultsModeValue('anything-else'), 'simple');
});

test('returns expected verdict levels from score', () => {
  assert.deepEqual(getVerdictMeta(87), { emoji: '🟢', label: 'VYSOKÁ PRAVDĚPODOBNOST' });
  assert.deepEqual(getVerdictMeta(60), { emoji: '🟡', label: 'STŘEDNÍ PRAVDĚPODOBNOST' });
  assert.deepEqual(getVerdictMeta(25), { emoji: '🔴', label: 'NÍZKÁ PRAVDĚPODOBNOST' });
  assert.deepEqual(getVerdictMeta('x'), { emoji: '⚪', label: 'NEURCENO' });
});

test('computes fake score with required weights and level', () => {
  const high = computeFakeScore({
    manipulated: true,
    hasTrustedDomain: false,
    sourceCount: 1
  });

  assert.equal(high.value, 1);
  assert.equal(high.level, 'HIGH');
  assert.equal(high.components.manipulated, 0.5);
  assert.equal(high.components.lowTrust, 0.3);
  assert.equal(high.components.fewSources, 0.2);

  const medium = computeFakeScore({
    manipulated: false,
    hasTrustedDomain: false,
    sourceCount: 1
  });

  assert.equal(medium.value, 0.5);
  assert.equal(medium.level, 'MEDIUM');

  const low = computeFakeScore({
    manipulated: false,
    hasTrustedDomain: true,
    sourceCount: 3
  });

  assert.equal(low.value, 0);
  assert.equal(low.level, 'LOW');
});

test('reads results filters and clamps min confidence', () => {
  const previousDocument = global.document;
  global.document = {
    getElementById(id) {
      if (id === 'results-min-confidence') return { value: '123' };
      if (id === 'results-only-manipulated') return { checked: true };
      if (id === 'results-only-trusted') return { checked: false };
      return null;
    }
  };

  try {
    assert.deepEqual(getResultsFilters(), {
      minConfidence: 100,
      onlyManipulated: true,
      onlyTrustedDomains: false
    });
  } finally {
    global.document = previousDocument;
  }
});

test('updates min confidence label dynamically', () => {
  const slider = { value: '47' };
  const label = { textContent: '' };
  const previousDocument = global.document;
  global.document = {
    getElementById(id) {
      if (id === 'results-min-confidence') return slider;
      if (id === 'results-min-confidence-value') return label;
      return null;
    }
  };

  try {
    updateResultsFilterUi();
    assert.equal(label.textContent, '47%');

    slider.value = '-5';
    updateResultsFilterUi();
    assert.equal(label.textContent, '0%');
  } finally {
    global.document = previousDocument;
  }
});
