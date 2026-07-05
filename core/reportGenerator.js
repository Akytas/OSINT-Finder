function buildForensicReport(payload = {}) {
  const results = Array.isArray(payload.results) ? payload.results : [];
  const topMatch = results[0] || null;

  const findings = results.slice(0, 10).map((item) => {
    const domain = item.domain || (Array.isArray(item.domains) ? item.domains[0] : '') || 'unknown-domain';
    const confidence = Number.isFinite(Number(item.confidencePercent))
      ? Number(item.confidencePercent)
      : Number.isFinite(Number(item.score))
        ? Number(item.score)
        : 0;
    return `${domain}: ${confidence}%`;
  });

  const inconsistencies = results
    .filter((item) => Boolean(item && item.manipulated))
    .map((item) => String(item && item.url ? item.url : item && item.title ? item.title : 'item'));

  const sourcesUsed = Array.from(new Set(results.flatMap((item) => Array.isArray(item.sources) ? item.sources : [])));

  const confidence = topMatch
    ? (Number.isFinite(Number(topMatch.confidencePercent))
      ? Number(topMatch.confidencePercent)
      : Number.isFinite(Number(topMatch.score))
        ? Number(topMatch.score)
        : 0)
    : 0;

  return {
    summary: topMatch
      ? `Top forensic match found with confidence ${confidence}%.`
      : 'No reliable forensic match found.',
    topMatch,
    confidence,
    findings,
    inconsistencies,
    sourcesUsed,
    methodology: 'Multi-source reverse image lookup, OCR cross-check, hash comparison, domain trust and manipulation analysis.',
    timestamp: new Date().toISOString()
  };
}

function buildForensicReportJson(payload = {}) {
  const report = buildForensicReport(payload);
  return {
    schemaVersion: '1.0',
    type: 'forensic-report',
    exportedAt: new Date().toISOString(),
    report
  };
}

module.exports = {
  buildForensicReport,
  buildForensicReportJson
};
