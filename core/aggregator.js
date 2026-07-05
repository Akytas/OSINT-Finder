const { isValidHttpUrl } = require('../utils/url');

function toText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toUrlKey(url) {
  return toText(url).toLowerCase();
}

function clampSimilarity(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0.5;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

function extractDomain(url) {
  try {
    return new URL(url).hostname || '';
  } catch {
    return '';
  }
}

function normalizeHash(hash) {
  return toText(hash).toLowerCase();
}

function normalizeDetectedText(text) {
  return toText(text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function toDimension(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const int = Math.floor(num);
  return int > 0 ? int : null;
}

function normalizeSegments(segments) {
  if (!Array.isArray(segments)) return [];
  return segments
    .map((part) => toText(part).toLowerCase())
    .filter(Boolean);
}

function splitHashSegments(hash, segmentCount = 4) {
  const value = normalizeHash(hash);
  if (!value) return [];

  const segmentLength = Math.floor(value.length / segmentCount);
  if (segmentLength < 1) return [];

  const segments = [];
  for (let i = 0; i < segmentCount; i += 1) {
    const start = i * segmentLength;
    const end = i === segmentCount - 1 ? value.length : start + segmentLength;
    const part = value.slice(start, end);
    if (part) segments.push(part);
  }

  return segments;
}

function countSharedSegments(a, b) {
  const left = new Set(normalizeSegments(a));
  const right = new Set(normalizeSegments(b));
  if (!left.size || !right.size) return 0;

  let shared = 0;
  left.forEach((segment) => {
    if (right.has(segment)) shared += 1;
  });

  return shared;
}

function aspectRatio(width, height) {
  if (!width || !height) return null;
  return width / height;
}

function detectManipulationSignals(dimensionEntries, hashEntries, options = {}) {
  const resizeRatioTolerance = Number.isFinite(Number(options.resizeRatioTolerance))
    ? Number(options.resizeRatioTolerance)
    : 0.03;
  const resizeScaleThreshold = Number.isFinite(Number(options.resizeScaleThreshold))
    ? Number(options.resizeScaleThreshold)
    : 1.2;
  const cropRatioThreshold = Number.isFinite(Number(options.cropRatioThreshold))
    ? Number(options.cropRatioThreshold)
    : 0.08;
  const lowSimilarityDistance = Number.isFinite(Number(options.lowSimilarityDistance))
    ? Number(options.lowSimilarityDistance)
    : 8;
  const minSharedSegments = Number.isFinite(Number(options.minSharedSegments))
    ? Number(options.minSharedSegments)
    : 1;

  let resized = false;
  let cropped = false;
  let segmentMatchOnLowSimilarity = false;

  const cleanDimensions = Array.isArray(dimensionEntries)
    ? dimensionEntries.filter((entry) => entry && entry.width && entry.height)
    : [];
  const cleanHashes = Array.isArray(hashEntries)
    ? hashEntries.filter((entry) => entry && entry.hash)
    : [];

  for (let i = 0; i < cleanDimensions.length; i += 1) {
    for (let j = i + 1; j < cleanDimensions.length; j += 1) {
      const a = cleanDimensions[i];
      const b = cleanDimensions[j];

      const ratioA = aspectRatio(a.width, a.height);
      const ratioB = aspectRatio(b.width, b.height);
      if (!ratioA || !ratioB) continue;

      const ratioDelta = Math.abs(ratioA - ratioB) / Math.max(ratioA, ratioB);
      const areaA = a.width * a.height;
      const areaB = b.width * b.height;
      const areaScale = Math.max(areaA, areaB) / Math.max(1, Math.min(areaA, areaB));

      if (ratioDelta <= resizeRatioTolerance && areaScale >= resizeScaleThreshold) {
        resized = true;
      }

      if (ratioDelta >= cropRatioThreshold) {
        cropped = true;
      }
    }
  }

  for (let i = 0; i < cleanHashes.length; i += 1) {
    for (let j = i + 1; j < cleanHashes.length; j += 1) {
      const a = cleanHashes[i];
      const b = cleanHashes[j];
      const distance = hammingDistance(a.hash, b.hash);
      if (!Number.isFinite(distance)) continue;

      const shared = countSharedSegments(a.segments, b.segments);
      if (distance >= lowSimilarityDistance && shared >= minSharedSegments) {
        segmentMatchOnLowSimilarity = true;
      }
    }
  }

  const manipulated = resized || cropped || segmentMatchOnLowSimilarity;
  const reasons = [];
  if (resized) reasons.push('resized');
  if (cropped) reasons.push('cropped');
  if (segmentMatchOnLowSimilarity) reasons.push('low_similarity_same_hash_segments');

  return {
    manipulated,
    resized,
    cropped,
    segmentMatchOnLowSimilarity,
    reasons
  };
}

function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;

  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      distance += 1;
    }
  }

  return distance;
}

function hasSimilarHash(hashesA, hashesB, maxDistance) {
  if (!hashesA.size || !hashesB.size) return false;

  for (const hashA of hashesA) {
    for (const hashB of hashesB) {
      if (hammingDistance(hashA, hashB) < maxDistance) {
        return true;
      }
    }
  }

  return false;
}

function find(parent, x) {
  if (parent[x] !== x) {
    parent[x] = find(parent, parent[x]);
  }
  return parent[x];
}

function union(parent, rank, a, b) {
  const rootA = find(parent, a);
  const rootB = find(parent, b);

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

function aggregateByUrl(items) {
  const byUrl = new Map();

  (Array.isArray(items) ? items : []).forEach((item) => {
    if (!item || typeof item !== 'object') return;

    const url = toText(item.url);
    if (!url) return;
    if (!isValidHttpUrl(url)) return;

    const key = toUrlKey(url);
    const similarity = clampSimilarity(item.similarity);
    const source = toText(item.source);
    const title = toText(item.title);
    const thumbnail = toText(item.thumbnail);
    const hash = normalizeHash(item.hash);
    const hashSegments = normalizeSegments(item.hashSegments);
    const domain = toText(item.domain) || extractDomain(url);
    const imageWidth = toDimension(item.imageWidth || item.width);
    const imageHeight = toDimension(item.imageHeight || item.height);
    const detectedText = toText(item.detectedText);
    const detectedTextKey = normalizeDetectedText(detectedText);
    const ocrConfidence = Number.isFinite(Number(item.ocrConfidence))
      ? Math.max(0, Math.min(1, Number(item.ocrConfidence)))
      : 0;

    let entry = byUrl.get(key);
    if (!entry) {
      entry = {
        url,
        title: title || url,
        thumbnail: thumbnail || '',
        sources: new Set(),
        occurrences: 0,
        similaritySum: 0,
        similarityCount: 0,
        domains: new Set(),
        hashes: new Set(),
        hashEntries: [],
        dimensions: [],
        textEntries: []
      };
      byUrl.set(key, entry);
    }

    if (!entry.title && title) entry.title = title;
    if (!entry.thumbnail && thumbnail) entry.thumbnail = thumbnail;
    if (source) entry.sources.add(source);
    if (domain) entry.domains.add(domain);
    if (hash) entry.hashes.add(hash);
    if (hash) {
      entry.hashEntries.push({
        hash,
        segments: hashSegments.length ? hashSegments : splitHashSegments(hash),
        source
      });
    }
    if (imageWidth && imageHeight) {
      entry.dimensions.push({
        width: imageWidth,
        height: imageHeight,
        source,
        hash
      });
    }
    if (detectedText && detectedTextKey) {
      entry.textEntries.push({
        text: detectedText,
        textKey: detectedTextKey,
        source,
        confidence: ocrConfidence
      });
    }

    entry.occurrences += 1;
    entry.similaritySum += similarity;
    entry.similarityCount += 1;
  });

  return Array.from(byUrl.values());
}

function mergeCluster(entries) {
  const sorted = entries.slice().sort((a, b) => b.occurrences - a.occurrences || a.url.localeCompare(b.url));
  const representative = sorted[0];

  let totalOccurrences = 0;
  let totalSimilaritySum = 0;
  let totalSimilarityCount = 0;
  const sources = new Set();
  const domains = new Set();
  const hashes = new Set();
  const hashEntries = [];
  const dimensions = [];
  const textMap = new Map();
  let title = representative.title || representative.url;
  let thumbnail = representative.thumbnail || '';

  entries.forEach((entry) => {
    totalOccurrences += entry.occurrences;
    totalSimilaritySum += entry.similaritySum;
    totalSimilarityCount += entry.similarityCount;

    entry.sources.forEach((value) => sources.add(value));
    entry.domains.forEach((value) => domains.add(value));
    entry.hashes.forEach((value) => hashes.add(value));
    entry.hashEntries.forEach((value) => hashEntries.push(value));
    entry.dimensions.forEach((value) => dimensions.push(value));
    entry.textEntries.forEach((textEntry) => {
      const bucket = textMap.get(textEntry.textKey) || {
        text: textEntry.text,
        sourceSet: new Set(),
        confidenceSum: 0,
        confidenceCount: 0
      };

      if (textEntry.source) {
        bucket.sourceSet.add(textEntry.source);
      }
      bucket.confidenceSum += textEntry.confidence;
      bucket.confidenceCount += 1;
      if (!bucket.text && textEntry.text) {
        bucket.text = textEntry.text;
      }

      textMap.set(textEntry.textKey, bucket);
    });

    if (!thumbnail && entry.thumbnail) thumbnail = entry.thumbnail;
    if ((!title || title === representative.url) && entry.title) title = entry.title;
  });

  const similarityAvg = totalSimilarityCount
    ? Number((totalSimilaritySum / totalSimilarityCount).toFixed(4))
    : 0;

  const detectedTexts = Array.from(textMap.values())
    .map((item) => ({
      text: item.text,
      sources: Array.from(item.sourceSet),
      sourceCount: item.sourceSet.size,
      confidence: item.confidenceCount
        ? Number((item.confidenceSum / item.confidenceCount).toFixed(4))
        : 0
    }))
    .sort((a, b) => b.sourceCount - a.sourceCount || b.confidence - a.confidence || a.text.localeCompare(b.text));

  const sourceCount = Math.max(1, sources.size);
  const maxTextSourceCount = detectedTexts.length
    ? detectedTexts[0].sourceCount
    : 0;
  const textRepeatScore = sourceCount > 1
    ? Number((Math.max(0, (maxTextSourceCount - 1) / (sourceCount - 1))).toFixed(4))
    : 0;

  const manipulation = detectManipulationSignals(dimensions, hashEntries);
  const uniqueDimensions = Array.from(new Set(
    dimensions.map((item) => `${item.width}x${item.height}`)
  ));

  return {
    url: representative.url,
    title: title || representative.url,
    thumbnail: thumbnail || null,
    sources: Array.from(sources),
    occurrences: totalOccurrences,
    similarityAvg,
    domains: Array.from(domains),
    hashes: Array.from(hashes),
    dimensions: uniqueDimensions,
    detectedTexts,
    textRepeatScore,
    manipulated: manipulation.manipulated,
    manipulation
  };
}

function aggregate(normalizedItems, options = {}) {
  const hashMaxDistance = Number.isFinite(Number(options.hashMaxDistance))
    ? Number(options.hashMaxDistance)
    : 10;

  const urlEntries = aggregateByUrl(normalizedItems);
  if (!urlEntries.length) return [];

  const parent = urlEntries.map((_, index) => index);
  const rank = urlEntries.map(() => 0);

  for (let i = 0; i < urlEntries.length; i += 1) {
    for (let j = i + 1; j < urlEntries.length; j += 1) {
      if (hasSimilarHash(urlEntries[i].hashes, urlEntries[j].hashes, hashMaxDistance)) {
        union(parent, rank, i, j);
      }
    }
  }

  const clusters = new Map();
  urlEntries.forEach((entry, index) => {
    const root = find(parent, index);
    const bucket = clusters.get(root);
    if (bucket) {
      bucket.push(entry);
    } else {
      clusters.set(root, [entry]);
    }
  });

  return Array.from(clusters.values())
    .map((clusterEntries) => mergeCluster(clusterEntries))
    .sort((a, b) => b.occurrences - a.occurrences || a.url.localeCompare(b.url));
}

module.exports = aggregate;
