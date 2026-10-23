'use strict';
/**
 * Query engine over a GraphStore.
 *
 * Responsibilities
 *  - time-window filtering with confidence buckets (exact / fuzzy / vague)
 *  - predicate-centric retrieval, honouring inverse and negate modifiers
 *  - free-text search across names, aliases and summaries
 *
 * All time comparisons happen on Julian Day Numbers supplied by the caller, so
 * this module is independent of how the UI converts a slider position to a date.
 */

const { confidenceClass, julianToJdn, jdnToJulian, formatRange } = require('../time/julian');
const { baseKey, isNegated, splitModifiers } = require('../predicates/registry');

/** Confidence buckets the UI exposes as checkboxes. */
const CONFIDENCE = Object.freeze({
  EXACT: 'exact',
  FUZZY: 'fuzzy',
  VAGUE: 'vague',
});

const ALL_CONFIDENCE = new Set([CONFIDENCE.EXACT, CONFIDENCE.FUZZY, CONFIDENCE.VAGUE]);

/**
 * Does a node's lifespan intersect [loJdn, hiJdn]?
 *
 * A node without any time data cannot be *proven* to exist inside a window, so
 * it is excluded when a window is active (includeUndated=false). With no window
 * the date question does not apply and the node stays visible.
 */
function nodeInWindow(node, { lo = null, hi = null, confidence = ALL_CONFIDENCE, includeUndated = false } = {}) {
  const life = node.lifespan;
  const windowActive = lo != null && hi != null;
  // Undated evidence: it can never satisfy a confidence bucket, because there is
  // no range to classify. Return it only when no date filtering was requested.
  const dateFilterRequested = windowActive
    || (confidence != null && confidence.size > 0 && confidence.size < ALL_CONFIDENCE.size);
  if (!life) return dateFilterRequested ? includeUndated : true;
  if (confidence && !confidence.has(confidenceClass(life))) return false;
  if (!windowActive) return true;
  const s = life.start != null ? life.start : life.mid;
  const e = life.end != null ? life.end : life.mid;
  if (s == null || e == null) return includeUndated;
  return s <= hi && e >= lo;
}

/** Normalise a filter description from the UI into a predicate list. */
function parsePredicateFilter(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : String(input).split(/[,、\s]+/);
  return list.map(s => s.trim()).filter(Boolean);
}

class QueryEngine {
  constructor(store) {
    this.store = store;
  }

  /**
   * Search entities.
   * @param {object} q
   * @param {string} q.text      free text (name / alias / summary)
   * @param {string} q.type      person | thing | organization | event | evidence
   * @param {string[]} q.predicates  predicates that must be present (any direction)
   *
   * Era classification used to be a `tags` filter here, then an `era` predicate.
   * Both are gone: era is a query-time derivation from birthDate/deathDate, not
   * stored data (design §2.6). To find people of a period, filter on the date
   * window (`lo`/`hi`) — the fuzzy ranges on those edges are what make it work.
   * @param {number} q.lo, q.hi  JDN window
   * @param {Set<string>} q.confidence  subset of exact/fuzzy/vague
   * @param {number} q.limit
   */
  search({ text = '', type = null, predicates = [], lo = null, hi = null, confidence = ALL_CONFIDENCE, includeUndated = false, includeNegated = false, limit = 200 } = {}) {
    const needle = String(text || '').trim().toLowerCase();
    const predList = parsePredicateFilter(predicates).map(p => this.store.registry.resolve(p) || p);

    // Predicate pre-filter: collect candidate node ids once so the main loop stays cheap.
    let candidateIds = null;
    if (predList.length) {
      candidateIds = new Set();
      for (const p of predList) {
        for (const e of this.store.edgesByPredicate(p)) {
          if (!includeNegated && isNegated(e.key)) continue;
          candidateIds.add(e.subject);
          if (!e.literal) candidateIds.add(e.object);
        }
      }
    }

    const hits = [];
    for (const node of this.store.nodes.values()) {
      if (node.stub) continue;
      if (type && node.type !== type) continue;
      if (candidateIds && !candidateIds.has(node.id)) continue;
      if (!nodeInWindow(node, { lo, hi, confidence, includeUndated })) continue;

      if (needle) {
        const hay = [node.name, ...(node.aliases || []), node.summary]
          .join('\u0000').toLowerCase();
        if (!hay.includes(needle)) continue;
      }

      hits.push(node);
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /**
   * All assertions for a predicate, resolved into displayable rows.
   * Inverse and negate modifiers are expanded so callers can ask for
   * "父亲" and also receive "子女/inverse" rows that mean the same thing.
   */
  edgesFor(predicate, { includeInverse = true, includeNegated = true, lo = null, hi = null } = {}) {
    const base = this.store.registry.resolve(predicate) || baseKey(predicate);
    return this._collectRows({ base, includeInverse, includeNegated, lo, hi, predicate });
  }

  /**
   * Gather rows for a predicate family. Storage may hold the assertion under any
   * of: `base`, `base/inverse`, `base/negate`, and the same three for the inverse
   * predicate. All four shapes are normalised here so callers can ask a plain
   * question ("show me 父亲") and get a complete, de-duplicated answer.
   */
  _collectRows({ base, includeInverse, includeNegated, lo, hi, predicate }) {
    const keys = new Set([base]);
    const inv = this.store.registry.inverseKey(base);
    if (includeInverse && inv) keys.add(inv);

    const rawKeys = [];
    for (const k of keys) {
      rawKeys.push(k);
      if (includeNegated) rawKeys.push(k + '/negate');
      // Edges stored with an explicit /inverse modifier use the *other* base key.
      if (includeInverse) rawKeys.push(k + '/inverse');
    }

    const rows = [];
    const seen = new Set();
    for (const key of rawKeys) {
      for (const e of this.store.byRawKey.get(key) || []) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        if (lo != null && hi != null && e.range) {
          const s = e.range.start ?? e.range.mid;
          const t = e.range.end ?? e.range.mid;
          if (s != null && t != null && (s > hi || t < lo)) continue;
        }
        const subj = this.store.nodes.get(e.subject);
        const obj = e.literal ? null : this.store.nodes.get(e.object);
        const mods = splitModifiers(e.key).mods;
        rows.push({
          edge: e,
          key: e.key,
          label: this.store.registry.label(baseKey(e.key)),
          negated: mods.includes('negate'),
          inverse: mods.includes('inverse'),
          subject: subj ? { id: subj.id, name: subj.name, type: subj.type } : { id: e.subject, name: e.subject, type: 'unknown' },
          object: obj ? { id: obj.id, name: obj.name, type: obj.type } : { id: null, name: e.object, type: 'literal' },
          role: e.role,
          range: e.range,
          rangeText: formatRange(e.range),
        });
      }
    }
    return rows;
  }

  /** Registry metadata for the predicate browser panel. */
  predicateCatalog() {
    const counts = this.store.summary().byPredicate;
    return this.store.registry.list().map(p => ({
      key: p.key,
      label: p.label,
      domain: p.domain,
      range: p.range,
      inverse: p.inverse,
      aliases: p.aliases,
      negatable: p.negatable,
      objectGender: p.objectGender,
      count: counts[p.key] || 0,
    })).sort((a, b) => (b.count - a.count) || a.key.localeCompare(b.key));
  }

  /** Histogram of entity lifespans by decade, for the timeline rail. */
  timelineHistogram({ bucketYears = 50, lo = null, hi = null, confidence = ALL_CONFIDENCE } = {}) {
    const buckets = new Map();
    const step = Math.max(1, bucketYears) * 365.25;
    for (const node of this.store.nodes.values()) {
      if (node.stub || !node.lifespan) continue;
      if (confidence && !confidence.has(confidenceClass(node.lifespan))) continue;
      const mid = node.lifespan.mid;
      if (mid == null) continue;
      if (lo != null && hi != null && (mid < lo || mid > hi)) continue;
      const b = Math.floor(mid / step) * step;
      buckets.set(b, (buckets.get(b) || 0) + 1);
    }
    return [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([start, count]) => ({ start, count, year: jdnToJulian(Math.round(start)).year }));
  }

  /** Convenience: convert a year to JDN for the UI slider. */
  static yearToJdn(y) {
    return julianToJdn(Math.round(y), 7, 1);
  }

  static jdnToYear(jdn) {
    return jdnToJulian(Math.round(jdn)).year;
  }
}

module.exports = {
  CONFIDENCE,
  ALL_CONFIDENCE,
  QueryEngine,
  nodeInWindow,
  parsePredicateFilter,
};
