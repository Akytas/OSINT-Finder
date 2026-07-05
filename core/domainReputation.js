const CATEGORY_SCORES = {
  wikipedia: 0.9,
  news: 0.8,
  social: 0.6,
  unknown: 0.5,
  suspicious: 0.2
};

const EXACT_DOMAIN_SCORES = {
  'wikipedia.org': CATEGORY_SCORES.wikipedia
};

const NEWS_SUFFIXES = [
  'reuters.com',
  'apnews.com',
  'bbc.com',
  'cnn.com',
  'nytimes.com',
  'washingtonpost.com',
  'theguardian.com',
  'bloomberg.com'
];

const SOCIAL_SUFFIXES = [
  'facebook.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'linkedin.com',
  'tiktok.com',
  'reddit.com',
  'youtube.com',
  'vk.com',
  't.me',
  'telegram.org'
];

const SUSPICIOUS_SUFFIXES = [
  '.zip',
  '.click',
  '.top',
  '.xyz',
  '.gq',
  '.tk',
  '.work',
  '.party',
  '.loan',
  '.download'
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeDomain(domain) {
  const raw = typeof domain === 'string' ? domain.trim().toLowerCase() : '';
  if (!raw) return '';
  return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
}

function matchesSuffix(domain, suffix) {
  return domain === suffix || domain.endsWith(`.${suffix}`);
}

function scoreSingleDomain(domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return CATEGORY_SCORES.unknown;

  if (Object.prototype.hasOwnProperty.call(EXACT_DOMAIN_SCORES, normalized)) {
    return EXACT_DOMAIN_SCORES[normalized];
  }

  if (SUSPICIOUS_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return CATEGORY_SCORES.suspicious;
  }

  if (NEWS_SUFFIXES.some((suffix) => matchesSuffix(normalized, suffix))) {
    return CATEGORY_SCORES.news;
  }

  if (SOCIAL_SUFFIXES.some((suffix) => matchesSuffix(normalized, suffix))) {
    return CATEGORY_SCORES.social;
  }

  return CATEGORY_SCORES.unknown;
}

function getDomainTrust(domains) {
  const list = Array.isArray(domains) ? domains : [];
  const normalized = Array.from(new Set(list.map((value) => normalizeDomain(value)).filter(Boolean)));

  if (!normalized.length) return CATEGORY_SCORES.unknown;

  const total = normalized.reduce((sum, domain) => sum + scoreSingleDomain(domain), 0);
  return clamp(total / normalized.length, 0, 1);
}

module.exports = {
  getDomainTrust,
  scoreSingleDomain,
  constants: {
    CATEGORY_SCORES,
    NEWS_SUFFIXES,
    SOCIAL_SUFFIXES,
    SUSPICIOUS_SUFFIXES
  }
};
