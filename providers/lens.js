const { createLookupPlugin } = require('./_shared');

function buildLookupLink(imageUrl) {
  const encoded = encodeURIComponent(imageUrl);
  return {
    source: 'Google Lens (URL)',
    url: `https://lens.google.com/uploadbyurl?url=${encoded}`
  };
}

module.exports = createLookupPlugin({
  name: 'lens',
  sourceLabel: 'Google Lens',
  buildLookupLink
});
