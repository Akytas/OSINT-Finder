function buildEvidenceItem(item = {}) {
  const domains = Array.isArray(item.domains) ? item.domains : (item.domain ? [item.domain] : []);
  const primaryDomain = domains[0] || 'unknown-domain';
  const sourceCount = Array.isArray(item.sources) ? item.sources.length : 0;
  const claim = `Image appears on domain ${primaryDomain}`;

  const evidence = [];
  evidence.push(`Found on ${Math.max(1, sourceCount)} source(s)`);

  if (typeof item.confidenceLabel === 'string') {
    evidence.push(`Confidence ${item.confidenceLabel}`);
  } else if (typeof item.confidenceLevel === 'string') {
    evidence.push(`Confidence ${item.confidenceLevel}`);
  }

  if (Array.isArray(item.dimensions) && item.dimensions.length) {
    evidence.push(`Dimensions observed: ${item.dimensions.join(', ')}`);
  }

  const topText = Array.isArray(item.detectedTexts) && item.detectedTexts.length
    ? item.detectedTexts[0]
    : null;
  if (topText && topText.text) {
    evidence.push(`Text '${topText.text}' detected`);
  }

  const contradictions = [];
  if (item.manipulated) {
    contradictions.push('Manipulation indicators detected');
  }
  if (sourceCount <= 1) {
    contradictions.push('Single-source evidence only');
  }

  const confidence = Number.isFinite(Number(item.confidencePercent))
    ? Number(item.confidencePercent)
    : Number.isFinite(Number(item.score))
      ? Number(item.score)
      : 0;

  return {
    claim,
    evidence,
    contradictions,
    confidence
  };
}

function buildEvidence(results = []) {
  const list = Array.isArray(results) ? results : [];
  return list.map((item) => buildEvidenceItem(item));
}

module.exports = {
  buildEvidence,
  buildEvidenceItem
};
