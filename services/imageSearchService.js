const { runSearchDetailed } = require('../core/engine');

async function runImageSearch(input) {
  const payload = input && input.payload ? input.payload : {};
  const options = input && input.options ? input.options : {};
  return runSearchDetailed(payload, options);
}

module.exports = {
  runImageSearch
};
