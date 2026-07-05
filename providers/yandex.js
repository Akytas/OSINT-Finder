const { createLookupPlugin } = require('./_shared');

function buildLookupLink(imageUrl) {
  const encoded = encodeURIComponent(imageUrl);
  return {
    source: 'Yandex Images (URL)',
    url: `https://yandex.com/images/search?rpt=imageview&url=${encoded}`
  };
}

module.exports = createLookupPlugin({
  name: 'yandex',
  sourceLabel: 'Yandex Images',
  buildLookupLink
});
