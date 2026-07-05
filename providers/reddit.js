const { createLookupPlugin } = require('./_shared');

function buildLookupLink(imageUrl) {
  const encoded = encodeURIComponent(imageUrl);
  return {
    source: 'Reddit Search (URL)',
    title: 'Reddit reverse lookup',
    url: `https://www.reddit.com/search/?q=${encoded}&sort=new`,
    thumbnail: imageUrl
  };
}

module.exports = createLookupPlugin({
  name: 'reddit',
  sourceLabel: 'Reddit Search',
  buildLookupLink
});
