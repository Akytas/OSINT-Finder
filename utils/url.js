function toText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseUrl(value) {
  const text = toText(value);
  if (!text) return null;

  try {
    return new URL(text);
  } catch {
    return null;
  }
}

function isValidUrl(value) {
  return Boolean(parseUrl(value));
}

function isValidHttpUrl(value) {
  const parsed = parseUrl(value);
  if (!parsed) return false;
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

module.exports = {
  isValidUrl,
  isValidHttpUrl
};