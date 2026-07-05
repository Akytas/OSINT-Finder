const { createLookupPlugin } = require('./_shared');
const fs = require('fs/promises');
const fsNative = require('fs');

function decodePlus(value) {
  return String(value || '').replace(/\+/g, ' ');
}

function normalizeTerm(value) {
  return String(value || '')
    .replace(/["'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUsefulCandidate(term) {
  if (!term) return false;
  if (term.length < 3) return false;
  if (/^https?:\/\//i.test(term)) return false;
  if (/^[\d\W_]+$/.test(term)) return false;
  return true;
}

function toAbsoluteGoogleUrl(location) {
  if (!location) return '';
  if (/^https?:\/\//i.test(location)) return location;
  if (location.startsWith('/')) return `https://www.google.com${location}`;
  return location;
}

function buildLookupLink(imageUrl) {
  const encoded = encodeURIComponent(imageUrl);
  return {
    source: 'Google SearchByImage (URL)',
    url: `https://www.google.com/searchbyimage?image_url=${encoded}`
  };
}

const plugin = createLookupPlugin({
  name: 'google',
  sourceLabel: 'Google SearchByImage',
  buildLookupLink
});

async function uploadImageAndGetResultUrl(file, fetchWithTimeout, timeoutMs) {
  const form = new FormData();
  const mimeType = file && file.mimetype ? file.mimetype : 'application/octet-stream';
  let blob;

  if (file && file.path && typeof fsNative.openAsBlob === 'function') {
    blob = await fsNative.openAsBlob(file.path, { type: mimeType });
  } else if (file && file.buffer) {
    blob = new Blob([file.buffer], { type: mimeType });
  } else if (file && file.path) {
    const buffer = await fs.readFile(file.path);
    blob = new Blob([buffer], { type: mimeType });
  } else {
    throw new Error('Google reverse image upload missing file data.');
  }

  form.append('encoded_image', blob, file.originalname || 'image.jpg');
  form.append('image_content', '');
  form.append('filename', file.originalname || 'image.jpg');

  const response = await fetchWithTimeout('https://www.google.com/searchbyimage/upload', {
    method: 'POST',
    body: form,
    redirect: 'manual'
  }, timeoutMs, 'Google reverse image');

  const location = response.headers.get('location') || '';
  const resultUrl = toAbsoluteGoogleUrl(location);

  if (!resultUrl) {
    throw new Error(`Google reverse image did not return redirect URL (status ${response.status}).`);
  }

  return resultUrl;
}

function extractCandidatesFromResultUrl(resultUrl) {
  const candidates = [];

  try {
    const parsed = new URL(resultUrl);
    const direct = [
      parsed.searchParams.get('q'),
      parsed.searchParams.get('oq'),
      parsed.searchParams.get('text')
    ];

    direct.forEach((value) => {
      const term = normalizeTerm(decodePlus(value));
      if (isUsefulCandidate(term)) {
        candidates.push(term);
      }
    });
  } catch {
    // keep empty candidate list if URL cannot be parsed
  }

  return candidates;
}

async function extractCandidatesFromResultHtml(resultUrl, fetchWithTimeout, timeoutMs) {
  try {
    const response = await fetchWithTimeout(resultUrl, {
      method: 'GET'
    }, timeoutMs, 'Google result page');

    if (!response.ok) return [];

    const html = await response.text();
    const found = [];

    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      const cleaned = normalizeTerm(titleMatch[1]
        .replace(/-\s*Google\s*(Search|Images)?/ig, '')
        .replace(/Google\s*(Search|Images)?/ig, ''));
      if (isUsefulCandidate(cleaned)) {
        found.push(cleaned);
      }
    }

    const phraseRegexes = [
      /(?:best\s+guess\s+for\s+this\s+image|visual\s+matches?)\s*[:\-]?\s*<[^>]+>([^<]{3,120})</i,
      /(?:nejlepsi\s+odhad|vizualni\s+shody)\s*[:\-]?\s*<[^>]+>([^<]{3,120})</i
    ];

    phraseRegexes.forEach((regex) => {
      const match = html.match(regex);
      if (match && match[1]) {
        const term = normalizeTerm(match[1]);
        if (isUsefulCandidate(term)) {
          found.push(term);
        }
      }
    });

    return found;
  } catch {
    return [];
  }
}

module.exports = Object.assign(plugin, {
  uploadImageAndGetResultUrl,
  extractCandidatesFromResultUrl,
  extractCandidatesFromResultHtml
});
