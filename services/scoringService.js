const { getDomainTrust } = require('../core/domainReputation');
const { normalizeUrl, extractDomainFromUrl } = require('../utils/resultAnalysis');

function qualitySignal(item) {
  const title = String(item && item.title ? item.title : '').trim();
  const detectedText = String(item && item.detectedText ? item.detectedText : '').trim();
  const sources = Array.isArray(item && item.sources) ? item.sources.length : 0;
  const score = Number(item && (item.qualityScore ?? item.score));

  return {
    score: Number.isFinite(score) ? score : 0,
    sourceCount: sources,
    hasDetectedText: Boolean(detectedText),
    hasSpecificTitle: Boolean(title && title.toLowerCase() !== 'provider result')
  };
}

function betterItem(a, b) {
  const qa = qualitySignal(a);
  const qb = qualitySignal(b);

  if (qa.score !== qb.score) return qa.score > qb.score ? a : b;
  if (qa.sourceCount !== qb.sourceCount) return qa.sourceCount > qb.sourceCount ? a : b;
  if (qa.hasDetectedText !== qb.hasDetectedText) return qa.hasDetectedText ? a : b;
  if (qa.hasSpecificTitle !== qb.hasSpecificTitle) return qa.hasSpecificTitle ? a : b;
  return a;
}

function normalizePercentScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num <= 1) return Math.round(Math.max(0, Math.min(1, num)) * 100);
  return Math.round(Math.max(0, Math.min(100, num)));
}

function calculateScore(item) {
  const sources = Array.isArray(item && item.sources) ? item.sources.length : 0;
  const sourceComponent = Math.max(0, Math.min(100, sources * 25));
  const similarityComponent = normalizePercentScore(item && item.similarityAvg);
  const qualityComponent = normalizePercentScore(item && (item.qualityScore ?? item.score));
  const domains = Array.isArray(item && item.domains)
    ? item.domains.filter(Boolean)
    : item && item.domain
      ? [item.domain]
      : [];
  const domainTrust = normalizePercentScore(getDomainTrust(domains));
  const hashSimilarity = normalizePercentScore(item && item.hashSimilarity);
  const textRepeat = normalizePercentScore(item && item.textRepeatScore);

  const scoreBreakdown = {
    similarity: similarityComponent,
    sourceCount: sourceComponent,
    domainTrust,
    hashSimilarity,
    textRepeat
  };

  return {
    sourceCount: sources,
    sourceComponent,
    similarityComponent,
    qualityComponent,
    scoreBreakdown,
    score: Math.round(sourceComponent * 0.5 + similarityComponent * 0.5),
    qualityScore: qualityComponent
  };
}

const buildAnalysisScore = calculateScore;

function decorateResultWithAnalysisScore(item) {
  if (!item || typeof item !== 'object') return item;

  const analysis = calculateScore(item);
  return {
    ...item,
    ...analysis
  };
}

function filterProviderItems(items, minScore = 30) {
  const list = Array.isArray(items) ? items : [];
  const threshold = Number.isFinite(Number(minScore)) ? Number(minScore) : 30;
  const deduped = new Map();
  const stats = {
    inputCount: list.length,
    invalidUrlBlocked: 0,
    spamBlocked: 0,
    lowScoreBlocked: 0,
    dedupedCount: 0
  };

  list.forEach((item) => {
    const normalized = normalizeUrl(item && item.url);
    if (!normalized) {
      stats.invalidUrlBlocked += 1;
      return;
    }

    const domain =
      String(item && item.domain ? item.domain : '').trim() || extractDomainFromUrl(normalized);
    if (/spam|junk|fake|tracker|affiliate|clickbait/i.test(domain)) {
      stats.spamBlocked += 1;
      return;
    }

    const score = Number(item && (item.qualityScore ?? item.score));
    const effectiveScore = Number.isFinite(score) ? score : 0;
    if (effectiveScore < threshold) {
      stats.lowScoreBlocked += 1;
      return;
    }

    const candidate = {
      ...item,
      url: normalized,
      domain
    };
    const existing = deduped.get(normalized);
    if (existing) {
      deduped.set(normalized, betterItem(existing, candidate));
    } else {
      deduped.set(normalized, candidate);
    }
  });

  stats.dedupedCount = deduped.size;

  return {
    items: Array.from(deduped.values()),
    stats
  };
}

module.exports = {
  calculateScore,
  betterItem,
  normalizePercentScore,
  buildAnalysisScore,
  decorateResultWithAnalysisScore,
  filterProviderItems
};
