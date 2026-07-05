function toDimTuple(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d+)x(\d+)$/i);
  if (!match) return null;

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return null;
  }

  return { width, height };
}

function detectManipulation(item = {}) {
  const indicators = [];
  let score = 0;

  if (item && item.manipulation && Array.isArray(item.manipulation.reasons)) {
    item.manipulation.reasons.forEach((reason) => {
      const value = String(reason || '').trim();
      if (!value) return;
      indicators.push(value);
      score += 0.2;
    });
  }

  const dimensions = Array.isArray(item.dimensions) ? item.dimensions : [];
  const parsed = dimensions.map((dim) => toDimTuple(dim)).filter(Boolean);
  if (parsed.length > 1) {
    const ratios = parsed.map((entry) => entry.width / entry.height);
    const minRatio = Math.min(...ratios);
    const maxRatio = Math.max(...ratios);
    const ratioDelta = maxRatio - minRatio;

    if (ratioDelta >= 0.08) {
      indicators.push('aspect_ratio_change');
      score += 0.25;
    }

    const areas = parsed.map((entry) => entry.width * entry.height);
    const minArea = Math.min(...areas);
    const maxArea = Math.max(...areas);
    if (minArea > 0 && (maxArea / minArea) >= 1.3) {
      indicators.push('resolution_inconsistency');
      score += 0.2;
    }
  }

  const textRepeatScore = Number(item && item.textRepeatScore);
  if (Number.isFinite(textRepeatScore) && textRepeatScore > 0.8 && item && item.manipulated) {
    indicators.push('possible_cropping_partial_match');
    score += 0.15;
  }

  if (item && item.manipulated) {
    indicators.push('compression_artifacts_or_hash_mismatch');
    score += 0.2;
  }

  const confidence = Math.max(0, Math.min(1, Number(score.toFixed(4))));
  return {
    manipulated: indicators.length > 0 || Boolean(item && item.manipulated),
    indicators: Array.from(new Set(indicators)),
    confidence
  };
}

module.exports = {
  detectManipulation
};
