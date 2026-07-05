function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toTextCandidates(item) {
  const list = [];

  if (typeof item?.detectedText === 'string' && item.detectedText.trim()) {
    list.push(item.detectedText);
  }

  asArray(item?.detectedTexts).forEach((entry) => {
    if (entry && typeof entry.text === 'string' && entry.text.trim()) {
      list.push(entry.text);
    }
  });

  return Array.from(new Set(list.map((value) => normalizeText(value)).filter(Boolean)));
}

function jaccardSimilarity(a, b) {
  const left = new Set(normalizeText(a).split(' ').filter((token) => token.length >= 3));
  const right = new Set(normalizeText(b).split(' ').filter((token) => token.length >= 3));
  if (!left.size || !right.size) return 0;

  let intersection = 0;
  left.forEach((token) => {
    if (right.has(token)) intersection += 1;
  });

  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 0;
}

function buildFrequencyMap(items, fieldName) {
  const map = new Map();
  asArray(items).forEach((item) => {
    const values = asArray(item && item[fieldName]).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
    values.forEach((value) => {
      map.set(value, (map.get(value) || 0) + 1);
    });
  });
  return map;
}

function computeConsistency(item, contextItems, sourceFreqMap, domainFreqMap) {
  const totalItems = Math.max(1, asArray(contextItems).length);
  const sources = asArray(item && item.sources).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  const domains = asArray(item && item.domains).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);

  const sourceCoverage = clamp(sources.length / 4, 0, 1);
  const domainCoverage = clamp(domains.length / 3, 0, 1);

  const sourceConsensus = sources.length
    ? Math.max(...sources.map((source) => (sourceFreqMap.get(source) || 0) / totalItems))
    : 0;

  const domainConsensus = domains.length
    ? Math.max(...domains.map((domain) => (domainFreqMap.get(domain) || 0) / totalItems))
    : 0;

  const score = clamp(
    (sourceCoverage * 0.35) +
    (domainCoverage * 0.25) +
    (sourceConsensus * 0.2) +
    (domainConsensus * 0.2),
    0,
    1
  );

  return {
    score: Number(score.toFixed(2)),
    sourceCount: sources.length,
    domainCount: domains.length,
    sourceConsensus: Number(sourceConsensus.toFixed(2)),
    domainConsensus: Number(domainConsensus.toFixed(2))
  };
}

function computeContradictions(item, contextItems) {
  const ownTexts = toTextCandidates(item);
  if (!ownTexts.length) {
    return {
      count: 0,
      hasContradiction: false,
      samples: []
    };
  }

  const ownDomains = new Set(asArray(item && item.domains).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
  const samples = [];

  asArray(contextItems).forEach((candidate) => {
    if (!candidate || candidate === item) return;

    const candidateDomains = asArray(candidate && candidate.domains)
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean);

    const relatedByDomain = candidateDomains.some((domain) => ownDomains.has(domain));
    if (!relatedByDomain) return;

    const candidateTexts = toTextCandidates(candidate);
    if (!candidateTexts.length) return;

    let bestSimilarity = 0;
    ownTexts.forEach((left) => {
      candidateTexts.forEach((right) => {
        bestSimilarity = Math.max(bestSimilarity, jaccardSimilarity(left, right));
      });
    });

    if (bestSimilarity < 0.25) {
      samples.push({
        url: String(candidate.url || ''),
        similarity: Number(bestSimilarity.toFixed(2))
      });
    }
  });

  const uniqueByUrl = Array.from(new Map(samples.map((sample) => [sample.url, sample])).values());
  return {
    count: uniqueByUrl.length,
    hasContradiction: uniqueByUrl.length > 0,
    samples: uniqueByUrl.slice(0, 5)
  };
}

function pickConclusion(consistency, contradictions, manipulated) {
  if (manipulated || contradictions.count >= 2 || consistency.score < 0.4) {
    return 'Possibly manipulated';
  }

  if (consistency.score >= 0.7 && contradictions.count === 0) {
    return 'Likely authentic';
  }

  return 'Uncertain';
}

function analyzeItemLogical(item, contextItems, sourceFreqMap, domainFreqMap) {
  const consistency = computeConsistency(item, contextItems, sourceFreqMap, domainFreqMap);
  const contradictions = computeContradictions(item, contextItems);
  const conclusion = pickConclusion(consistency, contradictions, Boolean(item && item.manipulated));

  return {
    consistency,
    contradictions,
    conclusion
  };
}

function analyzeItemsLogical(items) {
  const list = asArray(items);
  const sourceFreqMap = buildFrequencyMap(list, 'sources');
  const domainFreqMap = buildFrequencyMap(list, 'domains');

  return list.map((item) => ({
    ...item,
    logicAnalysis: analyzeItemLogical(item, list, sourceFreqMap, domainFreqMap)
  }));
}

module.exports = {
  analyzeItemLogical,
  analyzeItemsLogical
};
