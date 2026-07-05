const { createLookupPlugin } = require('./_shared');

function buildLookupLink(imageUrl) {
  const encoded = encodeURIComponent(imageUrl);
  return {
    source: 'Bing Visual Search (URL)',
    url: `https://www.bing.com/images/search?q=imgurl:${encoded}&view=detailv2&iss=sbi&FORM=IRSBIQ`
  };
}

module.exports = createLookupPlugin({
  name: 'bing',
  sourceLabel: 'Bing Visual Search',
  buildLookupLink
});
