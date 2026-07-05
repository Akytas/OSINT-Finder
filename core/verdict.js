function normalizeVerdictInput(results) {
  if (!Array.isArray(results)) return [];
  return results.filter(Boolean);
}

function buildVerdict(results = [], context = {}) {
  const normalizedResults = normalizeVerdictInput(results);

  return {
    summary: '',
    confidence: 'neznámá',
    riskLevel: 'medium',
    redFlags: [],
    recommendations: [],
    actions: [],
    sourceCount: normalizedResults.length,
    context: context && typeof context === 'object' ? { ...context } : {}
  };
}

function generateVerdict(results = []) {
  if (!Array.isArray(results) || results.length === 0) {
    const actions = [];
    const riskLevel = 'medium';
    const simpleExplanation = 'Nelze potvrdit relevantní shodu na základě dostupných dat.';

    return {
      summary: 'Žádné relevantní výsledky',
      confidence: 'low',
      simpleExplanation,
      riskLevel,
      warnings: ['Nebyl nalezen žádný výsledek'],
      redFlags: ['Nebyl nalezen žádný výsledek'],
      recommendations: ['Zkuste upravit vstupní údaj'],
      actions
    };
  }

  const avgScore = results.reduce((sum, result) => sum + (result.score || 0), 0) / results.length;

  let confidence = 'low';
  let summary = '';

  if (avgScore > 0.75 && results.length > 5) {
    confidence = 'high';
    summary = 'Vysoká pravděpodobnost relevantní shody';
  } else if (avgScore > 0.5) {
    confidence = 'medium';
    summary = 'Možná shoda – doporučeno ověření';
  } else {
    confidence = 'low';
    summary = 'Nízká pravděpodobnost relevantní shody';
  }

  const warnings = [];

  if (results.length < 2) {
    warnings.push('Pouze jeden nebo minimum zdrojů');
  }

  const lowTrust = results.filter((result) => result.domainTrust < 0.5).length;
  if (lowTrust > results.length / 2) {
    warnings.push('Převaha nedůvěryhodných zdrojů');
  }

  const manipulated = results.filter((result) => result.manipulationScore > 0.7).length;
  if (manipulated > 0) {
    warnings.push('Možná manipulace obrázku');
  }

  const recommendations = [];

  if (confidence !== 'high') {
    recommendations.push('Ověřit profil na sociálních sítích');
    recommendations.push('Získat další zdroje');
  }

  if (warnings.length > 0) {
    recommendations.push('Provést manuální kontrolu výsledků');
  }

  const actions = [];

  if (results.length > 10) {
    actions.push('Monitorovat další výskyty v čase');
  }

  if (results.length < 3) {
    actions.push('Získat další zdroje (např. jiné vyhledávání)');
  }

  if (lowTrust > results.length / 2) {
    actions.push('Prověřit důvěryhodnost zdrojů');
  }

  if (manipulated > 0) {
    actions.push('Provést detailní kontrolu obrázku');
  }

  let simpleExplanation = '';

  if (confidence === 'high') {
    simpleExplanation = 'Výsledky naznačují silnou shodu napříč více zdroji.';
  } else if (confidence === 'medium') {
    simpleExplanation = 'Výsledky obsahují možné shody, je nutné další ověření.';
  } else {
    simpleExplanation = 'Nelze potvrdit relevantní shodu na základě dostupných dat.';
  }

  const riskLevel = confidence === 'high' ? 'low' : 'medium';

  return {
    summary,
    confidence,
    simpleExplanation,
    riskLevel,
    warnings,
    redFlags: warnings,
    recommendations,
    actions
  };
}

module.exports = {
  buildVerdict,
  generateVerdict,
  normalizeVerdictInput
};
