const { isValidHttpUrl } = require('./url');

function normalizeUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (!isValidHttpUrl(url)) return '';

  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function extractDomainFromUrl(url) {
  try {
    return new URL(url).hostname || '';
  } catch {
    return '';
  }
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getItemText(item) {
  const candidates = [
    item && item.title,
    item && item.detectedText,
    item && item.explanation,
    item && item.source
  ];

  for (const candidate of candidates) {
    const value = normalizeText(candidate);
    if (value) return value;
  }

  return '';
}

function getItemHash(item) {
  const hashes = [
    item && item.hash,
    item && item.imageHash,
    item && item.phash
  ];

  for (const candidate of hashes) {
    const value = String(candidate || '').trim().toLowerCase();
    if (value) return value;
  }

  return '';
}

function groupByDomain(results) {
  const groups = new Map();

  (Array.isArray(results) ? results : []).forEach((item) => {
    const url = normalizeUrl(item && item.url);
    if (!url) return;

    const domain = String(item && item.domain ? item.domain : '').trim() || extractDomainFromUrl(url) || 'unknown';
    const existing = groups.get(domain) || {
      domain,
      count: 0,
      urls: new Set(),
      items: []
    };

    existing.count += 1;
    existing.urls.add(url);
    existing.items.push({
      url,
      title: item && item.title ? String(item.title) : '',
      source: item && item.source ? String(item.source) : '',
      score: Number.isFinite(Number(item && item.score)) ? Number(item.score) : 0
    });

    groups.set(domain, existing);
  });

  return Array.from(groups.values())
    .map((group) => {
      const topItem = group.items
        .slice()
        .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))[0] || null;

      return {
        domain: group.domain,
        count: group.count,
        uniqueUrls: group.urls.size,
        urls: Array.from(group.urls),
        topTitle: topItem ? topItem.title : '',
        items: group.items
      };
    })
    .sort((a, b) => b.count - a.count || b.uniqueUrls - a.uniqueUrls || a.domain.localeCompare(b.domain));
}

function findMostFrequentMatches(results) {
  const urlCounts = new Map();
  const hashCounts = new Map();
  const textCounts = new Map();

  (Array.isArray(results) ? results : []).forEach((item) => {
    const url = normalizeUrl(item && item.url);
    if (url) {
      const current = urlCounts.get(url) || { url, count: 0, items: [] };
      current.count += 1;
      current.items.push(item);
      urlCounts.set(url, current);
    }

    const hash = getItemHash(item);
    if (hash) {
      const current = hashCounts.get(hash) || { hash, count: 0, items: [] };
      current.count += 1;
      current.items.push(item);
      hashCounts.set(hash, current);
    }

    const text = getItemText(item);
    if (text) {
      const current = textCounts.get(text) || { text, count: 0, items: [] };
      current.count += 1;
      current.items.push(item);
      textCounts.set(text, current);
    }
  });

  const toTopMatches = (collection, keyName) => Array.from(collection.values())
    .filter((entry) => entry.count > 1)
    .sort((a, b) => b.count - a.count || String(a[keyName] || '').localeCompare(String(b[keyName] || '')))
    .map((entry) => ({
      [keyName]: entry[keyName],
      count: entry.count,
      items: entry.items
    }));

  return {
    duplicateUrls: toTopMatches(urlCounts, 'url'),
    duplicateHashes: toTopMatches(hashCounts, 'hash'),
    duplicateTexts: toTopMatches(textCounts, 'text')
  };
}

module.exports = {
  groupByDomain,
  findMostFrequentMatches,
  normalizeUrl,
  extractDomainFromUrl
};