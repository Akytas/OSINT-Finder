const { detectManipulation } = require('../core/manipulationDetector');
const { compareHashes } = require('../utils/imageHash');
const { normalizeUrl, extractDomainFromUrl } = require('../utils/resultAnalysis');

function normalizeTextForSimilarity(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textSimilarity(a, b) {
  const ta = normalizeTextForSimilarity(a)
    .split(' ')
    .filter((token) => token.length >= 3);
  const tb = normalizeTextForSimilarity(b)
    .split(' ')
    .filter((token) => token.length >= 3);
  if (!ta.length || !tb.length) return 0;

  const aSet = new Set(ta);
  const bSet = new Set(tb);
  let intersection = 0;
  aSet.forEach((token) => {
    if (bSet.has(token)) intersection += 1;
  });

  const union = new Set([...aSet, ...bSet]).size;
  return union ? intersection / union : 0;
}

function hasVisualSimilarity(hashListA, hashListB, maxDistance = 10) {
  const left = Array.isArray(hashListA) ? hashListA.filter(Boolean) : [];
  const right = Array.isArray(hashListB) ? hashListB.filter(Boolean) : [];
  if (!left.length || !right.length) return false;

  for (const hashA of left) {
    for (const hashB of right) {
      const distance = compareHashes(hashA, hashB);
      if (Number.isFinite(distance) && distance <= maxDistance) {
        return true;
      }
    }
  }

  return false;
}

function clusterFind(parent, index) {
  if (parent[index] !== index) {
    parent[index] = clusterFind(parent, parent[index]);
  }
  return parent[index];
}

function clusterUnion(parent, rank, a, b) {
  const rootA = clusterFind(parent, a);
  const rootB = clusterFind(parent, b);
  if (rootA === rootB) return;

  if (rank[rootA] < rank[rootB]) {
    parent[rootA] = rootB;
    return;
  }

  if (rank[rootA] > rank[rootB]) {
    parent[rootB] = rootA;
    return;
  }

  parent[rootB] = rootA;
  rank[rootA] += 1;
}

function normalizeTerm(value) {
  return String(value || '').trim();
}

function pickPrimaryDomain(item) {
  if (!item || typeof item !== 'object') return '';

  const directDomain = normalizeTerm(item.domain || '');
  if (directDomain) return directDomain;

  if (Array.isArray(item.domains)) {
    for (const entry of item.domains) {
      const candidate = normalizeTerm(entry);
      if (candidate) return candidate;
    }
  }

  const normalizedUrl = normalizeUrl(item.url || item.link || '');
  return normalizedUrl ? extractDomainFromUrl(normalizedUrl) : '';
}

function buildEnrichmentMap(providerScoredResults, providerNormalizedResults) {
  const map = new Map();

  (Array.isArray(providerScoredResults) ? providerScoredResults : []).forEach((item) => {
    const url = normalizeUrl(item && item.url);
    if (!url) return;
    const hashes = Array.isArray(item && item.hashes) ? item.hashes.filter(Boolean) : [];
    const topText =
      Array.isArray(item && item.detectedTexts) && item.detectedTexts.length
        ? item.detectedTexts[0].text
        : '';

    map.set(url, {
      hashes,
      text: topText || '',
      domain: pickPrimaryDomain(item)
    });
  });

  (Array.isArray(providerNormalizedResults) ? providerNormalizedResults : []).forEach((item) => {
    const url = normalizeUrl(item && item.url);
    if (!url) return;

    const existing = map.get(url) || { hashes: [], text: '', domain: '' };
    const hash = item && typeof item.hash === 'string' ? item.hash.trim() : '';

    map.set(url, {
      hashes: hash ? Array.from(new Set([...existing.hashes, hash])) : existing.hashes,
      text: existing.text || (item && item.detectedText ? String(item.detectedText) : ''),
      domain: existing.domain || pickPrimaryDomain(item)
    });
  });

  return map;
}

function buildClusters(items, enrichmentMap) {
  const list = (Array.isArray(items) ? items : [])
    .map((item) => {
      const url = normalizeUrl(item && item.url);
      if (!url) return null;
      const enrich = enrichmentMap && enrichmentMap.get(url) ? enrichmentMap.get(url) : null;
      return {
        item: {
          ...item,
          url
        },
        domain: (item && item.domain) || (enrich && enrich.domain) || extractDomainFromUrl(url),
        hashes: enrich && Array.isArray(enrich.hashes) ? enrich.hashes : [],
        text: (item && item.detectedText) || (enrich && enrich.text) || ''
      };
    })
    .filter(Boolean);

  if (!list.length) return [];

  const parent = list.map((_, index) => index);
  const rank = list.map(() => 0);

  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const sameDomain = list[i].domain && list[j].domain && list[i].domain === list[j].domain;
      const visualMatch = hasVisualSimilarity(list[i].hashes, list[j].hashes);
      const textMatch = textSimilarity(list[i].text, list[j].text) >= 0.6;

      if (sameDomain || visualMatch || textMatch) {
        clusterUnion(parent, rank, i, j);
      }
    }
  }

  const grouped = new Map();
  list.forEach((entry, index) => {
    const root = clusterFind(parent, index);
    const bucket = grouped.get(root);
    if (bucket) {
      bucket.push(entry);
    } else {
      grouped.set(root, [entry]);
    }
  });

  let clusterIndex = 1;
  return Array.from(grouped.values())
    .map((entries) => {
      const domainCount = new Map();
      let scoreSum = 0;
      let scoreCount = 0;

      entries.forEach((entry) => {
        const domain = String(entry.domain || '').trim();
        if (domain) {
          domainCount.set(domain, (domainCount.get(domain) || 0) + 1);
        }

        const score = Number(entry.item && entry.item.score);
        if (Number.isFinite(score)) {
          scoreSum += score;
          scoreCount += 1;
        }
      });

      const dominantDomain = Array.from(domainCount.entries()).sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
      )[0];

      return {
        clusterId: `cluster_${clusterIndex++}`,
        items: entries.map((entry) => entry.item),
        dominantDomain: dominantDomain ? dominantDomain[0] : '',
        avgScore: scoreCount ? Number((scoreSum / scoreCount).toFixed(2)) : 0
      };
    })
    .sort((a, b) => b.avgScore - a.avgScore || b.items.length - a.items.length);
}

function analyzeResults(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const withManipulation = options.forensicMode
    ? list.map((item) => ({
        ...item,
        manipulation: detectManipulation(item)
      }))
    : list;

  const enrichmentMap = buildEnrichmentMap(
    options.providerScoredResults,
    options.providerNormalizedResults
  );
  const clusters = buildClusters(withManipulation, enrichmentMap);

  return {
    results: withManipulation,
    clusters
  };
}

module.exports = {
  analyzeResults,
  buildClusters,
  buildEnrichmentMap,
  hasVisualSimilarity,
  normalizeTextForSimilarity,
  pickPrimaryDomain,
  textSimilarity
};
