const { runImageSearch } = require('../services/imageSearchService');
const { generateVerdict } = require('../core/verdict');

async function handleReverseImage(req, res) {
  try {
    const results = await runImageSearch(req.body);

    const verdict = generateVerdict(results);

    res.json({
      results,
      verdict
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Chyba pri zpracovani' });
  }
}

module.exports = {
  handleReverseImage
};
