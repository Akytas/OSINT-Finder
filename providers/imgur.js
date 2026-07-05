const { createLookupPlugin } = require('./_shared');

function buildLookupLink(imageUrl) {
  const encoded = encodeURIComponent(imageUrl);
  return {
    source: 'Imgur Search (URL)',
    title: 'Imgur reverse lookup',
    url: `https://imgur.com/search?q=${encoded}`,
    thumbnail: imageUrl
  };
}

module.exports = createLookupPlugin({
  name: 'imgur',
  sourceLabel: 'Imgur Search',
  buildLookupLink
});
