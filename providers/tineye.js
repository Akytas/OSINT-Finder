const { createLookupPlugin } = require('./_shared');

function buildLookupLink(imageUrl) {
  const encoded = encodeURIComponent(imageUrl);
  return {
    source: 'TinEye (URL)',
    url: `https://tineye.com/search?url=${encoded}`
  };
}

module.exports = createLookupPlugin({
  name: 'tineye',
  sourceLabel: 'TinEye',
  buildLookupLink
});
