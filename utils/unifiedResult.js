const { isValidHttpUrl } = require('./url');

function toText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asObject(value) {
  return value && typeof value === 'object' ? value : null;
}

function pickFirstText(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  for (const value of list) {
    const text = toText(value);
    if (text) return text;
  }
  return '';
}

function getNested(obj, path) {
  if (!obj || !Array.isArray(path)) return undefined;

  let current = obj;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !(key in current)) {
      return undefined;
    }
    current = current[key];
  }

  return current;
}

function pickFirstNestedText(obj, paths) {
  const list = Array.isArray(paths) ? paths : [];
  for (const path of list) {
    const text = toText(getNested(obj, path));
    if (text) return text;
  }
  return '';
}

function toSimilarity(rawItem) {
  const sourceObj = asObject(rawItem) || {};

  const direct = Number(sourceObj.similarity);
  if (Number.isFinite(direct)) {
    return Math.max(0, Math.min(1, direct));
  }

  const relevance = Number(sourceObj.relevance);
  if (Number.isFinite(relevance)) {
    const normalized = relevance > 1 ? relevance / 100 : relevance;
    return Math.max(0, Math.min(1, normalized));
  }

  const matches = Number(sourceObj.matches || sourceObj.matchCount);
  if (Number.isFinite(matches) && matches > 0) {
    return Math.max(0, Math.min(1, 0.5 + Math.min(matches, 20) / 40));
  }

  return 0.5;
}

function toTimestamp(rawItem, fallbackDate = new Date()) {
  const sourceObj = asObject(rawItem) || {};
  const candidate = pickFirstText([
    sourceObj.timestamp,
    sourceObj.date,
    sourceObj.createdAt,
    sourceObj.updatedAt
  ]);

  if (candidate) {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return fallbackDate.toISOString();
}

function toUnifiedResult(sourceName, rawItem, context = {}) {
  const sourceObj = asObject(rawItem) || {};

  const url = pickFirstText([
    sourceObj.url,
    sourceObj.link,
    sourceObj.resultUrl,
    sourceObj.targetUrl,
    sourceObj.jsonUrl,
    sourceObj.redirectUrl,
    pickFirstNestedText(sourceObj, [
      ['result', 'url'],
      ['result', 'link'],
      ['bestMatch', 'url'],
      ['best', 'url'],
      ['data', 'url']
    ])
  ]);

  if (!url) return null;
  if (!isValidHttpUrl(url)) return null;

  const title = pickFirstText([
    sourceObj.title,
    sourceObj.name,
    sourceObj.label,
    sourceObj.caption,
    sourceObj.headline,
    sourceObj.text,
    sourceObj.source,
    `${sourceName} result`
  ]);

  const thumbnail = pickFirstText([
    sourceObj.thumbnail,
    sourceObj.thumb,
    sourceObj.image,
    sourceObj.imageUrl,
    pickFirstNestedText(sourceObj, [
      ['result', 'thumbnail'],
      ['result', 'image'],
      ['bestMatch', 'thumbnail'],
      ['best', 'thumbnail']
    ])
  ]);

  return {
    source: sourceName,
    title,
    url,
    thumbnail,
    similarity: toSimilarity(sourceObj),
    timestamp: toTimestamp(sourceObj)
  };
}

module.exports = {
  toUnifiedResult
};