const { createLookupPlugin } = require('./_shared');

function buildLookupLink(imageUrl) {
  const encoded = encodeURIComponent(imageUrl);
  return {
    source: 'X Search (URL)',
    title: 'X reverse lookup',
    url: `https://x.com/search?q=${encoded}&src=typed_query&f=live`,
    thumbnail: imageUrl
  };
}

module.exports = createLookupPlugin({
  name: 'x',
  sourceLabel: 'X Search',
  buildLookupLink
});
