const { isValidHttpUrl } = require('../utils/url');

function resolveImageUrl(input) {
  if (typeof input === 'string') return input.trim();
  if (!input || typeof input !== 'object') return '';

  const candidates = [input.imageUrl, input.url, input.image, input.targetUrl];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function toItemArray(providerOutput) {
  if (!providerOutput) return [];
  if (Array.isArray(providerOutput)) return providerOutput;

  if (providerOutput && typeof providerOutput === 'object') {
    if (Array.isArray(providerOutput.items)) {
      return providerOutput.items;
    }
    return [providerOutput];
  }

  return [];
}

function createLookupPlugin({ name, sourceLabel, buildLookupLink }) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('Plugin name is required.');
  }

  if (typeof buildLookupLink !== 'function') {
    throw new Error(`Plugin ${name} is missing buildLookupLink().`);
  }

  const pluginName = name.trim();
  const label = typeof sourceLabel === 'string' && sourceLabel.trim() ? sourceLabel.trim() : pluginName;

  return {
    name: pluginName,
    buildLookupLink,
    async run(input) {
      const imageUrl = resolveImageUrl(input);
      if (!imageUrl) {
        throw new Error('Missing image URL in input.');
      }

      return buildLookupLink(imageUrl);
    },
    parse(data) {
      return toItemArray(data)
        .map((item) => {
          if (!item || typeof item !== 'object') return null;

          const normalized = { ...item };
          if (typeof normalized.source !== 'string' || !normalized.source.trim()) {
            normalized.source = `${label} (URL)`;
          }

          const candidateUrl = typeof normalized.url === 'string'
            ? normalized.url
            : (typeof normalized.link === 'string' ? normalized.link : '');
          if (!isValidHttpUrl(candidateUrl)) {
            return null;
          }

          if (typeof normalized.url !== 'string' || !normalized.url.trim()) {
            normalized.url = candidateUrl.trim();
          }

          return normalized;
        })
        .filter(Boolean);
    }
  };
}

module.exports = {
  createLookupPlugin,
  resolveImageUrl,
  toItemArray
};