const STORAGE_KEYS = {
  persons: 'osint_persons',
  uiState: 'osint_ui_state',
  theme: 'osint_theme',
  density: 'osint_density',
  simpleUi: 'osint_simple_ui',
  templates: 'osint_templates',
  cases: 'osint_cases',
  audit: 'osint_audit',
  entities: 'osint_entities',
  relationships: 'osint_relationships',
  timeline: 'osint_timeline',
  evidence: 'osint_evidence',
  tasks: 'osint_tasks',
  entityValidations: 'osint_entity_validations'
};
let exportDirectoryHandle = null;
let photoPreviewObjectUrl = null;
let lastPhotoAnalysis = null;
let lastPhotoDashboard = null;
let selectedEntityId = '';
let entityGraph = null;
let simpleModeDetailsOpen = false;
let simpleModeDetailsKey = '';
let selectedResultDetailKey = '';
let lastResultsSearchAt = '';
let photoSensitiveDetailsOpen = false;
let forensicDetailsOpen = false;
let loadingRunId = 0;
let SAFE_MODE = false;
let METHODOLOGY_LOG = [];
let ENTITY_VALIDATION_QUEUE = [];
syncEntityValidationQueue();

function syncMethodologyLog() {
  if (typeof window !== 'undefined') {
    window.METHODOLOGY_LOG = METHODOLOGY_LOG;
  }
}

function syncEntityValidationQueue() {
  if (typeof window !== 'undefined') {
    window.ENTITY_VALIDATION_QUEUE = ENTITY_VALIDATION_QUEUE;
  }
}

function logSafeMode(message) {
  console.log(`[SAFE MODE] ${message}`);
}

function logMethodologyStep(sourceId, sourceName, query, foundCount) {
  if (!query || !sourceName) return;

  METHODOLOGY_LOG.push({
    timestamp: new Date().toISOString(),
    source: sourceName,
    sourceId: sourceId,
    query: query,
    resultCount: foundCount
  });

  console.log(`[METHODOLOGY] ${sourceName}: ${foundCount} results`);
}

syncMethodologyLog();

function calculateConfidenceScore(sourceLabel, item) {
  let score = 0;
  const sourceText = String(sourceLabel || '').toLowerCase();

  if (sourceText.includes('linkedin') || sourceText.includes('github')) {
    score += 20;
  }

  const itemStr = JSON.stringify(item || {}).toLowerCase();
  if (itemStr.includes('bio') || itemStr.includes('description') || itemStr.includes('about')) {
    score += 15;
  }

  if (itemStr.length > 200) {
    score += 25;
  }

  const query = normalizeWhitespace(getQuery()).toLowerCase();
  const rawLabel = Array.isArray(item)
    ? String(item[0] || '')
    : String((item && (item.label || item[0])) || '');
  const itemLabel = rawLabel.toLowerCase();
  if (query && (itemLabel.includes(query) || query.includes(itemLabel))) {
    score += 30;
  }

  const trustedDomains = ['linkedin', 'github', 'gitlab', 'interpol', 'ofac', 'europol', 'fbi'];
  const isTrusted = trustedDomains.some((domain) => sourceText.includes(domain));
  if (isTrusted) {
    score += 10;
  }

  return Math.min(100, score);
}

function getConfidenceLabel(score) {
  if (score >= 75) return 'VYSOKÁ';
  if (score >= 50) return 'STŘEDNÍ';
  return 'NÍZKÁ';
}

function levenshteinDistance(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const leftLen = left.length;
  const rightLen = right.length;
  const matrix = [];

  for (let i = 0; i <= rightLen; i += 1) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= leftLen; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= rightLen; i += 1) {
    for (let j = 1; j <= leftLen; j += 1) {
      if (right[i - 1] === left[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[rightLen][leftLen];
}

function deduplicateByFuzzyMatch(items) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const groups = [];

  items.forEach((item) => {
    const rawLabel = String((item && (item.label || item[0])) || '');
    const normalized = rawLabel.toLowerCase().replace(/[._\-\s]/g, '');

    if (!normalized) return;

    let matched = false;
    for (const group of groups) {
      const distance = levenshteinDistance(normalized, group.normalized);
      if (distance <= 2) {
        group.items.push(item);
        matched = true;
        break;
      }
    }

    if (!matched) {
      groups.push({
        normalized,
        items: [item],
        mainLabel: rawLabel || 'Unknown'
      });
    }
  });

  return groups;
}

function showEntityValidation(candidates) {
  const panel = document.getElementById('entity-validation-panel');
  const itemsDiv = document.getElementById('validation-items');

  if (!panel || !itemsDiv || !Array.isArray(candidates) || candidates.length === 0) {
    showAlert('Není co ověřovat.');
    return;
  }

  itemsDiv.innerHTML = candidates
    .map((candidate, index) => {
      const label =
        candidate && (candidate.label || candidate[0])
          ? candidate.label || candidate[0]
          : 'Unknown';
      const url =
        candidate && (candidate.url || candidate[1]) ? candidate.url || candidate[1] : '(no URL)';
      return `
        <div style="padding: 8px; border-bottom: 1px solid #eee;">
          <strong>${index + 1}. ${label}</strong>
          <br><small style="color: #666;">URL: ${url}</small>
        </div>
      `;
    })
    .join('');

  panel.style.display = 'block';
  ENTITY_VALIDATION_QUEUE = candidates;
  syncEntityValidationQueue();
  panel.scrollIntoView({ behavior: 'smooth' });
}

function confirmEntityMerge() {
  if (!ENTITY_VALIDATION_QUEUE.length) return;

  const merged = ENTITY_VALIDATION_QUEUE[0];
  merged.validatedMerge = true;
  merged.mergedCount = ENTITY_VALIDATION_QUEUE.length;

  const panel = document.getElementById('entity-validation-panel');
  if (panel) {
    panel.style.display = 'none';
  }

  const savedValidations = JSON.parse(localStorage.getItem(STORAGE_KEYS.entityValidations) || '[]');
  savedValidations.push({
    timestamp: new Date().toISOString(),
    mergedCount: merged.mergedCount,
    labels: ENTITY_VALIDATION_QUEUE.map((item) => item.label || item[0] || 'Unknown')
  });
  localStorage.setItem(STORAGE_KEYS.entityValidations, JSON.stringify(savedValidations));

  ENTITY_VALIDATION_QUEUE = [];
  syncEntityValidationQueue();
  saveUiState();
  showAlert(`Sloučeno ${merged.mergedCount} položek. Entita je uložena.`);
}

function rejectEntityMerge() {
  const panel = document.getElementById('entity-validation-panel');
  if (panel) {
    panel.style.display = 'none';
  }

  ENTITY_VALIDATION_QUEUE = [];
  syncEntityValidationQueue();
  showAlert('Sloučení bylo zamítnuté.');
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

const TAB_IDS = ['search', 'results', 'case', 'history'];

function isSimpleUiEnabled() {
  return false;
}

function switchTab(tabName) {
  let nextTab = TAB_IDS.includes(tabName) ? tabName : 'search';

  TAB_IDS.forEach((id) => {
    const section = document.getElementById(`tab-${id}`);
    if (section) {
      section.classList.toggle('hidden', id !== nextTab);
    }
  });

  const navButtons = document.querySelectorAll('.tabs-nav button[data-tab]');
  navButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === nextTab);
  });

  if (nextTab === 'results') {
    const card = document.getElementById('results-card');
    const list = document.getElementById('results-list');
    if (card && Array.isArray(lastResults) && lastResults.length) {
      card.style.display = 'block';
    }
    const hasRenderedContent = !!(
      list &&
      (list.children.length > 0 || normalizeWhitespace(list.textContent))
    );
    if (!hasRenderedContent && Array.isArray(lastResults) && lastResults.length) {
      try {
        renderResults(lastResults);
      } catch (error) {
        console.error('Results tab auto-render failed, using fallback list:', error);
      }
    }

    if (Array.isArray(lastResults) && lastResults.length) {
      ensureResultsVisibleFallback(lastResults);

      const stillEmpty = !!(
        list &&
        list.children.length === 0 &&
        !normalizeWhitespace(list.textContent)
      );

      if (stillEmpty) {
        const emergencyBox = document.createElement('div');
        emergencyBox.className = 'answer-box';

        const title = document.createElement('strong');
        title.className = 'answer-title';
        title.textContent = 'Nouzovy vypis vysledku';

        const text = document.createElement('p');
        text.className = 'answer-text';
        text.textContent = 'Detailni panel selhal, zobrazuji odkazy v nouzovem rezimu.';

        const ul = document.createElement('ul');
        ul.style.margin = '8px 0 0';
        ul.style.paddingLeft = '18px';

        getPreparedResults(lastResults)
          .slice(0, 30)
          .forEach((item, index) => {
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.href = item.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = `${index + 1}. ${item.label}`;
            li.appendChild(a);
            ul.appendChild(li);
          });

        emergencyBox.appendChild(title);
        emergencyBox.appendChild(text);
        emergencyBox.appendChild(ul);
        if (list) {
          list.appendChild(emergencyBox);
        }
      }
    }
  }

  return nextTab;
}

const LOADING_STAGE_LABELS = {
  sources: 'Vyhledávám zdroje',
  analyze: 'Analyzuji data',
  evaluate: 'Vyhodnocuji'
};

const DEFAULT_TEMPLATES = [
  {
    id: 'tpl_all',
    name: 'Vsechny zdroje',
    sourceIds: [],
    custom: false
  },
  {
    id: 'tpl_social',
    name: 'Social profil',
    sourceIds: [
      'src_google',
      'src_x',
      'src_facebook',
      'src_instagram',
      'src_tiktok',
      'src_linkedin',
      'src_vk',
      'src_telegram'
    ],
    custom: false
  },
  {
    id: 'tpl_dev',
    name: 'Developer stopa',
    sourceIds: [
      'src_google',
      'src_github',
      'src_gitlab',
      'src_stackoverflow',
      'src_reddit',
      'src_quora',
      'src_youtube'
    ],
    custom: false
  },
  {
    id: 'tpl_media',
    name: 'Media a obsah',
    sourceIds: [
      'src_google',
      'src_images',
      'src_youtube',
      'src_vimeo',
      'src_web',
      'src_reddit',
      'src_tiktok',
      'src_instagram'
    ],
    custom: false
  }
];

const SOURCE_DEFS = [
  {
    id: 'src_google',
    label: 'Google',
    buildUrl: (q) => `https://www.google.com/search?q=${q}`
  },
  {
    id: 'src_reddit',
    label: 'Reddit',
    buildUrl: (q) => `https://www.google.com/search?q=site:reddit.com+${q}`
  },
  {
    id: 'src_x',
    label: 'X / Twitter',
    buildUrl: (q) => `https://www.google.com/search?q=site:twitter.com+${q}`
  },
  {
    id: 'src_web',
    label: 'Web',
    buildUrl: (q) => `https://www.google.com/search?q=${q}+diskuze+forum`
  },
  {
    id: 'src_images',
    label: 'Obrazky',
    buildUrl: (q) => `https://www.google.com/search?tbm=isch&q=${q}`
  },
  {
    id: 'src_linkedin',
    label: 'LinkedIn',
    buildUrl: (q) => `https://www.google.com/search?q=site:linkedin.com+${q}`
  },
  {
    id: 'src_facebook',
    label: 'Facebook',
    buildUrl: (q) => `https://www.google.com/search?q=site:facebook.com+${q}`
  },
  {
    id: 'src_instagram',
    label: 'Instagram',
    buildUrl: (q) => `https://www.google.com/search?q=site:instagram.com+${q}`
  },
  {
    id: 'src_github',
    label: 'GitHub',
    buildUrl: (q) => `https://www.google.com/search?q=site:github.com+${q}`
  },
  {
    id: 'src_youtube',
    label: 'YouTube',
    buildUrl: (q) => `https://www.google.com/search?q=site:youtube.com+${q}`
  },
  {
    id: 'src_tiktok',
    label: 'TikTok',
    buildUrl: (q) => `https://www.google.com/search?q=site:tiktok.com+${q}`
  },
  {
    id: 'src_seznam',
    label: 'Seznam',
    buildUrl: (q) => `https://search.seznam.cz/?q=${q}`
  },
  {
    id: 'src_bing',
    label: 'Bing',
    buildUrl: (q) => `https://www.bing.com/search?q=${q}`
  },
  {
    id: 'src_duckduckgo',
    label: 'DuckDuckGo',
    buildUrl: (q) => `https://duckduckgo.com/?q=${q}`
  },
  {
    id: 'src_telegram',
    label: 'Telegram',
    buildUrl: (q) => `https://www.google.com/search?q=site:t.me+${q}`
  },
  {
    id: 'src_quora',
    label: 'Quora',
    buildUrl: (q) => `https://www.google.com/search?q=site:quora.com+${q}`
  },
  {
    id: 'src_stackoverflow',
    label: 'Stack Overflow',
    buildUrl: (q) => `https://www.google.com/search?q=site:stackoverflow.com+${q}`
  },
  {
    id: 'src_gitlab',
    label: 'GitLab',
    buildUrl: (q) => `https://www.google.com/search?q=site:gitlab.com+${q}`
  },
  {
    id: 'src_startpage',
    label: 'Startpage',
    buildUrl: (q) => `https://www.startpage.com/sp/search?query=${q}`
  },
  {
    id: 'src_qwant',
    label: 'Qwant',
    buildUrl: (q) => `https://www.qwant.com/?q=${q}`
  },
  {
    id: 'src_vk',
    label: 'VK',
    buildUrl: (q) => `https://www.google.com/search?q=site:vk.com+${q}`
  },
  {
    id: 'src_yandex',
    label: 'Yandex',
    buildUrl: (q) => `https://yandex.com/search/?text=${q}`
  },
  {
    id: 'src_yahoo',
    label: 'Yahoo',
    buildUrl: (q) => `https://search.yahoo.com/search?p=${q}`
  },
  {
    id: 'src_vimeo',
    label: 'Vimeo',
    buildUrl: (q) => `https://www.google.com/search?q=site:vimeo.com+${q}`
  },
  {
    id: 'src_interpol',
    label: 'Interpol',
    buildUrl: (q) => `https://www.google.com/search?q=site:interpol.int+red+notice+${q}`
  },
  {
    id: 'src_europol',
    label: 'Europol',
    buildUrl: (q) => `https://www.google.com/search?q=site:europol.europa.eu+${q}`
  },
  {
    id: 'src_fbi_wanted',
    label: 'FBI Wanted',
    buildUrl: (q) => `https://www.google.com/search?q=site:fbi.gov/wanted+${q}`
  },
  {
    id: 'src_eu_most_wanted',
    label: 'EU Most Wanted',
    buildUrl: (q) => `https://www.google.com/search?q=site:eumostwanted.eu+${q}`
  },
  {
    id: 'src_dea',
    label: 'DEA',
    buildUrl: (q) => `https://www.google.com/search?q=site:dea.gov+most+wanted+${q}`
  },
  {
    id: 'src_usmarshals',
    label: 'US Marshals',
    buildUrl: (q) => `https://www.google.com/search?q=site:usmarshals.gov+fugitives+${q}`
  },
  {
    id: 'src_nca_uk',
    label: 'NCA UK',
    buildUrl: (q) =>
      `https://www.google.com/search?q=site:nationalcrimeagency.gov.uk+most+wanted+${q}`
  },
  {
    id: 'src_ofac',
    label: 'OFAC Sanctions',
    buildUrl: (q) => `https://www.google.com/search?q=site:ofac.treasury.gov+sanctions+${q}`
  },
  {
    id: 'src_eu_sanctions',
    label: 'EU Sanctions',
    buildUrl: (q) => `https://www.google.com/search?q=site:sanctionsmap.eu+${q}`
  },
  {
    id: 'src_un_sanctions',
    label: 'UN Sanctions',
    buildUrl: (q) => `https://www.google.com/search?q=site:un.org+sanctions+${q}`
  }
];

const SOURCE_CONFIDENCE = {
  src_interpol: 0.95,
  src_europol: 0.92,
  src_fbi_wanted: 0.93,
  src_eu_most_wanted: 0.9,
  src_dea: 0.88,
  src_usmarshals: 0.88,
  src_nca_uk: 0.88,
  src_ofac: 0.91,
  src_eu_sanctions: 0.89,
  src_un_sanctions: 0.89,
  src_google: 0.66,
  src_bing: 0.66,
  src_seznam: 0.64,
  src_yandex: 0.62,
  src_yahoo: 0.61,
  src_duckduckgo: 0.64,
  src_startpage: 0.64,
  src_qwant: 0.63,
  src_linkedin: 0.76,
  src_github: 0.74,
  src_gitlab: 0.73,
  src_stackoverflow: 0.72,
  src_reddit: 0.6,
  src_web: 0.56,
  src_images: 0.52,
  src_x: 0.63,
  src_facebook: 0.62,
  src_instagram: 0.61,
  src_tiktok: 0.57,
  src_vk: 0.57,
  src_telegram: 0.58,
  src_quora: 0.62,
  src_youtube: 0.61,
  src_vimeo: 0.6
};

const INTERNET_CORE_SOURCE_IDS = [
  'src_google',
  'src_bing',
  'src_seznam',
  'src_duckduckgo',
  'src_web',
  'src_reddit',
  'src_images',
  'src_x',
  'src_facebook',
  'src_instagram',
  'src_linkedin',
  'src_youtube'
];

const OFFICIAL_SOURCE_IDS = new Set([
  'src_interpol',
  'src_europol',
  'src_fbi_wanted',
  'src_eu_most_wanted',
  'src_dea',
  'src_usmarshals',
  'src_nca_uk',
  'src_ofac',
  'src_eu_sanctions',
  'src_un_sanctions'
]);

const OFFICIAL_SOURCE_DIRECT_URLS = {
  src_interpol: 'https://www.interpol.int/How-we-work/Notices/View-Red-Notices',
  src_europol: 'https://www.europol.europa.eu/eu-most-wanted',
  src_fbi_wanted: 'https://www.fbi.gov/wanted',
  src_eu_most_wanted: 'https://eumostwanted.eu/',
  src_dea: 'https://www.dea.gov/fugitives/all',
  src_usmarshals: 'https://www.usmarshals.gov/what-we-do/fugitive-apprehension/profiled-fugitives',
  src_nca_uk: 'https://www.nationalcrimeagency.gov.uk/most-wanted',
  src_ofac: 'https://sanctionssearch.ofac.treas.gov/',
  src_eu_sanctions: 'https://www.sanctionsmap.eu/',
  src_un_sanctions: 'https://main.un.org/securitycouncil/en/sanctions/information'
};

const ENTITY_TYPES = [
  { value: 'person', label: 'Osoba' },
  { value: 'phone', label: 'Telefon' },
  { value: 'email', label: 'E-mail' },
  { value: 'domain', label: 'Domena' },
  { value: 'web', label: 'Web' },
  { value: 'social', label: 'Socialni ucet' },
  { value: 'image', label: 'Obrazek' },
  { value: 'vehicle', label: 'Vozidlo' },
  { value: 'organization', label: 'Organizace' },
  { value: 'address', label: 'Adresa' },
  { value: 'document', label: 'Dokument' },
  { value: 'note', label: 'Poznamka' }
];

const RELATIONSHIP_TYPES = [
  'owns',
  'uses',
  'registered_to',
  'connected_to',
  'works_for',
  'member_of',
  'located_at',
  'appears_in',
  'mentioned_in',
  'related_to'
];

const ENTITY_TYPE_LABEL = ENTITY_TYPES.reduce((acc, item) => {
  acc[item.value] = item.label;
  return acc;
}, {});

let lastResults = [];

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeWhitespace(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function normalizePhone(value) {
  return (value || '').replace(/[^\d+]/g, '');
}

function normalizeResultsModeValue(mode) {
  return mode === 'forensic' || mode === 'advanced' ? 'forensic' : 'simple';
}

function getVerdictMeta(percent) {
  const value = Number(percent);
  if (!Number.isFinite(value)) {
    return { emoji: '⚪', label: 'NEURCENO' };
  }
  if (value >= 80) {
    return { emoji: '🟢', label: 'VYSOKÁ PRAVDĚPODOBNOST' };
  }
  if (value >= 50) {
    return { emoji: '🟡', label: 'STŘEDNÍ PRAVDĚPODOBNOST' };
  }
  return { emoji: '🔴', label: 'NÍZKÁ PRAVDĚPODOBNOST' };
}

function getVerdictShortLabel(percent) {
  const value = Number(percent);
  if (!Number.isFinite(value)) return 'neurceno';
  if (value >= 80) return 'vysoka';
  if (value >= 50) return 'stredni';
  return 'nizka';
}

function formatTopVerdictText(percent, customText) {
  const simpleUi = isSimpleUiEnabled();

  if (customText) {
    if (!simpleUi) return customText;

    const normalized = String(customText || '').toLowerCase();
    if (normalized.includes('ceka na analyzu')) {
      return '⚪ Ceka na analyzu';
    }

    return String(customText || '')
      .replace(/^\s*[🟢🟡🔴⚪]\s*V[ýy]sledek:\s*/i, '')
      .replace(/^\s*V[ýy]sledek:\s*/i, '');
  }

  if (!Number.isFinite(Number(percent))) {
    return simpleUi ? '⚪ Ceka na analyzu' : '⚪ Výsledek: ČEKÁ NA ANALÝZU';
  }

  const meta = getVerdictMeta(percent);
  if (!simpleUi) {
    return `${meta.emoji} Výsledek: ${meta.label} (${Math.round(Number(percent))} %)`;
  }

  return `${meta.emoji} ${Math.round(Number(percent))} % (${getVerdictShortLabel(percent)})`;
}

function updateTopVerdictBanner(percent, customText) {
  const banner = document.getElementById('top-verdict');
  if (!banner) return;

  banner.textContent = formatTopVerdictText(percent, customText);

  if (customText || !Number.isFinite(Number(percent))) {
    banner.classList.remove('top-verdict-high', 'top-verdict-medium', 'top-verdict-low');
    return;
  }

  banner.classList.remove('top-verdict-high', 'top-verdict-medium', 'top-verdict-low');
  if (Number(percent) >= 80) {
    banner.classList.add('top-verdict-high');
  } else if (Number(percent) >= 50) {
    banner.classList.add('top-verdict-medium');
  } else {
    banner.classList.add('top-verdict-low');
  }
}

function applyResultsUiState({
  verdict,
  percent = NaN,
  bannerText,
  results = [],
  totalCount = Array.isArray(results) ? results.length : 0
} = {}) {
  updateTopVerdictBanner(percent, bannerText);
  updateResultsSummary(results, totalCount);
  renderVerdict(verdict);
}

function updateAnalyzeButtonsState() {
  const photoFile = document.getElementById('photo-file');
  const hasFile = !!(photoFile && photoFile.files && photoFile.files[0]);
  const hint = hasFile ? 'Spusti foto analyzu' : 'Nejprve nahrajte obrazek';

  ['photo-api-search-btn', 'simple-analyze-btn'].forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = !hasFile;
    btn.title = hint;
    btn.setAttribute('aria-disabled', hasFile ? 'false' : 'true');
  });
}

function getInputValue(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}

function setInputValue(id, value) {
  const el = document.getElementById(id);
  if (el) {
    el.value = value || '';
  }
}

function readCases() {
  const items = JSON.parse(localStorage.getItem(STORAGE_KEYS.cases) || '[]');
  return Array.isArray(items) ? items : [];
}

function writeCases(cases) {
  localStorage.setItem(STORAGE_KEYS.cases, JSON.stringify(cases));
}

function readAuditEntries() {
  const items = JSON.parse(localStorage.getItem(STORAGE_KEYS.audit) || '[]');
  return Array.isArray(items) ? items : [];
}

function writeAuditEntries(entries) {
  localStorage.setItem(STORAGE_KEYS.audit, JSON.stringify(entries));
}

function readEntities() {
  const items = JSON.parse(localStorage.getItem(STORAGE_KEYS.entities) || '[]');
  return Array.isArray(items) ? items : [];
}

function writeEntities(entities) {
  localStorage.setItem(STORAGE_KEYS.entities, JSON.stringify(entities));
}

function readRelationships() {
  const items = JSON.parse(localStorage.getItem(STORAGE_KEYS.relationships) || '[]');
  return Array.isArray(items) ? items : [];
}

function writeRelationships(relationships) {
  localStorage.setItem(STORAGE_KEYS.relationships, JSON.stringify(relationships));
}

function readTimeline() {
  const items = JSON.parse(localStorage.getItem(STORAGE_KEYS.timeline) || '[]');
  return Array.isArray(items) ? items : [];
}

function writeTimeline(items) {
  localStorage.setItem(STORAGE_KEYS.timeline, JSON.stringify(items));
}

function readEvidence() {
  const items = JSON.parse(localStorage.getItem(STORAGE_KEYS.evidence) || '[]');
  return Array.isArray(items) ? items : [];
}

function writeEvidence(items) {
  localStorage.setItem(STORAGE_KEYS.evidence, JSON.stringify(items));
}

function readTasks() {
  const items = JSON.parse(localStorage.getItem(STORAGE_KEYS.tasks) || '[]');
  return Array.isArray(items) ? items : [];
}

function writeTasks(items) {
  localStorage.setItem(STORAGE_KEYS.tasks, JSON.stringify(items));
}

function makeCaseItemId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function getCaseTimeline(caseId) {
  if (!caseId) return [];
  return readTimeline()
    .filter((item) => item.caseId === caseId)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''), 'cs'));
}

function getCaseEvidence(caseId) {
  if (!caseId) return [];
  return readEvidence()
    .filter((item) => item.caseId === caseId)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''), 'cs'));
}

function getCaseTasks(caseId) {
  if (!caseId) return [];
  return readTasks()
    .filter((item) => item.caseId === caseId)
    .sort(
      (a, b) =>
        Number(a.completed) - Number(b.completed) ||
        String(b.createdAt || '').localeCompare(String(a.createdAt || ''), 'cs')
    );
}

function getCaseEntities(caseId) {
  return readEntities().filter((entity) => entity.caseId === caseId);
}

function getCaseRelationships(caseId) {
  return readRelationships().filter((rel) => rel.caseId === caseId);
}

function makeEntityId(type) {
  return `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function makeRelationshipId() {
  return `rel_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function findEntityById(entityId) {
  return readEntities().find((item) => item.id === entityId) || null;
}

function addEntityToCase(payload) {
  const caseId = ensureCaseExists();
  const now = new Date().toISOString();
  const entity = {
    id: makeEntityId(payload.type || 'note'),
    caseId,
    type: payload.type || 'note',
    name: normalizeWhitespace(payload.name),
    description: normalizeWhitespace(payload.description),
    createdAt: now,
    updatedAt: now,
    metadata: payload.metadata || {}
  };

  if (!entity.name) return null;

  const entities = readEntities();
  const duplicate = entities.find(
    (item) =>
      item.caseId === caseId &&
      item.type === entity.type &&
      normalizeWhitespace(item.name).toLowerCase() === entity.name.toLowerCase()
  );

  if (duplicate) {
    selectedEntityId = duplicate.id;
    renderEntityWorkspace();
    return duplicate;
  }

  entities.push(entity);
  writeEntities(entities);
  writeAuditEntry('entity_create', {
    entityId: entity.id,
    entityType: entity.type,
    entityName: entity.name
  });
  selectedEntityId = entity.id;
  renderEntityWorkspace();
  maybeSuggestAutomaticRelationship(entity);
  return entity;
}

function updateEntity(entityId, patch) {
  const entities = readEntities();
  const idx = entities.findIndex((item) => item.id === entityId);
  if (idx < 0) return;

  entities[idx] = {
    ...entities[idx],
    ...patch,
    name: normalizeWhitespace((patch && patch.name) || entities[idx].name),
    description: normalizeWhitespace((patch && patch.description) || entities[idx].description),
    updatedAt: new Date().toISOString()
  };

  writeEntities(entities);
  writeAuditEntry('entity_update', {
    entityId,
    entityType: entities[idx].type,
    entityName: entities[idx].name
  });
  renderEntityWorkspace();
}

function deleteEntity(entityId) {
  const entity = findEntityById(entityId);
  if (!entity) return;

  const entities = readEntities().filter((item) => item.id !== entityId);
  writeEntities(entities);

  const relationships = readRelationships().filter(
    (rel) => rel.sourceEntityId !== entityId && rel.targetEntityId !== entityId
  );
  writeRelationships(relationships);

  writeAuditEntry('entity_delete', {
    entityId,
    entityType: entity.type,
    entityName: entity.name
  });

  if (selectedEntityId === entityId) {
    selectedEntityId = '';
  }
  renderEntityWorkspace();
}

function addRelationshipToCase(payload) {
  const caseId = ensureCaseExists();
  if (!payload.sourceEntityId || !payload.targetEntityId || !payload.relationshipType) return null;
  if (payload.sourceEntityId === payload.targetEntityId) return null;

  const source = findEntityById(payload.sourceEntityId);
  const target = findEntityById(payload.targetEntityId);
  if (!source || !target || source.caseId !== caseId || target.caseId !== caseId) return null;

  const relationships = readRelationships();
  const duplicate = relationships.find(
    (rel) =>
      rel.caseId === caseId &&
      rel.sourceEntityId === payload.sourceEntityId &&
      rel.targetEntityId === payload.targetEntityId &&
      rel.relationshipType === payload.relationshipType
  );

  if (duplicate) return duplicate;

  const relationship = {
    id: makeRelationshipId(),
    caseId,
    sourceEntityId: payload.sourceEntityId,
    targetEntityId: payload.targetEntityId,
    relationshipType: payload.relationshipType,
    confidence: Math.max(0, Math.min(100, Number(payload.confidence || 60))),
    note: normalizeWhitespace(payload.note),
    createdAt: new Date().toISOString()
  };

  relationships.push(relationship);
  writeRelationships(relationships);
  writeAuditEntry('relationship_create', {
    relationshipId: relationship.id,
    relationshipType: relationship.relationshipType,
    sourceEntityId: relationship.sourceEntityId,
    targetEntityId: relationship.targetEntityId,
    confidence: relationship.confidence
  });
  renderEntityWorkspace();
  return relationship;
}

function deleteRelationship(relationshipId) {
  const rel = readRelationships().find((item) => item.id === relationshipId);
  if (!rel) return;
  const relationships = readRelationships().filter((item) => item.id !== relationshipId);
  writeRelationships(relationships);
  writeAuditEntry('relationship_delete', {
    relationshipId,
    relationshipType: rel.relationshipType
  });
  renderEntityWorkspace();
}

function inferEntityTypeFromText(value) {
  const text = normalizeWhitespace(value);
  if (!text) return 'note';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return 'email';
  if (/^\+?[0-9][0-9\s()-]{6,}$/.test(text)) return 'phone';
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(text) && !/^https?:\/\//i.test(text)) return 'domain';
  if (/^https?:\/\//i.test(text)) return 'web';
  if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(text)) return 'image';
  return 'note';
}

function inferEntityFromResult(item) {
  const url = normalizeWhitespace(item && item.url);
  const label = normalizeWhitespace(item && item.label);
  if (!url && !label) return null;

  const combined = `${label} ${url}`;
  const emailMatch = combined.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (emailMatch) {
    return {
      type: 'email',
      name: emailMatch[0],
      description: `Zdroj: ${label}`,
      metadata: { url, sourceLabel: label }
    };
  }

  const phoneMatch = combined.match(/\+?[0-9][0-9\s()-]{6,}/);
  if (phoneMatch) {
    return {
      type: 'phone',
      name: normalizePhone(phoneMatch[0]),
      description: `Zdroj: ${label}`,
      metadata: { url, sourceLabel: label }
    };
  }

  try {
    const parsed = new URL(url);
    const domain = parsed.hostname.toLowerCase();
    if (domain) {
      return {
        type: /\.(jpg|jpeg|png|webp|gif)$/i.test(parsed.pathname) ? 'image' : 'domain',
        name: /\.(jpg|jpeg|png|webp|gif)$/i.test(parsed.pathname) ? url : domain,
        description: `Zdroj: ${label}`,
        metadata: { url, sourceLabel: label }
      };
    }
  } catch {
    // ignore URL parse errors
  }

  return {
    type: inferEntityTypeFromText(label || url),
    name: label || url,
    description: `Zdroj: ${label || '-'}`,
    metadata: { url, sourceLabel: label }
  };
}

function getEntityTypeOptionsHtml(selectedValue) {
  return ENTITY_TYPES.map(
    (item) =>
      `<option value="${item.value}"${item.value === selectedValue ? ' selected' : ''}>${item.label}</option>`
  ).join('');
}

function getRelationshipTypeOptionsHtml(selectedValue) {
  return RELATIONSHIP_TYPES.map(
    (type) => `<option value="${type}"${type === selectedValue ? ' selected' : ''}>${type}</option>`
  ).join('');
}

function getEntityStats(caseId) {
  const entities = getCaseEntities(caseId);
  const stats = {};
  ENTITY_TYPES.forEach((item) => {
    stats[item.value] = 0;
  });
  entities.forEach((entity) => {
    stats[entity.type] = (stats[entity.type] || 0) + 1;
  });
  return stats;
}

function getRelationshipsForEntity(caseId, entityId) {
  return getCaseRelationships(caseId).filter(
    (rel) => rel.sourceEntityId === entityId || rel.targetEntityId === entityId
  );
}

function getEntityGraphImageDataUrl() {
  if (!entityGraph) return '';
  try {
    if (typeof entityGraph.canvasToDataURL === 'function') {
      return entityGraph.canvasToDataURL();
    }
    const graphHost = document.getElementById('entity-graph');
    const canvas = graphHost ? graphHost.querySelector('canvas') : null;
    if (canvas && typeof canvas.toDataURL === 'function') {
      return canvas.toDataURL('image/png');
    }
    return '';
  } catch {
    return '';
  }
}

function renderEntityGraph(caseId, entities, relationships) {
  const graphHost = document.getElementById('entity-graph');
  if (!graphHost || !window.vis || !window.vis.Network) return;

  const nodeItems = entities.map((entity) => ({
    id: entity.id,
    label: entity.name,
    title: `${ENTITY_TYPE_LABEL[entity.type] || entity.type}\n${entity.description || ''}`,
    group: entity.type
  }));

  const edgeItems = relationships.map((rel) => ({
    id: rel.id,
    from: rel.sourceEntityId,
    to: rel.targetEntityId,
    label: rel.relationshipType,
    title: `Důvěra: ${rel.confidence}%${rel.note ? `\n${rel.note}` : ''}`,
    arrows: 'to'
  }));

  const data = {
    nodes: new window.vis.DataSet(nodeItems),
    edges: new window.vis.DataSet(edgeItems)
  };

  const options = {
    layout: { improvedLayout: true },
    interaction: {
      hover: true,
      multiselect: false,
      navigationButtons: true
    },
    physics: {
      stabilization: true,
      barnesHut: {
        springLength: 120,
        springConstant: 0.05
      }
    },
    nodes: {
      shape: 'dot',
      size: 14,
      font: {
        size: 12
      }
    },
    edges: {
      smooth: true,
      font: { size: 10 }
    }
  };

  if (!entityGraph) {
    entityGraph = new window.vis.Network(graphHost, data, options);
    entityGraph.on('click', (params) => {
      if (params.nodes && params.nodes.length) {
        selectedEntityId = params.nodes[0];
        const connected = entityGraph.getConnectedEdges(params.nodes[0]);
        entityGraph.selectEdges(connected);
        renderEntityWorkspace();
      }
    });
    entityGraph.on('selectNode', (params) => {
      if (params.nodes && params.nodes.length) {
        entityGraph.selectNodes(params.nodes);
      }
    });
    return;
  }

  entityGraph.setData(data);
}

function maybeSuggestAutomaticRelationship(entity) {
  if (!entity) return;
  const caseId = entity.caseId;
  const entities = getCaseEntities(caseId).filter((item) => item.id !== entity.id);
  const suggestions = [];

  if (entity.type === 'phone' || entity.type === 'email') {
    const person = entities.find((item) => item.type === 'person');
    if (person) {
      suggestions.push({
        sourceEntityId: person.id,
        targetEntityId: entity.id,
        relationshipType: 'uses',
        confidence: 70,
        note: 'Nabidka automaticke vazby'
      });
    }
  }

  if (entity.type === 'person') {
    const phone = entities.find((item) => item.type === 'phone');
    if (phone) {
      suggestions.push({
        sourceEntityId: entity.id,
        targetEntityId: phone.id,
        relationshipType: 'uses',
        confidence: 70,
        note: 'Nabidka automaticke vazby'
      });
    }

    const email = entities.find((item) => item.type === 'email');
    if (email) {
      suggestions.push({
        sourceEntityId: entity.id,
        targetEntityId: email.id,
        relationshipType: 'uses',
        confidence: 70,
        note: 'Nabidka automaticke vazby'
      });
    }
  }

  if (entity.type === 'domain') {
    const org = entities.find((item) => item.type === 'organization');
    if (org) {
      suggestions.push({
        sourceEntityId: entity.id,
        targetEntityId: org.id,
        relationshipType: 'registered_to',
        confidence: 65,
        note: 'Nabidka automaticke vazby'
      });
    }
  }

  if (entity.type === 'organization') {
    const domain = entities.find((item) => item.type === 'domain');
    if (domain) {
      suggestions.push({
        sourceEntityId: domain.id,
        targetEntityId: entity.id,
        relationshipType: 'registered_to',
        confidence: 65,
        note: 'Nabidka automaticke vazby'
      });
    }
  }

  const host = document.getElementById('entity-auto-suggestions');
  if (!host) return;
  host.textContent = '';

  if (!suggestions.length) return;

  suggestions.forEach((suggestion) => {
    const source = findEntityById(suggestion.sourceEntityId);
    const target = findEntityById(suggestion.targetEntityId);
    if (!source || !target) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = `Navrh: ${source.name} -> ${suggestion.relationshipType} -> ${target.name}`;
    btn.addEventListener('click', () => {
      addRelationshipToCase(suggestion);
      showAlert('Navrzena vazba byla vytvorena.');
      host.textContent = '';
    });
    host.appendChild(btn);
  });
}

function renderEntityWorkspace() {
  const caseId = getCaseId();
  const list = document.getElementById('entity-list');
  const detail = document.getElementById('entity-detail');
  const stats = document.getElementById('entity-stats');
  const filter = normalizeWhitespace(getInputValue('entity-filter')).toLowerCase();
  const typeFilter = getInputValue('entity-type-filter') || 'all';

  if (!list || !detail || !stats) return;

  if (!caseId) {
    list.textContent = '';
    detail.innerHTML = '<p class="small">Nejprve nastavte pripad.</p>';
    stats.textContent = '';
    renderEntityGraph('', [], []);
    return;
  }

  const entities = getCaseEntities(caseId)
    .filter((entity) => (typeFilter === 'all' ? true : entity.type === typeFilter))
    .filter((entity) => {
      if (!filter) return true;
      return `${entity.name} ${entity.description}`.toLowerCase().includes(filter);
    })
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''), 'cs'));

  const relationships = getCaseRelationships(caseId);

  if (!selectedEntityId && entities.length) {
    selectedEntityId = entities[0].id;
  }

  list.textContent = '';
  entities.forEach((entity) => {
    const item = document.createElement('div');
    item.className = `entity-item${selectedEntityId === entity.id ? ' active' : ''}`;

    const name = document.createElement('strong');
    name.textContent = entity.name;

    const meta = document.createElement('div');
    meta.className = 'entity-meta';
    meta.textContent = `${ENTITY_TYPE_LABEL[entity.type] || entity.type} | ${new Date(entity.updatedAt || entity.createdAt).toLocaleString('cs-CZ')}`;

    item.appendChild(name);
    item.appendChild(meta);
    item.addEventListener('click', () => {
      selectedEntityId = entity.id;
      renderEntityWorkspace();
    });
    list.appendChild(item);
  });

  const selected = entities.find((entity) => entity.id === selectedEntityId) || null;
  if (!selected) {
    detail.innerHTML = '<p class="small">Vyberte nebo vytvorte entitu.</p>';
  } else {
    const related = getRelationshipsForEntity(caseId, selected.id);
    const options = entities
      .filter((entity) => entity.id !== selected.id)
      .map(
        (entity) =>
          `<option value="${entity.id}">${escapeHtml(entity.name)} (${escapeHtml(ENTITY_TYPE_LABEL[entity.type] || entity.type)})</option>`
      )
      .join('');

    const relHtml = related.length
      ? related
          .map((rel) => {
            const source = findEntityById(rel.sourceEntityId);
            const target = findEntityById(rel.targetEntityId);
            return `<div class="relationship-item">
          <strong>${escapeHtml(source ? source.name : rel.sourceEntityId)}</strong>
          -> ${escapeHtml(rel.relationshipType)} ->
          <strong>${escapeHtml(target ? target.name : rel.targetEntityId)}</strong>
          <div class="entity-meta">Důvěra: ${rel.confidence}%${rel.note ? ` | ${escapeHtml(rel.note)}` : ''}</div>
          <button type="button" data-delete-rel="${rel.id}">Smazat vazbu</button>
        </div>`;
          })
          .join('')
      : '<p class="small">Zatím bez vazeb.</p>';

    detail.innerHTML = `<div class="row">
      <label for="entity-edit-name">Nazev</label>
      <input id="entity-edit-name" value="${escapeHtml(selected.name)}" />
      <label for="entity-edit-description">Popis</label>
      <input id="entity-edit-description" value="${escapeHtml(selected.description || '')}" />
      <label for="entity-edit-type">Typ</label>
      <select id="entity-edit-type">${getEntityTypeOptionsHtml(selected.type)}</select>
      <button type="button" id="entity-save-btn">Ulozit entitu</button>
      <button type="button" id="entity-delete-btn">Smazat entitu</button>
    </div>
    <h4>Vazby entity</h4>
    <div class="relationship-list">${relHtml}</div>
    <h4>Nova vazba</h4>
    <div class="row">
      <label for="rel-target">Cilova entita</label>
      <select id="rel-target"><option value="">Vyberte</option>${options}</select>
      <label for="rel-type">Typ vazby</label>
      <select id="rel-type">${getRelationshipTypeOptionsHtml('related_to')}</select>
      <label for="rel-confidence">Důvěra</label>
      <input id="rel-confidence" type="number" min="0" max="100" value="70" />
      <label for="rel-note">Poznamka</label>
      <input id="rel-note" placeholder="volitelne" />
      <button type="button" id="rel-create-btn">Pridat vazbu</button>
    </div>`;

    const saveBtn = document.getElementById('entity-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        updateEntity(selected.id, {
          name: getInputValue('entity-edit-name'),
          description: getInputValue('entity-edit-description'),
          type: getInputValue('entity-edit-type') || selected.type
        });
        showAlert('Entita byla ulozena.');
      });
    }

    const deleteBtn = document.getElementById('entity-delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        deleteEntity(selected.id);
        showAlert('Entita byla smazana.');
      });
    }

    const relCreateBtn = document.getElementById('rel-create-btn');
    if (relCreateBtn) {
      relCreateBtn.addEventListener('click', () => {
        const created = addRelationshipToCase({
          sourceEntityId: selected.id,
          targetEntityId: getInputValue('rel-target'),
          relationshipType: getInputValue('rel-type') || 'related_to',
          confidence: Number(getInputValue('rel-confidence') || 70),
          note: getInputValue('rel-note')
        });
        if (!created) {
          showAlert('Vazbu se nepodarilo vytvorit.');
          return;
        }
        showAlert('Vazba byla vytvorena.');
      });
    }

    detail.querySelectorAll('[data-delete-rel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        deleteRelationship(btn.getAttribute('data-delete-rel'));
        showAlert('Vazba byla smazana.');
      });
    });
  }

  const statsObj = getEntityStats(caseId);
  const relCount = relationships.length;
  const statsText = ENTITY_TYPES.filter((type) => statsObj[type.value] > 0)
    .map((type) => `${type.label}: ${statsObj[type.value]}`)
    .join(' | ');
  stats.textContent = `${statsText || 'Zatím bez entit'} | Vazby: ${relCount}`;

  renderEntityGraph(caseId, getCaseEntities(caseId), relationships);
}

function createEntityFromForm() {
  const type = getInputValue('new-entity-type') || 'note';
  const name = getInputValue('new-entity-name');
  const description = getInputValue('new-entity-description');

  const entity = addEntityToCase({ type, name, description });
  if (!entity) {
    showAlert('Vyplnte nazev entity.');
    return;
  }

  setInputValue('new-entity-name', '');
  setInputValue('new-entity-description', '');
  showAlert('Entita byla pridana do pripadu.');
}

function addPreparedResultToCaseEntity(label, url) {
  const candidate = inferEntityFromResult({ label, url });
  if (!candidate) {
    showAlert('Z tohoto vysledku nelze vytvorit entitu.');
    return;
  }

  const entity = addEntityToCase(candidate);
  if (!entity) {
    showAlert('Nepodarilo se vytvorit entitu.');
    return;
  }

  showAlert(`Entita pridana: ${entity.name}`);
}

function wireEntityWorkspace() {
  const addBtn = document.getElementById('add-entity-btn');
  const filterInput = document.getElementById('entity-filter');
  const typeFilter = document.getElementById('entity-type-filter');

  if (addBtn) {
    addBtn.addEventListener('click', createEntityFromForm);
  }
  if (filterInput) {
    filterInput.addEventListener('input', renderEntityWorkspace);
  }
  if (typeFilter) {
    typeFilter.addEventListener('change', renderEntityWorkspace);
  }
}

function generateCaseId() {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
  const randomPart = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `CASE-${datePart}-${randomPart}`;
}

let currentCaseId = generateCaseId();

function startNewCase() {
  currentCaseId = generateCaseId();
  updateCaseDisplay();
  updateCaseBadge();
  saveUiState();
}

function updateCaseDisplay() {
  const display = document.getElementById('case-id-display');
  if (display) {
    display.textContent = currentCaseId;
  }

  const caseIdInput = document.getElementById('case-id');
  if (caseIdInput) {
    caseIdInput.value = currentCaseId;
  }
}

function getCaseId() {
  const current = normalizeWhitespace(getInputValue('case-id'));
  return current || currentCaseId;
}

function getCaseTitle() {
  return normalizeWhitespace(getInputValue('case-title'));
}

function getCaseReason() {
  return normalizeWhitespace(getInputValue('case-reason'));
}

function getCaseOperator() {
  return normalizeWhitespace(getInputValue('case-operator'));
}

function countCaseAuditEntries(caseId) {
  if (!caseId) return 0;
  return readAuditEntries().filter((entry) => entry.caseId === caseId).length;
}

function getCaseLastUpdated(caseId) {
  if (!caseId) return '';
  const timestamps = [];
  const caseRecord = getCaseRecord(caseId);
  if (caseRecord) {
    if (caseRecord.updatedAt) timestamps.push(caseRecord.updatedAt);
    if (caseRecord.createdAt) timestamps.push(caseRecord.createdAt);
  }

  getCurrentCaseEntries(caseId).forEach((entry) => {
    if (entry.at) timestamps.push(entry.at);
  });
  getCaseEntities(caseId).forEach((entry) => {
    if (entry.updatedAt) timestamps.push(entry.updatedAt);
    if (entry.createdAt) timestamps.push(entry.createdAt);
  });
  getCaseRelationships(caseId).forEach((entry) => {
    if (entry.createdAt) timestamps.push(entry.createdAt);
  });
  getCaseTimeline(caseId).forEach((entry) => {
    if (entry.updatedAt) timestamps.push(entry.updatedAt);
    if (entry.createdAt) timestamps.push(entry.createdAt);
  });
  getCaseEvidence(caseId).forEach((entry) => {
    if (entry.createdAt) timestamps.push(entry.createdAt);
  });
  getCaseTasks(caseId).forEach((entry) => {
    if (entry.updatedAt) timestamps.push(entry.updatedAt);
    if (entry.createdAt) timestamps.push(entry.createdAt);
  });

  if (!timestamps.length) return '';
  timestamps.sort((a, b) => String(b).localeCompare(String(a), 'cs'));
  return timestamps[0];
}

function updateCaseDashboardSummary() {
  const caseId = getCaseId();
  const entitiesEl = document.getElementById('case-kpi-entities');
  const relsEl = document.getElementById('case-kpi-relationships');
  const evidenceEl = document.getElementById('case-kpi-evidence');
  const timelineEl = document.getElementById('case-kpi-timeline');
  const lastUpdateEl = document.getElementById('case-kpi-last-update');

  if (!entitiesEl || !relsEl || !evidenceEl || !timelineEl || !lastUpdateEl) return;

  if (!caseId) {
    entitiesEl.textContent = '0';
    relsEl.textContent = '0';
    evidenceEl.textContent = '0';
    timelineEl.textContent = '0';
    lastUpdateEl.textContent = '-';
    return;
  }

  entitiesEl.textContent = String(getCaseEntities(caseId).length);
  relsEl.textContent = String(getCaseRelationships(caseId).length);
  evidenceEl.textContent = String(getCaseEvidence(caseId).length);
  timelineEl.textContent = String(getCaseTimeline(caseId).length);
  const lastUpdated = getCaseLastUpdated(caseId);
  lastUpdateEl.textContent = lastUpdated ? new Date(lastUpdated).toLocaleString('cs-CZ') : '-';
}

function renderTimeline() {
  const host = document.getElementById('timeline-list');
  if (!host) return;
  const caseId = getCaseId();
  clearNode(host);

  if (!caseId) {
    host.innerHTML = '<p class="small">Nejprve nastavte pripad.</p>';
    return;
  }

  const items = getCaseTimeline(caseId)
    .slice()
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''), 'cs'));

  if (!items.length) {
    host.innerHTML = '<p class="small">Timeline je zatím prázdná.</p>';
    return;
  }

  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'case-list-item';
    row.innerHTML = `<strong>${escapeHtml(item.title || 'Bez nazvu')}</strong>
      <div>${escapeHtml(item.description || '')}</div>
      <div class="case-list-meta">${new Date(item.createdAt).toLocaleString('cs-CZ')}</div>`;

    const actions = document.createElement('div');
    actions.className = 'case-list-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = 'Upravit';
    editBtn.addEventListener('click', () => {
      const title = prompt('Nazev udalosti', item.title || '');
      if (title === null) return;
      const description = prompt('Popis udalosti', item.description || '');
      if (description === null) return;
      const all = readTimeline();
      const idx = all.findIndex((entry) => entry.id === item.id);
      if (idx < 0) return;
      all[idx] = {
        ...all[idx],
        title: normalizeWhitespace(title),
        description: normalizeWhitespace(description),
        updatedAt: new Date().toISOString()
      };
      writeTimeline(all);
      writeAuditEntry('timeline_update', { timelineId: item.id });
      renderTimeline();
      updateCaseBadge();
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Smazat';
    deleteBtn.addEventListener('click', () => {
      writeTimeline(readTimeline().filter((entry) => entry.id !== item.id));
      writeAuditEntry('timeline_delete', { timelineId: item.id });
      renderTimeline();
      updateCaseBadge();
    });

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    row.appendChild(actions);
    host.appendChild(row);
  });
}

function addTimelineEventFromForm() {
  const caseId = ensureCaseExists();
  const title = normalizeWhitespace(getInputValue('timeline-title'));
  const description = normalizeWhitespace(getInputValue('timeline-description'));
  if (!title) {
    showAlert('Zadejte nazev udalosti timeline.');
    return;
  }

  const items = readTimeline();
  const now = new Date().toISOString();
  const payload = {
    id: makeCaseItemId('timeline'),
    caseId,
    title,
    description,
    createdAt: now
  };
  items.push(payload);
  writeTimeline(items);
  setInputValue('timeline-title', '');
  setInputValue('timeline-description', '');
  writeAuditEntry('timeline_create', { timelineId: payload.id, title: payload.title });
  renderTimeline();
  updateCaseBadge();
}

function renderEvidence() {
  const host = document.getElementById('evidence-list');
  if (!host) return;
  const caseId = getCaseId();
  clearNode(host);

  if (!caseId) {
    host.innerHTML = '<p class="small">Nejprve nastavte pripad.</p>';
    return;
  }

  const items = getCaseEvidence(caseId);
  if (!items.length) {
    host.innerHTML = '<p class="small">Bez pripojenych priloh.</p>';
    return;
  }

  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'case-list-item';
    row.innerHTML = `<strong>${escapeHtml(item.fileName || 'Soubor')}</strong>
      <div class="case-list-meta">${escapeHtml(item.fileType || 'neznámý')} | ${new Date(item.createdAt).toLocaleString('cs-CZ')}</div>`;

    const actions = document.createElement('div');
    actions.className = 'case-list-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = 'Otevrit';
    openBtn.addEventListener('click', () => {
      if (!item.dataUrl) {
        showAlert('Priloha nema lokalni obsah.');
        return;
      }
      const link = document.createElement('a');
      link.href = item.dataUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.download = item.fileName || 'priloha';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = 'Odebrat';
    removeBtn.addEventListener('click', () => {
      writeEvidence(readEvidence().filter((entry) => entry.id !== item.id));
      writeAuditEntry('evidence_delete', { evidenceId: item.id, fileName: item.fileName });
      renderEvidence();
      updateCaseBadge();
    });

    actions.appendChild(openBtn);
    actions.appendChild(removeBtn);
    row.appendChild(actions);
    host.appendChild(row);
  });
}

function addEvidenceFromFile() {
  const input = document.getElementById('evidence-file');
  const file = input && input.files && input.files[0];
  if (!file) {
    showAlert('Vyberte soubor prilohy.');
    return;
  }

  const caseId = ensureCaseExists();
  const reader = new FileReader();
  reader.onload = () => {
    const items = readEvidence();
    const payload = {
      id: makeCaseItemId('evidence'),
      caseId,
      fileName: file.name,
      fileType: file.type || 'application/octet-stream',
      createdAt: new Date().toISOString(),
      dataUrl: String(reader.result || '')
    };
    items.push(payload);
    writeEvidence(items);
    writeAuditEntry('evidence_create', {
      evidenceId: payload.id,
      fileName: payload.fileName,
      fileType: payload.fileType
    });
    if (input) input.value = '';
    renderEvidence();
    updateCaseBadge();
  };
  reader.onerror = () => {
    showAlert('Nepodarilo se nacist soubor prilohy.');
  };
  reader.readAsDataURL(file);
}

function renderTasks() {
  const host = document.getElementById('task-list');
  if (!host) return;
  const caseId = getCaseId();
  clearNode(host);

  if (!caseId) {
    host.innerHTML = '<p class="small">Nejprve nastavte pripad.</p>';
    return;
  }

  const items = getCaseTasks(caseId);
  if (!items.length) {
    host.innerHTML = '<p class="small">Checklist je zatím prázdný.</p>';
    return;
  }

  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = `case-list-item task-row${item.completed ? ' is-completed' : ''}`;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !!item.completed;
    checkbox.addEventListener('change', () => {
      const all = readTasks();
      const idx = all.findIndex((entry) => entry.id === item.id);
      if (idx < 0) return;
      all[idx] = {
        ...all[idx],
        completed: checkbox.checked,
        updatedAt: new Date().toISOString()
      };
      writeTasks(all);
      writeAuditEntry('task_update', { taskId: item.id, completed: checkbox.checked });
      renderTasks();
      renderAssistantRecommendations();
      updateCaseBadge();
    });

    const title = document.createElement('strong');
    title.textContent = item.title || 'Ukol';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = 'Smazat';
    removeBtn.addEventListener('click', () => {
      writeTasks(readTasks().filter((entry) => entry.id !== item.id));
      writeAuditEntry('task_delete', { taskId: item.id });
      renderTasks();
      renderAssistantRecommendations();
      updateCaseBadge();
    });

    row.appendChild(checkbox);
    row.appendChild(title);
    row.appendChild(removeBtn);
    host.appendChild(row);
  });
}

function addTaskFromForm() {
  const caseId = ensureCaseExists();
  const title = normalizeWhitespace(getInputValue('task-title'));
  if (!title) {
    showAlert('Zadejte nazev ukolu.');
    return;
  }

  const all = readTasks();
  const payload = {
    id: makeCaseItemId('task'),
    caseId,
    title,
    completed: false,
    createdAt: new Date().toISOString()
  };
  all.push(payload);
  writeTasks(all);
  setInputValue('task-title', '');
  writeAuditEntry('task_create', { taskId: payload.id, title: payload.title });
  renderTasks();
  renderAssistantRecommendations();
  updateCaseBadge();
}

function generateCaseRecommendations(caseId) {
  const targetCaseId = caseId || getCaseId();
  if (!targetCaseId) return [];

  const entities = getCaseEntities(targetCaseId);
  const relationships = getCaseRelationships(targetCaseId);
  const tasks = getCaseTasks(targetCaseId);
  const caseEntries = getCurrentCaseEntries(targetCaseId);

  const recommendations = [];
  const phones = entities.filter((item) => item.type === 'phone').slice(0, 3);
  const emails = entities.filter((item) => item.type === 'email').slice(0, 3);
  const images = entities.filter((item) => item.type === 'image');

  phones.forEach((item) => recommendations.push(`Proverit telefon ${item.name}`));
  emails.forEach((item) => recommendations.push(`Proverit e-mail ${item.name}`));

  const hasPhotoAction = caseEntries.some(
    (entry) => entry.action === 'search_photo_api' || entry.action === 'search_photo_url'
  );
  if ((images.length || normalizeWhitespace(getInputValue('photo-url'))) && !hasPhotoAction) {
    recommendations.push('Provest reverse image analyzu fotografie');
  }

  if (entities.length >= 3 && relationships.length < Math.max(1, Math.floor(entities.length / 2))) {
    recommendations.push('Doplnit vazby mezi nepriirazenymi entitami');
  }

  const openTasks = tasks.filter((item) => !item.completed).length;
  if (openTasks > 0) {
    recommendations.push(`Dokoncit otevrene ukoly (${openTasks})`);
  }

  if (!recommendations.length) {
    recommendations.push('Data vypadají konzistentně, pokračujte ručním ověřením top zdrojů.');
  }

  return recommendations;
}

function getAssistantOutput(result) {
  const item = result && typeof result === 'object' ? result : null;
  if (!item) {
    return {
      zaver: 'Zatím nejsou dostupná data pro interpretaci.',
      rizika: ['Bez dostupnych vysledku k vyhodnoceni.'],
      doporuceni: ['Spustte vyhledavani a vyberte detail vysledku.']
    };
  }

  const confidence = normalizePercentScore(item.confidence ?? item.validityPercent ?? 0);
  const fakeScore = item.fakeScore && typeof item.fakeScore === 'object' ? item.fakeScore : null;
  const logicAnalysis =
    item.logicAnalysis && typeof item.logicAnalysis === 'object' ? item.logicAnalysis : null;
  const aiAnalysis =
    item.aiAnalysis && typeof item.aiAnalysis === 'object' ? item.aiAnalysis : null;
  const contradictions =
    logicAnalysis &&
    logicAnalysis.contradictions &&
    typeof logicAnalysis.contradictions === 'object'
      ? Number(logicAnalysis.contradictions.count) || 0
      : 0;

  const aiRisk = normalizeWhitespace(aiAnalysis && aiAnalysis.risk).toUpperCase() || '';
  const fakeLevel = normalizeWhitespace(fakeScore && fakeScore.level).toUpperCase() || '';
  const riskSet = new Set();
  const recommendationSet = new Set();

  if (item.manipulated) {
    const reasonText =
      Array.isArray(item.manipulationReasons) && item.manipulationReasons.length
        ? ` (${item.manipulationReasons.join(', ')})`
        : '';
    riskSet.add(`Signal mozne manipulace obrazku${reasonText}.`);
    recommendationSet.add('Overit puvodni zdroj obrazku a porovnat metadata (hash/EXIF).');
  }

  if (!item.hasTrustedDomain) {
    riskSet.add('Výsledek nemá oporu v důvěryhodné doméně.');
    recommendationSet.add(
      'Dohledat potvrzeni na oficialnich nebo dlouhodobe reputacnich zdrojich.'
    );
  }

  if ((Number(item.sourceCount) || 0) <= 1) {
    riskSet.add('Nízká opora dat (pouze jeden zdroj).');
    recommendationSet.add('Rozsirit overeni alespon o dva nezavisle zdroje.');
  }

  if (contradictions > 0) {
    riskSet.add(`OCR detekovalo mozny rozpor (${contradictions}x).`);
    recommendationSet.add('Rucne overit OCR text proti originalu obrazku.');
  }

  if (aiRisk === 'HIGH' || fakeLevel === 'HIGH') {
    riskSet.add('Model vyhodnotil zvysene riziko (HIGH).');
    recommendationSet.add('Escalovat na sekundarni kontrolu a ulozit dukazni material.');
  } else if (aiRisk === 'MEDIUM' || fakeLevel === 'MEDIUM') {
    riskSet.add('Model vyhodnotil střední riziko (MEDIUM).');
    recommendationSet.add('Potvrdit zavery dalsim nezavislym overenim.');
  }

  if (confidence < 50) {
    recommendationSet.add(
      'Zpresnit vstupni dotaz (jmeno, alias, lokalita, telefon) a opakovat hledani.'
    );
  }

  let zaver = '';
  if (aiAnalysis && normalizeWhitespace(aiAnalysis.conclusion)) {
    zaver = normalizeWhitespace(aiAnalysis.conclusion);
  } else if (logicAnalysis && normalizeWhitespace(logicAnalysis.conclusion)) {
    zaver = normalizeWhitespace(logicAnalysis.conclusion);
  } else if (item.manipulated) {
    zaver = 'Výsledek je pravděpodobně ovlivněn manipulací a vyžaduje manuální verifikaci.';
  } else if (confidence >= 80) {
    zaver = 'Výsledek má vysokou důvěryhodnost, stále je nutné finální ruční ověření.';
  } else if (confidence >= 55) {
    zaver = 'Výsledek je použitelný orientačně, ale není dostatečný pro definitivní závěr.';
  } else {
    zaver = 'Data jsou zatím nepřesvědčivá a vyžadují doplnění dalších zdrojů.';
  }

  if (!riskSet.size) {
    riskSet.add('Bez vyraznych rizikovych signalu v aktualnim vzorku.');
  }
  if (!recommendationSet.size) {
    recommendationSet.add('Pokracovat v manualnim overeni top zdroju a ulozit auditni dukazy.');
  }

  return {
    zaver,
    rizika: Array.from(riskSet),
    doporuceni: Array.from(recommendationSet)
  };
}

function getAssistantFocusResult() {
  const prepared = getFinalReportPreparedResults();
  if (!prepared.length) return null;

  const photoLookup = buildPhotoResultLookup();
  const clusterLookup = buildResultClusterLookup();
  const detailMap = new Map();

  prepared.slice(0, 40).forEach((item) => {
    const technical = resolveResultTechnicalDetails(item, photoLookup);
    const detail = buildResultDetailModel(item, technical, clusterLookup);
    detailMap.set(detail.key, detail);
  });

  if (selectedResultDetailKey && detailMap.has(selectedResultDetailKey)) {
    return detailMap.get(selectedResultDetailKey);
  }

  return detailMap.values().next().value || null;
}

function renderAssistantRecommendations() {
  const host = document.getElementById('assistant-recommendations');
  if (!host) return;
  clearNode(host);

  const caseId = getCaseId();
  if (!caseId) {
    host.innerHTML = '<p class="small">Nejprve nastavte pripad.</p>';
    return;
  }

  const appendRow = (text) => {
    const row = document.createElement('div');
    row.className = 'case-list-item';
    row.textContent = text;
    host.appendChild(row);
  };

  const focusResult = getAssistantFocusResult();
  const assistantOutput = getAssistantOutput(focusResult);
  appendRow(`Závěr: ${assistantOutput.zaver}`);

  appendRow('Rizika:');
  assistantOutput.rizika.forEach((risk) => {
    appendRow(`- ${risk}`);
  });

  appendRow('Doporuceni:');
  const list = Array.from(
    new Set([...assistantOutput.doporuceni, ...generateCaseRecommendations(caseId)])
  );

  list.forEach((item) => {
    appendRow(`- ${item}`);
  });
}

function updateCaseBadge() {
  const badge = document.getElementById('case-badge');
  if (!badge) return;

  const caseId = getCaseId();
  if (!caseId) {
    badge.textContent = 'Pripad: nenastaven';
    updateCaseDashboardSummary();
    renderTimeline();
    renderEvidence();
    renderTasks();
    renderAssistantRecommendations();
    return;
  }

  badge.textContent = `Pripad: ${caseId} | Audit zaznamu: ${countCaseAuditEntries(caseId)}`;
  updateCaseDashboardSummary();
  renderTimeline();
  renderEvidence();
  renderTasks();
  renderAssistantRecommendations();
}

function ensureCaseExists() {
  let caseId = getCaseId();
  if (!caseId) {
    currentCaseId = generateCaseId();
    updateCaseDisplay();
    caseId = currentCaseId;
  }

  const cases = readCases();
  const title = getCaseTitle() || 'Bez nazvu';
  const operator = getCaseOperator() || '';
  const reason = getCaseReason() || '';
  const now = new Date().toISOString();

  const found = cases.find((item) => item.id === caseId);
  if (found) {
    found.title = title;
    found.operator = operator;
    found.reason = reason;
    found.updatedAt = now;
  } else {
    cases.push({
      id: caseId,
      title,
      operator,
      reason,
      createdAt: now,
      updatedAt: now
    });
  }

  writeCases(cases);
  saveUiState();
  updateCaseBadge();
  return caseId;
}

function saveCaseProfile() {
  const caseId = ensureCaseExists();
  showAlert(`Pripad ulozen: ${caseId}`);
  renderEntityWorkspace();
}

function getCurrentInputsSnapshot() {
  return {
    name: normalizeWhitespace(getInputValue('name')),
    nick: normalizeWhitespace(getInputValue('nick')),
    city: normalizeWhitespace(getInputValue('city')),
    phone: normalizePhone(getInputValue('phone')),
    photoUrl: getPhotoUrlInput()
  };
}

function writeAuditEntry(action, extra) {
  const caseId = ensureCaseExists();
  const entries = readAuditEntries();

  entries.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    action,
    caseId,
    caseReason: getCaseReason(),
    operator: getCaseOperator(),
    query: getQuery(),
    selectedSources: getSelectedSources().map((source) => source.id),
    inputs: getCurrentInputsSnapshot(),
    ...extra
  });

  if (entries.length > 3000) {
    entries.splice(0, entries.length - 3000);
  }

  writeAuditEntries(entries);
  updateCaseBadge();
  if (typeof renderSearchHistory === 'function') {
    renderSearchHistory();
  }
}

function buildSearchResultSnapshot(items, maxItems = 25) {
  return getPreparedResults(Array.isArray(items) ? items : [])
    .slice(0, Math.max(1, Number(maxItems) || 25))
    .map((item) => ({
      label: item.label,
      url: item.url,
      validityPercent: item.validityPercent,
      sourcePercent: item.sourcePercent,
      queryPercent: item.queryPercent
    }));
}

const SEARCH_HISTORY_ACTIONS = new Set(['search_all', 'search_photo_url', 'search_photo_api']);

function getSearchHistoryEntries() {
  return readAuditEntries()
    .filter((entry) => SEARCH_HISTORY_ACTIONS.has(entry.action))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''), 'cs'));
}

function normalizeSearchHistoryEntry(entry) {
  const snapshot = Array.isArray(entry && entry.resultSnapshot) ? entry.resultSnapshot : [];
  const resultUrls = snapshot.map((item) => normalizeResultUrl(item && item.url)).filter(Boolean);

  return {
    id: entry.id,
    at: entry.at,
    action: entry.action,
    query: normalizeWhitespace(entry.query),
    resultCount: Number.isFinite(Number(entry.resultCount))
      ? Number(entry.resultCount)
      : snapshot.length,
    selectedSourceCount: Array.isArray(entry.selectedSources) ? entry.selectedSources.length : 0,
    selectedSources: Array.isArray(entry.selectedSources) ? entry.selectedSources : [],
    resultSnapshot: snapshot,
    resultUrls,
    photoHash: normalizeWhitespace(entry.photoHash),
    photoPerceptualHash: normalizeWhitespace(entry.photoPerceptualHash),
    photoAnalysis: entry.photoAnalysis || null,
    inputs: entry.inputs || null
  };
}

function getActionLabel(action) {
  if (action === 'search_all') return 'Hledat všude';
  if (action === 'search_photo_url') return 'Foto z URL';
  if (action === 'search_photo_api') return 'Foto OSINT';
  return action;
}

function createStatusBox({
  title,
  text,
  detailText,
  links,
  listClassName = '',
  listLimit = 0
} = {}) {
  const box = document.createElement('div');
  box.className = 'answer-box';

  const boxTitle = document.createElement('strong');
  boxTitle.className = 'answer-title';
  boxTitle.textContent = title || 'Stav';
  box.appendChild(boxTitle);

  if (text) {
    const bodyText = document.createElement('p');
    bodyText.className = 'answer-text';
    bodyText.textContent = text;
    box.appendChild(bodyText);
  }

  if (detailText) {
    const bodyDetail = document.createElement('p');
    bodyDetail.className = 'result-summary';
    bodyDetail.textContent = detailText;
    box.appendChild(bodyDetail);
  }

  if (Array.isArray(links) && links.length) {
    const list = document.createElement('ul');
    list.className = listClassName;
    list.style.margin = '8px 0 0';
    list.style.paddingLeft = '18px';

    links.slice(0, listLimit > 0 ? listLimit : links.length).forEach((item, index) => {
      const li = document.createElement('li');
      const anchor = document.createElement('a');
      anchor.href = item.url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = `${index + 1}. ${item.label}`;
      li.appendChild(anchor);
      list.appendChild(li);
    });

    box.appendChild(list);
  }

  return box;
}

function getQueryTokens(query) {
  return normalizeWhitespace(query)
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

function jaccardSimilarity(listA, listB) {
  const a = new Set((Array.isArray(listA) ? listA : []).filter(Boolean));
  const b = new Set((Array.isArray(listB) ? listB : []).filter(Boolean));
  if (!a.size || !b.size) return 0;

  let intersection = 0;
  a.forEach((item) => {
    if (b.has(item)) intersection += 1;
  });

  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function compareSearchHistoryEntries(left, right) {
  if (!left || !right) return null;

  const leftTokens = getQueryTokens(left.query);
  const rightTokens = getQueryTokens(right.query);
  const leftSources = left.selectedSources || [];
  const rightSources = right.selectedSources || [];
  const leftUrls = left.resultUrls || [];
  const rightUrls = right.resultUrls || [];

  const sharedSources = leftSources.filter((source) => rightSources.includes(source));
  const sharedUrls = leftUrls.filter((url) => rightUrls.includes(url));
  const queryOverlap = jaccardSimilarity(leftTokens, rightTokens);
  const sourceOverlap = jaccardSimilarity(leftSources, rightSources);
  const resultOverlap = jaccardSimilarity(leftUrls, rightUrls);
  const photoHashMatch = Boolean(
    (left.photoHash && left.photoHash === right.photoHash) ||
    (left.photoPerceptualHash && left.photoPerceptualHash === right.photoPerceptualHash)
  );

  return {
    left,
    right,
    sharedSources,
    sharedUrls,
    queryOverlap,
    sourceOverlap,
    resultOverlap,
    photoHashMatch,
    resultDelta: Math.abs((left.resultCount || 0) - (right.resultCount || 0)),
    queryDelta: Math.abs(leftTokens.length - rightTokens.length)
  };
}

function getSearchHistoryComparisonSummary(comparison) {
  if (!comparison) return 'Vyberte dva záznamy pro porovnani.';

  const parts = [];
  parts.push(`Shoda dotazu: ${Math.round(comparison.queryOverlap * 100)}%`);
  parts.push(`Shoda zdroju: ${Math.round(comparison.sourceOverlap * 100)}%`);
  parts.push(`Shoda vysledku: ${Math.round(comparison.resultOverlap * 100)}%`);
  if (comparison.photoHashMatch) parts.push('Foto hash se shoduje');
  if (comparison.sharedUrls.length) parts.push(`Spolecne URL: ${comparison.sharedUrls.length}`);
  if (comparison.sharedSources.length)
    parts.push(`Spolecne zdroje: ${comparison.sharedSources.length}`);
  return parts.join(' | ');
}

function getSearchHistoryFilterValues() {
  const actionFilter = document.getElementById('search-history-filter');
  const textFilter = document.getElementById('search-history-text-filter');

  return {
    action: actionFilter ? actionFilter.value : 'all',
    text: normalizeWhitespace(textFilter ? textFilter.value : '').toLowerCase()
  };
}

function filterSearchHistoryEntries(entries, filters) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    if (filters.action !== 'all' && entry.action !== filters.action) return false;
    if (filters.text) {
      const haystack = [
        entry.query,
        getActionLabel(entry.action),
        entry.caseId,
        entry.photoHash,
        entry.photoPerceptualHash,
        ...(Array.isArray(entry.selectedSources) ? entry.selectedSources : [])
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(filters.text)) return false;
    }
    return true;
  });
}

function setSelectOptions(select, entries, placeholder) {
  if (!select) return;

  const current = select.value;
  clearNode(select);

  const placeholderOption = document.createElement('option');
  placeholderOption.value = '';
  placeholderOption.textContent = placeholder;
  select.appendChild(placeholderOption);

  entries.forEach((entry) => {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = `${new Date(entry.at).toLocaleString('cs-CZ')} | ${getActionLabel(entry.action)} | ${truncateMiddle(entry.query || 'bez dotazu', 48)}`;
    select.appendChild(option);
  });

  if (Array.from(select.options).some((option) => option.value === current)) {
    select.value = current;
  }
}

function buildHistoryEntryLabel(entry) {
  const date = new Date(entry.at).toLocaleString('cs-CZ');
  const action = getActionLabel(entry.action);
  const query = truncateMiddle(entry.query || '', 64) || 'bez dotazu';
  return `${date} • ${action} • ${query}`;
}

function exportSearchHistory(type) {
  const entries = filterSearchHistoryEntries(
    getSearchHistoryEntries().map(normalizeSearchHistoryEntry),
    getSearchHistoryFilterValues()
  );

  if (!entries.length) {
    showAlert('Historie je prazdna nebo neobsahuje zadne shodne zaznamy.');
    return;
  }

  const filename = `osint-history-export.${type}`;

  if (type === 'csv') {
    const rows = [
      ['at', 'action', 'query', 'resultCount', 'selectedSourceCount', 'sharedUrls', 'photoHash']
    ];

    entries.forEach((entry) => {
      rows.push([
        entry.at,
        entry.action,
        entry.query,
        String(entry.resultCount),
        String(entry.selectedSourceCount),
        String(entry.resultUrls.length),
        entry.photoHash || entry.photoPerceptualHash || ''
      ]);
    });

    const content = rows
      .map((row) => row.map((value) => `"${String(value || '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    downloadText(content, filename, 'text/csv');
    return;
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    filters: getSearchHistoryFilterValues(),
    entries
  };
  downloadText(JSON.stringify(payload, null, 2), filename, 'application/json');
}

function renderSearchHistory() {
  const card = document.getElementById('search-history-card');
  const summary = document.getElementById('search-history-summary');
  const list = document.getElementById('search-history-list');
  const compareOutput = document.getElementById('search-history-compare-output');
  const leftSelect = document.getElementById('search-history-left');
  const rightSelect = document.getElementById('search-history-right');

  if (!card || !summary || !list || !compareOutput || !leftSelect || !rightSelect) return;

  const normalizedEntries = getSearchHistoryEntries().map(normalizeSearchHistoryEntry);
  const filters = getSearchHistoryFilterValues();
  const filtered = filterSearchHistoryEntries(normalizedEntries, filters);

  if (!normalizedEntries.length) {
    card.style.display = 'none';
    clearNode(summary);
    clearNode(list);
    compareOutput.textContent = '';
    return;
  }

  card.style.display = 'block';
  clearNode(summary);

  const stats = [
    `Zaznamu: ${normalizedEntries.length}`,
    `Zobrazeno: ${filtered.length}`,
    `Porovnavani: ${normalizedEntries.length >= 2 ? 'dostupne' : 'nedostupne'}`
  ];

  stats.forEach((text) => {
    const chip = document.createElement('span');
    chip.className = 'photo-summary-chip';
    chip.textContent = text;
    summary.appendChild(chip);
  });

  setSelectOptions(leftSelect, normalizedEntries, 'Vyberte první záznam');
  setSelectOptions(rightSelect, normalizedEntries, 'Vyberte druhý záznam');

  if (!leftSelect.value && normalizedEntries[0]) {
    leftSelect.value = normalizedEntries[0].id;
  }
  if (!rightSelect.value && normalizedEntries[1]) {
    rightSelect.value = normalizedEntries[1].id;
  }

  clearNode(list);
  filtered.slice(0, 25).forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'history-row';

    const head = document.createElement('div');
    head.className = 'history-row-head';

    const title = document.createElement('strong');
    title.textContent = buildHistoryEntryLabel(entry);

    const badge = document.createElement('span');
    badge.className = 'photo-score-badge';
    badge.textContent = `${entry.resultCount} výsledků`;

    head.appendChild(title);
    head.appendChild(badge);

    const meta = document.createElement('div');
    meta.className = 'history-row-meta';
    meta.textContent = [
      `Akce: ${getActionLabel(entry.action)}`,
      entry.selectedSourceCount ? `Zdroje: ${entry.selectedSourceCount}` : 'Bez vybraných zdrojů'
    ]
      .filter(Boolean)
      .join(' • ');

    const compareRow = document.createElement('div');
    compareRow.className = 'row';

    const useLeft = document.createElement('button');
    useLeft.type = 'button';
    useLeft.textContent = 'Do A';
    useLeft.addEventListener('click', () => {
      leftSelect.value = entry.id;
      renderSearchHistory();
    });

    const useRight = document.createElement('button');
    useRight.type = 'button';
    useRight.textContent = 'Do B';
    useRight.addEventListener('click', () => {
      rightSelect.value = entry.id;
      renderSearchHistory();
    });

    compareRow.appendChild(useLeft);
    compareRow.appendChild(useRight);

    row.appendChild(head);
    row.appendChild(meta);
    row.appendChild(compareRow);
    list.appendChild(row);
  });

  const leftEntry =
    normalizedEntries.find((entry) => entry.id === leftSelect.value) ||
    normalizedEntries[0] ||
    null;
  const rightEntry =
    normalizedEntries.find((entry) => entry.id === rightSelect.value) ||
    normalizedEntries[1] ||
    null;
  const comparison = compareSearchHistoryEntries(leftEntry, rightEntry);
  compareOutput.textContent = getSearchHistoryComparisonSummary(comparison);
}

function formatCaseLine(entry) {
  return [
    `${entry.at} | ${entry.action}`,
    `case=${entry.caseId}`,
    entry.operator ? `operator=${entry.operator}` : '',
    entry.caseReason ? `reason=${entry.caseReason}` : '',
    entry.query ? `query=${entry.query}` : '',
    Array.isArray(entry.selectedSources) && entry.selectedSources.length
      ? `sources=${entry.selectedSources.join(',')}`
      : '',
    typeof entry.resultCount === 'number' ? `results=${entry.resultCount}` : '',
    entry.photoHash ? `photoHash=${entry.photoHash}` : '',
    entry.photoHashMd5 ? `photoHashMd5=${entry.photoHashMd5}` : '',
    entry.photoPerceptualHash ? `photoPHash=${entry.photoPerceptualHash}` : ''
  ]
    .filter(Boolean)
    .join(' | ');
}

function getCaseExportTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function getCaseExportFilename() {
  return `case-${getCaseExportTimestamp()}.json`;
}

function buildCaseBundle(caseId) {
  const targetCaseId = normalizeWhitespace(caseId);
  if (!targetCaseId) return null;

  const caseItem = readCases().find((item) => item.id === targetCaseId);
  const caseEntries = readAuditEntries().filter((entry) => entry.caseId === targetCaseId);
  if (!caseEntries.length) return null;

  const prepared = getPreparedResults(lastResults).map((item) => ({
    source: item.label,
    url: item.url,
    validityPercent: item.validityPercent
  }));
  const latestPhotoAnalysis = getLatestPhotoAnalysisFromCaseEntries(caseEntries);
  const caseEntities = getCaseEntities(targetCaseId);
  const caseRelationships = getCaseRelationships(targetCaseId);
  const caseTimeline = getCaseTimeline(targetCaseId);
  const caseEvidence = getCaseEvidence(targetCaseId);
  const caseTasks = getCaseTasks(targetCaseId);
  const entityStats = getEntityStats(targetCaseId);
  const graphImage = getEntityGraphImageDataUrl();

  return {
    schemaVersion: 2,
    bundleType: 'case-bundle',
    exportedAt: new Date().toISOString(),
    case: caseItem || {
      id: targetCaseId,
      title: getCaseTitle(),
      operator: getCaseOperator(),
      reason: getCaseReason(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    auditCount: caseEntries.length,
    entries: caseEntries,
    latestPreparedResults: prepared,
    latestPhotoAnalysis,
    entities: caseEntities,
    relationships: caseRelationships,
    timeline: caseTimeline,
    evidence: caseEvidence,
    tasks: caseTasks,
    entityStats,
    relationshipCount: caseRelationships.length,
    graphImage
  };
}

async function exportCaseBundleToServer(bundle, filename) {
  const response = await fetch('/api/case/export', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fileName: filename,
      caseBundle: bundle
    })
  });

  if (!response.ok) {
    let details = '';
    try {
      const payload = await response.json();
      details = normalizeWhitespace(payload && (payload.error || payload.details));
    } catch {
      details = '';
    }
    throw new Error(details || `Case export endpoint returned HTTP ${response.status}`);
  }

  const result = await response.json();
  return {
    fileName: normalizeWhitespace(result && result.fileName) || filename,
    relativePath: normalizeWhitespace(result && result.relativePath)
  };
}

async function exportCaseBundle() {
  const caseId = getCaseId();
  if (!caseId) {
    showAlert('Nejprve nastavte pripad.');
    return;
  }

  const bundle = buildCaseBundle(caseId);
  if (!bundle) {
    showAlert('Pro tento případ zatím není auditní záznam.');
    return;
  }

  const fileName = getCaseExportFilename();
  try {
    const saved = await exportCaseBundleToServer(bundle, fileName);
    const location = saved.relativePath || `data/exports/${saved.fileName}`;
    showAlert(`Spis JSON (Case export) ulozen do ${location}.`);
    return;
  } catch {
    await downloadText(JSON.stringify(bundle, null, 2), fileName, 'application/json');
    showAlert(
      'Spis JSON (Case export) ulozen pres stazeni (backend ulozeni do data/exports neni dostupne).'
    );
  }
}

function normalizeImportedArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeImportedCaseRecord(value, fallbackCaseId) {
  const source = value && typeof value === 'object' ? value : {};
  const id = normalizeWhitespace(source.id) || fallbackCaseId || generateCaseId();
  const now = new Date().toISOString();

  return {
    id,
    title: normalizeWhitespace(source.title) || 'Bez nazvu',
    operator: normalizeWhitespace(source.operator),
    reason: normalizeWhitespace(source.reason),
    createdAt: source.createdAt || now,
    updatedAt: source.updatedAt || now
  };
}

function remapCaseId(items, caseId, idPrefix) {
  return normalizeImportedArray(items)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      return {
        ...item,
        id: normalizeWhitespace(item.id) || makeCaseItemId(idPrefix),
        caseId
      };
    })
    .filter(Boolean);
}

function applyImportedCaseBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    showAlert('Case import selhal: neplatny format spisu JSON.');
    return;
  }

  const importedCase = normalizeImportedCaseRecord(bundle.case, '');
  const caseId = importedCase.id;

  const entries = remapCaseId(bundle.entries, caseId, 'audit').map((entry) => ({
    ...entry,
    at: entry.at || new Date().toISOString(),
    action: normalizeWhitespace(entry.action) || 'imported_entry',
    query: normalizeWhitespace(entry.query),
    selectedSources: Array.isArray(entry.selectedSources) ? entry.selectedSources : []
  }));
  const entities = remapCaseId(bundle.entities, caseId, 'entity').map((entity) => ({
    ...entity,
    createdAt: entity.createdAt || new Date().toISOString(),
    updatedAt: entity.updatedAt || entity.createdAt || new Date().toISOString()
  }));
  const relationships = remapCaseId(bundle.relationships, caseId, 'rel').map((rel) => ({
    ...rel,
    createdAt: rel.createdAt || new Date().toISOString()
  }));
  const timeline = remapCaseId(bundle.timeline, caseId, 'timeline').map((item) => ({
    ...item,
    createdAt: item.createdAt || new Date().toISOString(),
    updatedAt: item.updatedAt || item.createdAt || new Date().toISOString()
  }));
  const evidence = remapCaseId(bundle.evidence, caseId, 'evidence').map((item) => ({
    ...item,
    createdAt: item.createdAt || new Date().toISOString()
  }));
  const tasks = remapCaseId(bundle.tasks, caseId, 'task').map((item) => ({
    ...item,
    completed: Boolean(item.completed),
    createdAt: item.createdAt || new Date().toISOString(),
    updatedAt: item.updatedAt || item.createdAt || new Date().toISOString()
  }));

  localStorage.setItem(STORAGE_KEYS.cases, JSON.stringify([importedCase]));
  localStorage.setItem(STORAGE_KEYS.audit, JSON.stringify(entries));
  localStorage.setItem(STORAGE_KEYS.entities, JSON.stringify(entities));
  localStorage.setItem(STORAGE_KEYS.relationships, JSON.stringify(relationships));
  localStorage.setItem(STORAGE_KEYS.timeline, JSON.stringify(timeline));
  localStorage.setItem(STORAGE_KEYS.evidence, JSON.stringify(evidence));
  localStorage.setItem(STORAGE_KEYS.tasks, JSON.stringify(tasks));

  setInputValue('case-id', importedCase.id);
  setInputValue('case-title', importedCase.title);
  setInputValue('case-operator', importedCase.operator);
  setInputValue('case-reason', importedCase.reason);
  currentCaseId = importedCase.id || generateCaseId();
  updateCaseDisplay();
  selectedEntityId = '';
  lastResults = [];
  saveUiState();
  renderResults([]);
  updateCaseBadge();
  renderEntityWorkspace();
  showAlert('Import spis JSON (Case import) dokoncen: pripad nacten bez michani dat.');
}

function importCaseBundleFromFile(file) {
  if (!file) return;

  const needsConfirmation = typeof window !== 'undefined' && typeof window.confirm === 'function';
  if (needsConfirmation) {
    const approved = window.confirm(
      'Case import nahradi aktualni case data (audit, entity, vazby, timeline, evidence, tasks). Pokracovat?'
    );
    if (!approved) return;
  }

  file
    .text()
    .then((raw) => {
      const parsed = JSON.parse(raw);
      applyImportedCaseBundle(parsed);
    })
    .catch(() => {
      showAlert('Import spis JSON (Case import) selhal. Zkontrolujte JSON soubor.');
    });
}

function exportCaseAuditTxt() {
  const caseId = getCaseId();
  if (!caseId) {
    showAlert('Nejprve nastavte pripad.');
    return;
  }

  const entries = readAuditEntries().filter((entry) => entry.caseId === caseId);
  if (!entries.length) {
    showAlert('Pro tento případ zatím není auditní záznam.');
    return;
  }

  const content = entries.map((entry) => formatCaseLine(entry)).join('\n');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadText(content, `osint-case-audit-${caseId}-${stamp}.txt`, 'text/plain');
  showAlert(`Audit TXT (case) exportovan: ${entries.length} zaznamu.`);
}

function getCaseRecord(caseId) {
  if (!caseId) return null;
  return readCases().find((item) => item.id === caseId) || null;
}

function getCurrentCaseEntries(caseId) {
  if (!caseId) return [];
  return readAuditEntries()
    .filter((entry) => entry.caseId === caseId)
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || ''), 'cs'));
}

function getSourceFromPreparedLabel(label) {
  if (!label) return null;
  const cleanLabel = String(label).split(' [')[0].trim();
  return getSourceByLabel(cleanLabel);
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function toRiskLevel(score) {
  if (score >= 75) return 'vysoke';
  if (score >= 45) return 'stredni';
  return 'nizke';
}

function parseManualLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line.replace(/^[-*]\s*/, '')))
    .filter(Boolean);
}

function getFinalReportNotes() {
  return {
    summary: getInputValue('final-summary'),
    risks: getInputValue('final-risk-notes'),
    cases: getInputValue('final-cases-notes'),
    links: getInputValue('final-connections-notes'),
    nextSteps: getInputValue('final-next-steps')
  };
}

function getFinalReportPreparedResults() {
  const links = lastResults.length ? lastResults : getActiveLinks();
  return getPreparedResults(links);
}

function buildFinalReportData() {
  const caseId = getCaseId();
  const caseRecord = getCaseRecord(caseId);
  const caseEntries = getCurrentCaseEntries(caseId);
  const caseEntities = getCaseEntities(caseId);
  const caseRelationships = getCaseRelationships(caseId);
  const entityStats = getEntityStats(caseId);
  const timeline = getCaseTimeline(caseId);
  const tasks = getCaseTasks(caseId);
  const evidence = getCaseEvidence(caseId);
  const prepared = getFinalReportPreparedResults();
  const notes = getFinalReportNotes();
  const latestPhotoAnalysis = getLatestPhotoAnalysisFromCaseEntries(caseEntries);
  const caseRecommendations = generateCaseRecommendations(caseId);
  const assistantFocusResult = getAssistantFocusResult();
  const assistantOutput = getAssistantOutput(assistantFocusResult);
  const recommendations = Array.from(
    new Set([...assistantOutput.doporuceni, ...caseRecommendations])
  );

  const sourceStats = new Map();
  const domainStats = new Map();
  const riskFlags = new Set();
  let sumValidity = 0;
  let officialSourceCount = 0;

  prepared.forEach((item) => {
    sumValidity += item.validityPercent;
    const source = getSourceFromPreparedLabel(item.label);
    if (source) {
      const count = sourceStats.get(source.label) || 0;
      sourceStats.set(source.label, count + 1);

      if (
        /^src_(interpol|europol|fbi_wanted|eu_most_wanted|dea|usmarshals|nca_uk|ofac|eu_sanctions|un_sanctions)$/.test(
          source.id
        )
      ) {
        officialSourceCount += 1;
      }
    }

    const domain = domainFromUrl(item.url);
    if (domain) {
      const count = domainStats.get(domain) || 0;
      domainStats.set(domain, count + 1);
    }

    const riskText = `${item.label} ${item.url}`.toLowerCase();
    if (/wanted|red\s*notice|fugitive/.test(riskText))
      riskFlags.add('Mozny wanted/fugitive zaznam');
    if (/sanction|ofac|eu sanctions|un sanctions/.test(riskText))
      riskFlags.add('Mozny sankcni zaznam');
    if (/fraud|scam|podvod/.test(riskText)) riskFlags.add('Mozna vazba na podvodne aktivity');
    if (/terror|extrem/.test(riskText)) riskFlags.add('Mozna bezpecnostni/extremisticka stopa');
  });

  parseManualLines(notes.risks).forEach((line) => riskFlags.add(line));

  const avgValidity = prepared.length ? Math.round(sumValidity / prepared.length) : 0;
  const queryCompleteness = Math.round(getQueryCompleteness() * 100);
  const riskScore = clamp(
    Math.round(
      avgValidity * 0.45 + Math.min(officialSourceCount, 8) * 6 + Math.min(riskFlags.size, 8) * 5
    ),
    0,
    100
  );

  const summaryPoints = [];
  if (notes.summary.trim()) {
    summaryPoints.push(...parseManualLines(notes.summary));
  }
  summaryPoints.push(`Nalezeno ${prepared.length} pripravenych odkazu pro overeni.`);
  summaryPoints.push(
    `Prumerna validita odkazu je ${avgValidity}% (kompletnost dotazu ${queryCompleteness}%).`
  );
  if (officialSourceCount) {
    summaryPoints.push(
      `Mezi pripravenymi odkazy je ${officialSourceCount} oficialnich zdroju k overeni.`
    );
  }
  if (caseEntries.length) {
    summaryPoints.push(`Audit pripadu obsahuje ${caseEntries.length} zaznamu.`);
  }

  return {
    generatedAt: new Date().toISOString(),
    caseId,
    caseRecord,
    operator: (caseRecord && caseRecord.operator) || getCaseOperator(),
    reason: (caseRecord && caseRecord.reason) || getCaseReason(),
    query: getQuery(),
    subject: {
      name: normalizeWhitespace(getInputValue('name')),
      nick: normalizeWhitespace(getInputValue('nick')),
      city: normalizeWhitespace(getInputValue('city')),
      phone: normalizePhone(getInputValue('phone')),
      photoUrl: getPhotoUrlInput()
    },
    notes,
    summaryPoints,
    riskScore,
    riskLevel: toRiskLevel(riskScore),
    riskFlags: Array.from(riskFlags).slice(0, 14),
    preparedResults: prepared,
    topSources: Array.from(sourceStats.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12),
    topDomains: Array.from(domainStats.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12),
    caseEntries,
    timeline,
    tasks,
    evidence,
    assistantOutput,
    recommendations,
    entities: caseEntities,
    relationships: caseRelationships,
    entityStats,
    relationshipCount: caseRelationships.length,
    graphImage: getEntityGraphImageDataUrl(),
    photoAnalysis: latestPhotoAnalysis,
    manualCases: parseManualLines(notes.cases),
    manualConnections: parseManualLines(notes.links),
    manualNextSteps: parseManualLines(notes.nextSteps),
    avgValidity,
    queryCompleteness
  };
}

function getFinalReportSubjectLabel(report) {
  const subject = [
    report.subject.name,
    report.subject.nick ? `(${report.subject.nick})` : '',
    report.subject.city ? `, ${report.subject.city}` : ''
  ]
    .filter(Boolean)
    .join(' ')
    .trim();

  if (subject) return subject;
  if (report.subject.photoUrl) return `Foto URL: ${report.subject.photoUrl}`;
  return 'Subjekt neuveden';
}

function buildFinalReportText(report) {
  const lines = [];
  const caseTitle = report.caseRecord && report.caseRecord.title ? report.caseRecord.title : '';
  const subjectLabel = getFinalReportSubjectLabel(report);
  const generatedAt = new Date(report.generatedAt).toLocaleString('cs-CZ');
  const reportId = report.caseId || 'nenastaven';
  const prepared = Array.isArray(report.preparedResults) ? report.preparedResults : [];
  const topResults = prepared.slice(0, 10);
  const auditSlice = Array.isArray(report.caseEntries) ? report.caseEntries.slice(-10) : [];
  const timeline = Array.isArray(report.timeline) ? report.timeline : [];
  const tasks = Array.isArray(report.tasks) ? report.tasks : [];
  const evidence = Array.isArray(report.evidence) ? report.evidence : [];
  const riskFlags = Array.isArray(report.riskFlags) ? report.riskFlags : [];
  const topSources = Array.isArray(report.topSources) ? report.topSources : [];
  const topDomains = Array.isArray(report.topDomains) ? report.topDomains : [];
  const summaryPoints = Array.isArray(report.summaryPoints) ? report.summaryPoints : [];
  const recommendations = Array.isArray(report.recommendations) ? report.recommendations : [];
  const manualCases = Array.isArray(report.manualCases) ? report.manualCases : [];
  const manualConnections = Array.isArray(report.manualConnections) ? report.manualConnections : [];
  const manualNextSteps = Array.isArray(report.manualNextSteps) ? report.manualNextSteps : [];

  const addTitle = (title) => {
    lines.push('');
    lines.push(title);
    lines.push('-'.repeat(Math.max(title.length, 18)));
  };

  const addBulletList = (items, emptyLine) => {
    if (items.length) {
      items.forEach((item) => lines.push(`- ${item}`));
      return;
    }
    lines.push(`- ${emptyLine}`);
  };

  lines.push('OSINT Finder - Úřední report');
  lines.push('Příloha k úřednímu záznamu / pracovní souhrn podkladů');
  lines.push(`Vyhotoveno: ${generatedAt}`);
  lines.push(`Případ: ${reportId}${caseTitle ? ` (${caseTitle})` : ''}`);
  lines.push(`Operátor: ${report.operator || '-'}`);
  lines.push(`Důvod šetření: ${report.reason || '-'}`);
  lines.push(`Subjekt: ${subjectLabel}`);
  lines.push(`Dotaz: ${report.query || '-'}`);
  lines.push(`Orientační rizikové skóre: ${report.riskScore}/100 (${report.riskLevel})`);
  lines.push(`Kompletnost dotazu: ${report.queryCompleteness || 0}%`);
  lines.push(
    'Poznámka: dokument shrnuje pracovní zjištění a odkazy k ověření, nikoli definitivní závěr.'
  );

  addTitle('1. Stručné shrnutí');
  if (report.notes && report.notes.summary) {
    addBulletList(parseManualLines(report.notes.summary), 'Bez doplněného shrnutí.');
  }
  addBulletList(summaryPoints, 'Bez automaticky vygenerovaných shrnujících bodů.');

  addTitle('2. Klíčová zjištění a validita');
  if (topResults.length) {
    topResults.forEach((item, index) => {
      lines.push(
        `${index + 1}. ${item.label} [${getReportLinkNature(item)}] - validita ${item.validityPercent}%, URL: ${item.url}`
      );
    });
  } else {
    lines.push('- Nebyly k dispozici žádné zpracované výsledky.');
  }

  addTitle('3. Závadové indikátory a rizika');
  if (report.notes && report.notes.risks) {
    addBulletList(parseManualLines(report.notes.risks), 'Bez doplněných závadových informací.');
  }
  addBulletList(riskFlags, 'Nebyly identifikovány jednoznačné závadové indikátory.');
  if (report.assistantOutput && typeof report.assistantOutput === 'object') {
    lines.push(`- Závěr asistenta: ${report.assistantOutput.zaver || 'n/a'}`);
    addBulletList(report.assistantOutput.rizika || [], 'Asistent nevrátil další rizika.');
  } else {
    lines.push('- Asistent neměl dostatek dat pro interpretaci.');
  }

  addTitle('4. Použité zdroje a domény');
  if (topSources.length) {
    topSources.forEach(([source, count]) => lines.push(`- ${source} (${count}x)`));
  } else {
    lines.push('- Zatím bez vyhodnocených zdrojů.');
  }
  if (topDomains.length) {
    topDomains.slice(0, 8).forEach(([domain, count]) => {
      lines.push(`- Domena ${domain} (${count}x)`);
    });
  } else {
    lines.push('- Zatím bez vyhodnocených domén.');
  }

  addTitle('5. Entity a vazby');
  if (report.notes && report.notes.links) {
    addBulletList(parseManualLines(report.notes.links), 'Bez doplněných spojitostí a vazeb.');
  }
  if (manualConnections.length) {
    manualConnections.forEach((line) => lines.push(`- ${line}`));
  }
  ENTITY_TYPES.forEach((type) => {
    const count =
      report.entityStats && typeof report.entityStats[type.value] === 'number'
        ? report.entityStats[type.value]
        : 0;
    if (count > 0) {
      lines.push(`- ${type.label}: ${count}`);
    }
  });
  lines.push(`- Vazby celkem: ${report.relationshipCount || 0}`);
  if (Array.isArray(report.relationships) && report.relationships.length) {
    report.relationships.slice(0, 20).forEach((rel) => {
      const source = (report.entities || []).find((item) => item.id === rel.sourceEntityId);
      const target = (report.entities || []).find((item) => item.id === rel.targetEntityId);
      const sourceName = source ? source.name : rel.sourceEntityId;
      const targetName = target ? target.name : rel.targetEntityId;
      lines.push(
        `- ${sourceName} -> ${rel.relationshipType} -> ${targetName} (confidence ${rel.confidence}%)`
      );
    });
  } else {
    lines.push('- Bez evidovaných vazeb k přiložení.');
  }

  addTitle('6. Foto analýza');
  if (report.photoAnalysis && report.photoAnalysis.hashes) {
    if (report.photoAnalysis.hashes.sha256)
      lines.push(`- SHA256: ${report.photoAnalysis.hashes.sha256}`);
    if (report.photoAnalysis.hashes.md5) lines.push(`- MD5: ${report.photoAnalysis.hashes.md5}`);
    if (report.photoAnalysis.hashes.perceptualHash)
      lines.push(`- Perceptual hash: ${report.photoAnalysis.hashes.perceptualHash}`);

    const exif = report.photoAnalysis.exif;
    if (exif && typeof exif === 'object') {
      if (exif.make) lines.push(`- EXIF výrobce: ${exif.make}`);
      if (exif.model) lines.push(`- EXIF model: ${exif.model}`);
      if (exif.software) lines.push(`- EXIF software: ${exif.software}`);
      if (exif.dateTimeOriginal) lines.push(`- EXIF datum: ${exif.dateTimeOriginal}`);
      if (
        exif.gps &&
        typeof exif.gps === 'object' &&
        typeof exif.gps.lat === 'number' &&
        typeof exif.gps.lon === 'number'
      ) {
        lines.push(`- EXIF GPS: ${exif.gps.lat}, ${exif.gps.lon}`);
      }
    }

    if (Array.isArray(report.photoAnalysis.geoLinks) && report.photoAnalysis.geoLinks.length) {
      report.photoAnalysis.geoLinks.forEach((item) => {
        lines.push(`- ${item.source}: ${item.url}`);
      });
    }
  } else {
    lines.push('- Foto analýza nebyla k dispozici.');
  }

  addTitle('7. Audit a průběh práce');
  if (report.notes && report.notes.cases) {
    addBulletList(parseManualLines(report.notes.cases), 'Bez doplněných případových poznámek.');
  }
  if (manualCases.length) {
    manualCases.forEach((line) => lines.push(`- ${line}`));
  }
  if (auditSlice.length) {
    auditSlice.forEach((entry) => {
      lines.push(
        `- Audit ${new Date(entry.at).toLocaleString('cs-CZ')} | ${entry.action} | výsledků: ${entry.resultCount || 0}`
      );
    });
  } else {
    lines.push('- Zatím bez auditních záznamů.');
  }
  if (timeline.length) {
    timeline.forEach((item) => {
      lines.push(
        `- ${new Date(item.createdAt).toLocaleString('cs-CZ')} | ${item.title} | ${item.description || '-'}`
      );
    });
  } else {
    lines.push('- Bez zaznamenaných událostí timeline.');
  }

  addTitle('8. Evidence a přílohy');
  if (tasks.length) {
    tasks.forEach((item) => {
      lines.push(`- [${item.completed ? 'x' : ' '}] ${item.title}`);
    });
  } else {
    lines.push('- Bez evidovaných úkolů.');
  }
  if (evidence.length) {
    evidence.forEach((item) => {
      lines.push(`- ${item.fileName} (${item.fileType || 'unknown'})`);
    });
  } else {
    lines.push('- Bez přiložených souborů.');
  }
  if (report.photoAnalysis && Array.isArray(report.photoAnalysis.geoLinks)) {
    report.photoAnalysis.geoLinks.forEach((item) => {
      lines.push(`- ${item.source}: ${item.url}`);
    });
  }

  addTitle('9. Doporučení a další kroky');
  if (report.notes && report.notes.nextSteps) {
    addBulletList(parseManualLines(report.notes.nextSteps), 'Bez doplněných dalších kroků.');
  } else {
    lines.push('- Ověřit top oficiální zdroje s nejvyšší validitou.');
    lines.push('- Projít odkazy z oficiálních registrů ručně a uložit screenshoty.');
    lines.push('- Potvrdit nebo vyvrátit spojitosti mezi profily a doménami.');
  }
  addBulletList(manualNextSteps, 'Bez doplněných dalších kroků.');
  addBulletList(recommendations, 'Bez dalších automatických doporučení.');

  addTitle('10. Odkazy k ověření');
  if (prepared.length) {
    prepared.slice(0, 30).forEach((item, index) => {
      lines.push(
        `${index + 1}. ${item.label} [${getReportLinkNature(item)}]: ${item.url} (Validita ${item.validityPercent}%)`
      );
    });
  } else {
    lines.push('- Bez dostupných odkazů k ověření.');
  }

  lines.push('');
  lines.push('Poznámka: tento report slouží jako pracovní příloha a podklad k dalšímu ověření.');

  return lines.join('\n');
}

function exportFinalReportTxt() {
  const report = buildFinalReportData();
  if (!report.preparedResults.length) {
    showAlert('Nejprve vygenerujte alespon jedny vysledky.');
    return;
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const casePart = report.caseId || 'bez-case';
  const content = buildFinalReportText(report);
  downloadText(content, `osint-uredni-report-${casePart}-${stamp}.txt`, 'text/plain');
  showAlert('Úřední report TXT byl exportován.');
}

async function exportFinalReportPdf() {
  const report = buildFinalReportData();
  if (!report.preparedResults.length) {
    showAlert('Nejprve vygenerujte alespon jedny vysledky.');
    return;
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const casePart = report.caseId || 'bez-case';
  const filename = `osint-uredni-report-${casePart}-${stamp}.pdf`;
  const reportText = buildFinalReportText(report);

  if (window.jspdf && window.jspdf.jsPDF) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const lines = doc.splitTextToSize(reportText, 510);

    let y = 40;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(17);
    doc.text('OSINT Finder - Uredni report', 40, y);
    y += 22;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    lines.forEach((line) => {
      if (y > 800) {
        doc.addPage();
        y = 40;
      }
      doc.text(line, 40, y);
      y += 13;
    });

    if (report.graphImage) {
      try {
        if (y > 580) {
          doc.addPage();
          y = 40;
        }
        doc.setFontSize(11);
        doc.text('Graf vztahu entit:', 40, y);
        y += 10;
        doc.addImage(report.graphImage, 'PNG', 40, y, 500, 220);
      } catch {
        // ignore graph image rendering errors
      }
    }

    const pdfBlob = doc.output('blob');
    const saved = await saveBlobToPreferredFolder(filename, pdfBlob);
    if (!saved) {
      triggerBrowserDownload(pdfBlob, filename);
    }
    showAlert('Úřední report PDF byl exportován.');
    return;
  }

  const html = `<!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8" />
  <title>Uredni report</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 28px; color: #17293d; }
    h1 { margin: 0 0 8px; }
    pre { white-space: pre-wrap; font-size: 13px; line-height: 1.45; }
    @media print { body { margin: 14mm; } }
  </style>
</head>
<body>
  <h1>OSINT Finder - Uredni report</h1>
  <pre>${escapeHtml(reportText)}</pre>
  ${report.graphImage ? `<h2>Graf vztahu entit</h2><img src="${report.graphImage}" alt="Graf vztahu entit" style="max-width:100%;height:auto;border:1px solid #c9d7e5;border-radius:8px;" />` : ''}
</body>
</html>`;

  const reportWindow = window.open('', '_blank', 'noopener,noreferrer');
  if (!reportWindow) {
    showAlert('Prohlizec zablokoval popup pro tisk reportu.');
    return;
  }

  reportWindow.document.open();
  reportWindow.document.write(html);
  reportWindow.document.close();
  reportWindow.focus();
  setTimeout(() => {
    reportWindow.print();
  }, 250);
}

async function hashFileSha256(file) {
  if (!file || !window.crypto || !window.crypto.subtle) {
    return '';
  }

  try {
    const buffer = await file.arrayBuffer();
    const digest = await window.crypto.subtle.digest('SHA-256', buffer);
    const bytes = Array.from(new Uint8Array(digest));
    return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

function normalizePhotoAnalysis(payload) {
  const hashes =
    payload && payload.hashes
      ? payload.hashes
      : (payload && payload.imageMeta && payload.imageMeta.hashes) || {};
  const exif =
    payload && payload.exif
      ? payload.exif
      : (payload && payload.imageMeta && payload.imageMeta.exif) || null;
  const geoLinks = Array.isArray(payload && payload.geoLinks)
    ? payload.geoLinks
    : Array.isArray(payload && payload.imageMeta && payload.imageMeta.geoLinks)
      ? payload.imageMeta.geoLinks
      : [];

  const normalized = {
    hashes: {
      sha256: normalizeWhitespace(hashes && hashes.sha256),
      md5: normalizeWhitespace(hashes && hashes.md5),
      perceptualHash: normalizeWhitespace(
        hashes && (hashes.perceptualHash || hashes.pHash || hashes.phash)
      )
    },
    exif: exif || null,
    geoLinks: geoLinks
      .map((item) => ({
        source: normalizeWhitespace(item && item.source),
        url: normalizeWhitespace(item && item.url)
      }))
      .filter((item) => item.source && item.url)
  };

  const hasData =
    normalized.hashes.sha256 ||
    normalized.hashes.md5 ||
    normalized.hashes.perceptualHash ||
    (normalized.exif && typeof normalized.exif === 'object') ||
    normalized.geoLinks.length;

  return hasData ? normalized : null;
}

function renderPhotoAnalysis(analysis) {
  const box = document.getElementById('photo-analysis');
  if (!box) return;

  if (!analysis) {
    box.style.display = 'none';
    box.textContent = '';
    photoSensitiveDetailsOpen = false;
    return;
  }

  const hashLines = [];
  if (analysis.hashes.sha256)
    hashLines.push(`<li><strong>SHA256:</strong> ${escapeHtml(analysis.hashes.sha256)}</li>`);
  if (analysis.hashes.md5)
    hashLines.push(`<li><strong>MD5:</strong> ${escapeHtml(analysis.hashes.md5)}</li>`);
  if (analysis.hashes.perceptualHash)
    hashLines.push(
      `<li><strong>Perceptual hash:</strong> ${escapeHtml(analysis.hashes.perceptualHash)}</li>`
    );

  const safeLines = [];

  if (analysis.exif && typeof analysis.exif === 'object') {
    if (analysis.exif.make)
      safeLines.push(`<li><strong>EXIF make:</strong> ${escapeHtml(analysis.exif.make)}</li>`);
    if (analysis.exif.model)
      safeLines.push(`<li><strong>EXIF model:</strong> ${escapeHtml(analysis.exif.model)}</li>`);
    if (analysis.exif.software)
      safeLines.push(
        `<li><strong>EXIF software:</strong> ${escapeHtml(analysis.exif.software)}</li>`
      );
    if (analysis.exif.dateTimeOriginal)
      safeLines.push(
        `<li><strong>EXIF datum:</strong> ${escapeHtml(String(analysis.exif.dateTimeOriginal))}</li>`
      );
    if (analysis.exif.gps && typeof analysis.exif.gps === 'object') {
      const lat = analysis.exif.gps.lat;
      const lon = analysis.exif.gps.lon;
      if (typeof lat === 'number' && typeof lon === 'number') {
        safeLines.push(`<li><strong>EXIF GPS:</strong> ${lat}, ${lon}</li>`);
      }
    }
  }

  analysis.geoLinks.forEach((item) => {
    safeLines.push(
      `<li><strong>${escapeHtml(item.source)}:</strong> <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.url)}</a></li>`
    );
  });

  if (!hashLines.length && !safeLines.length) {
    box.style.display = 'none';
    box.textContent = '';
    return;
  }

  if (!photoSensitiveDetailsOpen) {
    box.innerHTML = `<h4>Foto analyza (backend)</h4>
      <p class="small">Hash, raw data a request logy jsou defaultne skryte.</p>
      <button type="button" id="photo-sensitive-toggle-btn">Zobrazit technicke detaily</button>`;
    const showBtn = document.getElementById('photo-sensitive-toggle-btn');
    if (showBtn) {
      showBtn.addEventListener('click', () => {
        photoSensitiveDetailsOpen = true;
        renderPhotoAnalysis(analysis);
      });
    }
    box.style.display = 'block';
    return;
  }

  box.innerHTML = `<h4>Foto analyza (backend)</h4>
    <ul>${hashLines.join('')}${safeLines.join('')}</ul>
    <button type="button" id="photo-sensitive-toggle-btn">Skryt technicke detaily</button>`;
  const hideBtn = document.getElementById('photo-sensitive-toggle-btn');
  if (hideBtn) {
    hideBtn.addEventListener('click', () => {
      photoSensitiveDetailsOpen = false;
      renderPhotoAnalysis(analysis);
    });
  }
  box.style.display = 'block';
}

function clearNode(node) {
  if (!node) return;
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function extractHostnameFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizePercentScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num <= 1) return Math.round(clamp(num, 0, 1) * 100);
  return Math.round(clamp(num, 0, 100));
}

function buildPhotoDashboardItems(payload) {
  const list = Array.isArray(payload && payload.results) ? payload.results : [];

  return list
    .map((item, index) => {
      const url = normalizeWhitespace(item && item.url);
      if (!url) return null;

      const label =
        normalizeWhitespace(item && (item.source || item.title || item.label)) ||
        `Výsledek ${index + 1}`;
      const domain = extractHostnameFromUrl(url);
      const score = normalizePercentScore(item && item.score);
      const qualityScore = normalizePercentScore(item && (item.qualityScore ?? item.score));
      const sourceCount = Math.max(0, Number(item && item.sourceCount) || 0);
      const similarityComponent = normalizePercentScore(item && item.similarityComponent);
      const occurrences = Math.max(1, Number(item && item.occurrences) || 1);
      const manipulated = Boolean(item && item.manipulated);
      const manipulationReasons = Array.isArray(item && item.manipulationReasons)
        ? item.manipulationReasons.map((reason) => normalizeWhitespace(reason)).filter(Boolean)
        : [];
      const sources = Array.isArray(item && item.sources)
        ? item.sources.map((value) => normalizeWhitespace(value)).filter(Boolean)
        : [];
      const domains = Array.isArray(item && item.domains)
        ? item.domains.map((value) => normalizeWhitespace(value).toLowerCase()).filter(Boolean)
        : domain
          ? [domain]
          : [];
      const hashMatchRaw = item && (item.hashMatch ?? item.photoHashMatch ?? item.exactHashMatch);
      const hashMatch = typeof hashMatchRaw === 'boolean' ? hashMatchRaw : null;
      const scoreBreakdown =
        item && typeof item.scoreBreakdown === 'object' && item.scoreBreakdown
          ? {
              similarity: normalizePercentScore(item.scoreBreakdown.similarity),
              sourceCount: normalizePercentScore(item.scoreBreakdown.sourceCount),
              domainTrust: normalizePercentScore(item.scoreBreakdown.domainTrust),
              hashSimilarity: normalizePercentScore(item.scoreBreakdown.hashSimilarity),
              textRepeat: normalizePercentScore(item.scoreBreakdown.textRepeat)
            }
          : {
              similarity: similarityComponent,
              sourceCount: normalizePercentScore(sourceCount * 25),
              domainTrust: 0,
              hashSimilarity: 0,
              textRepeat: normalizePercentScore(item && item.textRepeatScore)
            };
      const logicAnalysis =
        item && typeof item.logicAnalysis === 'object' && item.logicAnalysis
          ? {
              consistency: item.logicAnalysis.consistency || null,
              contradictions: item.logicAnalysis.contradictions || null,
              conclusion: normalizeWhitespace(item.logicAnalysis.conclusion) || 'Uncertain'
            }
          : null;
      const aiAnalysis =
        item && typeof item.aiAnalysis === 'object' && item.aiAnalysis
          ? {
              conclusion: normalizeWhitespace(item.aiAnalysis.conclusion) || 'Uncertain',
              reasoning: normalizeWhitespace(item.aiAnalysis.reasoning),
              risk: normalizeWhitespace(item.aiAnalysis.risk).toUpperCase() || 'MEDIUM'
            }
          : null;

      return {
        id: `photo-${index}`,
        index,
        label,
        url,
        domain,
        score,
        qualityScore,
        sourceCount,
        occurrences,
        similarityComponent,
        manipulated,
        manipulationReasons,
        sources,
        domains,
        scoreBreakdown,
        logicAnalysis,
        aiAnalysis,
        hashMatch,
        detectedText: normalizeWhitespace(item && item.detectedText)
      };
    })
    .filter(Boolean);
}

function getPhotoDashboardFilters() {
  const domainSelect = document.getElementById('photo-domain-filter');
  const scoreRange = document.getElementById('photo-min-score');
  const sortSelect = document.getElementById('photo-sort-mode');

  return {
    domain: domainSelect ? domainSelect.value : 'all',
    minScore: Number(scoreRange && scoreRange.value) || 0,
    sort: sortSelect ? sortSelect.value : 'relevance'
  };
}

function sortPhotoDashboardItems(items, sortMode) {
  const list = Array.isArray(items) ? items.slice() : [];

  if (sortMode === 'domain') {
    return list.sort(
      (a, b) =>
        a.domain.localeCompare(b.domain) ||
        b.score - a.score ||
        a.label.localeCompare(b.label, 'cs')
    );
  }

  if (sortMode === 'timeline') {
    return list.sort((a, b) => a.index - b.index);
  }

  return list.sort(
    (a, b) =>
      b.score - a.score || b.qualityScore - a.qualityScore || a.label.localeCompare(b.label, 'cs')
  );
}

function buildPhotoDashboardSummary(items) {
  const domains = new Set();
  let scoreSum = 0;
  let scoreCount = 0;

  items.forEach((item) => {
    if (item.domain) domains.add(item.domain);
    if (Number.isFinite(item.score)) {
      scoreSum += item.score;
      scoreCount += 1;
    }
  });

  return {
    total: items.length,
    domainCount: domains.size,
    averageScore: scoreCount ? Math.round(scoreSum / scoreCount) : 0
  };
}

function buildPhotoSourceCoverage(items) {
  const counts = new Map();

  items.forEach((item) => {
    const key = item.label || 'Neznámý zdroj';
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  return Array.from(counts.entries())
    .map(([label, count]) => ({
      label,
      count,
      percent: items.length ? Math.round((count / items.length) * 100) : 0
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'cs'));
}

function filterPhotoDashboardItems(items, filters) {
  return (Array.isArray(items) ? items : []).filter((item) => {
    if (filters.domain !== 'all' && item.domain !== filters.domain) return false;
    const relevance = Math.max(
      item.score,
      item.qualityScore,
      item.sourceCount * 25,
      item.similarityComponent
    );
    if (relevance < filters.minScore) return false;
    return true;
  });
}

function renderPhotoDashboardOptions(items) {
  const domainSelect = document.getElementById('photo-domain-filter');
  if (!domainSelect) return;

  const currentValue = domainSelect.value || 'all';
  const domains = Array.from(new Set(items.map((item) => item.domain).filter(Boolean))).sort(
    (a, b) => a.localeCompare(b, 'cs')
  );

  clearNode(domainSelect);

  const allOption = document.createElement('option');
  allOption.value = 'all';
  allOption.textContent = 'Všechny domény';
  domainSelect.appendChild(allOption);

  domains.forEach((domain) => {
    const option = document.createElement('option');
    option.value = domain;
    option.textContent = domain;
    domainSelect.appendChild(option);
  });

  domainSelect.value = domains.includes(currentValue) ? currentValue : 'all';
}

function renderPhotoDashboard(payload) {
  const panel = document.getElementById('photo-dashboard');
  const summaryBox = document.getElementById('photo-dashboard-summary');
  const progressBox = document.getElementById('photo-source-progress');
  const resultsBox = document.getElementById('photo-results-list');
  const timelineBox = document.getElementById('photo-timeline');

  if (!panel || !summaryBox || !progressBox || !resultsBox || !timelineBox) return;

  const items = buildPhotoDashboardItems(payload);
  lastPhotoDashboard =
    payload && items.length
      ? {
          ...payload,
          items
        }
      : null;

  if (!items.length) {
    panel.style.display = 'none';
    clearNode(summaryBox);
    clearNode(progressBox);
    clearNode(resultsBox);
    clearNode(timelineBox);
    return;
  }

  panel.style.display = 'block';
  renderPhotoDashboardOptions(items);

  const filters = getPhotoDashboardFilters();
  const filteredItems = sortPhotoDashboardItems(
    filterPhotoDashboardItems(items, filters),
    filters.sort
  );
  const summary = buildPhotoDashboardSummary(items);
  const coverage = buildPhotoSourceCoverage(items);

  clearNode(summaryBox);
  const summaryItems = [
    `Vysledku: ${summary.total}`,
    `Domén: ${summary.domainCount}`,
    `Průměrné score: ${summary.averageScore}%`
  ];
  summaryItems.forEach((text) => {
    const badge = document.createElement('span');
    badge.className = 'photo-summary-chip';
    badge.textContent = text;
    summaryBox.appendChild(badge);
  });

  clearNode(progressBox);
  coverage.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'photo-progress-row';

    const label = document.createElement('div');
    label.className = 'photo-progress-label';
    label.textContent = `${item.label} (${item.count})`;

    const barWrap = document.createElement('div');
    barWrap.className = 'photo-progress-bar';

    const bar = document.createElement('div');
    bar.className = 'photo-progress-bar-fill';
    bar.style.width = `${Math.max(8, item.percent)}%`;
    bar.title = `${item.percent}% z celkového počtu`;
    barWrap.appendChild(bar);

    row.appendChild(label);
    row.appendChild(barWrap);
    progressBox.appendChild(row);
  });

  clearNode(resultsBox);
  filteredItems.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'photo-result-row';

    const head = document.createElement('div');
    head.className = 'photo-result-head';

    const title = document.createElement('strong');
    title.textContent = item.label;

    const badge = document.createElement('span');
    badge.className = 'photo-score-badge';
    badge.textContent = `Score ${Math.max(item.score, item.qualityScore)}%`;

    head.appendChild(title);
    head.appendChild(badge);

    const meta = document.createElement('div');
    meta.className = 'photo-result-meta';
    const metaParts = [
      item.domain || 'neznámá doména',
      item.manipulated ? 'manipulace' : 'beze změny',
      item.detectedText ? `OCR: ${truncateMiddle(item.detectedText, 50)}` : ''
    ].filter(Boolean);
    meta.textContent = metaParts.join(' • ');

    const url = document.createElement('a');
    url.href = item.url;
    url.target = '_blank';
    url.rel = 'noopener noreferrer';
    url.textContent = item.url;

    const actions = document.createElement('div');
    actions.className = 'row';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = 'Otevřít';
    openBtn.addEventListener('click', () => openSearch(item.url));

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Kopírovat';
    copyBtn.addEventListener('click', () => copyText(item.url, 'Odkaz zkopírován.'));

    actions.appendChild(openBtn);
    actions.appendChild(copyBtn);

    row.appendChild(head);
    row.appendChild(meta);
    row.appendChild(url);
    row.appendChild(actions);
    resultsBox.appendChild(row);
  });

  clearNode(timelineBox);
  filteredItems
    .slice()
    .sort((a, b) => a.index - b.index)
    .forEach((item, index) => {
      const step = document.createElement('div');
      step.className = 'photo-timeline-item';

      const marker = document.createElement('span');
      marker.className = 'photo-timeline-marker';
      marker.textContent = String(index + 1).padStart(2, '0');

      const text = document.createElement('div');
      text.className = 'photo-timeline-text';
      text.textContent = `${item.label} • ${item.domain || 'neznámá doména'} • ${Math.max(item.score, item.qualityScore)}%`;

      step.appendChild(marker);
      step.appendChild(text);
      timelineBox.appendChild(step);
    });
}

function exportPhotoDashboard(type) {
  if (
    !lastPhotoDashboard ||
    !Array.isArray(lastPhotoDashboard.items) ||
    !lastPhotoDashboard.items.length
  ) {
    showAlert('Nejprve spusťte foto OSINT hledání.');
    return;
  }

  const filters = getPhotoDashboardFilters();
  const filteredItems = sortPhotoDashboardItems(
    filterPhotoDashboardItems(lastPhotoDashboard.items, filters),
    filters.sort
  );
  const payload = {
    exportedAt: new Date().toISOString(),
    filters,
    summary: buildPhotoDashboardSummary(lastPhotoDashboard.items),
    analysis: lastPhotoDashboard.analysis || null,
    results: filteredItems
  };

  const filename = `osint-photo-dashboard-export.${type}`;

  if (type === 'csv') {
    const rows = [
      [
        'label',
        'url',
        'domain',
        'score',
        'qualityScore',
        'sourceCount',
        'similarityComponent',
        'manipulated'
      ]
    ];

    filteredItems.forEach((item) => {
      rows.push([
        item.label,
        item.url,
        item.domain,
        String(item.score),
        String(item.qualityScore),
        String(item.sourceCount),
        String(item.similarityComponent),
        String(item.manipulated)
      ]);
    });

    const content = rows
      .map((row) => row.map((value) => `"${String(value || '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    downloadText(content, filename, 'text/csv');
    return;
  }

  downloadText(JSON.stringify(payload, null, 2), filename, 'application/json');
}

function getLatestPhotoAnalysisFromCaseEntries(entries) {
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i] && entries[i].photoAnalysis) {
      return entries[i].photoAnalysis;
    }
  }
  return lastPhotoAnalysis;
}

function getPhotoEndpoint() {
  return normalizeWhitespace(getInputValue('photo-endpoint'));
}

function getPhotoUrlInput() {
  return normalizeWhitespace(getInputValue('photo-url'));
}

function truncateMiddle(text, maxLen) {
  const value = normalizeWhitespace(text);
  if (!value || value.length <= maxLen) return value;

  const safeMax = Math.max(10, Number(maxLen) || 80);
  const head = Math.ceil((safeMax - 3) / 2);
  const tail = Math.floor((safeMax - 3) / 2);
  return `${value.slice(0, head)}...${value.slice(value.length - tail)}`;
}

function normalizePhotoApiResults(payload) {
  const sourceList = Array.isArray(payload)
    ? payload
    : Array.isArray(payload && payload.results)
      ? payload.results
      : [];

  return sourceList
    .map((item, index) => {
      const url = normalizeWhitespace(item && item.url);
      if (!url) return null;

      const source = normalizeWhitespace(item && (item.source || item.engine || item.title));
      const baseLabel = source || `Foto match ${index + 1}`;

      const scoreValue = Number(item && item.score);
      const scorePart =
        Number.isFinite(scoreValue) && scoreValue > 0 ? `score ${Math.round(scoreValue)}%` : '';

      const qualityValue = Number(item && item.qualityScore);
      const qualityPart =
        Number.isFinite(qualityValue) && qualityValue > 0
          ? `quality ${Math.round(qualityValue)}%`
          : '';

      const sourceValue = Number(item && item.sourceCount);
      const sourcePart =
        Number.isFinite(sourceValue) && sourceValue > 0 ? `sources ${Math.round(sourceValue)}` : '';

      const similarityValue = Number(item && item.similarityComponent);
      const similarityPart =
        Number.isFinite(similarityValue) && similarityValue > 0
          ? `similarity ${Math.round(similarityValue)}%`
          : '';

      const repeatValue = Number(item && item.textRepeatScore);
      const repeatPart =
        Number.isFinite(repeatValue) && repeatValue > 0
          ? `text-repeat ${Math.round(repeatValue * 100)}%`
          : '';

      const manipulated = Boolean(item && item.manipulated);
      const reasons = Array.isArray(item && item.manipulationReasons)
        ? item.manipulationReasons.map((reason) => normalizeWhitespace(reason)).filter(Boolean)
        : [];
      const manipulationPart = manipulated
        ? `manipulated: true${reasons.length ? ` (${reasons.join(', ')})` : ''}`
        : '';

      const ocrTextRaw = normalizeWhitespace(item && item.detectedText);
      const ocrText = ocrTextRaw ? truncateMiddle(ocrTextRaw, 80) : '';
      const ocrPart = ocrText ? `OCR: "${ocrText}"` : '';

      const extras = [
        scorePart,
        sourcePart,
        similarityPart,
        qualityPart,
        repeatPart,
        manipulationPart,
        ocrPart
      ]
        .filter(Boolean)
        .join(' | ');
      const label = extras ? `${baseLabel} [${extras}]` : baseLabel;
      return [label, url];
    })
    .filter(Boolean);
}

function normalizePhotoCandidates(payload) {
  const candidates = Array.isArray(payload && payload.candidates) ? payload.candidates : [];

  const seen = new Set();
  return candidates
    .map((item) => normalizeWhitespace(item))
    .filter((item) => {
      if (!item || item.length < 3) return false;
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

function buildPhotoSourceLinks(candidates) {
  const selectedSources = getSelectedSources();
  if (!selectedSources.length || !candidates.length) return [];

  const links = [];
  candidates.forEach((candidate) => {
    const encoded = encodeURIComponent(candidate);
    selectedSources.forEach((source) => {
      links.push([`${source.label} [${candidate}]`, source.buildUrl(encoded)]);
    });
  });

  return links.filter((link) => normalizeWhitespace(link[0]) && normalizeWhitespace(link[1]));
}

function renderPhotoPreview(file) {
  const preview = document.getElementById('photo-preview');
  if (!preview) return;

  if (photoPreviewObjectUrl) {
    URL.revokeObjectURL(photoPreviewObjectUrl);
    photoPreviewObjectUrl = null;
  }

  if (!file) {
    preview.removeAttribute('src');
    preview.style.display = 'none';
    return;
  }

  photoPreviewObjectUrl = URL.createObjectURL(file);
  preview.src = photoPreviewObjectUrl;
  preview.style.display = 'block';
}

function wirePhotoInputPreview() {
  const input = document.getElementById('photo-file');
  if (!input) return;

  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    renderPhotoPreview(file || null);
    updateAnalyzeButtonsState();
  });

  updateAnalyzeButtonsState();
}

function applyDefaultPhotoEndpoint() {
  const endpointInput = document.getElementById('photo-endpoint');
  if (!endpointInput) return;

  if (!normalizeWhitespace(endpointInput.value)) {
    const origin =
      typeof window !== 'undefined' &&
      window.location &&
      /^https?:$/i.test(window.location.protocol)
        ? window.location.origin
        : 'http://localhost:3000';
    endpointInput.value = `${origin}/api/reverse-image`;
  }
}

function searchByPhotoUrl() {
  const imageUrl = getPhotoUrlInput();
  if (!imageUrl) {
    showAlert('Pro reverzni vyhledani vlozte URL obrazku.');
    return;
  }

  let parsed;
  try {
    parsed = new URL(imageUrl);
  } catch {
    showAlert('URL obrazku nema platny format.');
    return;
  }

  if (!/^https?:$/i.test(parsed.protocol)) {
    showAlert('URL obrazku musi zacinat http:// nebo https://');
    return;
  }

  const encoded = encodeURIComponent(parsed.toString());
  const links = [
    ['Google Lens (URL)', `https://lens.google.com/uploadbyurl?url=${encoded}`],
    ['Yandex Images (URL)', `https://yandex.com/images/search?rpt=imageview&url=${encoded}`],
    ['TinEye (URL)', `https://tineye.com/search?url=${encoded}`]
  ];

  const loadingId = startLoading('sources');
  setLoadingStage(loadingId, 'analyze');

  lastPhotoAnalysis = null;
  renderPhotoAnalysis(null);
  lastPhotoDashboard = null;
  renderPhotoDashboard(null);
  clearRefinementState();
  setLoadingStage(loadingId, 'evaluate');
  window.originalResults = links;
  window.currentResults = links;
  lastResults = links;
  lastResultsSearchAt = new Date().toISOString();
  renderResults(lastResults);
  writeAuditEntry('search_photo_url', {
    resultCount: links.length,
    imageUrlHost: parsed.host,
    resultSnapshot: buildSearchResultSnapshot(lastResults)
  });
  stopLoading(loadingId);
  showAlert(`Vygenerovano foto odkazu: ${links.length}`);
}

async function searchByPhotoApi() {
  const endpoint = getPhotoEndpoint();
  if (!endpoint) {
    showAlert('Pro API vyhledani nastavte endpoint backendu.');
    return;
  }

  const input = document.getElementById('photo-file');
  const file = input && input.files && input.files[0];
  if (!file) {
    showAlert('Vyberte fotografii pro API vyhledani.');
    return;
  }

  const formData = new FormData();
  formData.append('image', file);

  if (SAFE_MODE) {
    logSafeMode('Upload disabled for external temporary hosts');
  }

  const hints = [
    normalizeWhitespace(getInputValue('name')),
    normalizeWhitespace(getInputValue('nick')),
    normalizeWhitespace(getInputValue('city'))
  ]
    .filter(Boolean)
    .join(', ');

  if (hints) {
    formData.append('hints', hints);
  }

  const loadingId = startLoading('sources');
  let timeoutId = null;
  try {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(endpoint, {
      method: 'POST',
      body: formData,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    timeoutId = null;

    if (!response.ok) {
      let details = '';
      try {
        const errData = await response.json();
        details = normalizeWhitespace(errData && (errData.error || errData.details));
      } catch {
        details = '';
      }
      showAlert(
        details ? `API vratilo chybu: ${details}` : `API vratilo chybu: ${response.status}`
      );
      return;
    }

    const data = await response.json();
    renderVerdict(data.verdict);
    setLoadingStage(loadingId, 'analyze');
    const photoLinks = normalizePhotoApiResults(data);
    const candidates = normalizePhotoCandidates(data);
    const sourceLinks = buildPhotoSourceLinks(candidates);
    const links = [...photoLinks, ...sourceLinks];
    const warnings = Array.isArray(data && data.warnings) ? data.warnings : [];
    if (SAFE_MODE && warnings.length) {
      warnings.forEach((warning) => {
        logSafeMode(`Backend warning: ${warning}`);
      });
    }
    const photoAnalysis = normalizePhotoAnalysis(data);

    if (!links.length) {
      renderPhotoDashboard(data);
      clearRefinementState();
      window.originalResults = [];
      window.currentResults = [];
      lastResults = [];
      renderResults([]);
      showAlert('API nevratilo zadne pouzitelne vysledky.');
      return;
    }

    if (candidates.length) {
      if (!normalizeWhitespace(getInputValue('name'))) {
        setInputValue('name', candidates[0]);
      }
      saveUiState();
    }

    setLoadingStage(loadingId, 'evaluate');
    lastPhotoAnalysis = photoAnalysis;
    renderPhotoAnalysis(lastPhotoAnalysis);
    renderPhotoDashboard(data);
    clearRefinementState();
    window.originalResults = links;
    window.currentResults = links;
    lastResults = links;
    lastResultsSearchAt = new Date().toISOString();
    renderResults(lastResults);

    writeAuditEntry('search_photo_api', {
      resultCount: links.length,
      photoResultCount: photoLinks.length,
      sourceResultCount: sourceLinks.length,
      candidateCount: candidates.length,
      photoHash: photoAnalysis && photoAnalysis.hashes ? photoAnalysis.hashes.sha256 : '',
      photoHashMd5: photoAnalysis && photoAnalysis.hashes ? photoAnalysis.hashes.md5 : '',
      photoPerceptualHash:
        photoAnalysis && photoAnalysis.hashes ? photoAnalysis.hashes.perceptualHash : '',
      photoAnalysis,
      resultSnapshot: buildSearchResultSnapshot(lastResults)
    });

    if (warnings.length) {
      showAlert(`Foto OSINT hotovo s omezenim: ${warnings[0]}`);
      return;
    }

    if (sourceLinks.length) {
      showAlert(
        `Foto OSINT hotovo: ${photoLinks.length} moznych shod, ${sourceLinks.length} odkazu ve zdrojich k overeni.`
      );
      return;
    }

    showAlert(
      `Byly nalezeny mozne shody: ${photoLinks.length}. Pro sirsi hledani doplnte jmeno/nick.`
    );
  } catch (error) {
    if (error && error.name === 'AbortError') {
      showAlert('API vyhledani vyprselo po 10 sekundach (timeout).');
      return;
    }
    const message = String((error && error.message) || '').toLowerCase();
    if (
      message.includes('failed to fetch') ||
      message.includes('networkerror') ||
      message.includes('err_connection_refused')
    ) {
      showAlert(
        'Backend neni dostupny na endpointu. Spustte server prikazem: node server.js (port 8787).'
      );
      return;
    }

    showAlert('API vyhledani selhalo. Zkontrolujte endpoint/CORS/backend.');
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    stopLoading(loadingId);
  }
}

function getPrioritizedQueryInfo() {
  const mainQuery = normalizeWhitespace(getInputValue('main-query'));
  const name = normalizeWhitespace(getInputValue('name'));
  const nick = normalizeWhitespace(getInputValue('nick'));
  const city = normalizeWhitespace(getInputValue('city'));
  const phone = normalizePhone(getInputValue('phone'));

  if (mainQuery) {
    return { priority: 0, value: mainQuery };
  }

  const nameTokens = name.split(/\s+/).filter(Boolean);
  const fullName = nameTokens.length >= 2 ? nameTokens.join(' ') : '';
  const firstName = nameTokens.length ? nameTokens[0] : '';

  if (fullName) {
    return { priority: 1, value: `"${fullName}"` };
  }

  if (firstName) {
    return { priority: 2, value: firstName };
  }

  if (phone.length >= 7) {
    return { priority: 3, value: phone };
  }

  if (nick) {
    return { priority: 4, value: nick };
  }

  if (city) {
    return { priority: 5, value: city };
  }

  return { priority: 0, value: '' };
}

function getQuery() {
  return getPrioritizedQueryInfo().value;
}

function refineResults() {
  const city = (document.getElementById('city')?.value || '').toLowerCase();

  if (!window.currentResults) return;

  const filtered = window.currentResults.filter((result) => {
    if (!city) return true;

    const title = String((result && (result.title || result.label)) || '');
    const url = String(result && result.url ? result.url : '');
    const text = `${title} ${url}`.toLowerCase();
    return text.includes(city);
  });

  renderResults(filtered);
}

function updateRefinementControls() {
  const undoBtn = document.getElementById('refine-undo-btn');
  const history = Array.isArray(window.refineHistory) ? window.refineHistory : [];

  if (undoBtn) {
    undoBtn.disabled = history.length === 0;
  }

  const historyHost = document.getElementById('refine-history');
  if (!historyHost) return;

  historyHost.textContent = '';
  if (!history.length) {
    historyHost.style.display = 'none';
    return;
  }

  historyHost.style.display = 'flex';
  history.forEach((term, index) => {
    const chip = document.createElement('span');
    chip.className = 'refine-history-chip';
    chip.textContent = `#${index + 1} ${String(term || '')}`;
    historyHost.appendChild(chip);
  });
}

function clearRefinementState(options = {}) {
  window.refineHistory = [];
  const refineInput = document.getElementById('refine-text');
  if (refineInput) {
    refineInput.value = '';
    if (options.focus === true) {
      refineInput.focus();
    }
  }
  updateRefinementControls();
}

function buildSoftRefinedResults(baseResults, refineTerms) {
  const terms = Array.isArray(refineTerms)
    ? refineTerms
        .map((item) =>
          String(item || '')
            .toLowerCase()
            .trim()
        )
        .filter(Boolean)
    : [];

  const uniqueTerms = Array.from(new Set(terms));

  const updated = (Array.isArray(baseResults) ? baseResults : []).map((r) => {
    const resultLabel = Array.isArray(r)
      ? String(r[0] || '')
      : String((r && (r.title || r.label || r.source)) || '');
    const resultUrl = Array.isArray(r) ? String(r[1] || '') : String((r && r.url) || '');
    const text = `${resultLabel} ${resultUrl}`.toLowerCase();

    let bonus = 0;
    uniqueTerms.forEach((term) => {
      if (term && text.includes(term)) {
        bonus += 0.2;
      }
    });

    const baseScoreRaw = Array.isArray(r) ? 0 : Number(r && r.score);
    const baseScore = Number.isFinite(baseScoreRaw) ? baseScoreRaw : 0;
    const refinedScore = baseScore + bonus;

    if (Array.isArray(r)) {
      const next = [r[0], r[1]];
      next.refinedScore = refinedScore;
      return next;
    }

    return {
      ...r,
      refinedScore
    };
  });

  updated.sort((a, b) => {
    const left = Number(a && a.refinedScore) || 0;
    const right = Number(b && b.refinedScore) || 0;
    return right - left;
  });

  return updated;
}

function updateVerdictFromCurrentResults() {
  if (typeof generateVerdict === 'function') {
    try {
      const verdict = generateVerdict(window.currentResults);
      renderVerdict(verdict);
    } catch {
      // renderResults already computes and renders a fallback verdict path.
    }
  }
}

function applyRefinement() {
  const refineInput = document.getElementById('refine-text');
  const refineText = String((refineInput && refineInput.value) || '')
    .toLowerCase()
    .trim();

  if (!Array.isArray(window.originalResults)) return;
  if (!refineText) return;

  const history = Array.isArray(window.refineHistory) ? window.refineHistory : [];
  const previous = history.length ? String(history[history.length - 1]) : '';
  if (previous === refineText) return;

  window.refineHistory = [...history, refineText];

  const updated = buildSoftRefinedResults(window.originalResults, window.refineHistory);

  window.currentResults = updated;
  lastResults = updated;
  renderResults(updated);
  updateResultsSummary(updated);
  updateVerdictFromCurrentResults();
  updateRefinementControls();
}

function undoRefinement() {
  if (!Array.isArray(window.originalResults)) return;

  const history = Array.isArray(window.refineHistory) ? [...window.refineHistory] : [];
  if (!history.length) return;

  history.pop();
  window.refineHistory = history;

  const updated = buildSoftRefinedResults(window.originalResults, history);
  window.currentResults = updated;
  lastResults = updated;
  renderResults(updated);
  updateResultsSummary(updated);
  updateVerdictFromCurrentResults();
  updateRefinementControls();
}

function resetRefinement() {
  if (!Array.isArray(window.originalResults)) return;

  clearRefinementState({ focus: true });

  window.currentResults = window.originalResults;
  lastResults = window.originalResults;

  renderResults(window.originalResults);
  updateResultsSummary(window.originalResults);
  updateVerdictFromCurrentResults();
}

function updateResultsSummary(results, totalCount = Array.isArray(results) ? results.length : 0) {
  const summary = document.getElementById('results-summary');
  if (!summary) return;

  const shownCount = Array.isArray(results) ? results.length : 0;
  summary.textContent =
    totalCount > shownCount
      ? `Zobrazeno ${shownCount} z ${totalCount} výsledků`
      : `Nalezeno ${shownCount} výsledků`;
}

function getRealMatchOnlyEnabled() {
  const checkbox = document.getElementById('real-match-only');
  if (!checkbox) return false;
  return !!checkbox.checked;
}

function getVerificationBackendBaseUrl() {
  const endpoint = getPhotoEndpoint();
  if (endpoint) {
    try {
      const parsed = new URL(endpoint);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      // fallback handled below
    }
  }

  if (
    typeof window !== 'undefined' &&
    window.location &&
    /^https?:$/i.test(window.location.protocol)
  ) {
    return window.location.origin;
  }

  return 'http://localhost:3000';
}

function getQueryTermsForVerification() {
  const raw = getQuery().toLowerCase();
  const seen = new Set();

  return raw
    .split(/\s+/)
    .map((part) => part.replace(/[^\p{L}\p{N}_@.+-]/gu, '').trim())
    .filter((part) => part.length >= 3)
    .filter((part) => {
      if (seen.has(part)) return false;
      seen.add(part);
      return true;
    })
    .slice(0, 10);
}

async function verifyLinksForRealMatches(links) {
  const queryTerms = getQueryTermsForVerification();
  if (!queryTerms.length || !Array.isArray(links) || !links.length) {
    return {
      links: [],
      checkedCount: 0,
      resultCount: 0,
      queryTermCount: queryTerms.length
    };
  }

  const verifyEndpoint = `${getVerificationBackendBaseUrl()}/api/verify-links`;
  const verifyLinks = links.slice(0, 20);
  const timeoutMs = Math.min(120000, Math.max(15000, 12000 + verifyLinks.length * 2500));
  const controller = new AbortController();
  let didTimeout = false;
  const timeoutId = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(verifyEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        queryTerms,
        links: verifyLinks.map((item) => ({ label: item[0], url: item[1] }))
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      let details = '';
      try {
        const errData = await response.json();
        details = normalizeWhitespace(errData && (errData.error || errData.details));
      } catch {
        details = '';
      }
      throw new Error(details || `Verifikace odkazu selhala (HTTP ${response.status}).`);
    }

    const payload = await response.json();
    const verified = Array.isArray(payload && payload.results) ? payload.results : [];

    const normalizedLinks = verified
      .map((item) => {
        const label = normalizeWhitespace(item && item.label);
        const url = normalizeWhitespace(item && item.url);
        if (!label || !url) return null;
        const score = Number(item && item.matchScore);
        const scorePart = Number.isFinite(score) ? ` [overeno ${Math.round(score)}%]` : '';
        return [`${label}${scorePart}`, url];
      })
      .filter(Boolean);

    return {
      links: normalizedLinks,
      checkedCount: verifyLinks.length,
      resultCount: normalizedLinks.length,
      queryTermCount: queryTerms.length
    };
  } catch (error) {
    const message = String((error && error.message) || '').toLowerCase();
    if (didTimeout || (error && error.name === 'AbortError') || message.includes('aborted')) {
      throw new Error(`Overeni realnych shod vyprselo po ${Math.round(timeoutMs / 1000)} s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function getEncodedQuery() {
  const query = getQuery();
  return query ? encodeURIComponent(query) : '';
}

function getSelectedSources() {
  return SOURCE_DEFS.filter((source) => {
    const checkbox = document.getElementById(source.id);
    return checkbox && checkbox.checked;
  });
}

function updateActiveSourceCount() {
  const badge = document.getElementById('active-source-count');
  if (!badge) return;

  const count = getSelectedSources().length;
  badge.textContent = `Aktivni zdroje: ${count}`;
}

function readCustomTemplates() {
  const templates = JSON.parse(localStorage.getItem(STORAGE_KEYS.templates) || '[]');
  return Array.isArray(templates) ? templates : [];
}

function writeCustomTemplates(templates) {
  localStorage.setItem(STORAGE_KEYS.templates, JSON.stringify(templates));
}

function getAllTemplates() {
  const defaults = DEFAULT_TEMPLATES.map((template) => {
    if (template.id === 'tpl_all') {
      return {
        ...template,
        sourceIds: SOURCE_DEFS.map((source) => source.id)
      };
    }

    return template;
  });

  return [...defaults, ...readCustomTemplates()];
}

function renderTemplateSelect() {
  const select = document.getElementById('template-select');
  const deleteBtn = document.getElementById('delete-template-btn');
  if (!select) return;

  const currentValue = select.value;
  const templates = getAllTemplates();

  select.textContent = '';
  templates.forEach((tpl) => {
    const option = document.createElement('option');
    option.value = tpl.id;
    option.textContent = tpl.custom ? `${tpl.name} (vlastni)` : tpl.name;
    select.appendChild(option);
  });

  if (currentValue && templates.some((tpl) => tpl.id === currentValue)) {
    select.value = currentValue;
  }

  if (deleteBtn) {
    const selected = templates.find((tpl) => tpl.id === select.value);
    deleteBtn.disabled = !(selected && selected.custom);
  }
}

function setSourceSelection(sourceIds) {
  const selected = new Set(sourceIds);
  SOURCE_DEFS.forEach((source) => {
    const checkbox = document.getElementById(source.id);
    if (checkbox) {
      checkbox.checked = selected.has(source.id);
    }
  });

  saveUiState();
  updateActiveSourceCount();
}

function resetAllSources() {
  setSourceSelection(SOURCE_DEFS.map((source) => source.id));
  showAlert('Zdrojova sada obnovena: vsechny zdroje jsou aktivni.');
}

function applySelectedTemplate() {
  const select = document.getElementById('template-select');
  if (!select) return;

  const template = getAllTemplates().find((tpl) => tpl.id === select.value);
  if (!template) {
    showAlert('Sablona nebyla nalezena.');
    return;
  }

  setSourceSelection(template.sourceIds);
  showAlert(`Aplikovana sablona: ${template.name}`);
}

function saveCurrentTemplate() {
  const input = document.getElementById('template-name');
  if (!input) return;

  const name = normalizeWhitespace(input.value);
  if (!name) {
    showAlert('Zadejte nazev sablony.');
    return;
  }

  const selectedIds = getSelectedSources().map((source) => source.id);
  if (!selectedIds.length) {
    showAlert('Vyberte alespon jeden zdroj.');
    return;
  }

  const customTemplates = readCustomTemplates();
  const id = `custom_${Date.now()}`;

  customTemplates.push({ id, name, sourceIds: selectedIds, custom: true });
  writeCustomTemplates(customTemplates);
  renderTemplateSelect();

  const select = document.getElementById('template-select');
  if (select) {
    select.value = id;
  }

  input.value = '';
  showAlert('Sablona byla ulozena.');
}

function deleteSelectedTemplate() {
  const select = document.getElementById('template-select');
  if (!select) return;

  const selectedId = select.value;
  const customTemplates = readCustomTemplates();
  const target = customTemplates.find((tpl) => tpl.id === selectedId);
  if (!target) {
    showAlert('Lze mazat pouze vlastni sablony.');
    return;
  }

  writeCustomTemplates(customTemplates.filter((tpl) => tpl.id !== selectedId));
  renderTemplateSelect();
  showAlert('Sablona byla smazana.');
}

function applyTheme(theme) {
  const body = document.body;
  if (!body) return;

  const value = theme === 'dark' ? 'dark' : 'light';
  body.setAttribute('data-theme', value);

  const toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.textContent = value === 'dark' ? 'Svetly rezim' : 'Tmavy rezim';
  }

  localStorage.setItem(STORAGE_KEYS.theme, value);
}

function loadTheme() {
  const saved = localStorage.getItem(STORAGE_KEYS.theme) || 'light';
  applyTheme(saved);
}

function setSafeModeAlertVisibility(enabled) {
  const safeModeAlert = document.getElementById('safe-mode-alert');
  if (!safeModeAlert) return;

  safeModeAlert.style.display = enabled ? 'block' : 'none';
  safeModeAlert.setAttribute('aria-hidden', enabled ? 'false' : 'true');
}

function renderSafeModeControls(enabled, statusText = '') {
  const wrap = document.getElementById('safe-mode-controls');
  const checkbox = document.getElementById('safe-mode-toggle');
  const status = document.getElementById('safe-mode-toggle-status');
  if (!wrap || !checkbox || !status) return;

  wrap.style.display = 'block';
  checkbox.checked = !!enabled;
  status.textContent = statusText || (enabled ? 'Aktivni' : 'Vypnuto');
}

async function setSafeModeFlag(enabled) {
  const response = await fetch('/api/safe-mode', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ enabled: !!enabled })
  });

  if (!response.ok) {
    let details = '';
    try {
      const payload = await response.json();
      details = normalizeWhitespace(payload && (payload.error || payload.details));
    } catch {
      details = '';
    }
    throw new Error(details || `SAFE MODE endpoint returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  return Boolean(payload && payload.safeMode);
}

async function detectSafeModeFlag() {
  if (typeof window !== 'undefined' && window && typeof window.OSINT_SAFE_MODE === 'boolean') {
    return window.OSINT_SAFE_MODE;
  }

  try {
    const response = await fetch('/health', {
      method: 'GET',
      headers: {
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      return false;
    }

    const payload = await response.json();
    return Boolean(payload && payload.safeMode);
  } catch {
    return false;
  }
}

async function initSafeModeAlert() {
  SAFE_MODE = await detectSafeModeFlag();
  renderSafeModeControls(SAFE_MODE);

  if (SAFE_MODE) {
    logSafeMode('UI restrictions enabled');
    const safeModeAlert = document.getElementById('safe-mode-alert');
    if (safeModeAlert) {
      safeModeAlert.style.display = 'block';
      safeModeAlert.setAttribute('aria-hidden', 'false');
    }
    return;
  }

  setSafeModeAlertVisibility(false);
}

function toggleTheme() {
  const current = document.body.getAttribute('data-theme') || 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

function wireThemeToggle() {
  const toggle = document.getElementById('theme-toggle');
  if (!toggle) return;

  toggle.addEventListener('click', toggleTheme);
}

async function exportPdfReport() {
  const query = getQuery();
  const links = lastResults.length ? lastResults : getActiveLinks();
  const caseId = getCaseId();
  const caseRecord = getCaseRecord(caseId) || {};
  const caseEntries = getCurrentCaseEntries(caseId);
  const caseEntities = getCaseEntities(caseId);
  const caseRelationships = getCaseRelationships(caseId);
  const entityStats = getEntityStats(caseId);
  const graphImage = getEntityGraphImageDataUrl();
  const reportPhotoAnalysis = getLatestPhotoAnalysisFromCaseEntries(caseEntries);

  if (!query) {
    showAlert('Pro report vyplnte alespon jeden udaj.');
    return;
  }

  if (!links.length) {
    showAlert('Pro report vyberte alespon jeden zdroj.');
    return;
  }

  const timestamp = new Date().toLocaleString('cs-CZ');
  const filenameStamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  if (window.jspdf && window.jspdf.jsPDF) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });

    let y = 42;
    doc.setFontSize(18);
    doc.text('OSINT Finder report', 40, y);
    y += 20;

    doc.setFontSize(12);
    doc.text('TITULNÍ STRANA', 40, y);
    y += 16;

    doc.setFontSize(10);
    doc.text(`Vygenerovano: ${timestamp}`, 40, y);
    y += 20;

    const caseTitleLine = `Případ ID: ${caseId || 'nenastaven'}${caseRecord.title ? ` | ${caseRecord.title}` : ''}`;
    const caseTitleWrapped = doc.splitTextToSize(caseTitleLine, 510);
    doc.text(caseTitleWrapped, 40, y);
    y += caseTitleWrapped.length * 12 + 4;

    doc.setFontSize(12);
    const queryLines = doc.splitTextToSize(`Dotaz: ${query}`, 510);
    doc.text(queryLines, 40, y);
    y += queryLines.length * 14 + 8;

    doc.addPage();
    y = 42;

    if (METHODOLOGY_LOG && METHODOLOGY_LOG.length > 0) {
      y += 10;
      doc.setFontSize(12);
      doc.text('METODIKA SBĚRU DAT', 40, y);
      y += 14;

      doc.setFontSize(10);
      METHODOLOGY_LOG.forEach((entry) => {
        const line = `${entry.timestamp.slice(0, 19).replace('T', ' ')} | ${entry.source} | Dotaz: "${entry.query}" | Nalezeno: ${entry.resultCount}`;
        const wrapped = doc.splitTextToSize(line, 510);

        if (y + wrapped.length * 12 > 790) {
          doc.addPage();
          y = 42;
        }

        doc.text(wrapped, 40, y);
        y += wrapped.length * 12 + 2;
      });
    }

    doc.setFontSize(10);
    const noteLines = doc.splitTextToSize(
      'Poznamka: odkazy jsou vyhledavaci dotazy nebo zdrojove stranky, ne potvrzene udalosti.',
      510
    );
    doc.text(noteLines, 40, y);
    y += noteLines.length * 12 + 6;

    doc.addPage();
    y = 42;

    y += 10;
    doc.setFontSize(12);
    doc.text('RELEVANCE ZDROJŮ', 40, y);
    y += 14;

    doc.setFontSize(10);
    links.forEach((link) => {
      const sourceLabel = Array.isArray(link)
        ? String(link[0] || '')
        : String((link && (link.label || link.source || link.title)) || '');
      const confidence = calculateConfidenceScore(sourceLabel || '', link);
      const label = getConfidenceLabel(confidence);
      const line = `${sourceLabel} | ${label} (${confidence}%)`;
      const wrapped = doc.splitTextToSize(line, 510);

      if (y + wrapped.length * 12 > 790) {
        doc.addPage();
        y = 42;
      }

      doc.text(wrapped, 40, y);
      y += wrapped.length * 12 + 2;
    });

    doc.addPage();
    y = 42;

    const dedupeGroups = deduplicateByFuzzyMatch(getPreparedResults(links));
    const mergedGroups = dedupeGroups.filter((group) => group.items.length > 1);

    if (mergedGroups.length > 0) {
      y += 10;
      doc.setFontSize(12);
      doc.text('DEDUPLIKOVANÉ ENTITY', 40, y);
      y += 14;

      doc.setFontSize(10);
      mergedGroups.forEach((group) => {
        const confidence = Math.min(100, 50 + group.items.length * 12);
        const headerLine = `✅ ${group.mainLabel} (${confidence}%)`;
        const headerWrapped = doc.splitTextToSize(headerLine, 510);

        if (y + headerWrapped.length * 12 > 790) {
          doc.addPage();
          y = 42;
        }

        doc.text(headerWrapped, 40, y);
        y += headerWrapped.length * 12 + 2;

        doc.setFontSize(9);
        group.items.forEach((item) => {
          doc.addPage();
          y = 42;
          const subLine = `- ${item.label || item[0] || 'Unknown'}`;
          const wrapped = doc.splitTextToSize(subLine, 500);

          if (y + wrapped.length * 10 > 790) {
            doc.addPage();
            y = 42;
            doc.setFontSize(9);
          }

          doc.text(wrapped, 50, y);
          y += wrapped.length * 10 + 2;
        });

        y += 8;
        doc.setFontSize(10);
      });
    }

    doc.setFontSize(11);
    doc.text(`Pocet odkazu: ${links.length}`, 40, y);
    y += 16;

    const caseLine = `Pripad: ${caseId || 'nenastaven'}${caseRecord.title ? ` (${caseRecord.title})` : ''}`;
    const caseWrapped = doc.splitTextToSize(caseLine, 510);
    doc.text(caseWrapped, 40, y);
    y += caseWrapped.length * 13 + 4;

    const operatorLine = `Operator: ${caseRecord.operator || getCaseOperator() || '-'} | Duvod: ${caseRecord.reason || getCaseReason() || '-'}`;
    const operatorWrapped = doc.splitTextToSize(operatorLine, 510);
    doc.text(operatorWrapped, 40, y);
    y += operatorWrapped.length * 13 + 8;

    const note = 'Výsledek slouží pouze jako vodítko pro další šetření.';
    const noteWrapped = doc.splitTextToSize(note, 510);
    doc.text(noteWrapped, 40, y);
    y += noteWrapped.length * 13 + 8;

    const entityLines = ENTITY_TYPES.map(
      (type) => `${type.label}: ${entityStats[type.value] || 0}`
    ).concat([`Vazby: ${caseRelationships.length}`]);

    entityLines.forEach((line) => {
      const wrapped = doc.splitTextToSize(line, 510);
      doc.text(wrapped, 40, y);
      y += wrapped.length * 13 + 2;
    });

    caseEntities.slice(0, 12).forEach((entity) => {
      const line = `Entita: ${entity.name} [${ENTITY_TYPE_LABEL[entity.type] || entity.type}]`;
      const wrapped = doc.splitTextToSize(line, 510);
      doc.text(wrapped, 40, y);
      y += wrapped.length * 13 + 2;
    });

    caseRelationships.slice(0, 12).forEach((rel) => {
      const source = caseEntities.find((item) => item.id === rel.sourceEntityId);
      const target = caseEntities.find((item) => item.id === rel.targetEntityId);
      const line = `Vazba: ${(source && source.name) || rel.sourceEntityId} -> ${rel.relationshipType} -> ${(target && target.name) || rel.targetEntityId} (${rel.confidence}%)`;
      const wrapped = doc.splitTextToSize(line, 510);
      doc.text(wrapped, 40, y);
      y += wrapped.length * 13 + 2;
    });

    doc.addPage();
    y = 42;

    y += 16;
    if (y > 760) {
      doc.addPage();
      y = 42;
    }

    doc.setFontSize(12);
    doc.text('ZJIŠTĚNÁ RIZIKA A DOPORUČENÍ', 40, y);
    y += 14;

    doc.setFontSize(10);
    const riskLines = [
      '⚠️ Osobní údaje: Email, telefon mohou být veřejné',
      '⚠️ Sociální sítě: Profily jsou viditelné',
      '✅ Kriminální záznamy: Nebyly nalezeny',
      '✅ OFAC/EU sankce: Osoba není na seznamu'
    ];

    riskLines.forEach((line) => {
      const wrapped = doc.splitTextToSize(line, 510);
      if (y + wrapped.length * 12 > 790) {
        doc.addPage();
        y = 42;
      }
      doc.text(wrapped, 40, y);
      y += wrapped.length * 12 + 2;
    });

    y += 20;
    if (y > 760) {
      doc.addPage();
      y = 42;
    }

    doc.setFontSize(12);
    doc.text('ZÁVĚR A DOPORUČENÍ', 40, y);
    y += 14;

    doc.setFontSize(10);
    const summary = `Osoba "${query}" byla identifikována přes ${dedupeGroups.length} unikátních entit.
Data naznačují aktivitu v internetovém prostředí. Důvěra v identifikaci: ${Math.round(
      dedupeGroups.reduce((a, g) => a + calculateConfidenceScore(g.mainLabel, g.items[0]), 0) /
        Math.max(1, dedupeGroups.length)
    )}%.

DOPORUČENÍ:
- Monitorovat sociální sítě na aktivitu
- Minimalizovat sdílené osobní údaje
- Pravidelně auditovat viditelné informace`;

    const summaryWrapped = doc.splitTextToSize(summary, 510);
    if (y + summaryWrapped.length * 12 > 790) {
      doc.addPage();
      y = 42;
    }
    doc.text(summaryWrapped, 40, y);
    y += summaryWrapped.length * 12 + 8;

    doc.addPage();
    y = 42;

    y += 12;
    if (y > 760) {
      doc.addPage();
      y = 42;
    }

    doc.setFontSize(12);
    doc.text('PŘÍLOHY', 40, y);
    y += 14;

    if (reportPhotoAnalysis && reportPhotoAnalysis.hashes) {
      const hashLines = [
        reportPhotoAnalysis.hashes.sha256 ? `SHA256: ${reportPhotoAnalysis.hashes.sha256}` : '',
        reportPhotoAnalysis.hashes.md5 ? `MD5: ${reportPhotoAnalysis.hashes.md5}` : '',
        reportPhotoAnalysis.hashes.perceptualHash
          ? `Perceptual hash: ${reportPhotoAnalysis.hashes.perceptualHash}`
          : ''
      ].filter(Boolean);

      hashLines.forEach((line) => {
        const wrapped = doc.splitTextToSize(line, 510);
        doc.text(wrapped, 40, y);
        y += wrapped.length * 13 + 2;
      });

      const exif = reportPhotoAnalysis.exif;
      const exifLines =
        exif && typeof exif === 'object'
          ? [
              exif.make ? `EXIF vyrobce: ${exif.make}` : '',
              exif.model ? `EXIF model: ${exif.model}` : '',
              exif.software ? `EXIF software: ${exif.software}` : '',
              exif.dateTimeOriginal ? `EXIF datum: ${exif.dateTimeOriginal}` : '',
              exif.gps && typeof exif.gps.lat === 'number' && typeof exif.gps.lon === 'number'
                ? `EXIF GPS: ${exif.gps.lat}, ${exif.gps.lon}`
                : ''
            ].filter(Boolean)
          : [];

      exifLines.forEach((line) => {
        const wrapped = doc.splitTextToSize(line, 510);
        doc.text(wrapped, 40, y);
        y += wrapped.length * 13 + 2;
      });
    }

    links.forEach((link, index) => {
      const line = `${index + 1}. ${link[0]} [${getReportLinkNature({ label: link[0], url: link[1] })}]: ${link[1]}`;
      const wrapped = doc.splitTextToSize(line, 510);

      if (y + wrapped.length * 13 > 790) {
        doc.addPage();
        y = 42;
      }

      doc.text(wrapped, 40, y);
      y += wrapped.length * 13 + 4;
    });

    if (graphImage) {
      try {
        if (y > 570) {
          doc.addPage();
          y = 42;
        }
        doc.setFontSize(11);
        doc.text('Graf vztahu entit:', 40, y);
        y += 10;
        doc.addImage(graphImage, 'PNG', 40, y, 500, 220);
      } catch {
        // ignore graph image rendering errors
      }
    }

    const pdfBlob = doc.output('blob');
    const filename = `osint-report-${filenameStamp}.pdf`;
    const saved = await saveBlobToPreferredFolder(filename, pdfBlob);
    if (!saved) {
      triggerBrowserDownload(pdfBlob, filename);
    }

    showAlert('PDF report byl exportovan.');
    return;
  }

  const now = new Date();
  const fallbackTime = now.toLocaleString('cs-CZ');
  const caseLineHtml = `${escapeHtml(caseId || 'nenastaven')}${caseRecord.title ? ` (${escapeHtml(caseRecord.title)})` : ''}`;
  const operatorHtml = `${escapeHtml(caseRecord.operator || getCaseOperator() || '-')}`;
  const reasonHtml = `${escapeHtml(caseRecord.reason || getCaseReason() || '-')}`;
  const statsHtml = ENTITY_TYPES.map(
    (type) => `<li><strong>${escapeHtml(type.label)}:</strong> ${entityStats[type.value] || 0}</li>`
  ).join('');
  const relationshipStatsHtml = `<li><strong>Vazby:</strong> ${caseRelationships.length}</li>`;
  const entitiesHtml = caseEntities
    .slice(0, 20)
    .map(
      (entity) =>
        `<li><strong>${escapeHtml(entity.name)}</strong> [${escapeHtml(ENTITY_TYPE_LABEL[entity.type] || entity.type)}]</li>`
    )
    .join('');
  const relationshipsHtml = caseRelationships
    .slice(0, 20)
    .map((rel) => {
      const source = caseEntities.find((item) => item.id === rel.sourceEntityId);
      const target = caseEntities.find((item) => item.id === rel.targetEntityId);
      return `<li>${escapeHtml((source && source.name) || rel.sourceEntityId)} -> ${escapeHtml(rel.relationshipType)} -> ${escapeHtml((target && target.name) || rel.targetEntityId)} (${rel.confidence}%)</li>`;
    })
    .join('');
  const hashesHtml =
    reportPhotoAnalysis && reportPhotoAnalysis.hashes
      ? [
          reportPhotoAnalysis.hashes.sha256
            ? `<li><strong>SHA256:</strong> ${escapeHtml(reportPhotoAnalysis.hashes.sha256)}</li>`
            : '',
          reportPhotoAnalysis.hashes.md5
            ? `<li><strong>MD5:</strong> ${escapeHtml(reportPhotoAnalysis.hashes.md5)}</li>`
            : '',
          reportPhotoAnalysis.hashes.perceptualHash
            ? `<li><strong>Perceptual hash:</strong> ${escapeHtml(reportPhotoAnalysis.hashes.perceptualHash)}</li>`
            : ''
        ]
          .filter(Boolean)
          .join('')
      : '';
  const exifHtml =
    reportPhotoAnalysis && reportPhotoAnalysis.exif && typeof reportPhotoAnalysis.exif === 'object'
      ? [
          reportPhotoAnalysis.exif.make
            ? `<li><strong>EXIF vyrobce:</strong> ${escapeHtml(reportPhotoAnalysis.exif.make)}</li>`
            : '',
          reportPhotoAnalysis.exif.model
            ? `<li><strong>EXIF model:</strong> ${escapeHtml(reportPhotoAnalysis.exif.model)}</li>`
            : '',
          reportPhotoAnalysis.exif.software
            ? `<li><strong>EXIF software:</strong> ${escapeHtml(reportPhotoAnalysis.exif.software)}</li>`
            : '',
          reportPhotoAnalysis.exif.dateTimeOriginal
            ? `<li><strong>EXIF datum:</strong> ${escapeHtml(String(reportPhotoAnalysis.exif.dateTimeOriginal))}</li>`
            : '',
          reportPhotoAnalysis.exif.gps &&
          typeof reportPhotoAnalysis.exif.gps.lat === 'number' &&
          typeof reportPhotoAnalysis.exif.gps.lon === 'number'
            ? `<li><strong>EXIF GPS:</strong> ${reportPhotoAnalysis.exif.gps.lat}, ${reportPhotoAnalysis.exif.gps.lon}</li>`
            : ''
        ]
          .filter(Boolean)
          .join('')
      : '';
  const geoHtml =
    reportPhotoAnalysis && Array.isArray(reportPhotoAnalysis.geoLinks)
      ? reportPhotoAnalysis.geoLinks
          .map(
            (item) =>
              `<li><strong>${escapeHtml(item.source)}:</strong> <a href="${escapeHtml(item.url)}">${escapeHtml(item.url)}</a></li>`
          )
          .join('')
      : '';
  const listHtml = links
    .map((link, index) => {
      const label = escapeHtml(link[0]);
      const href = escapeHtml(link[1]);
      const nature = escapeHtml(getReportLinkNature({ label: link[0], url: link[1] }));
      return `<li><span>${index + 1}. <strong>${label}</strong> [${nature}]</span><a href="${href}">${href}</a></li>`;
    })
    .join('');

  const html = `<!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8" />
  <title>OSINT report</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 28px; color: #17293d; }
    h1 { margin: 0 0 6px; }
    .meta { margin: 0 0 18px; color: #506781; }
    .box { border: 1px solid #c9d7e5; border-radius: 10px; padding: 12px; margin-bottom: 14px; }
    ol { padding-left: 20px; }
    li { margin-bottom: 10px; }
    a { color: #1e5f99; word-break: break-all; text-decoration: none; }
    @media print {
      body { margin: 14mm; }
      a { color: #000; text-decoration: none; }
    }
  </style>
</head>
<body>
  <h1>OSINT Finder report</h1>
  <p class="meta">Vygenerovano: ${escapeHtml(fallbackTime)}</p>
  <div class="box"><strong>Dotaz:</strong> ${escapeHtml(query)}</div>
  <div class="box"><strong>Pripad:</strong> ${caseLineHtml}<br/><strong>Operator:</strong> ${operatorHtml}<br/><strong>Duvod:</strong> ${reasonHtml}</div>
  <div class="box"><strong>Titulní strana</strong><br/><strong>Datum:</strong> ${escapeHtml(fallbackTime)}<br/><strong>Případ ID:</strong> ${caseLineHtml}<br/><strong>Dotaz:</strong> ${escapeHtml(query)}</div>
  <div class="box"><strong>Statistika entit a vazeb</strong><ul>${statsHtml}${relationshipStatsHtml}</ul></div>
  ${entitiesHtml ? `<div class="box"><strong>Seznam entit (vyber)</strong><ul>${entitiesHtml}</ul></div>` : ''}
  ${relationshipsHtml ? `<div class="box"><strong>Seznam vazeb (vyber)</strong><ul>${relationshipsHtml}</ul></div>` : ''}
  <div class="box"><strong>ZJIŠTĚNÁ RIZIKA A DOPORUČENÍ</strong><ul><li>⚠️ Osobní údaje: Email, telefon mohou být veřejné</li><li>⚠️ Sociální sítě: Profily jsou viditelné</li><li>✅ Kriminální záznamy: Nebyly nalezeny</li><li>✅ OFAC/EU sankce: Osoba není na seznamu</li></ul></div>
  <div class="box"><strong>ZÁVĚR A DOPORUČENÍ</strong><p>Osoba "${escapeHtml(query)}" byla identifikována přes ${dedupeGroups.length} unikátních entit. Data naznačují aktivitu v internetovém prostředí. Důvěra v identifikaci: ${Math.round(dedupeGroups.reduce((a, g) => a + calculateConfidenceScore(g.mainLabel, g.items[0]), 0) / Math.max(1, dedupeGroups.length))}%.</p><p><strong>DOPORUČENÍ:</strong></p><ul><li>Monitorovat sociální sítě na aktivitu</li><li>Minimalizovat sdílené osobní údaje</li><li>Pravidelně auditovat viditelné informace</li></ul></div>
  <div class="box"><strong>PŘÍLOHY</strong></div>
  <div class="box"><strong>Poznámka:</strong> Odkazy jsou vyhledávací dotazy nebo zdrojové stránky, ne potvrzené události.</div>
  <div class="box"><strong>Upozornění:</strong> Výsledek slouží pouze jako vodítko pro další šetření.</div>
  ${hashesHtml || exifHtml || geoHtml ? `<div class="box"><strong>Foto analyza</strong><ul>${hashesHtml}${exifHtml}${geoHtml}</ul></div>` : ''}
  ${graphImage ? `<div class="box"><strong>Graf vztahu entit</strong><div><img src="${graphImage}" alt="Graf vztahu entit" style="max-width:100%;height:auto;border:1px solid #c9d7e5;border-radius:8px;" /></div></div>` : ''}
  <div class="box">
    <strong>Pocet odkazu:</strong> ${links.length}
    <ol>${listHtml}</ol>
  </div>
</body>
</html>`;

  const reportWindow = window.open('', '_blank', 'noopener,noreferrer');
  if (!reportWindow) {
    showAlert('Prohlizec zablokoval popup pro tisk reportu.');
    return;
  }

  reportWindow.document.open();
  reportWindow.document.write(html);
  reportWindow.document.close();
  reportWindow.focus();
  setTimeout(() => {
    reportWindow.print();
  }, 250);
}

function getActiveLinks() {
  const encodedQuery = getEncodedQuery();
  if (!encodedQuery) return [];

  const canUseOfficialSources = hasOfficialQuerySignal();

  return getSelectedSources()
    .map((source) => buildSourceLink(source, encodedQuery, canUseOfficialSources))
    .filter((link) => link && normalizeWhitespace(link[0]) && normalizeWhitespace(link[1]));
}

function hasOfficialQuerySignal() {
  const name = normalizeWhitespace(getInputValue('name'));
  const nick = normalizeWhitespace(getInputValue('nick'));
  const phone = normalizePhone(getInputValue('phone'));

  const nameTokens = name.split(/\s+/).filter(Boolean).length;
  if (nameTokens >= 2) return true;
  if (nick.length >= 4) return true;
  if (phone.length >= 7) return true;
  return false;
}

function isOfficialSource(source) {
  return !!(source && OFFICIAL_SOURCE_IDS.has(source.id));
}

function buildSourceLink(source, encodedQuery, canUseOfficialSources) {
  if (!source) return null;

  if (isOfficialSource(source)) {
    if (!canUseOfficialSources) {
      return null;
    }

    const directUrl = OFFICIAL_SOURCE_DIRECT_URLS[source.id];
    if (directUrl) {
      return [source.label, directUrl];
    }
  }

  return [source.label, source.buildUrl(encodedQuery)];
}

function getSkippedOfficialSourceLabels() {
  if (hasOfficialQuerySignal()) return [];

  return getSelectedSources()
    .filter((source) => isOfficialSource(source))
    .map((source) => source.label);
}

function getSourceByLabel(label) {
  return SOURCE_DEFS.find((source) => source.label === label) || null;
}

function getResultsSortMode() {
  const select = document.getElementById('results-sort');
  return select && select.value === 'source' ? 'source' : 'validity';
}

function isRawModeEnabled() {
  const checkbox = document.getElementById('results-raw-mode');
  return !!(checkbox && checkbox.checked);
}

function getResultsFilters() {
  const minConfidenceEl = document.getElementById('results-min-confidence');
  const onlyManipulatedEl = document.getElementById('results-only-manipulated');
  const onlyTrustedEl = document.getElementById('results-only-trusted');

  return {
    minConfidence: clamp(Number(minConfidenceEl && minConfidenceEl.value) || 0, 0, 100),
    onlyManipulated: !!(onlyManipulatedEl && onlyManipulatedEl.checked),
    onlyTrustedDomains: !!(onlyTrustedEl && onlyTrustedEl.checked)
  };
}

function updateResultsFilterUi() {
  const minConfidenceEl = document.getElementById('results-min-confidence');
  const minConfidenceValueEl = document.getElementById('results-min-confidence-value');
  if (!minConfidenceEl || !minConfidenceValueEl) return;

  const value = clamp(Number(minConfidenceEl.value) || 0, 0, 100);
  minConfidenceValueEl.textContent = `${Math.round(value)}%`;
}

function isTrustedDomain(domain) {
  const value = String(domain || '')
    .toLowerCase()
    .trim();
  if (!value) return false;

  const trustedSuffixes = ['.gov', '.edu', '.mil', '.int', '.europa.eu'];

  const trustedExact = new Set([
    'linkedin.com',
    'github.com',
    'gitlab.com',
    'stackoverflow.com',
    'wikipedia.org',
    'interpol.int',
    'europol.europa.eu',
    'fbi.gov',
    'dea.gov',
    'usmarshals.gov',
    'nationalcrimeagency.gov.uk',
    'sanctionsmap.eu',
    'un.org'
  ]);

  if (trustedExact.has(value)) return true;
  if (Array.from(trustedExact).some((host) => value.endsWith(`.${host}`))) return true;
  return trustedSuffixes.some((suffix) => value.endsWith(suffix));
}

function hasTrustedDomain(domains) {
  return (Array.isArray(domains) ? domains : []).some((domain) => isTrustedDomain(domain));
}

function computeFakeScore(detail) {
  const manipulatedPart = detail && detail.manipulated ? 0.5 : 0;
  const lowTrustPart = detail && !detail.hasTrustedDomain ? 0.3 : 0;
  const fewSourcesPart = detail && detail.sourceCount <= 1 ? 0.2 : 0;

  const value = Number((manipulatedPart + lowTrustPart + fewSourcesPart).toFixed(2));
  let level = 'LOW';
  if (value >= 0.7) {
    level = 'HIGH';
  } else if (value >= 0.4) {
    level = 'MEDIUM';
  }

  return {
    value,
    level,
    components: {
      manipulated: manipulatedPart,
      lowTrust: lowTrustPart,
      fewSources: fewSourcesPart
    }
  };
}

function computeSeenRange(candidates) {
  const ordered = (Array.isArray(candidates) ? candidates : [])
    .map((value) => normalizeWhitespace(value))
    .filter(Boolean)
    .map((value) => ({
      raw: value,
      ts: Date.parse(value)
    }))
    .filter((item) => Number.isFinite(item.ts))
    .sort((a, b) => a.ts - b.ts);

  if (!ordered.length) {
    return { firstSeen: '', lastSeen: '' };
  }

  return {
    firstSeen: ordered[0].raw,
    lastSeen: ordered[ordered.length - 1].raw
  };
}

function findSeenRangeFromHistory(url) {
  const key = normalizeResultUrl(url);
  if (!key) return { firstSeen: '', lastSeen: '' };

  const hits = getSearchHistoryEntries()
    .filter((entry) => {
      const snapshot = Array.isArray(entry && entry.resultSnapshot) ? entry.resultSnapshot : [];
      return snapshot.some((item) => normalizeResultUrl(item && item.url) === key);
    })
    .map((entry) => String((entry && entry.at) || ''))
    .filter(Boolean);

  return computeSeenRange(hits);
}

function formatSeenTimestamp(value) {
  if (!value) return 'n/a';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('cs-CZ');
}

function deriveReportEndpoint() {
  const reverseEndpoint = getPhotoEndpoint();
  const normalized = normalizeWhitespace(reverseEndpoint);
  if (!normalized) return '';

  if (normalized.includes('/api/reverse-image')) {
    return normalized.replace('/api/reverse-image', '/api/report-generate');
  }

  try {
    const parsed = new URL(normalized);
    parsed.pathname = '/api/report-generate';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

async function fetchGeneratedReportJson() {
  const endpoint = deriveReportEndpoint();
  if (!lastPhotoDashboard) {
    const error = new Error('No photo dashboard data');
    error.code = 'NO_DASHBOARD';
    throw error;
  }

  if (!endpoint) {
    const error = new Error('Invalid photo endpoint');
    error.code = 'INVALID_ENDPOINT';
    throw error;
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        results: Array.isArray(lastPhotoDashboard.results) ? lastPhotoDashboard.results : [],
        analysis: lastPhotoDashboard.analysis || {},
        warnings: Array.isArray(lastPhotoDashboard.warnings) ? lastPhotoDashboard.warnings : [],
        candidates: Array.isArray(lastPhotoDashboard.candidates)
          ? lastPhotoDashboard.candidates
          : [],
        hashes: lastPhotoDashboard.hashes || null,
        exif: lastPhotoDashboard.exif || null
      })
    });
  } catch {
    const error = new Error('Report endpoint unreachable');
    error.code = 'UNREACHABLE';
    error.endpoint = endpoint;
    throw error;
  }

  if (!response.ok) {
    let details = '';
    try {
      const payload = await response.json();
      details = normalizeWhitespace(payload && (payload.error || payload.details));
    } catch {
      details = '';
    }

    const error = new Error(details || `Report endpoint returned ${response.status}`);
    error.code = `HTTP_${response.status}`;
    error.endpoint = endpoint;
    throw error;
  }

  const payload = await response.json();
  if (!payload || typeof payload !== 'object') {
    const error = new Error('Report payload invalid');
    error.code = 'INVALID_PAYLOAD';
    error.endpoint = endpoint;
    throw error;
  }

  return payload;
}

function getReportJsonExportHint(errorLike) {
  const code = String((errorLike && errorLike.code) || '').toUpperCase();
  const endpoint = normalizeWhitespace((errorLike && errorLike.endpoint) || deriveReportEndpoint());

  if (code === 'NO_DASHBOARD') {
    return 'JSON report vyzaduje foto analyzu. Spuste nejdriv Foto OSINT hledani a pak export opakujte.';
  }

  if (code === 'INVALID_ENDPOINT') {
    return 'JSON report nelze vytvorit: zkontrolujte pole Backend endpoint (ma smerovat na /api/reverse-image).';
  }

  if (code === 'UNREACHABLE') {
    return `JSON report nelze vytvorit: backend neni dostupny (${endpoint || 'neznamy endpoint'}). Spuste server.`;
  }

  if (code.startsWith('HTTP_')) {
    return `JSON report selhal na backendu (${code.replace('HTTP_', 'HTTP ')}). Zkontrolujte log serveru.`;
  }

  if (code === 'INVALID_PAYLOAD') {
    return 'JSON report nelze vytvorit: backend vratil neplatna data.';
  }

  const fallbackMessage = normalizeWhitespace(errorLike && errorLike.message);
  if (fallbackMessage) {
    return `JSON report nelze vytvorit: ${fallbackMessage}`;
  }

  return 'JSON report nelze vytvorit. Spuste foto analyzu a overte backend endpoint.';
}

async function exportReportJson() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const reportFromPayload =
    lastPhotoDashboard && lastPhotoDashboard.report && typeof lastPhotoDashboard.report === 'object'
      ? {
          schemaVersion: '1.0',
          type: 'forensic-report',
          exportedAt: new Date().toISOString(),
          report: lastPhotoDashboard.report
        }
      : null;

  let report = reportFromPayload;
  if (!report) {
    let exportError = null;
    try {
      report = await fetchGeneratedReportJson();
    } catch (error) {
      exportError = error;
      report = null;
    }

    if (!report) {
      showAlert(getReportJsonExportHint(exportError));
      return;
    }
  }

  await downloadText(
    JSON.stringify(report, null, 2),
    `osint-forensic-report-${stamp}.json`,
    'application/json'
  );
  showAlert('JSON report byl exportovan.');
}

function getResultsMode() {
  const forensic = document.getElementById('results-mode-forensic');
  if (!forensic) return 'forensic';
  return forensic.checked ? 'forensic' : 'simple';
}

function normalizeWorkflowPreset(value) {
  const allowed = new Set(['person', 'relationship', 'photo', 'full']);
  return allowed.has(value) ? value : 'person';
}

function getWorkflowPreset() {
  const select = document.getElementById('workflow-preset');
  return normalizeWorkflowPreset(select && select.value);
}

function setWorkflowPreset(value) {
  const select = document.getElementById('workflow-preset');
  if (!select) return;
  select.value = normalizeWorkflowPreset(value);
  applyWorkflowPreset();
}

function applyWorkflowPreset() {
  const preset = getWorkflowPreset();
  const sections = {
    casePanel: document.getElementById('case-panel'),
    finalReportPanel: document.getElementById('final-report-panel'),
    entitiesPanel: document.getElementById('entities-panel'),
    templatesPanel: document.getElementById('templates-panel'),
    photoPanel: document.getElementById('photo-panel')
  };

  const visibility = {
    person: {
      casePanel: true,
      finalReportPanel: true,
      entitiesPanel: false,
      templatesPanel: false,
      photoPanel: false
    },
    relationship: {
      casePanel: true,
      finalReportPanel: true,
      entitiesPanel: true,
      templatesPanel: false,
      photoPanel: false
    },
    photo: {
      casePanel: true,
      finalReportPanel: true,
      entitiesPanel: false,
      templatesPanel: false,
      photoPanel: true
    },
    full: {
      casePanel: true,
      finalReportPanel: true,
      entitiesPanel: true,
      templatesPanel: true,
      photoPanel: true
    }
  };

  const next = visibility[preset] || visibility.person;
  Object.keys(sections).forEach((key) => {
    const node = sections[key];
    if (!node) return;
    node.classList.toggle('section-hidden', !next[key]);
  });
}

function setResultsMode(mode) {
  const simple = document.getElementById('results-mode-simple');
  const forensic = document.getElementById('results-mode-forensic');
  if (!simple || !forensic) return;

  const nextMode = normalizeResultsModeValue(mode);
  simple.checked = nextMode === 'simple';
  forensic.checked = nextMode === 'forensic';
  updateResultsModeUi();
}

function updateResultsModeUi() {
  const rawToggle = document.getElementById('results-raw-toggle');
  const rawModeCheckbox = document.getElementById('results-raw-mode');
  const confidenceLegend = document.getElementById('confidence-legend');
  const modePersonas = document.getElementById('mode-personas');
  const simpleActionsBar = document.getElementById('simple-actions-bar');
  const forensicToggleMissing = !document.getElementById('results-mode-forensic');
  const mode = getResultsMode();
  const isForensic = forensicToggleMissing || normalizeResultsModeValue(mode) === 'forensic';

  if (rawToggle) {
    rawToggle.style.display = isForensic ? 'inline-flex' : 'none';
  }

  if (confidenceLegend) {
    confidenceLegend.style.display = isForensic ? 'flex' : 'none';
  }

  if (modePersonas) {
    modePersonas.style.display = 'none';
  }

  if (simpleActionsBar) {
    simpleActionsBar.style.display = 'none';
  }

  if (!isForensic && rawModeCheckbox) {
    rawModeCheckbox.checked = false;
    forensicDetailsOpen = false;
  }
}

function normalizeResultUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';

    const params = Array.from(parsed.searchParams.entries())
      .filter(([key]) => !/^utm_/i.test(key))
      .sort((a, b) => a[0].localeCompare(b[0]));

    parsed.search = '';
    params.forEach(([key, value]) => {
      parsed.searchParams.append(key, value);
    });

    return parsed.toString();
  } catch {
    return String(url || '').trim();
  }
}

function isValidUrl(value) {
  const text = normalizeWhitespace(value);
  if (!text) return false;

  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getQueryCompleteness() {
  const name = normalizeWhitespace(getInputValue('name'));
  const nick = normalizeWhitespace(getInputValue('nick'));
  const city = normalizeWhitespace(getInputValue('city'));
  const phone = normalizePhone(getInputValue('phone'));

  let score = 0.35;
  if (name) score += 0.25;
  if (nick) score += 0.18;
  if (city) score += 0.12;
  if (phone) score += 0.2;

  const tokenCount = getQuery().split(' ').filter(Boolean).length;
  if (tokenCount >= 3) score += 0.05;
  if (tokenCount >= 5) score += 0.03;

  return clamp(score, 0.35, 0.98);
}

function calculateValidityPercent(link) {
  return calculateValidityDetails(link).validityPercent;
}

function calculateValidityDetails(link) {
  const source = getSourceByLabel(link[0]);
  let sourceConfidence = source ? SOURCE_CONFIDENCE[source.id] || 0.6 : 0.6;
  const queryCompleteness = getQueryCompleteness();

  if (source && isOfficialSource(source)) {
    sourceConfidence -= 0.12;
    if (!hasOfficialQuerySignal()) {
      sourceConfidence -= 0.1;
    }
    sourceConfidence = clamp(sourceConfidence, 0.45, 0.9);
  }

  const weighted = sourceConfidence * 0.72 + queryCompleteness * 0.28;
  return {
    validityPercent: Math.round(clamp(weighted, 0.35, 0.98) * 100),
    sourcePercent: Math.round(sourceConfidence * 100),
    queryPercent: Math.round(queryCompleteness * 100)
  };
}

function getValidityClass(percent) {
  if (percent >= 80) return 'validity-high';
  if (percent >= 50) return 'validity-medium';
  return 'validity-low';
}

function getConfidenceIndicator(percent) {
  if (percent >= 80) {
    return { label: 'VYSOKÁ', emoji: '🟢' };
  }

  if (percent >= 50) {
    return { label: 'STŘEDNÍ', emoji: '🟡' };
  }

  return { label: 'NÍZKÁ', emoji: '🔴' };
}

function getConfidenceBarClass(percent) {
  if (percent > 75) return 'confidence-bar-high';
  if (percent >= 50) return 'confidence-bar-medium';
  return 'confidence-bar-low';
}

function appendConfidenceBar(container, percent) {
  const safePercent = clamp(Number(percent) || 0, 0, 100);
  const wrapper = document.createElement('div');
  wrapper.className = 'confidence-bar-wrap';

  const bar = document.createElement('div');
  bar.className = `confidence-bar-fill ${getConfidenceBarClass(safePercent)}`;
  bar.style.width = `${safePercent}%`;
  bar.title = `Důvěra ${safePercent}%`;

  wrapper.appendChild(bar);
  container.appendChild(wrapper);
}

function getPreparedResults(links) {
  const rawMode = isRawModeEnabled();
  const results = [];
  const deduped = new Map();

  links.forEach((link) => {
    let label = '';
    let url = '';

    if (Array.isArray(link)) {
      label = link[0];
      url = link[1];
    } else if (link && typeof link === 'object') {
      label = link.label || link.source || link.title || '';
      url = link.url || link.link || link.href || '';
    }

    const cleanLabel = normalizeWhitespace(label);
    const cleanUrl = normalizeWhitespace(url);
    if (!cleanLabel || !cleanUrl || !isValidUrl(cleanUrl)) return;
    const validity = calculateValidityDetails([cleanLabel, cleanUrl]);
    const item = {
      label: cleanLabel,
      url: cleanUrl,
      validityPercent: validity.validityPercent,
      sourcePercent: validity.sourcePercent,
      queryPercent: validity.queryPercent
    };

    if (rawMode) {
      results.push(item);
      return;
    }

    const key = normalizeResultUrl(url);
    const existing = deduped.get(key);
    if (!existing || item.validityPercent > existing.validityPercent) {
      deduped.set(key, item);
    }
  });

  const prepared = rawMode ? results : Array.from(deduped.values());
  const sortMode = getResultsSortMode();

  if (sortMode === 'source') {
    prepared.sort((a, b) => a.label.localeCompare(b.label, 'cs'));
    return prepared;
  }

  prepared.sort((a, b) => {
    if (b.validityPercent !== a.validityPercent) {
      return b.validityPercent - a.validityPercent;
    }

    return a.label.localeCompare(b.label, 'cs');
  });

  return prepared;
}

function buildPhotoResultLookup() {
  const lookup = new Map();
  const items =
    lastPhotoDashboard && Array.isArray(lastPhotoDashboard.items) ? lastPhotoDashboard.items : [];

  items.forEach((item) => {
    if (!item || !item.url) return;
    lookup.set(normalizeResultUrl(item.url), item);
  });

  return lookup;
}

function resolveResultTechnicalDetails(item, photoLookup) {
  const source = getSourceFromPreparedLabel(item.label);
  const photo = photoLookup.get(normalizeResultUrl(item.url)) || null;

  const manipulationReasons =
    photo && Array.isArray(photo.manipulationReasons)
      ? photo.manipulationReasons.filter(Boolean)
      : [];

  return {
    sourceLabel: source
      ? source.label
      : String(item.label || '')
          .split(' [')[0]
          .trim(),
    sources:
      photo && photo.sourceCount > 0 ? String(photo.sourceCount) : source ? source.label : 'n/a',
    similarity: photo && photo.similarityComponent > 0 ? `${photo.similarityComponent}%` : 'n/a',
    hashMatch:
      photo && typeof photo.hashMatch === 'boolean' ? (photo.hashMatch ? 'ano' : 'ne') : 'n/a',
    ocrText: photo && photo.detectedText ? truncateMiddle(photo.detectedText, 140) : 'n/a',
    manipulationFlags: photo
      ? photo.manipulated
        ? `ano${manipulationReasons.length ? ` (${manipulationReasons.join(', ')})` : ''}`
        : 'ne'
      : 'n/a'
  };
}

function getSimpleExplanation(item, technical) {
  if (technical.manipulationFlags.startsWith('ano')) {
    return `⚠ ${item.validityPercent} % shoda - mozne znamky manipulace`;
  }

  return `✅ ${item.validityPercent} % shoda - pravdepodobny zdroj nalezen`;
}

function getOperationalSubjectLine(item, detailModel) {
  const subjectParts = [
    normalizeWhitespace(getInputValue('name')),
    normalizeWhitespace(getInputValue('nick'))
      ? `(${normalizeWhitespace(getInputValue('nick'))})`
      : '',
    normalizeWhitespace(getInputValue('city'))
      ? `, ${normalizeWhitespace(getInputValue('city'))}`
      : '',
    normalizePhone(getInputValue('phone')) ? `, ${normalizePhone(getInputValue('phone'))}` : ''
  ].filter(Boolean);

  const subject = subjectParts.join(' ').replace(/\s+,/g, ',').trim();
  if (subject) return subject;

  const sourceLabel = getSourceFromPreparedLabel(item && item.label);
  if (sourceLabel && sourceLabel.label) {
    return `Subjekt z dotazu | zdroj ${sourceLabel.label}`;
  }

  if (detailModel && detailModel.title) {
    return `Subjekt z dotazu | nalez ${detailModel.title}`;
  }

  return 'Subjekt z dotazu';
}

function getOperationalFoundLine(item, detailModel) {
  const domain = domainFromUrl(item && item.url);
  const sourceCount = Number(detailModel && detailModel.sourceCount) || 1;
  const domainLabel = domain || 'neznámý web';
  return `${item.validityPercent}% shoda | ${domainLabel} | ${sourceCount} zdroj(e)`;
}

function appendOperationalSummary(container, item, detailModel) {
  const assistantOutput = getAssistantOutput(detailModel);
  const risks = Array.isArray(assistantOutput && assistantOutput.rizika)
    ? assistantOutput.rizika
    : [];

  const foundLine = getOperationalFoundLine(item, detailModel);
  const subjectLine = getOperationalSubjectLine(item, detailModel);
  const riskLine = risks.length
    ? risks.slice(0, 2).join(' | ')
    : 'Bez vyraznych rizikovych signalu v aktualnim vzorku.';
  const conclusionLine =
    normalizeWhitespace(assistantOutput && assistantOutput.zaver) ||
    'Závěr zatím nelze jednoznačně stanovit.';

  const rows = [
    ['👤', 'subjekt', subjectLine],
    ['✅', 'nalezeno', foundLine],
    ['⚠️', 'rizika', riskLine],
    ['🎯', 'zaver', conclusionLine]
  ];

  const box = document.createElement('div');
  box.className = 'result-operational';

  rows.forEach(([icon, label, value]) => {
    const row = document.createElement('div');
    row.className = 'result-operational-row';

    const badge = document.createElement('span');
    badge.className = 'result-operational-badge';
    badge.textContent = `${icon} ${label}`;

    const text = document.createElement('span');
    text.className = 'result-operational-text';
    text.textContent = value;

    row.appendChild(badge);
    row.appendChild(text);
    box.appendChild(row);
  });

  container.appendChild(box);
}

function appendTechnicalDetails(container, technical) {
  const detailsBox = document.createElement('div');
  detailsBox.className = 'result-tech';

  const sourceCount = Number(technical.sources);
  const hasMoreSources = Number.isFinite(sourceCount) && sourceCount > 1;
  const hasOcr = technical.ocrText && technical.ocrText !== 'n/a';
  const hasMatch =
    technical.hashMatch === 'ano' || (technical.similarity && technical.similarity !== 'n/a');
  const hasManipulation = String(technical.manipulationFlags || '')
    .toLowerCase()
    .startsWith('ano');

  const rows = [
    [
      '✔',
      'Shoda',
      hasMatch
        ? technical.hashMatch === 'ano'
          ? 'Potvrzena shoda'
          : `Podobnost ${technical.similarity}`
        : 'Bez potvrzene shody'
    ],
    ['⚠', 'Manipulace', hasManipulation ? technical.manipulationFlags : 'Bez znamky manipulace'],
    ['📝', 'OCR', hasOcr ? technical.ocrText : 'OCR text nenalezen'],
    ['🔗', 'Vice zdroju', hasMoreSources ? `${sourceCount} zdroje` : 'Jeden zdroj']
  ];

  rows.forEach(([icon, label, value]) => {
    const line = document.createElement('div');
    line.className = 'result-tech-line';

    const key = document.createElement('strong');
    key.textContent = `${icon} ${label}:`;

    const text = document.createElement('span');
    text.textContent = value || 'n/a';

    line.appendChild(key);
    line.appendChild(text);
    detailsBox.appendChild(line);
  });

  container.appendChild(detailsBox);
}

function parseManipulationIndicators(flagsText) {
  const raw = normalizeWhitespace(flagsText);
  if (!raw || !raw.toLowerCase().startsWith('ano')) return [];

  const match = raw.match(/\((.*)\)$/);
  if (!match || !match[1]) return ['Neupresneny signal'];

  return match[1]
    .split(',')
    .map((value) => normalizeWhitespace(value))
    .filter(Boolean);
}

function getResultDetailKey(item) {
  return `${item.label}|${normalizeResultUrl(item.url)}`;
}

function buildResultClusterLookup() {
  const map = new Map();
  const clusters =
    lastPhotoDashboard && Array.isArray(lastPhotoDashboard.clusters)
      ? lastPhotoDashboard.clusters
      : [];

  clusters.forEach((cluster) => {
    const clusterItems = Array.isArray(cluster && cluster.items) ? cluster.items : [];
    clusterItems.forEach((clusterItem) => {
      const url = normalizeWhitespace(clusterItem && clusterItem.url);
      if (!url) return;

      const candidates = [
        normalizeWhitespace(clusterItem && clusterItem.firstSeen),
        normalizeWhitespace(clusterItem && clusterItem.lastSeen),
        normalizeWhitespace(clusterItem && clusterItem.timestamp),
        normalizeWhitespace(cluster && cluster.firstSeen),
        normalizeWhitespace(cluster && cluster.lastSeen)
      ].filter(Boolean);

      const sortedCandidates = candidates
        .map((value) => ({ raw: value, ts: Date.parse(value) }))
        .filter((item) => Number.isFinite(item.ts))
        .sort((a, b) => a.ts - b.ts)
        .map((item) => item.raw);

      map.set(normalizeResultUrl(url), {
        clusterId: normalizeWhitespace(cluster && cluster.clusterId) || 'cluster',
        occurrences: Math.max(1, Number(clusterItem && clusterItem.occurrences) || 1),
        sources: Array.isArray(clusterItem && clusterItem.sources)
          ? clusterItem.sources.map((source) => normalizeWhitespace(source)).filter(Boolean)
          : [],
        dominantDomain: normalizeWhitespace(cluster && cluster.dominantDomain),
        avgScore: Number.isFinite(Number(cluster && cluster.avgScore))
          ? Number(cluster.avgScore)
          : null,
        firstSeen: sortedCandidates.length ? sortedCandidates[0] : '',
        lastSeen: sortedCandidates.length ? sortedCandidates[sortedCandidates.length - 1] : ''
      });
    });
  });

  return map;
}

function buildResultDetailModel(item, technical, clusterLookup) {
  const photo =
    lastPhotoDashboard && Array.isArray(lastPhotoDashboard.items)
      ? lastPhotoDashboard.items.find(
          (entry) => normalizeResultUrl(entry.url) === normalizeResultUrl(item.url)
        )
      : null;
  const cluster = clusterLookup.get(normalizeResultUrl(item.url)) || null;
  const manipulationReasons =
    photo && Array.isArray(photo.manipulationReasons) ? photo.manipulationReasons : [];
  const sources =
    photo && Array.isArray(photo.sources)
      ? photo.sources
      : cluster && Array.isArray(cluster.sources)
        ? cluster.sources
        : [];
  const domains = photo && Array.isArray(photo.domains) ? photo.domains : [];

  const seenRange = computeSeenRange([
    cluster && cluster.firstSeen,
    cluster && cluster.lastSeen,
    lastResultsSearchAt
  ]);
  const firstSeen = seenRange.firstSeen;
  const lastSeen = seenRange.lastSeen;
  const sourceCount = Math.max(1, Array.isArray(sources) ? sources.length : 0);
  const trusted = hasTrustedDomain(domains);

  const detail = {
    key: getResultDetailKey(item),
    title: item.label,
    url: item.url,
    confidence: item.validityPercent,
    sources,
    sourceCount,
    domains,
    hasTrustedDomain: trusted,
    ocrText: technical.ocrText && technical.ocrText !== 'n/a' ? technical.ocrText : '',
    manipulated: String(technical.manipulationFlags || '')
      .toLowerCase()
      .startsWith('ano'),
    manipulationReasons,
    scoreBreakdown: photo && photo.scoreBreakdown ? photo.scoreBreakdown : null,
    logicAnalysis: photo && photo.logicAnalysis ? photo.logicAnalysis : null,
    aiAnalysis: photo && photo.aiAnalysis ? photo.aiAnalysis : null,
    firstSeen,
    lastSeen,
    cluster
  };

  return {
    ...detail,
    fakeScore: computeFakeScore(detail)
  };
}

function renderDetailList(container, title, values, emptyText) {
  const block = document.createElement('div');
  block.className = 'result-detail-block';

  const heading = document.createElement('strong');
  heading.className = 'result-detail-label';
  heading.textContent = title;
  block.appendChild(heading);

  if (!values.length) {
    const empty = document.createElement('p');
    empty.className = 'result-detail-empty';
    empty.textContent = emptyText;
    block.appendChild(empty);
    container.appendChild(block);
    return;
  }

  const chips = document.createElement('div');
  chips.className = 'result-detail-chips';
  values.forEach((value) => {
    const chip = document.createElement('span');
    chip.className = 'result-detail-chip';
    chip.textContent = value;
    chips.appendChild(chip);
  });
  block.appendChild(chips);
  container.appendChild(block);
}

function renderScoreBreakdown(container, breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return;

  const block = document.createElement('div');
  block.className = 'result-detail-block';

  const heading = document.createElement('strong');
  heading.className = 'result-detail-label';
  heading.textContent = 'Scoring explain';
  block.appendChild(heading);

  const keys = [
    ['similarity', 'Similarity'],
    ['sourceCount', 'Source count'],
    ['domainTrust', 'Domain trust'],
    ['hashSimilarity', 'Hash similarity'],
    ['textRepeat', 'Text repeat']
  ];

  keys.forEach(([key, label]) => {
    const value = normalizePercentScore(breakdown[key]);
    const row = document.createElement('div');
    row.className = 'result-breakdown-row';

    const text = document.createElement('span');
    text.textContent = `${label}: ${value}%`;

    const bar = document.createElement('div');
    bar.className = 'result-breakdown-bar';

    const fill = document.createElement('div');
    fill.className = `result-breakdown-fill ${getConfidenceBarClass(value)}`;
    fill.style.width = `${value}%`;

    bar.appendChild(fill);
    row.appendChild(text);
    row.appendChild(bar);
    block.appendChild(row);
  });

  container.appendChild(block);
}

function renderLogicAnalysis(container, logicAnalysis) {
  if (!logicAnalysis || typeof logicAnalysis !== 'object') return;

  const block = document.createElement('div');
  block.className = 'result-detail-block';

  const heading = document.createElement('strong');
  heading.className = 'result-detail-label';
  heading.textContent = 'Logic analysis';
  block.appendChild(heading);

  const conclusion = document.createElement('p');
  conclusion.className = 'result-detail-meta';
  conclusion.textContent = `Conclusion: ${logicAnalysis.conclusion || 'Uncertain'}`;
  block.appendChild(conclusion);

  const consistency = logicAnalysis.consistency || null;
  if (consistency && typeof consistency === 'object') {
    const line = document.createElement('p');
    line.className = 'result-detail-meta';
    line.textContent = `Consistency: ${Math.round((Number(consistency.score) || 0) * 100)}% | sources ${Number(consistency.sourceCount) || 0} | domains ${Number(consistency.domainCount) || 0}`;
    block.appendChild(line);
  }

  const contradictions = logicAnalysis.contradictions || null;
  if (contradictions && typeof contradictions === 'object') {
    const line = document.createElement('p');
    line.className = 'result-detail-meta';
    line.textContent = `Contradictions (OCR): ${Number(contradictions.count) || 0}`;
    block.appendChild(line);
  }

  container.appendChild(block);
}

function renderAiAnalysis(container, aiAnalysis) {
  if (!aiAnalysis || typeof aiAnalysis !== 'object') return;

  const block = document.createElement('div');
  block.className = 'result-detail-block';

  const heading = document.createElement('strong');
  heading.className = 'result-detail-label';
  heading.textContent = 'AI analyza';
  block.appendChild(heading);

  const conclusion = document.createElement('p');
  conclusion.className = 'result-detail-meta';
  conclusion.textContent = `Závěr: ${aiAnalysis.conclusion || 'Neurčité'} | Riziko: ${aiAnalysis.risk || 'STŘEDNÍ'}`;
  block.appendChild(conclusion);

  if (aiAnalysis.reasoning) {
    const reasoning = document.createElement('p');
    reasoning.className = 'result-detail-text';
    reasoning.textContent = aiAnalysis.reasoning;
    block.appendChild(reasoning);
  }

  container.appendChild(block);
}

function renderResultDetailPanel(detail, detailPanel, options = {}) {
  if (!detailPanel) return;
  clearNode(detailPanel);

  if (!detail) {
    const empty = document.createElement('p');
    empty.className = 'result-detail-empty';
    empty.textContent = 'Vyberte vysledek vlevo pro detail.';
    detailPanel.appendChild(empty);
    return;
  }

  const title = document.createElement('h4');
  title.className = 'result-detail-title';
  title.textContent = detail.title;
  detailPanel.appendChild(title);

  const link = document.createElement('a');
  link.href = detail.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = detail.url;
  link.className = 'result-detail-link';
  detailPanel.appendChild(link);

  const confidence = document.createElement('p');
  confidence.className = 'result-detail-meta';
  confidence.textContent = `Důvěra: ${detail.confidence}%`;
  detailPanel.appendChild(confidence);

  appendConfidenceBar(detailPanel, detail.confidence);

  const showTechnical = Boolean(options && options.showTechnical);

  const timeline = document.createElement('div');
  timeline.className = 'result-detail-block';
  const timelineTitle = document.createElement('strong');
  timelineTitle.className = 'result-detail-label';
  timelineTitle.textContent = 'Časová osa';
  timeline.appendChild(timelineTitle);

  const firstSeen = document.createElement('p');
  firstSeen.className = 'result-detail-meta';
  firstSeen.textContent = `První záchyt: ${formatSeenTimestamp(detail.firstSeen)}`;
  timeline.appendChild(firstSeen);

  const lastSeen = document.createElement('p');
  lastSeen.className = 'result-detail-meta';
  lastSeen.textContent = `Poslední záchyt: ${formatSeenTimestamp(detail.lastSeen)}`;
  timeline.appendChild(lastSeen);
  detailPanel.appendChild(timeline);

  renderDetailList(detailPanel, 'Sources', detail.sources, 'Bez zdroju');
  renderDetailList(detailPanel, 'Domains', detail.domains, 'Bez domen');

  if (showTechnical) {
    const fakeScoreBlock = document.createElement('div');
    fakeScoreBlock.className = 'result-detail-block';
    const fakeScoreTitle = document.createElement('strong');
    fakeScoreTitle.className = 'result-detail-label';
    fakeScoreTitle.textContent = 'Skóre manipulace';
    fakeScoreBlock.appendChild(fakeScoreTitle);

    const fakeScoreBadge = document.createElement('span');
    fakeScoreBadge.className = `fake-score-badge fake-score-${String(detail.fakeScore.level || 'LOW').toLowerCase()}`;
    fakeScoreBadge.textContent = `${detail.fakeScore.level} (${Math.round(detail.fakeScore.value * 100)}%)`;
    fakeScoreBlock.appendChild(fakeScoreBadge);

    const fakeScoreMeta = document.createElement('p');
    fakeScoreMeta.className = 'result-detail-meta';
    fakeScoreMeta.textContent = `manipulace +${detail.fakeScore.components.manipulated.toFixed(1)} | nízká důvěryhodnost +${detail.fakeScore.components.lowTrust.toFixed(1)} | málo zdrojů +${detail.fakeScore.components.fewSources.toFixed(1)}`;
    fakeScoreBlock.appendChild(fakeScoreMeta);
    detailPanel.appendChild(fakeScoreBlock);

    if (detail.manipulated) {
      const warning = document.createElement('div');
      warning.className = 'manipulation-warning';

      const warningTitle = document.createElement('strong');
      warningTitle.textContent = '⚠ Podezreni na manipulaci';
      warning.appendChild(warningTitle);

      const warningList = document.createElement('ul');
      warningList.className = 'manipulation-indicators';
      (detail.manipulationReasons.length
        ? detail.manipulationReasons
        : ['Neupresneny signal']
      ).forEach((reason) => {
        const li = document.createElement('li');
        li.textContent = reason;
        warningList.appendChild(li);
      });
      warning.appendChild(warningList);
      detailPanel.appendChild(warning);
    }

    const ocrBlock = document.createElement('div');
    ocrBlock.className = 'result-detail-block';
    const ocrTitle = document.createElement('strong');
    ocrTitle.className = 'result-detail-label';
    ocrTitle.textContent = 'OCR text';
    const ocrText = document.createElement('p');
    ocrText.className = 'result-detail-text';
    ocrText.textContent = detail.ocrText || 'OCR text nenalezen';
    ocrBlock.appendChild(ocrTitle);
    ocrBlock.appendChild(ocrText);
    detailPanel.appendChild(ocrBlock);

    renderScoreBreakdown(detailPanel, detail.scoreBreakdown);
    renderLogicAnalysis(detailPanel, detail.logicAnalysis);
    renderAiAnalysis(detailPanel, detail.aiAnalysis);

    if (detail.cluster) {
      const clusterBlock = document.createElement('div');
      clusterBlock.className = 'result-detail-block';

      const clusterTitle = document.createElement('strong');
      clusterTitle.className = 'result-detail-label';
      clusterTitle.textContent = 'Cluster info';
      clusterBlock.appendChild(clusterTitle);

      const clusterMeta = document.createElement('p');
      clusterMeta.className = 'result-detail-meta';
      clusterMeta.textContent = `${detail.cluster.clusterId} | Occurrences: ${detail.cluster.occurrences}`;
      clusterBlock.appendChild(clusterMeta);

      renderDetailList(
        clusterBlock,
        'Cluster sources',
        detail.cluster.sources,
        'Bez cluster zdroju'
      );

      if (detail.cluster.dominantDomain) {
        const dominant = document.createElement('p');
        dominant.className = 'result-detail-meta';
        dominant.textContent = `Dominant domain: ${detail.cluster.dominantDomain}`;
        clusterBlock.appendChild(dominant);
      }

      if (Number.isFinite(detail.cluster.avgScore)) {
        const avg = document.createElement('p');
        avg.className = 'result-detail-meta';
        avg.textContent = `Avg cluster score: ${detail.cluster.avgScore}`;
        clusterBlock.appendChild(avg);
      }

      detailPanel.appendChild(clusterBlock);
    }
  }
}

function createResultRow(item, technical, options) {
  const row = document.createElement('div');
  row.className = 'result-row';
  if (options && options.featured) {
    row.classList.add('result-row-featured');
  }
  if (
    String((technical && technical.manipulationFlags) || '')
      .toLowerCase()
      .startsWith('ano')
  ) {
    row.classList.add('result-row-manipulated');
  }

  const head = document.createElement('div');
  head.className = 'result-head';

  const source = document.createElement('strong');
  source.textContent = item.label;

  const validity = item.validityPercent;
  const confidenceIndicator = getConfidenceIndicator(validity);
  const badge = document.createElement('span');
  badge.className = `validity-badge ${getValidityClass(validity)}`;
  badge.textContent = `${confidenceIndicator.emoji} ${confidenceIndicator.label} ${validity}%`;
  badge.title = `HIGH 80-100% | MEDIUM 50-79% | LOW 0-49% | Zdroj: ${item.sourcePercent}% | Kompletnost dotazu: ${item.queryPercent}%`;

  if (options && options.featured) {
    const marker = document.createElement('span');
    marker.className = 'top-result-marker';
    marker.textContent = 'TOP VÝSLEDEK';
    head.appendChild(marker);
  }

  head.appendChild(source);
  head.appendChild(badge);

  row.appendChild(head);
  appendConfidenceBar(row, validity);

  const manipulationIndicators = parseManipulationIndicators(
    technical && technical.manipulationFlags
  );
  if (manipulationIndicators.length) {
    const warning = document.createElement('div');
    warning.className = 'manipulation-warning manipulation-warning-inline';

    const warningTitle = document.createElement('strong');
    warningTitle.textContent = '⚠ Podezreni na manipulaci';
    warning.appendChild(warningTitle);

    const warningList = document.createElement('ul');
    warningList.className = 'manipulation-indicators';
    manipulationIndicators.forEach((reason) => {
      const li = document.createElement('li');
      li.textContent = reason;
      warningList.appendChild(li);
    });
    warning.appendChild(warningList);
    row.appendChild(warning);
  }

  if (options && options.showSourceSummary) {
    const meta = document.createElement('p');
    meta.className = 'result-meta';
    meta.textContent = `Důvěra: ${validity}% | Zdroje: ${technical.sources}`;
    row.appendChild(meta);
  }

  if (options && options.summaryText) {
    const summary = document.createElement('p');
    summary.className = 'result-summary';
    summary.textContent = options.summaryText;
    row.appendChild(summary);
  }

  appendOperationalSummary(row, item, options && options.detailModel ? options.detailModel : null);

  const anchor = document.createElement('a');
  anchor.href = item.url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.textContent = item.url;
  row.appendChild(anchor);

  if (options && options.showTechnical) {
    appendTechnicalDetails(row, technical);
  }

  if (!(options && options.hideActions)) {
    const actions = document.createElement('div');
    actions.className = 'row';

    const openBtn = document.createElement('button');
    openBtn.textContent = 'Otevrít';
    openBtn.type = 'button';
    openBtn.addEventListener('click', () => openSearch(item.url));

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Kopirovat';
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => copyText(item.url, 'Odkaz zkopirovan.'));

    const addEntityBtn = document.createElement('button');
    addEntityBtn.textContent = 'Pridat do pripadu';
    addEntityBtn.type = 'button';
    addEntityBtn.addEventListener('click', () =>
      addPreparedResultToCaseEntity(item.label, item.url)
    );

    actions.appendChild(openBtn);
    actions.appendChild(copyBtn);
    actions.appendChild(addEntityBtn);

    if (options && options.onDetailsToggle) {
      const detailsBtn = document.createElement('button');
      detailsBtn.type = 'button';
      detailsBtn.textContent = options.showTechnical ? 'Skryt detail' : 'Zobrazit detail';
      detailsBtn.addEventListener('click', options.onDetailsToggle);
      actions.appendChild(detailsBtn);
    }

    row.appendChild(actions);
  }

  if (options && typeof options.onSelect === 'function') {
    row.classList.add('result-row-clickable');
    row.addEventListener('click', (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('button, a')) {
        return;
      }
      options.onSelect();
    });
  }

  if (options && options.selected) {
    row.classList.add('result-row-selected');
  }

  return row;
}

function isResultSuspicious(item, technical) {
  const manipulated = String((technical && technical.manipulationFlags) || '')
    .toLowerCase()
    .startsWith('ano');
  return manipulated || item.validityPercent < 40;
}

function createResultGroupSection(title, className, entries, options) {
  const section = document.createElement('section');
  section.className = `result-group ${className}`;

  const heading = document.createElement('h4');
  heading.className = 'result-group-title';
  heading.textContent = `${title} (${entries.length})`;
  section.appendChild(heading);

  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'result-group-empty';
    empty.textContent = 'Bez polozek';
    section.appendChild(empty);
    return section;
  }

  entries.forEach((entry) => {
    const key = getResultDetailKey(entry.item);
    const row = createResultRow(entry.item, entry.technical, {
      detailModel: entry.detailModel,
      showTechnical: options && options.showTechnical,
      hideActions: options && options.hideActions,
      onSelect: options && options.onSelect ? () => options.onSelect(entry) : null,
      selected: Boolean(options && options.selectedKey && options.selectedKey === key)
    });
    section.appendChild(row);
  });

  return section;
}

function getReportLinkNature(item) {
  const source = getSourceFromPreparedLabel(item.label);
  if (!source) return 'vyhledavaci odkaz';

  if (
    /^src_(interpol|europol|fbi_wanted|eu_most_wanted|dea|usmarshals|nca_uk|ofac|eu_sanctions|un_sanctions)$/.test(
      source.id
    )
  ) {
    return 'oficialni zdroj k overeni';
  }

  return 'vyhledavaci odkaz';
}

function renderVerdict(verdict) {
  const panel = document.getElementById('verdict-panel');
  if (!panel) return;

  if (!verdict || typeof verdict !== 'object') {
    panel.style.display = 'none';
    panel.classList.remove('verdict-high', 'verdict-medium', 'verdict-low');
    return;
  }

  panel.classList.remove('verdict-high', 'verdict-medium', 'verdict-low');
  panel.classList.add(`verdict-${verdict.confidence || 'low'}`);

  let primaryHeaderEl = document.getElementById('verdict-primary-header');
  if (!primaryHeaderEl) {
    primaryHeaderEl = document.createElement('div');
    primaryHeaderEl.id = 'verdict-primary-header';
    panel.prepend(primaryHeaderEl);
  }
  primaryHeaderEl.className = 'verdict-primary-header';
  primaryHeaderEl.innerHTML = `👉 ${verdict && typeof verdict.summary === 'string' ? verdict.summary : ''}`;

  const summaryEl = document.getElementById('verdict-summary');
  if (summaryEl) {
    summaryEl.textContent = verdict && typeof verdict.summary === 'string' ? verdict.summary : '';
  }

  const warningsEl = document.getElementById('verdict-warnings');
  if (warningsEl) {
    warningsEl.innerHTML = '';
    const warnings = Array.isArray(verdict.warnings)
      ? verdict.warnings
      : Array.isArray(verdict.redFlags)
        ? verdict.redFlags
        : [];
    warnings.forEach((warning) => {
      const li = document.createElement('li');
      li.textContent = warning;
      warningsEl.appendChild(li);
    });
    const warningsTitleEl = warningsEl.previousElementSibling;
    if (warningsTitleEl) warningsTitleEl.style.display = warnings.length ? '' : 'none';
    warningsEl.style.display = warnings.length ? '' : 'none';
  }

  const recommendationsEl = document.getElementById('verdict-recommendations');
  if (recommendationsEl) {
    recommendationsEl.innerHTML = '';
    const recommendations = Array.isArray(verdict.recommendations) ? verdict.recommendations : [];
    recommendations.forEach((recommendation) => {
      const li = document.createElement('li');
      li.textContent = recommendation;
      recommendationsEl.appendChild(li);
    });
    const recommendationsTitleEl = recommendationsEl.previousElementSibling;
    if (recommendationsTitleEl) {
      recommendationsTitleEl.style.display = recommendations.length ? '' : 'none';
    }
    recommendationsEl.style.display = recommendations.length ? '' : 'none';
  }

  const explanationEl = document.getElementById('verdict-explanation');
  if (explanationEl) {
    const explanation =
      verdict && typeof verdict.simpleExplanation === 'string' ? verdict.simpleExplanation : '';
    explanationEl.textContent = explanation;
    const explanationTitleEl = explanationEl.previousElementSibling;
    if (explanationTitleEl) explanationTitleEl.style.display = explanation ? '' : 'none';
    explanationEl.style.display = explanation ? '' : 'none';
  }

  const actionsEl = document.getElementById('verdict-actions');
  if (actionsEl) {
    actionsEl.innerHTML = '';
    const actions = Array.isArray(verdict.actions) ? verdict.actions : [];
    actions.forEach((action) => {
      const li = document.createElement('li');
      li.textContent = action;
      actionsEl.appendChild(li);
    });
    const actionsTitleEl = actionsEl.previousElementSibling;
    if (actionsTitleEl) actionsTitleEl.style.display = actions.length ? '' : 'none';
    actionsEl.style.display = actions.length ? '' : 'none';
  }

  panel.style.display = 'block';
}

function renderResults(links) {
  const card = document.getElementById('results-card');
  const list = document.getElementById('results-list');

  if (!card || !list) return;

  const preparedResults = getPreparedResults(links);
  const mode = getResultsMode();

  card.style.display = 'block';
  list.textContent = '';

  if (!preparedResults.length) {
    list.appendChild(
      createStatusBox({
        title: 'Odpověď',
        text: '⚪ Nenašli jsme pravděpodobnou shodu - ověřte dotaz nebo zkuste jiný zdroj.',
        detailText:
          mode === 'forensic'
            ? 'Forensic: zatím nejsou data k zobrazení. Zkuste širší dotaz nebo aktivujte další zdroje.'
            : 'Další krok: nahrajte kvalitnější obrázek nebo doplňte jméno/nick.'
      })
    );
    applyResultsUiState({
      percent: NaN,
      bannerText: '⚪ Výsledek: ČEKÁ NA ANALÝZU',
      results: [],
      totalCount: 0,
      verdict: {
        summary: 'Žádné relevantní výsledky',
        warnings: ['Nebyl nalezen žádný výsledek'],
        recommendations: ['Zkuste upravit vstupní údaj']
      }
    });
    return;
  }

  // Guaranteed base output: always show a plain list first, even if advanced rendering fails later.
  const guaranteedListBox = document.createElement('div');
  guaranteedListBox.className = 'answer-box';

  const guaranteedTitle = document.createElement('strong');
  guaranteedTitle.className = 'answer-title';
  guaranteedTitle.textContent = `Potvrzene odkazy (${preparedResults.length})`;

  const guaranteedList = document.createElement('ul');
  guaranteedList.style.margin = '8px 0 0';
  guaranteedList.style.paddingLeft = '18px';

  preparedResults.slice(0, 30).forEach((item, index) => {
    const li = document.createElement('li');
    const anchor = document.createElement('a');
    anchor.href = item.url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    const confidence = calculateConfidenceScore(item.label || '', item);
    const label = getConfidenceLabel(confidence);
    anchor.textContent = `${index + 1}. ${item.label} | ${confidence}% (${label})`;
    li.appendChild(anchor);
    guaranteedList.appendChild(li);
  });

  guaranteedListBox.appendChild(guaranteedTitle);
  guaranteedListBox.appendChild(guaranteedList);
  list.appendChild(guaranteedListBox);

  const dedupeGroups = deduplicateByFuzzyMatch(preparedResults);
  const mergedGroups = dedupeGroups.filter((group) => group.items.length > 1);
  window.lastDedupeGroup = dedupeGroups.length > 0 ? dedupeGroups[0].items : [];

  if (mergedGroups.length > 0) {
    const dedupeBox = createStatusBox({
      title: 'Sloučení duplicate entit',
      text: `Původně ${preparedResults.length} výsledků, po sloučení ${dedupeGroups.length} unikátních entit.`
    });

    const dedupeDetails = document.createElement('div');
    dedupeDetails.className = 'dedupe-groups';

    mergedGroups.forEach((group) => {
      const confidence = Math.min(100, 50 + group.items.length * 12);
      const heading = document.createElement('p');
      heading.className = 'result-summary';
      heading.style.fontWeight = '700';
      heading.style.marginTop = '8px';
      heading.textContent = `✅ ${group.mainLabel} (${confidence}%)`;
      dedupeDetails.appendChild(heading);

      const listItems = document.createElement('ul');
      listItems.style.margin = '4px 0 0';
      listItems.style.paddingLeft = '18px';

      group.items.forEach((item) => {
        const li = document.createElement('li');
        li.textContent = `- ${item.label || item[0] || 'Unknown'}`;
        listItems.appendChild(li);
      });

      dedupeDetails.appendChild(listItems);
    });

    dedupeBox.appendChild(dedupeDetails);
    list.appendChild(dedupeBox);
  }

  const photoLookup = buildPhotoResultLookup();
  const clusterLookup = buildResultClusterLookup();
  const filters = getResultsFilters();

  const allEntries = preparedResults.map((item) => {
    const technical = resolveResultTechnicalDetails(item, photoLookup);
    const detailModel = buildResultDetailModel(item, technical, clusterLookup);
    return { item, technical, detailModel };
  });

  const filteredEntries = allEntries.filter((entry) => {
    if (entry.item.validityPercent < filters.minConfidence) return false;
    if (filters.onlyManipulated && !entry.detailModel.manipulated) return false;
    if (filters.onlyTrustedDomains && !entry.detailModel.hasTrustedDomain) return false;
    return true;
  });

  if (
    !filteredEntries.length &&
    preparedResults.length &&
    (filters.minConfidence > 0 || filters.onlyManipulated || filters.onlyTrustedDomains)
  ) {
    const minConfidenceEl = document.getElementById('results-min-confidence');
    const onlyManipulatedEl = document.getElementById('results-only-manipulated');
    const onlyTrustedEl = document.getElementById('results-only-trusted');

    if (minConfidenceEl) minConfidenceEl.value = '0';
    if (onlyManipulatedEl) onlyManipulatedEl.checked = false;
    if (onlyTrustedEl) onlyTrustedEl.checked = false;
    updateResultsFilterUi();
    saveUiState();
    showAlert('Filtry skryly vsechny vysledky. Automaticky jsem je resetoval.');
    renderResults(links);
    return;
  }

  const displayedResults = filteredEntries.map((entry) => entry.item);

  if (!filteredEntries.length) {
    list.appendChild(
      createStatusBox({
        title: 'Filtry',
        text: '⚪ Žádný výsledek neodpovídá aktivním filtrům.',
        detailText: 'Zkuste snížit minimální relevanci nebo vypnout omezené filtry.'
      })
    );
    applyResultsUiState({
      percent: NaN,
      bannerText: '⚪ Výsledek: BEZ SHODY VE FILTRECH',
      results: [],
      totalCount: preparedResults.length,
      verdict: {
        summary: 'Žádné relevantní výsledky',
        warnings: ['Nebyl nalezen žádný výsledek'],
        recommendations: ['Zkuste upravit vstupní údaj']
      }
    });
    return;
  }

  const topEntry = filteredEntries[0];
  const top = topEntry.item;
  const topTechnical = topEntry.technical;

  try {
    applyResultsUiState({
      percent: top.validityPercent,
      results: displayedResults,
      totalCount: preparedResults.length,
      verdict: generateVerdict(
        filteredEntries.map((entry) => ({
          score: entry.item.validityPercent / 100,
          domainTrust: entry.detailModel && entry.detailModel.hasTrustedDomain ? 1 : 0,
          manipulationScore: entry.detailModel && entry.detailModel.manipulated ? 1 : 0
        }))
      )
    });
  } catch (error) {
    console.warn('Verdict rendering failed, results list continues', error);
  }

  const quickListBox = document.createElement('div');
  quickListBox.className = 'result-quick-list';
  const quickTitle = document.createElement('strong');
  quickTitle.textContent = `Konkretni nalezy (${filteredEntries.length})`;
  quickListBox.appendChild(quickTitle);

  const quickList = document.createElement('ul');
  filteredEntries.slice(0, 8).forEach((entry, index) => {
    const li = document.createElement('li');
    li.textContent = `${index + 1}. ${entry.item.label}: ${entry.item.url}`;
    quickList.appendChild(li);
  });
  quickListBox.appendChild(quickList);
  list.appendChild(quickListBox);

  const detailModelMap = new Map(
    filteredEntries.map((entry) => [entry.detailModel.key, entry.detailModel])
  );

  const layout = document.createElement('div');
  layout.className = 'results-layout';
  const listColumn = document.createElement('div');
  listColumn.className = 'results-column-list';
  const detailColumn = document.createElement('aside');
  detailColumn.className = 'results-column-detail';
  layout.appendChild(listColumn);
  layout.appendChild(detailColumn);
  list.appendChild(layout);

  const answerBox = document.createElement('div');
  answerBox.className = 'answer-box';

  const answerTitle = document.createElement('strong');
  answerTitle.className = 'answer-title';
  answerTitle.textContent = 'Odpověď';

  const answerText = document.createElement('p');
  answerText.className = 'answer-text';
  answerText.textContent = getSimpleExplanation(top, topTechnical);

  answerBox.appendChild(answerTitle);
  answerBox.appendChild(answerText);

  if (top.validityPercent < 50) {
    const nextStep = document.createElement('p');
    nextStep.className = 'result-summary';
    nextStep.textContent = 'Nízká pravděpodobnost, ověřte výsledek ručně.';
    answerBox.appendChild(nextStep);
  }
  listColumn.appendChild(answerBox);

  if (mode === 'simple') {
    const topKey = `${top.label}|${normalizeResultUrl(top.url)}`;
    if (simpleModeDetailsKey !== topKey) {
      simpleModeDetailsKey = topKey;
      simpleModeDetailsOpen = false;
    }
  }

  if (!selectedResultDetailKey || !detailModelMap.has(selectedResultDetailKey)) {
    selectedResultDetailKey = topEntry.detailModel.key;
  }

  const selectDetail = (entry) => {
    const key = getResultDetailKey(entry.item);
    selectedResultDetailKey = key;
    const selectedDetail = detailModelMap.get(key) || null;
    renderResultDetailPanel(selectedDetail, detailColumn, {
      showTechnical: mode === 'forensic'
    });
    renderResults(lastResults);
  };

  const topRow = createResultRow(top, topTechnical, {
    detailModel: topEntry.detailModel,
    summaryText: 'Nejrelevantnejsi nalez',
    showTechnical: mode === 'forensic' ? forensicDetailsOpen : false,
    hideActions: mode === 'simple',
    featured: true,
    showSourceSummary: true,
    onSelect: () => selectDetail({ item: top, technical: topTechnical }),
    selected: selectedResultDetailKey === topEntry.detailModel.key
  });
  listColumn.appendChild(topRow);

  if (mode === 'forensic') {
    const forensicToggle = document.createElement('button');
    forensicToggle.type = 'button';
    forensicToggle.className = 'forensic-toggle';
    forensicToggle.textContent = forensicDetailsOpen
      ? 'Skryt technicke detaily'
      : 'Zobrazit technicke detaily';
    forensicToggle.addEventListener('click', () => {
      forensicDetailsOpen = !forensicDetailsOpen;
      renderResults(lastResults);
    });
    listColumn.appendChild(forensicToggle);
  }

  const grouped = {
    top: [],
    suspicious: [],
    normal: []
  };

  filteredEntries.slice(1).forEach((entry) => {
    if (entry.item.validityPercent > 80) {
      grouped.top.push(entry);
      return;
    }

    if (isResultSuspicious(entry.item, entry.technical)) {
      grouped.suspicious.push(entry);
      return;
    }

    grouped.normal.push(entry);
  });

  const hideActions = mode === 'simple';
  const showTechnical = mode === 'forensic' ? forensicDetailsOpen : false;

  listColumn.appendChild(
    createResultGroupSection('Top', 'result-group-top', grouped.top, {
      showTechnical,
      hideActions,
      onSelect: selectDetail,
      selectedKey: selectedResultDetailKey
    })
  );
  listColumn.appendChild(
    createResultGroupSection('Suspicious', 'result-group-suspicious', grouped.suspicious, {
      showTechnical,
      hideActions,
      onSelect: selectDetail,
      selectedKey: selectedResultDetailKey
    })
  );
  listColumn.appendChild(
    createResultGroupSection('Normal', 'result-group-normal', grouped.normal, {
      showTechnical,
      hideActions,
      onSelect: selectDetail,
      selectedKey: selectedResultDetailKey
    })
  );

  renderResultDetailPanel(
    detailModelMap.get(selectedResultDetailKey) || topEntry.detailModel,
    detailColumn,
    { showTechnical: mode === 'forensic' }
  );
}

function ensureResultsVisibleFallback(links) {
  const card = document.getElementById('results-card');
  const list = document.getElementById('results-list');
  if (!card || !list) return;

  const hasResultRows = !!list.querySelector('.result-row');
  const hasQuickItems = !!list.querySelector('.result-quick-list li');
  const hasAnswerBox = !!list.querySelector('.answer-box');
  const hasLinks = !!list.querySelector('a[href]');
  const plainText = normalizeWhitespace(list.textContent);
  const hasRenderableContent =
    hasResultRows || hasQuickItems || hasAnswerBox || hasLinks || plainText.length > 24;
  if (hasRenderableContent) return;

  const prepared = getPreparedResults(links);
  if (!prepared.length) return;

  card.style.display = 'block';
  const box = createStatusBox({
    title: 'Nahradni vypis vysledku',
    text: `Zobrazuji ${prepared.length} overenych odkazu v jednoduchem seznamu.`,
    links: prepared,
    listClassName: 'result-quick-list',
    listLimit: 20
  });
  list.appendChild(box);
}

function getPersonData() {
  return {
    name: normalizeWhitespace(getInputValue('name')),
    nick: normalizeWhitespace(getInputValue('nick')),
    city: normalizeWhitespace(getInputValue('city')),
    phone: normalizePhone(getInputValue('phone')),
    date: new Date().toISOString(),
    links: getActiveLinks()
  };
}

function readPersons() {
  return JSON.parse(localStorage.getItem(STORAGE_KEYS.persons) || '[]');
}

function writePersons(persons) {
  localStorage.setItem(STORAGE_KEYS.persons, JSON.stringify(persons));
}

function savePerson() {
  const data = getPersonData();
  if (!data.name && !data.nick && !data.city && !data.phone) {
    showAlert('Vyplnte alespon jeden udaj pro ulozeni osoby!');
    return;
  }

  const persons = readPersons();
  persons.push(data);
  writePersons(persons);
  showAlert('Osoba ulozena!');
  renderPersons();
}

function renderPersons() {
  const persons = readPersons();
  const list = document.getElementById('persons-list');
  const card = document.getElementById('persons-card');

  if (!list || !card) return;

  if (!persons.length) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  list.textContent = '';

  persons.forEach((person, index) => {
    const row = document.createElement('div');
    row.className = 'person-row';

    const text = document.createElement('span');
    text.textContent = [
      person.name || '',
      person.nick ? `(${person.nick})` : '',
      person.city ? `, ${person.city}` : '',
      person.phone ? `, ${person.phone}` : ''
    ]
      .join(' ')
      .replace(/\s+,/g, ',')
      .trim();

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.textContent = 'Export';
    exportBtn.addEventListener('click', () => exportPerson(index));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Smazat';
    deleteBtn.addEventListener('click', () => deletePerson(index));

    row.appendChild(text);
    row.appendChild(exportBtn);
    row.appendChild(deleteBtn);
    list.appendChild(row);
  });
}

function exportPerson(idx) {
  const persons = readPersons();
  if (!persons[idx]) return;

  const person = persons[idx];
  let content = `Jmeno: ${person.name}\nNick: ${person.nick}\nMesto: ${person.city}\nTelefon: ${person.phone}\nUlozeno: ${person.date}`;

  if (person.links && person.links.length) {
    content += '\n\nVyhledavaci odkazy:';
    person.links.forEach((link) => {
      content += `\n- ${link[0]}: ${link[1]}`;
    });
  }

  downloadText(content, `osoba-${person.name || person.nick || 'profil'}.txt`, 'text/plain');
}

function deletePerson(idx) {
  const persons = readPersons();
  persons.splice(idx, 1);
  writePersons(persons);
  renderPersons();
}

function triggerBrowserDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }, 100);
}

async function saveBlobToPreferredFolder(filename, blob) {
  if (!exportDirectoryHandle) return false;

  try {
    const fileHandle = await exportDirectoryHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch {
    showAlert('Ulozeni do slozky selhalo. Pouziji standardni stahovani.');
    return false;
  }
}

function setExportFolderLabel(text) {
  const label = document.getElementById('export-folder-label');
  if (!label) return;

  label.textContent = text;
}

async function pickExportFolder() {
  if (!window.showDirectoryPicker) {
    showAlert('Vyber slozky neni v tomto prohlizeci podporovan.');
    return;
  }

  try {
    exportDirectoryHandle = await window.showDirectoryPicker();
    setExportFolderLabel(`Slozka: ${exportDirectoryHandle.name}`);
    showAlert('Slozka pro export vybrana.');
  } catch {
    showAlert('Vyber slozky byl zrusen.');
  }
}

async function downloadText(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const saved = await saveBlobToPreferredFolder(filename, blob);
  if (!saved) {
    triggerBrowserDownload(blob, filename);
  }
}

function exportLinks(type) {
  const links = getActiveLinks();
  if (!links.length) {
    showAlert('Neni co exportovat!');
    return;
  }

  let content = '';
  const filename = `osint-odkazy.${type}`;

  if (type === 'csv') {
    content = 'Zdroj,Odkaz\n' + links.map((link) => `"${link[0]}","${link[1]}"`).join('\n');
    downloadText(content, filename, 'text/csv');
    return;
  }

  content = links.map((link) => `${link[0]}: ${link[1]}`).join('\n');
  downloadText(content, filename, 'text/plain');
}

function showAlert(msg) {
  const alert = document.getElementById('alert');
  if (!alert) return;

  alert.textContent = msg;
  alert.style.display = 'block';
  alert.style.opacity = 1;

  setTimeout(() => {
    alert.style.opacity = 0;
    setTimeout(() => {
      alert.style.display = 'none';
    }, 400);
  }, 2500);
}

function hideAlert() {
  const alert = document.getElementById('alert');
  if (!alert) return;
  alert.style.opacity = 0;
  alert.style.display = 'none';
  alert.textContent = '';
}

function resolveLoadingStageText(stageKeyOrText) {
  const key = String(stageKeyOrText || '').trim();
  if (LOADING_STAGE_LABELS[key]) {
    return LOADING_STAGE_LABELS[key];
  }
  return key || LOADING_STAGE_LABELS.sources;
}

function startLoading(stageKeyOrText = 'sources') {
  loadingRunId += 1;
  const panel = document.getElementById('loading-status');
  const stage = document.getElementById('loading-stage');
  if (!panel || !stage) return loadingRunId;

  stage.textContent = resolveLoadingStageText(stageKeyOrText);
  panel.style.display = 'inline-flex';
  panel.setAttribute('aria-hidden', 'false');
  return loadingRunId;
}

function setLoadingStage(runId, stageKeyOrText) {
  if (runId !== loadingRunId) return;
  const panel = document.getElementById('loading-status');
  const stage = document.getElementById('loading-stage');
  if (!panel || !stage) return;

  stage.textContent = resolveLoadingStageText(stageKeyOrText);
  panel.style.display = 'inline-flex';
  panel.setAttribute('aria-hidden', 'false');
}

function stopLoading(runId, force = false) {
  if (!force && runId !== loadingRunId) return;
  const panel = document.getElementById('loading-status');
  const stage = document.getElementById('loading-stage');
  if (!panel || !stage) return;

  panel.style.display = 'none';
  panel.setAttribute('aria-hidden', 'true');
  stage.textContent = LOADING_STAGE_LABELS.sources;
}

function openSearch(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function searchById(sourceId) {
  const encodedQuery = getEncodedQuery();
  if (!encodedQuery) {
    showAlert('Vyplnte alespon jedno pole pro vyhledavani!');
    return;
  }

  const source = SOURCE_DEFS.find((item) => item.id === sourceId);
  if (!source) return;

  openSearch(source.buildUrl(encodedQuery));
}

function searchGoogle() {
  searchById('src_google');
}
function searchReddit() {
  searchById('src_reddit');
}
function searchX() {
  searchById('src_x');
}
function searchWeb() {
  searchById('src_web');
}
function searchImages() {
  searchById('src_images');
}
function searchLinkedIn() {
  searchById('src_linkedin');
}
function searchFacebook() {
  searchById('src_facebook');
}
function searchInstagram() {
  searchById('src_instagram');
}
function searchGitHub() {
  searchById('src_github');
}
function searchYouTube() {
  searchById('src_youtube');
}
function searchTikTok() {
  searchById('src_tiktok');
}
function searchSeznam() {
  searchById('src_seznam');
}
function searchBing() {
  searchById('src_bing');
}
function searchDuckDuckGo() {
  searchById('src_duckduckgo');
}
function searchTelegram() {
  searchById('src_telegram');
}
function searchQuora() {
  searchById('src_quora');
}
function searchStackOverflow() {
  searchById('src_stackoverflow');
}
function searchGitLab() {
  searchById('src_gitlab');
}
function searchStartpage() {
  searchById('src_startpage');
}
function searchQwant() {
  searchById('src_qwant');
}
function searchVK() {
  searchById('src_vk');
}
function searchYandex() {
  searchById('src_yandex');
}
function searchYahoo() {
  searchById('src_yahoo');
}
function searchVimeo() {
  searchById('src_vimeo');
}
function searchInterpol() {
  searchById('src_interpol');
}
function searchEuropol() {
  searchById('src_europol');
}
function searchFbiWanted() {
  searchById('src_fbi_wanted');
}
function searchEuMostWanted() {
  searchById('src_eu_most_wanted');
}
function searchDeaFugitives() {
  searchById('src_dea');
}
function searchUsMarshals() {
  searchById('src_usmarshals');
}
function searchNcaUk() {
  searchById('src_nca_uk');
}
function searchOfacSanctions() {
  searchById('src_ofac');
}
function searchEuSanctions() {
  searchById('src_eu_sanctions');
}
function searchUnSanctions() {
  searchById('src_un_sanctions');
}

async function searchAll() {
  const query = getQuery();
  if (!query) {
    clearRefinementState();
    window.originalResults = [];
    window.currentResults = [];
    showAlert('Vyplnte alespon jedno pole pro vyhledavani!');
    renderResults([]);
    return;
  }

  const loadingId = startLoading('sources');

  try {
    let noticeMessage = '';
    let selectedSources = getSelectedSources();
    METHODOLOGY_LOG = [];
    syncMethodologyLog();
    if (!selectedSources.length) {
      setSourceSelection(SOURCE_DEFS.map((source) => source.id));
      selectedSources = getSelectedSources();
      noticeMessage =
        'Nebyly aktivni zadne zdroje, automaticky jsem obnovil vychozi zdrojovou sadu.';
    }
    let links = getActiveLinks();

    if (selectedSources.length && selectedSources.every((source) => isOfficialSource(source))) {
      const expanded = new Set(selectedSources.map((source) => source.id));
      INTERNET_CORE_SOURCE_IDS.forEach((sourceId) => expanded.add(sourceId));
      setSourceSelection(Array.from(expanded));
      links = getActiveLinks();
      noticeMessage =
        'Byly aktivni pouze oficialni registry, automaticky jsem pridal internetove zdroje.';
    }

    if (!links.length) {
      clearRefinementState();
      window.originalResults = [];
      window.currentResults = [];
      METHODOLOGY_LOG = [];
      syncMethodologyLog();
      const selectedCount = getSelectedSources().length;
      const skippedOfficial = getSkippedOfficialSourceLabels();

      if (!selectedCount) {
        showAlert('Vyberte alespon jeden zdroj!');
      } else if (skippedOfficial.length === selectedCount) {
        showAlert(
          'Vybrane jsou pouze oficialni registry a dotaz je prilis obecny. Pro jejich zapnuti doplnte cele jmeno+prijmeni, delsi nick (4+), nebo telefon (7+ cisel).'
        );
      } else {
        showAlert(
          'Z aktivnich zdroju se nepodarilo vygenerovat odkazy. Zkuste upravit dotaz nebo vyber zdroju.'
        );
      }

      renderResults([]);
      return;
    }

    setLoadingStage(loadingId, 'analyze');

    if (selectedSources.length === 1) {
      noticeMessage = `Pozor: aktivni je pouze 1 zdroj (${selectedSources[0].label}). Pro sirsi OSINT zapnete dalsi zdroje nebo kliknete na Obnovit zdroje.`;
    }

    if (getRealMatchOnlyEnabled()) {
      try {
        const verification = await verifyLinksForRealMatches(links);
        const verifiedLinks = Array.isArray(verification && verification.links)
          ? verification.links
          : [];
        const checkedCount = Number(verification && verification.checkedCount) || 0;
        const resultCount = Number(verification && verification.resultCount) || 0;

        if (!verifiedLinks.length) {
          writeAuditEntry('search_all_verified_none', {
            query,
            resultCount: 0,
            selectedSourceCount: selectedSources.length
          });
          const verificationInfo =
            checkedCount > 0
              ? `Overeni realnych shod: overeno ${checkedCount} odkazu, potvrzeno ${resultCount}.`
              : 'Overeni realnych shod: nebyla data k overeni.';
          noticeMessage = noticeMessage
            ? `${noticeMessage} ${verificationInfo} Ponechavam bezne vysledky.`
            : `${verificationInfo} Ponechavam bezne vysledky.`;
        } else {
          links = verifiedLinks;
          const verificationInfo =
            checkedCount > 0
              ? `Overeni realnych shod: overeno ${checkedCount} odkazu, potvrzeno ${resultCount}.`
              : `Overeni realnych shod: potvrzeno ${resultCount}.`;
          noticeMessage = noticeMessage
            ? `${noticeMessage} ${verificationInfo} Zobrazuji jen realne overene zminky.`
            : `${verificationInfo} Zobrazuji jen realne overene zminky.`;
        }
      } catch (error) {
        const message = String((error && error.message) || '').toLowerCase();
        if (message.includes('vyprselo') || message.includes('aborted')) {
          noticeMessage = noticeMessage
            ? `${noticeMessage} Overeni realnych shod trvalo prilis dlouho, pokracuji bez overeni.`
            : 'Overeni realnych shod trvalo prilis dlouho, pokracuji bez overeni.';
        } else if (
          message.includes('failed to fetch') ||
          message.includes('networkerror') ||
          message.includes('err_connection_refused')
        ) {
          noticeMessage = noticeMessage
            ? `${noticeMessage} Overeni realnych shod neni dostupne (backend), pokracuji bez overeni.`
            : 'Overeni realnych shod neni dostupne (backend), pokracuji bez overeni.';
        } else {
          noticeMessage = noticeMessage
            ? `${noticeMessage} Verifikace realnych shod selhala, pokracuji bez overeni.`
            : `Verifikace realnych shod selhala, pokracuji bez overeni (${error instanceof Error ? error.message : 'neznamy problem'}).`;
        }
      }
    }

    setLoadingStage(loadingId, 'evaluate');

    selectedSources.forEach((source) => {
      const sourceLinks = links.filter((link) => {
        if (Array.isArray(link)) {
          return normalizeWhitespace(link[0]) === source.label;
        }

        if (link && typeof link === 'object') {
          const label = normalizeWhitespace(link.label || link.source || link.title || '');
          return label === source.label;
        }

        return false;
      });

      if (sourceLinks.length > 0) {
        logMethodologyStep(source.id, source.label, query, sourceLinks.length);
      }
    });

    clearRefinementState();
    window.originalResults = links;
    window.currentResults = links;
    lastResults = links;
    lastResultsSearchAt = new Date().toISOString();
    try {
      renderResults(lastResults);
    } catch (error) {
      console.error('Render results failed, switching to fallback list:', error);
    }
    ensureResultsVisibleFallback(lastResults);
    switchTab('results');
    window.scrollTo(0, 0);
    saveUiState();
    const skippedOfficial = getSkippedOfficialSourceLabels();
    writeAuditEntry('search_all', {
      query,
      resultCount: getPreparedResults(lastResults).length,
      skippedOfficialSources: skippedOfficial,
      resultSnapshot: buildSearchResultSnapshot(lastResults)
    });

    if (skippedOfficial.length) {
      const base = `Vygenerovano odkazu: ${getPreparedResults(lastResults).length}. Oficialni registry preskoceny (prilis obecny dotaz): ${skippedOfficial.join(', ')}. Pro zapnuti doplnte cele jmeno+prijmeni, delsi nick (4+), nebo telefon (7+ cisel).`;
      showAlert(noticeMessage ? `${noticeMessage} ${base}` : base);
      return;
    }

    const done = `Vygenerovano odkazu: ${getPreparedResults(lastResults).length}`;
    showAlert(noticeMessage ? `${noticeMessage} ${done}` : done);
  } finally {
    stopLoading(loadingId);
  }
}

function openAllResults() {
  if (!lastResults.length) {
    showAlert('Nejprve vygenerujte vysledky.');
    return;
  }

  getPreparedResults(lastResults).forEach((item) => openSearch(item.url));
}

function copyAllResults() {
  if (!lastResults.length) {
    showAlert('Nejprve vygenerujte vysledky.');
    return;
  }

  const text = getPreparedResults(lastResults)
    .map((item) => `${item.label}: ${item.url} (Validita ${item.validityPercent}%)`)
    .join('\n');
  copyText(text, 'Vsechny odkazy zkopirovany.');
}

function copyText(text, successMessage) {
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    showAlert('Clipboard API neni dostupne.');
    return;
  }

  navigator.clipboard
    .writeText(text)
    .then(() => showAlert(successMessage))
    .catch(() => showAlert('Kopirovani se nezdarilo.'));
}

function clearInputs() {
  clearRefinementState();
  window.originalResults = [];
  window.currentResults = [];
  setInputValue('main-query', '');
  setInputValue('name', '');
  setInputValue('nick', '');
  setInputValue('city', '');
  setInputValue('phone', '');
  setInputValue('photo-url', '');
  lastResults = [];
  renderResults([]);

  const photoFile = document.getElementById('photo-file');
  if (photoFile) {
    photoFile.value = '';
  }
  updateAnalyzeButtonsState();
  renderPhotoPreview(null);
  lastPhotoAnalysis = null;
  renderPhotoAnalysis(null);
  lastPhotoDashboard = null;
  renderPhotoDashboard(null);

  saveUiState();
}

function startNewSearch() {
  // Reset pouze aktivniho hledani a vysledku. Pripad, historie a dalsi pracovni data zustavaji.
  clearRefinementState();
  window.originalResults = [];
  window.currentResults = [];
  const inputIds = ['main-query', 'name', 'nick', 'city', 'phone', 'photo-url'];

  inputIds.forEach((id) => setInputValue(id, ''));

  const fileInputs = ['photo-file'];
  fileInputs.forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });

  const minConfidence = document.getElementById('results-min-confidence');
  if (minConfidence) minConfidence.value = '0';
  const onlyManipulated = document.getElementById('results-only-manipulated');
  if (onlyManipulated) onlyManipulated.checked = false;
  const onlyTrusted = document.getElementById('results-only-trusted');
  if (onlyTrusted) onlyTrusted.checked = false;
  const realMatchOnly = document.getElementById('real-match-only');
  if (realMatchOnly) realMatchOnly.checked = false;

  setSourceSelection(SOURCE_DEFS.map((source) => source.id));
  const sourceFilter = document.getElementById('source-filter');
  if (sourceFilter) sourceFilter.value = '';

  selectedEntityId = '';
  simpleModeDetailsOpen = false;
  simpleModeDetailsKey = '';
  selectedResultDetailKey = '';
  photoSensitiveDetailsOpen = false;
  forensicDetailsOpen = false;
  lastResultsSearchAt = '';

  lastResults = [];
  lastPhotoAnalysis = null;
  lastPhotoDashboard = null;

  updateAnalyzeButtonsState();
  renderPhotoPreview(null);
  renderPhotoAnalysis(null);
  renderPhotoDashboard(null);
  renderResults([]);
  updateTopVerdictBanner(NaN, '⚪ Výsledek: ČEKÁ NA ANALÝZU');
  stopLoading(loadingRunId, true);
  hideAlert();
  switchTab('search');

  saveUiState();
  showAlert('Vyhledavani bylo resetovano. Pripad a historie zustaly zachovany.');
}

function wirePhotoDashboardControls() {
  const controls = [
    document.getElementById('photo-domain-filter'),
    document.getElementById('photo-min-score'),
    document.getElementById('photo-sort-mode')
  ];

  controls.forEach((control) => {
    if (!control) return;
    control.addEventListener('change', () => {
      if (lastPhotoDashboard) {
        renderPhotoDashboard(lastPhotoDashboard);
      }
    });
    if (control.id === 'photo-min-score') {
      control.addEventListener('input', () => {
        if (lastPhotoDashboard) {
          renderPhotoDashboard(lastPhotoDashboard);
        }
      });
    }
  });

  const exportJsonBtn = document.getElementById('photo-export-json-btn');
  const exportCsvBtn = document.getElementById('photo-export-csv-btn');

  if (exportJsonBtn) {
    exportJsonBtn.addEventListener('click', () => exportPhotoDashboard('json'));
  }

  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', () => exportPhotoDashboard('csv'));
  }
}

function wireSearchHistoryControls() {
  const filter = document.getElementById('search-history-filter');
  const textFilter = document.getElementById('search-history-text-filter');
  const leftSelect = document.getElementById('search-history-left');
  const rightSelect = document.getElementById('search-history-right');
  const compareBtn = document.getElementById('search-history-compare-btn');
  const exportJsonBtn = document.getElementById('history-export-json-btn');
  const exportCsvBtn = document.getElementById('history-export-csv-btn');

  if (filter) {
    filter.addEventListener('change', renderSearchHistory);
  }

  if (textFilter) {
    textFilter.addEventListener('input', renderSearchHistory);
  }

  if (leftSelect) {
    leftSelect.addEventListener('change', renderSearchHistory);
  }

  if (rightSelect) {
    rightSelect.addEventListener('change', renderSearchHistory);
  }

  if (compareBtn) {
    compareBtn.addEventListener('click', renderSearchHistory);
  }

  if (exportJsonBtn) {
    exportJsonBtn.addEventListener('click', () => exportSearchHistory('json'));
  }

  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', () => exportSearchHistory('csv'));
  }

  renderSearchHistory();
}

function collectUiState() {
  const inputs = {
    mainQuery: getInputValue('main-query'),
    name: getInputValue('name'),
    nick: getInputValue('nick'),
    city: getInputValue('city'),
    phone: getInputValue('phone'),
    photoUrl: getInputValue('photo-url'),
    photoEndpoint: getInputValue('photo-endpoint'),
    caseId: getInputValue('case-id'),
    caseTitle: getInputValue('case-title'),
    caseReason: getInputValue('case-reason'),
    caseOperator: getInputValue('case-operator'),
    finalSummary: getInputValue('final-summary'),
    finalRiskNotes: getInputValue('final-risk-notes'),
    finalCasesNotes: getInputValue('final-cases-notes'),
    finalConnectionsNotes: getInputValue('final-connections-notes'),
    finalNextSteps: getInputValue('final-next-steps'),
    resultsMode: getResultsMode(),
    realMatchOnly: getRealMatchOnlyEnabled(),
    workflowPreset: getWorkflowPreset(),
    resultsMinConfidence: String(
      (document.getElementById('results-min-confidence') || {}).value || '0'
    ),
    resultsOnlyManipulated: !!(document.getElementById('results-only-manipulated') || {}).checked,
    resultsOnlyTrusted: !!(document.getElementById('results-only-trusted') || {}).checked
  };

  const sources = {};
  SOURCE_DEFS.forEach((source) => {
    const checkbox = document.getElementById(source.id);
    sources[source.id] = !!(checkbox && checkbox.checked);
  });

  return { inputs, sources };
}

function saveUiState() {
  localStorage.setItem(STORAGE_KEYS.uiState, JSON.stringify(collectUiState()));
}

function loadUiState() {
  const state = JSON.parse(localStorage.getItem(STORAGE_KEYS.uiState) || '{}');
  if (!state || typeof state !== 'object') return;

  if (state.inputs) {
    setInputValue('main-query', state.inputs.mainQuery || '');
    setInputValue('name', state.inputs.name || '');
    setInputValue('nick', state.inputs.nick || '');
    setInputValue('city', state.inputs.city || '');
    setInputValue('phone', state.inputs.phone || '');
    setInputValue('photo-url', state.inputs.photoUrl || '');
    setInputValue('photo-endpoint', state.inputs.photoEndpoint || '');
    setInputValue('case-id', state.inputs.caseId || '');
    setInputValue('case-title', state.inputs.caseTitle || '');
    setInputValue('case-reason', state.inputs.caseReason || '');
    setInputValue('case-operator', state.inputs.caseOperator || '');
    setInputValue('final-summary', state.inputs.finalSummary || '');
    setInputValue('final-risk-notes', state.inputs.finalRiskNotes || '');
    setInputValue('final-cases-notes', state.inputs.finalCasesNotes || '');
    setInputValue('final-connections-notes', state.inputs.finalConnectionsNotes || '');
    setInputValue('final-next-steps', state.inputs.finalNextSteps || '');
    setResultsMode(state.inputs.resultsMode || 'simple');
    currentCaseId = normalizeWhitespace(state.inputs.caseId || '') || currentCaseId;
    updateCaseDisplay();

    const realMatchOnly = document.getElementById('real-match-only');
    if (realMatchOnly) {
      realMatchOnly.checked = state.inputs.realMatchOnly === true;
    }

    setWorkflowPreset(state.inputs.workflowPreset || 'person');

    const minConfidence = document.getElementById('results-min-confidence');
    if (minConfidence && state.inputs.resultsMinConfidence !== undefined) {
      minConfidence.value = String(state.inputs.resultsMinConfidence || '0');
    }

    const onlyManipulated = document.getElementById('results-only-manipulated');
    if (onlyManipulated) {
      onlyManipulated.checked = state.inputs.resultsOnlyManipulated === true;
    }

    const onlyTrusted = document.getElementById('results-only-trusted');
    if (onlyTrusted) {
      onlyTrusted.checked = state.inputs.resultsOnlyTrusted === true;
    }
  }

  updateResultsFilterUi();
  updateResultsModeUi();
  applyWorkflowPreset();

  if (state.sources) {
    SOURCE_DEFS.forEach((source) => {
      const checkbox = document.getElementById(source.id);
      if (checkbox && Object.prototype.hasOwnProperty.call(state.sources, source.id)) {
        checkbox.checked = !!state.sources[source.id];
      }
    });
  }
}

function setSourceGroupState(groupName, shouldCheck) {
  const group = document.querySelector(`.source-group[data-group="${groupName}"]`);
  if (!group) return;

  const checkboxes = group.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach((checkbox) => {
    checkbox.checked = shouldCheck;
  });

  saveUiState();
  updateActiveSourceCount();
}

function updateGroupCollapseButton(group) {
  if (!group) return;

  const button = group.querySelector('.group-collapse');
  if (!button) return;

  button.textContent = group.classList.contains('is-collapsed') ? 'Rozbalit' : 'Sbalit';
}

function setGroupCollapsed(groupName, collapsed) {
  const group = document.querySelector(`.source-group[data-group="${groupName}"]`);
  if (!group) return;

  group.classList.toggle('is-collapsed', !!collapsed);
  updateGroupCollapseButton(group);
}

function setAllGroupsCollapsed(collapsed) {
  const groups = document.querySelectorAll('.source-group');
  groups.forEach((group) => {
    group.classList.toggle('is-collapsed', !!collapsed);
    updateGroupCollapseButton(group);
  });
}

function wireSourceGroupToggles() {
  const buttons = document.querySelectorAll('.group-toggle');
  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      const group = button.dataset.group;
      const action = button.dataset.action;
      if (!group || !action) return;

      setSourceGroupState(group, action === 'all');
    });
  });
}

function wireSourceGroupCollapse() {
  const collapseButtons = document.querySelectorAll('.group-collapse');
  collapseButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const groupName = button.dataset.group;
      const group = document.querySelector(`.source-group[data-group="${groupName}"]`);
      if (!group) return;

      const nextCollapsed = !group.classList.contains('is-collapsed');
      setGroupCollapsed(groupName, nextCollapsed);
    });
  });

  const collapseAll = document.getElementById('collapse-all-sources');
  const expandAll = document.getElementById('expand-all-sources');

  if (collapseAll) {
    collapseAll.addEventListener('click', () => {
      setAllGroupsCollapsed(true);
    });
  }

  if (expandAll) {
    expandAll.addEventListener('click', () => {
      setAllGroupsCollapsed(false);
    });
  }
}

function applySourceFilter(query) {
  const needle = (query || '').toLowerCase().trim();
  const groups = document.querySelectorAll('.source-group');

  groups.forEach((group) => {
    const labels = group.querySelectorAll('.source-items label');
    let matches = 0;

    labels.forEach((label) => {
      const text = label.textContent.toLowerCase();
      const hit = !needle || text.includes(needle);
      label.classList.toggle('source-hidden', !hit);
      if (hit) matches += 1;
    });

    if (needle) {
      group.classList.toggle('source-hidden', matches === 0);
      if (matches > 0) {
        group.classList.remove('is-collapsed');
      }
      updateGroupCollapseButton(group);
    } else {
      group.classList.remove('source-hidden');
    }
  });
}

function wireSourceFilter() {
  const input = document.getElementById('source-filter');
  if (!input) return;

  input.addEventListener('input', () => {
    applySourceFilter(input.value);
  });
}

function getTileMonogram(label) {
  const cleaned = (label || '').replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
  if (!cleaned) return 'OS';

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }

  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

const TILE_BRAND_SLUGS = {
  google: 'google',
  reddit: 'reddit',
  'x twitter': 'x',
  linkedin: 'linkedin',
  facebook: 'facebook',
  instagram: 'instagram',
  github: 'github',
  youtube: 'youtube',
  tiktok: 'tiktok',
  seznam: 'seznam',
  bing: 'bing',
  duckduckgo: 'duckduckgo',
  telegram: 'telegram',
  quora: 'quora',
  'stack overflow': 'stackoverflow',
  gitlab: 'gitlab',
  startpage: 'startpage',
  qwant: 'qwant',
  vk: 'vk',
  yandex: 'yandex',
  yahoo: 'yahoo',
  vimeo: 'vimeo',
  interpol: 'interpol',
  europol: 'europol',
  'fbi wanted': 'fbi',
  dea: 'dea',
  'us marshals': 'usmarshals',
  'nca uk': 'nationalcrimeagency',
  'ofac sanctions': 'ofac',
  'eu sanctions': 'europeanunion',
  'un sanctions': 'unitednations',
  'eu most wanted': 'europeanunion'
};

const TILE_BRAND_DOMAINS = {
  bing: 'bing.com',
  linkedin: 'linkedin.com',
  seznam: 'seznam.cz',
  interpol: 'interpol.int',
  europol: 'europol.europa.eu',
  'fbi wanted': 'fbi.gov',
  dea: 'dea.gov',
  'us marshals': 'usmarshals.gov',
  'nca uk': 'nationalcrimeagency.gov.uk',
  'ofac sanctions': 'ofac.treasury.gov',
  yandex: 'yandex.com',
  yahoo: 'yahoo.com',
  'eu sanctions': 'sanctionsmap.eu',
  'un sanctions': 'un.org'
};

const TILE_PREFER_FAVICON = new Set([
  'bing',
  'linkedin',
  'seznam',
  'interpol',
  'europol',
  'fbi wanted',
  'dea',
  'us marshals',
  'nca uk',
  'ofac sanctions',
  'yandex',
  'yahoo',
  'eu sanctions',
  'un sanctions'
]);

function normalizeTileLabelKey(label) {
  return (label || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTileBrandSlug(label) {
  const key = normalizeTileLabelKey(label);

  return TILE_BRAND_SLUGS[key] || '';
}

function getTileBrandDomain(label) {
  const key = normalizeTileLabelKey(label);
  return TILE_BRAND_DOMAINS[key] || '';
}

function shouldPreferFavicon(label) {
  return TILE_PREFER_FAVICON.has(normalizeTileLabelKey(label));
}

function createFaviconIcon(domain, label) {
  if (!domain) return null;

  const img = document.createElement('img');
  img.className = 'brand-icon brand-favicon';
  img.alt = `${label} favicon`;
  img.width = 28;
  img.height = 28;
  img.loading = 'lazy';
  img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
  return img;
}

function createBrandIcon(slug, label) {
  if (!slug) return null;

  const img = document.createElement('img');
  img.className = 'brand-icon';
  img.alt = `${label} logo`;
  img.width = 28;
  img.height = 28;
  img.loading = 'lazy';
  img.src = `https://cdn.simpleicons.org/${slug}`;
  return img;
}

function createTileIcon(monogram) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.setAttribute('width', '28');
  svg.setAttribute('height', '28');
  svg.setAttribute('aria-hidden', 'true');

  const rect = document.createElementNS(ns, 'rect');
  rect.setAttribute('x', '1.5');
  rect.setAttribute('y', '1.5');
  rect.setAttribute('width', '33');
  rect.setAttribute('height', '33');
  rect.setAttribute('rx', '8');
  rect.setAttribute('fill', '#1f7a8c');

  const text = document.createElementNS(ns, 'text');
  text.setAttribute('x', '18');
  text.setAttribute('y', '22');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('font-size', '11');
  text.setAttribute('font-weight', '700');
  text.setAttribute('font-family', 'IBM Plex Sans, Segoe UI, sans-serif');
  text.setAttribute('fill', '#ffffff');
  text.textContent = monogram;

  svg.appendChild(rect);
  svg.appendChild(text);
  return svg;
}

function normalizeTileIcons() {
  const tiles = document.querySelectorAll('.tile');
  tiles.forEach((tile) => {
    const iconHost = tile.querySelector('.icon');
    if (!iconHost) return;

    const labelNode = tile.querySelector('span:last-child');
    const label = labelNode
      ? labelNode.textContent.trim()
      : (tile.getAttribute('aria-label') || '').trim();

    const monogram = getTileMonogram(label);
    const slug = getTileBrandSlug(label);
    const domain = getTileBrandDomain(label);
    const faviconIcon = createFaviconIcon(domain, label);
    const brandIcon = createBrandIcon(slug, label);
    const preferred =
      shouldPreferFavicon(label) && faviconIcon ? faviconIcon : brandIcon || faviconIcon;

    iconHost.textContent = '';
    if (preferred) {
      preferred.addEventListener('error', () => {
        iconHost.textContent = '';
        if (preferred !== brandIcon && brandIcon) {
          brandIcon.addEventListener('error', () => {
            iconHost.textContent = '';
            iconHost.appendChild(createTileIcon(monogram));
          });
          iconHost.appendChild(brandIcon);
          return;
        }

        if (preferred !== faviconIcon && faviconIcon) {
          faviconIcon.addEventListener('error', () => {
            iconHost.textContent = '';
            iconHost.appendChild(createTileIcon(monogram));
          });
          iconHost.appendChild(faviconIcon);
          return;
        }

        iconHost.appendChild(createTileIcon(monogram));
      });
      iconHost.appendChild(preferred);
      return;
    }

    iconHost.appendChild(createTileIcon(monogram));
  });
}

function wireAutoSave() {
  [
    'main-query',
    'name',
    'nick',
    'city',
    'phone',
    'photo-url',
    'photo-endpoint',
    'case-id',
    'case-title',
    'case-reason',
    'case-operator',
    'final-summary',
    'final-risk-notes',
    'final-cases-notes',
    'final-connections-notes',
    'final-next-steps'
  ].forEach((id) => {
    const input = document.getElementById(id);
    if (input) {
      input.addEventListener('input', () => {
        saveUiState();
        if (id.startsWith('case-')) {
          updateCaseBadge();
        }
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          searchAll();
        }
      });
    }
  });

  SOURCE_DEFS.forEach((source) => {
    const checkbox = document.getElementById(source.id);
    if (checkbox) {
      checkbox.addEventListener('change', () => {
        saveUiState();
        updateActiveSourceCount();
      });
    }
  });
}

function wireCaseEnhancements() {
  const timelineAddBtn = document.getElementById('timeline-add-btn');
  const evidenceAddBtn = document.getElementById('evidence-add-btn');
  const taskAddBtn = document.getElementById('task-add-btn');
  const assistantRefreshBtn = document.getElementById('assistant-refresh-btn');
  const importCaseBtn = document.getElementById('import-case-btn');
  const importCaseInput = document.getElementById('import-case-input');
  const caseInputs = ['case-id', 'case-title', 'case-reason', 'case-operator'];

  if (timelineAddBtn) {
    timelineAddBtn.addEventListener('click', addTimelineEventFromForm);
  }

  if (evidenceAddBtn) {
    evidenceAddBtn.addEventListener('click', addEvidenceFromFile);
  }

  if (taskAddBtn) {
    taskAddBtn.addEventListener('click', addTaskFromForm);
  }

  if (assistantRefreshBtn) {
    assistantRefreshBtn.addEventListener('click', renderAssistantRecommendations);
  }

  if (importCaseBtn && importCaseInput) {
    importCaseBtn.addEventListener('click', () => {
      importCaseInput.click();
    });

    importCaseInput.addEventListener('change', () => {
      const file = importCaseInput.files && importCaseInput.files[0];
      importCaseBundleFromFile(file);
      importCaseInput.value = '';
    });
  }

  caseInputs.forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('input', () => {
      updateCaseBadge();
    });
  });
}

function buildDataSnapshot() {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    persons: readPersons(),
    cases: readCases(),
    audit: readAuditEntries(),
    timeline: readTimeline(),
    evidence: readEvidence(),
    tasks: readTasks(),
    entities: readEntities(),
    relationships: readRelationships(),
    uiState: collectUiState(),
    theme: localStorage.getItem(STORAGE_KEYS.theme) || 'light',
    density: localStorage.getItem(STORAGE_KEYS.density) || 'comfort',
    simpleUi: localStorage.getItem(STORAGE_KEYS.simpleUi) || 'off',
    templates: readCustomTemplates()
  };
}

function exportDataJson() {
  const snapshot = buildDataSnapshot();
  const content = JSON.stringify(snapshot, null, 2);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadText(content, `osint-data-${stamp}.json`, 'application/json');
  showAlert('Globalni JSON export byl dokoncen.');
}

function applyImportedData(data) {
  if (!data || typeof data !== 'object') {
    showAlert('Globalni JSON import selhal: neplatny format.');
    return;
  }

  if (Array.isArray(data.persons)) {
    localStorage.setItem(STORAGE_KEYS.persons, JSON.stringify(data.persons));
  }

  if (Array.isArray(data.cases)) {
    localStorage.setItem(STORAGE_KEYS.cases, JSON.stringify(data.cases));
  }

  if (Array.isArray(data.audit)) {
    localStorage.setItem(STORAGE_KEYS.audit, JSON.stringify(data.audit));
  }

  if (Array.isArray(data.timeline)) {
    localStorage.setItem(STORAGE_KEYS.timeline, JSON.stringify(data.timeline));
  }

  if (Array.isArray(data.evidence)) {
    localStorage.setItem(STORAGE_KEYS.evidence, JSON.stringify(data.evidence));
  }

  if (Array.isArray(data.tasks)) {
    localStorage.setItem(STORAGE_KEYS.tasks, JSON.stringify(data.tasks));
  }

  if (Array.isArray(data.entities)) {
    localStorage.setItem(STORAGE_KEYS.entities, JSON.stringify(data.entities));
  }

  if (Array.isArray(data.relationships)) {
    localStorage.setItem(STORAGE_KEYS.relationships, JSON.stringify(data.relationships));
  }

  if (data.uiState && typeof data.uiState === 'object') {
    localStorage.setItem(STORAGE_KEYS.uiState, JSON.stringify(data.uiState));
  }

  if (typeof data.theme === 'string') {
    localStorage.setItem(STORAGE_KEYS.theme, data.theme === 'dark' ? 'dark' : 'light');
  }

  if (typeof data.density === 'string') {
    localStorage.setItem(STORAGE_KEYS.density, data.density === 'compact' ? 'compact' : 'comfort');
  }

  if (typeof data.simpleUi === 'string') {
    localStorage.setItem(STORAGE_KEYS.simpleUi, data.simpleUi === 'on' ? 'on' : 'off');
  }

  if (Array.isArray(data.templates)) {
    localStorage.setItem(STORAGE_KEYS.templates, JSON.stringify(data.templates));
  }

  loadTheme();
  loadUiState();
  renderTemplateSelect();
  updateActiveSourceCount();
  updateCaseBadge();
  renderPersons();
  renderEntityWorkspace();
  lastResults = [];
  renderResults([]);
  showAlert('Globalni JSON import byl uspesne nacten.');
}

function importDataJsonFromFile(file) {
  if (!file) return;

  file
    .text()
    .then((raw) => {
      const parsed = JSON.parse(raw);
      applyImportedData(parsed);
    })
    .catch(() => {
      showAlert('Globalni JSON import selhal. Zkontrolujte soubor.');
    });
}

function wireDataTransferActions() {
  const exportBtn = document.getElementById('export-json-btn');
  const importBtn = document.getElementById('import-json-btn');
  const importInput = document.getElementById('import-json-input');
  const pickFolderBtn = document.getElementById('pick-export-folder-btn');

  if (exportBtn) {
    exportBtn.addEventListener('click', exportDataJson);
  }

  if (importBtn && importInput) {
    importBtn.addEventListener('click', () => {
      importInput.click();
    });

    importInput.addEventListener('change', () => {
      const file = importInput.files && importInput.files[0];
      importDataJsonFromFile(file);
      importInput.value = '';
    });
  }

  if (pickFolderBtn) {
    pickFolderBtn.addEventListener('click', () => {
      pickExportFolder();
    });
  }
}

function wireTemplateActions() {
  const applyBtn = document.getElementById('apply-template-btn');
  const saveBtn = document.getElementById('save-template-btn');
  const deleteBtn = document.getElementById('delete-template-btn');
  const select = document.getElementById('template-select');

  if (applyBtn) applyBtn.addEventListener('click', applySelectedTemplate);
  if (saveBtn) saveBtn.addEventListener('click', saveCurrentTemplate);
  if (deleteBtn) deleteBtn.addEventListener('click', deleteSelectedTemplate);
  if (select) {
    select.addEventListener('change', () => {
      renderTemplateSelect();
    });
  }
}

function wireResultsSortControl() {
  const select = document.getElementById('results-sort');
  const rawModeCheckbox = document.getElementById('results-raw-mode');
  const modeInputs = document.querySelectorAll('input[name="results-mode"]');
  const minConfidenceInput = document.getElementById('results-min-confidence');
  const onlyManipulatedInput = document.getElementById('results-only-manipulated');
  const onlyTrustedInput = document.getElementById('results-only-trusted');

  if (
    !select &&
    !rawModeCheckbox &&
    !modeInputs.length &&
    !minConfidenceInput &&
    !onlyManipulatedInput &&
    !onlyTrustedInput
  )
    return;

  updateResultsFilterUi();

  if (select) {
    select.addEventListener('change', () => {
      if (lastResults.length) {
        renderResults(lastResults);
      }
    });
  }

  if (rawModeCheckbox) {
    rawModeCheckbox.addEventListener('change', () => {
      if (lastResults.length) {
        renderResults(lastResults);
        return;
      }

      showAlert(
        rawModeCheckbox.checked
          ? 'Raw rezim aktivni: deduplikace vypnuta.'
          : 'Raw rezim vypnut: deduplikace aktivni.'
      );
    });
  }

  if (minConfidenceInput) {
    minConfidenceInput.addEventListener('input', () => {
      updateResultsFilterUi();
      if (lastResults.length) {
        renderResults(lastResults);
      }
      saveUiState();
    });
    minConfidenceInput.addEventListener('change', saveUiState);
  }

  if (onlyManipulatedInput) {
    onlyManipulatedInput.addEventListener('change', () => {
      if (lastResults.length) {
        renderResults(lastResults);
      }
      saveUiState();
    });
  }

  if (onlyTrustedInput) {
    onlyTrustedInput.addEventListener('change', () => {
      if (lastResults.length) {
        renderResults(lastResults);
      }
      saveUiState();
    });
  }

  if (modeInputs.length) {
    modeInputs.forEach((input) => {
      input.addEventListener('change', () => {
        simpleModeDetailsOpen = false;
        updateResultsModeUi();
        saveUiState();
        if (lastResults.length) {
          renderResults(lastResults);
        }
      });
    });
  }
}

function wirePrimaryActions() {
  const searchAllBtn = document.getElementById('search-all-btn');
  if (searchAllBtn) searchAllBtn.addEventListener('click', searchAll);

  const resetSourcesBtn = document.getElementById('reset-sources-btn');
  if (resetSourcesBtn) resetSourcesBtn.addEventListener('click', resetAllSources);

  const realMatchOnly = document.getElementById('real-match-only');
  if (realMatchOnly) {
    realMatchOnly.addEventListener('change', saveUiState);
  }

  const safeModeToggleBtn = document.getElementById('safe-mode-toggle-btn');
  if (safeModeToggleBtn) {
    safeModeToggleBtn.addEventListener('click', async () => {
      const checkbox = document.getElementById('safe-mode-toggle');
      const status = document.getElementById('safe-mode-toggle-status');
      if (!checkbox) return;

      safeModeToggleBtn.disabled = true;
      if (status) status.textContent = 'Ukladam...';

      try {
        const next = await setSafeModeFlag(checkbox.checked);
        SAFE_MODE = next;
        setSafeModeAlertVisibility(SAFE_MODE);
        renderSafeModeControls(SAFE_MODE, SAFE_MODE ? 'Aktivni' : 'Vypnuto');
        showAlert(SAFE_MODE ? 'Bezpecny rezim byl zapnut.' : 'Bezpecny rezim byl vypnut.');
      } catch (error) {
        checkbox.checked = SAFE_MODE;
        renderSafeModeControls(SAFE_MODE, 'Zmena selhala');
        showAlert(
          `Nepodarilo se zmenit bezpecny rezim: ${error instanceof Error ? error.message : 'neznamy problem'}`
        );
      } finally {
        safeModeToggleBtn.disabled = false;
      }
    });
  }

  const workflowPreset = document.getElementById('workflow-preset');
  if (workflowPreset) {
    workflowPreset.addEventListener('change', () => {
      applyWorkflowPreset();
      saveUiState();
    });
  }

  const clearInputsBtn = document.getElementById('clear-inputs-btn');
  if (clearInputsBtn) clearInputsBtn.addEventListener('click', clearInputs);

  const exportCsvBtn = document.getElementById('export-csv-btn');
  if (exportCsvBtn) exportCsvBtn.addEventListener('click', () => exportLinks('csv'));

  const exportTxtBtn = document.getElementById('export-txt-btn');
  if (exportTxtBtn) exportTxtBtn.addEventListener('click', () => exportLinks('txt'));

  const savePersonBtn = document.getElementById('save-person-btn');
  if (savePersonBtn) savePersonBtn.addEventListener('click', savePerson);

  const photoUrlSearchBtn = document.getElementById('photo-url-search-btn');
  if (photoUrlSearchBtn) photoUrlSearchBtn.addEventListener('click', searchByPhotoUrl);

  const photoApiSearchBtn = document.getElementById('photo-api-search-btn');
  if (photoApiSearchBtn) photoApiSearchBtn.addEventListener('click', searchByPhotoApi);

  const refineInput = document.getElementById('refine-text');
  if (refineInput) {
    refineInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      applyRefinement();
    });
  }

  const simpleAnalyzeBtn = document.getElementById('simple-analyze-btn');
  if (simpleAnalyzeBtn) {
    simpleAnalyzeBtn.addEventListener('click', async () => {
      if (simpleAnalyzeBtn.disabled) {
        showAlert('Nejprve nahrajte obrazek.');
        return;
      }
      setResultsMode('simple');
      updateResultsModeUi();
      saveUiState();
      await searchByPhotoApi();
      if (lastResults.length) {
        renderResults(lastResults);
      }
    });
  }

  const simpleDetailBtn = document.getElementById('simple-detail-btn');
  if (simpleDetailBtn) {
    simpleDetailBtn.addEventListener('click', () => {
      if (!lastResults.length) {
        showAlert('Nejprve spustte hledani.');
        return;
      }
      setResultsMode('simple');
      simpleModeDetailsOpen = !simpleModeDetailsOpen;
      renderResults(lastResults);
    });
  }

  const simpleExportPdfBtn = document.getElementById('simple-export-pdf-btn');
  if (simpleExportPdfBtn) {
    simpleExportPdfBtn.addEventListener('click', exportPdfReport);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeResultsModeValue,
    getVerdictMeta,
    getResultsFilters,
    updateResultsFilterUi,
    computeFakeScore,
    getAssistantOutput
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    loadTheme();
    loadUiState();
    switchTab('search');
    updateCaseDisplay();
    renderTemplateSelect();
    wireThemeToggle();
    wireTemplateActions();
    wireDataTransferActions();
    wireSourceGroupToggles();
    wireSourceGroupCollapse();
    wireSourceFilter();
    wireResultsSortControl();
    wireAutoSave();
    wirePhotoInputPreview();
    wirePhotoDashboardControls();
    wireSearchHistoryControls();
    wireEntityWorkspace();
    wireCaseEnhancements();
    wirePrimaryActions();
    applyDefaultPhotoEndpoint();
    ensureCaseExists();
    updateCaseDisplay();
    normalizeTileIcons();
    updateActiveSourceCount();
    updateCaseBadge();
    renderEntityWorkspace();
    renderPersons();
    updateTopVerdictBanner(NaN, '⚪ Výsledek: ČEKÁ NA ANALÝZU');
    initSafeModeAlert();
    updateRefinementControls();
  });
} else if (require.main === module) {
  const { runCli } = require('./cli');
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error || 'CLI failed'));
    process.exitCode = 1;
  });
}
