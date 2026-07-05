const { Jimp } = require('jimp');
const { requestWithRetry } = require('./request');

const DEFAULT_TIMEOUT_MS = 5000;

function toHex(bits) {
  const padded = bits.padEnd(Math.ceil(bits.length / 4) * 4, '0');
  let hex = '';

  for (let i = 0; i < padded.length; i += 4) {
    const nibble = padded.slice(i, i + 4);
    hex += Number.parseInt(nibble, 2).toString(16);
  }

  return hex;
}

function splitHashSegments(hash, segmentCount = 4) {
  const value = typeof hash === 'string' ? hash.trim().toLowerCase() : '';
  if (!value || !/^[0-9a-f]+$/i.test(value) || segmentCount < 1) return [];

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

function hexNibbleDistance(a, b) {
  const xor = Number.parseInt(a, 16) ^ Number.parseInt(b, 16);
  let bits = xor;
  let count = 0;

  while (bits > 0) {
    count += bits & 1;
    bits >>= 1;
  }

  return count;
}

function compareHashes(hash1, hash2) {
  const a = typeof hash1 === 'string' ? hash1.trim().toLowerCase() : '';
  const b = typeof hash2 === 'string' ? hash2.trim().toLowerCase() : '';

  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return Number.POSITIVE_INFINITY;

  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    distance += hexNibbleDistance(a[i], b[i]);
  }

  return distance;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getLuma(data, width, height, x, y) {
  const px = clamp(x, 0, width - 1);
  const py = clamp(y, 0, height - 1);
  const index = (py * width + px) * 4;

  const r = data[index] || 0;
  const g = data[index + 1] || 0;
  const b = data[index + 2] || 0;

  // ITU-R BT.709 luminance.
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function sampleGrid(bitmap, targetWidth, targetHeight) {
  const { data, width, height } = bitmap;
  const grid = [];

  for (let y = 0; y < targetHeight; y += 1) {
    const row = [];
    const srcY = clamp(Math.floor(((y + 0.5) * height) / targetHeight), 0, height - 1);

    for (let x = 0; x < targetWidth; x += 1) {
      const srcX = clamp(Math.floor(((x + 0.5) * width) / targetWidth), 0, width - 1);
      row.push(getLuma(data, width, height, srcX, srcY));
    }

    grid.push(row);
  }

  return grid;
}

async function computeDHashFromBuffer(imageBuffer) {
  const image = await Jimp.read(imageBuffer);
  const bitmap = image && image.bitmap ? image.bitmap : null;
  if (!bitmap || !bitmap.width || !bitmap.height || !bitmap.data) {
    throw new Error('Invalid image bitmap.');
  }

  const grid = sampleGrid(bitmap, 9, 8);

  let bits = '';
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = grid[y][x];
      const right = grid[y][x + 1];
      bits += left < right ? '1' : '0';
    }
  }

  return toHex(bits);
}

async function computePHashFromBuffer(imageBuffer) {
  const image = await Jimp.read(imageBuffer);
  const bitmap = image && image.bitmap ? image.bitmap : null;
  if (!bitmap || !bitmap.width || !bitmap.height || !bitmap.data) {
    throw new Error('Invalid image bitmap.');
  }

  const grid = sampleGrid(bitmap, 8, 8);
  const values = [];

  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      values.push(grid[y][x]);
    }
  }

  const avg = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const bits = values.map((value) => (value >= avg ? '1' : '0')).join('');
  return toHex(bits);
}

function compareHashesDetailed(hash1, hash2) {
  const distance = compareHashes(hash1, hash2);
  let matchLevel = 'LOW';

  if (Number.isFinite(distance) && distance <= 4) {
    matchLevel = 'HIGH';
  } else if (Number.isFinite(distance) && distance <= 10) {
    matchLevel = 'MEDIUM';
  }

  return {
    distance,
    matchLevel
  };
}

async function computeImageFingerprintFromBuffer(imageBuffer) {
  const image = await Jimp.read(imageBuffer);
  const bitmap = image && image.bitmap ? image.bitmap : null;
  if (!bitmap || !bitmap.width || !bitmap.height || !bitmap.data) {
    throw new Error('Invalid image bitmap.');
  }

  const grid = sampleGrid(bitmap, 9, 8);

  let bits = '';
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = grid[y][x];
      const right = grid[y][x + 1];
      bits += left < right ? '1' : '0';
    }
  }

  const hash = toHex(bits);
  let pHash = '';
  try {
    pHash = await computePHashFromBuffer(imageBuffer);
  } catch {
    pHash = '';
  }

  return {
    hash,
    dHash: hash,
    pHash,
    width: bitmap.width,
    height: bitmap.height,
    segments: splitHashSegments(hash),
    hashEvidence: {
      dHash: hash,
      pHash
    }
  };
}

async function computeDHashFromUrl(imageUrl, options = {}) {
  const fingerprint = await computeImageFingerprintFromUrl(imageUrl, options);
  return fingerprint.hash;
}

async function computeImageFingerprintFromUrl(imageUrl, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Number(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;

  const response = await requestWithRetry(imageUrl, {
    timeoutMs,
    maxRetries: 2,
    serviceName: 'Image fingerprint fetch',
    fetchFn: options.fetchFn,
    skipIpPolicy: typeof options.fetchFn === 'function',
    disableDelay: options.disableDelay,
    onFailure: options.onFailure
  });

  if (!response || !response.ok) {
    throw new Error(`Image fetch failed (${response ? response.status : 'no response'}).`);
  }

  const mime = String(
    response.headers && response.headers.get ? response.headers.get('content-type') || '' : ''
  ).toLowerCase();
  if (mime && !mime.startsWith('image/')) {
    throw new Error('Fetched resource is not an image.');
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return computeImageFingerprintFromBuffer(buffer);
}

module.exports = {
  computeDHashFromBuffer,
  computePHashFromBuffer,
  computeImageFingerprintFromBuffer,
  computeDHashFromUrl,
  computeImageFingerprintFromUrl,
  compareHashes,
  compareHashesDetailed,
  splitHashSegments
};
