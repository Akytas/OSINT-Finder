const DEFAULT_WEIGHTS = {
  sourceCountWeight: 15,
  similarityWeight: 30,
  domainReputationWeight: 20,
  occurrenceWeight: 10,
  hashSimilarityWeight: 25,
  textRepeatWeight: 15,
  manipulationPenaltyWeight: 12
};

const { getDomainTrust } = require('./domainReputation');

const DEFAULT_CAPS = {
  sourceCount: 5,
  occurrences: 5
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return null;

  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) distance += 1;
  }

  return distance;
}

function hashSimilarityScore(hashes) {
  const cleanHashes = Array.from(new Set(
    asArray(hashes)
      .map((hash) => (typeof hash === 'string' ? hash.trim().toLowerCase() : ''))
      .filter(Boolean)
  ));

  if (!cleanHashes.length) return 0.3;
  if (cleanHashes.length === 1) return 0.6;

  const closenessValues = [];

  for (let i = 0; i < cleanHashes.length; i += 1) {
    for (let j = i + 1; j < cleanHashes.length; j += 1) {
      const distance = hammingDistance(cleanHashes[i], cleanHashes[j]);
      if (distance === null) continue;

      const closeness = clamp(1 - (distance / 10), 0, 1);
      closenessValues.push(closeness);
    }
  }

  if (!closenessValues.length) return 0.4;
  const avg = closenessValues.reduce((sum, value) => sum + value, 0) / closenessValues.length;
  return clamp(avg, 0, 1);
}

function confidenceLevel(score) {
  if (score >= 80) return 'HIGH';
  if (score >= 50) return 'MEDIUM';
  return 'LOW';
}

function forensicConfidenceLabel(value) {
  if (value >= 0.8) return 'HIGH';
  if (value >= 0.5) return 'MEDIUM';
  return 'LOW';
}

function scoreForensicItem(item) {
  const sources = asArray(item && item.sources);
  const domains = asArray(item && item.domains);
  const hashes = asArray(item && item.hashes);
  const similarityAvg = clamp(toNumber(item && item.similarityAvg, 0.5), 0, 1);
  const textRepeatScore = clamp(toNumber(item && item.textRepeatScore, 0), 0, 1);
  const domainTrust = clamp(getDomainTrust(domains), 0, 1);
  const hashScore = clamp(hashSimilarityScore(hashes), 0, 1);
  const sourceConsistency = sources.length > 1 ? 1 : 0.45;
  const sourceCountBreakdown = clamp(sources.length / 5, 0, 1);

  let confidence =
    (similarityAvg * 0.30) +
    (sourceConsistency * 0.25) +
    (hashScore * 0.20) +
    (domainTrust * 0.15) +
    (textRepeatScore * 0.10);

  if (item && item.manipulated) {
    confidence *= 0.8;
  }

  if (sources.length <= 1) {
    confidence *= 0.7;
  }

  confidence = clamp(confidence, 0, 1);
  const confidencePercent = Math.round(confidence * 100);

  return {
    ...item,
    confidence,
    confidencePercent,
    confidenceLabel: forensicConfidenceLabel(confidence),
    score: confidencePercent,
    scoreBreakdown: {
      similarity: Math.round(similarityAvg * 100),
      sourceCount: Math.round(sourceCountBreakdown * 100),
      domainTrust: Math.round(domainTrust * 100),
      hashSimilarity: Math.round(hashScore * 100),
      textRepeat: Math.round(textRepeatScore * 100)
    },
    confidenceLevel: confidenceLevel(confidencePercent)
  };
}

function scoreItems(aggregatedItems, options = {}) {
  if (String(options && options.mode || '').toLowerCase() === 'forensic') {
    return asArray(aggregatedItems)
      .map((item) => scoreForensicItem(item))
      .sort((a, b) => b.confidencePercent - a.confidencePercent || b.occurrences - a.occurrences);
  }

  const weights = {
    ...DEFAULT_WEIGHTS,
    ...(options.weights || {})
  };

  const caps = {
    ...DEFAULT_CAPS,
    ...(options.caps || {})
  };

  const maxRaw =
    (caps.sourceCount * weights.sourceCountWeight) +
    weights.similarityWeight +
    (caps.occurrences * weights.occurrenceWeight) +
    weights.domainReputationWeight +
    weights.hashSimilarityWeight +
    weights.textRepeatWeight;

  return asArray(aggregatedItems)
    .map((item) => {
      const sources = asArray(item.sources);
      const occurrences = toNumber(item.occurrences, 0);
      const similarityAvg = clamp(toNumber(item.similarityAvg, 0.5), 0, 1);
      const domains = asArray(item.domains);
      const hashes = asArray(item.hashes);
      const textRepeatScore = clamp(toNumber(item.textRepeatScore, 0), 0, 1);
      const manipulated = Boolean(item.manipulated);
      const manipulationReasons = asArray(item && item.manipulation && item.manipulation.reasons)
        .filter((reason) => typeof reason === 'string' && reason.trim());

      const sourceCount = sources.length;
      const sourceCountCapped = clamp(sourceCount, 0, caps.sourceCount);
      const occurrenceCapped = clamp(occurrences, 0, caps.occurrences);
      const domainTrust = getDomainTrust(domains);
      const hashScore = hashSimilarityScore(hashes);
      const sourceCountBreakdown = caps.sourceCount > 0 ? clamp(sourceCountCapped / caps.sourceCount, 0, 1) : 0;

      const rawScore =
        (sourceCountCapped * weights.sourceCountWeight) +
        (similarityAvg * weights.similarityWeight) +
        (occurrenceCapped * weights.occurrenceWeight) +
        (domainTrust * weights.domainReputationWeight) +
        (hashScore * weights.hashSimilarityWeight) +
        (textRepeatScore * weights.textRepeatWeight) -
        (manipulated ? weights.manipulationPenaltyWeight : 0);

      const score = maxRaw > 0
        ? clamp(Math.round((rawScore / maxRaw) * 100), 0, 100)
        : 0;

      return {
        ...item,
        score,
        manipulated,
        scoreBreakdown: {
          similarity: Math.round(similarityAvg * 100),
          sourceCount: Math.round(sourceCountBreakdown * 100),
          domainTrust: Math.round(clamp(domainTrust, 0, 1) * 100),
          hashSimilarity: Math.round(clamp(hashScore, 0, 1) * 100),
          textRepeat: Math.round(textRepeatScore * 100)
        },
        scoreNotes: manipulated
          ? [`Manipulation signal: ${manipulationReasons.join(', ') || 'unspecified'}`]
          : [],
        confidenceLevel: confidenceLevel(score)
      };
    })
    .sort((a, b) => b.score - a.score || b.occurrences - a.occurrences);
}

module.exports = scoreItems;
