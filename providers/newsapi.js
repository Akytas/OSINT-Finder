const { requestWithRetry } = require('../utils/request');
const { isValidHttpUrl } = require('../utils/url');
const { resolveImageUrl, toItemArray } = require('./_shared');

function toText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTerm(value) {
  return toText(value)
    .replace(/["'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractHostKeyword(imageUrl) {
  try {
    const host = new URL(imageUrl).hostname.toLowerCase().replace(/^www\./, '');
    return host.split('.')[0] || '';
  } catch {
    return '';
  }
}

function extractSearchTerms(input, imageUrl) {
  const hints = Array.isArray(input && input.hints)
    ? input.hints
    : String(input && input.hints || '')
      .split(/[;,]/)
      .map((part) => normalizeTerm(part))
      .filter(Boolean);

  const terms = hints
    .map((term) => normalizeTerm(term))
    .filter((term) => term.length >= 3)
    .slice(0, 3);

  const hostKeyword = extractHostKeyword(imageUrl);
  if (hostKeyword && !terms.includes(hostKeyword)) {
    terms.push(hostKeyword);
  }

  if (!terms.length) {
    terms.push('image');
  }

  return terms;
}

function buildFallbackItem(imageUrl, terms) {
  const query = terms.join(' ');
  return {
    source: 'News API (fallback)',
    title: `News lookup for ${query}`,
    url: `https://news.google.com/search?q=${encodeURIComponent(query)}`,
    thumbnail: imageUrl,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  name: 'newsapi',
  async run(input) {
    const imageUrl = resolveImageUrl(input);
    if (!imageUrl) {
      throw new Error('Missing image URL in input.');
    }

    const apiKey = String(process.env.NEWS_API_KEY || '').trim();
    const terms = extractSearchTerms(input, imageUrl);
    if (!apiKey) {
      return [buildFallbackItem(imageUrl, terms)];
    }

    const query = terms.join(' OR ');
    const endpoint = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=publishedAt&pageSize=6`;

    const response = await requestWithRetry(endpoint, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        accept: 'application/json'
      },
      timeoutMs: 7000,
      maxRetries: 1,
      serviceName: 'News API'
    });

    if (!response || !response.ok) {
      throw new Error(`News API returned status ${response ? response.status : 'unknown'}.`);
    }

    const payload = await response.json();
    const articles = Array.isArray(payload && payload.articles) ? payload.articles : [];

    if (!articles.length) {
      return [buildFallbackItem(imageUrl, terms)];
    }

    return articles.map((article) => ({
      source: 'News API',
      title: toText(article && article.title) || 'News API article',
      url: toText(article && article.url),
      thumbnail: toText(article && article.urlToImage) || imageUrl,
      timestamp: toText(article && article.publishedAt) || new Date().toISOString()
    }));
  },
  parse(data) {
    return toItemArray(data)
      .map((item) => {
        if (!item || typeof item !== 'object') return null;

        const url = toText(item.url);
        if (!isValidHttpUrl(url)) return null;

        return {
          source: toText(item.source) || 'News API',
          title: toText(item.title) || 'News API article',
          url,
          thumbnail: toText(item.thumbnail),
          timestamp: toText(item.timestamp)
        };
      })
      .filter(Boolean);
  }
};
