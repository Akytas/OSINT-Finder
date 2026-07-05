const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const { app } = require('./server');

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const filePath = args.find((arg) => !String(arg || '').startsWith('--')) || '';
  const endpointArg = args.find((arg) => String(arg || '').startsWith('--endpoint='));
  const endpoint = endpointArg ? endpointArg.split('=').slice(1).join('=') : 'local';

  return {
    filePath: filePath ? path.resolve(filePath) : '',
    endpoint
  };
}

function shortResultSummary(payload) {
  const results = Array.isArray(payload && payload.results) ? payload.results : [];
  const analysis = payload && payload.analysis ? payload.analysis : null;

  return {
    queryType: payload && payload.queryType ? payload.queryType : 'image-upload',
    resultCount: results.length,
    candidates: Array.isArray(payload && payload.candidates) ? payload.candidates : [],
    topResults: results.slice(0, 10).map((item) => ({
      label: item && item.source ? item.source : item && item.title ? item.title : 'result',
      url: item && item.url ? item.url : '',
      score: Number.isFinite(Number(item && item.score)) ? Number(item.score) : 0,
      qualityScore: Number.isFinite(Number(item && item.qualityScore)) ? Number(item.qualityScore) : 0,
      domain: item && item.domain ? item.domain : ''
    })),
    analysis,
    warnings: Array.isArray(payload && payload.warnings) ? payload.warnings : []
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const { filePath } = parseArgs(argv);

  if (!filePath) {
    console.error('Použití: node app.js image.jpg');
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(filePath)) {
    console.error(`Soubor nenalezen: ${filePath}`);
    process.exitCode = 1;
    return;
  }

  const fileName = path.basename(filePath);
  const buffer = fs.readFileSync(filePath);
  const request = supertest(app);
  const response = await request
    .post('/api/reverse-image')
    .attach('image', buffer, {
      filename: fileName,
      contentType: inferMimeType(fileName)
    });

  if (response.status >= 400) {
    const message = response.body && (response.body.error || response.body.details)
      ? `${response.body.error || ''} ${response.body.details || ''}`.trim()
      : `HTTP ${response.status}`;
    throw new Error(message);
  }

  process.stdout.write(`${JSON.stringify(shortResultSummary(response.body), null, 2)}\n`);
}

function inferMimeType(fileName) {
  const lower = String(fileName || '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error || 'CLI failed'));
    process.exitCode = 1;
  });
}

module.exports = {
  runCli
};