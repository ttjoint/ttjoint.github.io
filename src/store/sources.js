'use strict';
/**
 * Reading the `sources` field across the migration window.
 *
 * Historically an entity's sources were inline objects:
 *
 *     sources: [{ id: 'cpc-aHR0c…', name: '人民网人物资料', url: '…', accessedAt: '…' }]
 *
 * After the evidence refactor they are references to evidence nodes:
 *
 *     sources: ['evidence:3e1d39471ff68f8fa512', …]
 *
 * Both shapes existed in the corpus at the same time (the migration touched
 * 5287 entities and could not be atomic), and hand-edited shards may still use
 * either. Every consumer therefore goes through this module instead of indexing
 * `sources[0].url` directly — that expression returns undefined for the new
 * shape, which is how a source URL silently disappears from the UI.
 */

/** URL of an inline legacy source object. */
function urlOf(source) {
  if (!source) return '';
  if (typeof source === 'string') return ''; // an evidence id has no inline URL
  return source.url || '';
}

/**
 * Normalise an entity's `sources` field into a uniform list.
 *
 * Each item is either `{ kind: 'evidence', id }` (a reference to a node) or
 * `{ kind: 'inline', ...source }` (a legacy inline object not yet migrated).
 * Callers that only need URLs use `sourceUrls`; callers that resolve nodes
 * filter on `kind === 'evidence'`.
 *
 * @param {object} entity
 * @returns {Array<object>}
 */
function listSources(entity) {
  const raw = entity && entity.sources;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    if (typeof s === 'string') {
      if (s) out.push({ kind: 'evidence', id: s });
    } else if (s && typeof s === 'object') {
      out.push({ kind: 'inline', ...s });
    }
  }
  return out;
}

/**
 * Ids of the evidence nodes an entity cites.
 * @param {object} entity
 * @returns {string[]}
 */
function evidenceIds(entity) {
  return listSources(entity).filter((s) => s.kind === 'evidence').map((s) => s.id);
}

/**
 * A display URL for an entity, preferring the first usable one.
 *
 * Used where the graph only needs "a link to show", not provenance analysis.
 * Returns '' rather than throwing when nothing is available.
 *
 * @param {object} entity
 * @param {function(string):object} [resolve]  evidence id -> evidence node
 * @returns {string}
 */
function preferredUrl(entity, resolve) {
  // Inline URLs first: they are self-contained and need no lookup.
  for (const s of listSources(entity)) {
    if (s.kind === 'inline' && s.url) return s.url;
  }
  if (typeof resolve === 'function') {
    for (const s of listSources(entity)) {
      if (s.kind !== 'evidence') continue;
      const node = resolve(s.id);
      if (node && node.url) return node.url;
    }
  }
  // Fall back to the importer-specific URL stashed on `external`.
  const ext = (entity && entity.external) || {};
  return ext.cpcUrl || ext.url || '';
}

/**
 * All URLs an entity cites, inline and via evidence nodes, de-duplicated.
 * @param {object} entity
 * @param {function(string):object} [resolve]
 * @returns {string[]}
 */
function sourceUrls(entity, resolve) {
  const seen = new Set();
  for (const s of listSources(entity)) {
    if (s.kind === 'inline') {
      if (s.url) seen.add(s.url);
    } else if (typeof resolve === 'function') {
      const node = resolve(s.id);
      if (node && node.url) seen.add(node.url);
    }
  }
  const ext = (entity && entity.external) || {};
  if (ext.cpcUrl) seen.add(ext.cpcUrl);
  return [...seen];
}

/** True when every source on the entity is already an evidence reference. */
function isFullyMigrated(entity) {
  return listSources(entity).every((s) => s.kind === 'evidence');
}

module.exports = {
  listSources,
  evidenceIds,
  preferredUrl,
  sourceUrls,
  urlOf,
  isFullyMigrated,
};
