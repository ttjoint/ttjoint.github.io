'use strict';
/**
 * Normalisation and rule-based extraction for official profile candidates.
 *
 * Extracted from `scripts/extract_structured_candidates.js`, which had all of
 * this inline in a single 2000-character line where it could not be tested.
 * The LLM path is deliberately *not* here: this module is pure and synchronous,
 * so the sanitising rules that decide what reaches the corpus can be asserted in
 * a unit test without a model, a network, or a database.
 */

/** Fields whose values are arrays of objects with evidence. */
const ARRAY_FIELDS = ['currentPositions', 'career'];

/** Fields whose values are plain strings. */
const STRING_FIELDS = ['name', 'gender', 'birthDate', 'nativePlace', 'ethnicity', 'education', 'summary'];

/**
 * Canonicalise a scalar value for a field.
 *
 * Trailing suffixes are stripped because they are title-decoration, not data:
 * "1955年3月出生" -> "1955年3月", "江苏南京人" -> "江苏南京". Without this the
 * same person extracted twice yields two different birth-date strings and the
 * dedupe step downstream cannot tell they are the same fact.
 */
function canonicalise(field, value) {
  let t = String(value).trim();
  if (field === 'birthDate') t = t.replace(/\s*(生|出生)$/, '').replace(/\s+/g, '');
  if (field === 'nativePlace') t = t.replace(/\s*(人|籍)$/, '').replace(/\s+/g, '');
  if (field === 'name') t = t.replace(/\s+/g, '');
  return t;
}

/** Trim a value, mapping null/undefined to ''. */
function nonEmpty(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  return value;
}

/**
 * Drop empty strings and empty objects recursively so a stored candidate has no
 * placeholder noise. Arrays of objects lose entries that reduce to nothing.
 */
function normalise(candidate) {
  const out = {};
  for (const [key, value] of Object.entries(candidate || {})) {
    if (value == null) continue;

    if (typeof value === 'string') {
      const t = canonicalise(key, value);
      if (t) out[key] = t;
    } else if (Array.isArray(value)) {
      const rows = value
        .filter((x) => x && typeof x === 'object')
        .map((x) => Object.fromEntries(
          Object.entries(x)
            .map(([k, v]) => [k, nonEmpty(v)])
            .filter(([, v]) => v !== ''),
        ))
        .filter((x) => Object.keys(x).length);
      if (rows.length) out[key] = rows;
    } else if (typeof value === 'number' || typeof value === 'object') {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Validate an LLM response before normalising it.
 *
 * The model is asked for a specific shape; when it drifts we throw a message
 * that names the field, because "invalid JSON" sends people debugging the wrong
 * layer.
 */
function requireStructured(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('LM Studio returned non-object JSON');
  }
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) {
    throw new Error('LM Studio JSON missing name');
  }
  for (const key of ARRAY_FIELDS) {
    if (candidate[key] !== undefined && !Array.isArray(candidate[key])) {
      throw new Error(`${key} must be array`);
    }
  }
  return normalise(candidate);
}

/**
 * Rule-based extraction, used as a floor when the LLM is unavailable or fails.
 *
 * @param {string} name
 * @param {string} text  cleaned page text
 * @param {string} url   source URL, stored as provenance
 */
function extractByRules(name, text, url) {
  const pick = (re) => {
    const m = String(text || '').match(re);
    return m ? m[1].trim() : '';
  };
  return normalise({
    name,
    birthDate: pick(/(\d{4}年\d{1,2}月)出生/),
    nativePlace: pick(/籍贯[：:]?([^，。；\n]{2,30})/),
    positions: [],
    sourceUrl: url,
  });
}

/** Matches "2023年5月逝世/去世/病逝" in a page body. */
const DEATH_RE = /(\d{4})年(\d{1,2})月[^。]{0,12}(逝世|去世|病逝)/;

/**
 * Add death information that the extraction step missed.
 *
 * This exists because the model sometimes omits a fact the page states plainly.
 * It only ever *adds* information and only when the text says so, so it cannot
 * invent a death date.
 */
function enrichDeath(candidate, text) {
  const m = String(text || '').match(DEATH_RE);
  if (!m) return candidate;

  const out = { ...candidate };
  out.deceased = true;
  out.deceasedDate = `${m[1]}年${m[2]}月`;
  const tag = `（${out.deceasedDate}逝世）`;
  if (out.summary && !out.summary.includes('逝世')) {
    out.summary = out.summary.trim() + tag;
  }
  return out;
}

/**
 * Strip markdown fences the model wraps JSON in despite being told not to.
 */
function stripFences(content) {
  return String(content || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

module.exports = {
  ARRAY_FIELDS,
  STRING_FIELDS,
  DEATH_RE,
  canonicalise,
  normalise,
  requireStructured,
  extractByRules,
  enrichDeath,
  stripFences,
};
