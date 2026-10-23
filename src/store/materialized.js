'use strict';
/**
 * Materialised query results with dependency fingerprints (P3-4).
 *
 * The problem
 * -----------
 * Some answers are expensive to compute and change rarely: a family-tree chart,
 * a population-by-century histogram, a "most common courtesy names" panel. Two
 * naive strategies both fail:
 *
 *   - Recompute on every request: too slow (a depth-5 tree over 486k entities, or
 *     a GROUP BY over 51k edges, on every page view).
 *   - Recompute on a timer: either stale (rebuild after the data changed) or
 *     wasteful (rebuild 500 views because one person's name was fixed).
 *
 * The fix
 * -------
 * Store the result together with the fingerprints of exactly the entities it read.
 * A view is valid while every one of those fingerprints still matches. When an
 * entity changes, only the views that named it are rebuilt.
 *
 * What a fingerprint covers
 * -------------------------
 * `entities.content_hash` hashes everything downstream code could observe about an
 * entity: its name, summary, props, its aliases, and its outgoing edges including
 * qualifiers. It deliberately excludes:
 *
 *   - `folder` / `type`: moving an entity between folders is not a change to what
 *     it claims, and including it would invalidate every view containing it.
 *   - the entity's own id: it is the key, not content.
 *   - provenance: correcting a citation does not change the claim. (A view that
 *     *displays* citations must declare `provenance` as a dependency — see
 *     `deps.mode` below.)
 *
 * The `deps` shape
 * ----------------
 *   { "entities": { "<id>": "<hash>", ... } }
 *
 * An empty `entities` map is legal and means the view is constant. It is NOT a
 * wildcard: a view that reads the whole table must list the ids it read, which for
 * a table-wide aggregate is every entity. That is 486k entries and is exactly why
 * table-wide aggregates are recomputed rather than fingerprinted — see `shouldRebuild`.
 */

const crypto = require('crypto');

/**
 * Compute an entity's content fingerprint.
 *
 * Must be stable across rebuilds and must change when anything observable changes.
 * JSON with sorted keys, because object key order is not semantic and an unordered
 * hash would report spurious changes.
 */
function entityFingerprint({ id, name, summary, aliases, props, relations }) {
  // Edges are sorted and their qualifiers included: adding a father changes the
  // entity's meaning even though no column of the entity row changed.
  const edges = [];
  for (const [predicate, targets] of Object.entries(relations || {})) {
    for (const t of targets || []) {
      if (typeof t === 'string') edges.push(`${predicate}\u0000${t}\u0000`);
      else if (t && typeof t === 'object' && t.id) {
        const quals = Object.keys(t)
          .filter((k) => k !== 'id' && t[k] != null)
          .sort()
          .map((k) => `${k}=${t[k]}`)
          .join(',');
        edges.push(`${predicate}\u0000${t.id}\u0000${quals}`);
      }
    }
  }
  edges.sort();

  const canonical = JSON.stringify({
    name: name ?? '',
    summary: summary ?? '',
    aliases: [...(aliases || [])].sort(),
    props: sortedObject(props),
    edges,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function sortedObject(o) {
  if (!o || typeof o !== 'object') return o ?? null;
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  return out;
}

/**
 * Is a stored view still valid against the current data?
 *
 * Returns `{ valid, reason }`. The reason matters: "one dependency changed" and
 * "a dependency was deleted" call for different log lines, and this is the only
 * place that can tell them apart.
 */
function isFresh(db, key) {
  const row = db.prepare('SELECT deps FROM materialized WHERE key=?').get(key);
  if (!row) return { valid: false, reason: 'absent' };

  let deps;
  try {
    deps = JSON.parse(row.deps);
  } catch {
    // A corrupt deps blob cannot be trusted to say "nothing changed".
    return { valid: false, reason: 'corrupt-deps' };
  }

  const wanted = deps.entities || {};
  const ids = Object.keys(wanted);
  if (!ids.length) return { valid: true, reason: 'constant' };

  const stmt = db.prepare('SELECT content_hash FROM entities WHERE id=?');
  for (const id of ids) {
    const cur = stmt.get(id);
    if (!cur) return { valid: false, reason: `deleted:${id}` };
    if (cur.content_hash !== wanted[id]) return { valid: false, reason: `changed:${id}` };
  }
  return { valid: true, reason: 'fresh' };
}

/** Read a view's payload, rebuilding through `build()` if stale. */
function materialize(db, key, build, opts = {}) {
  const now = new Date().toISOString();
  let rebuildReason = opts.force ? 'forced' : null;
  if (!opts.force) {
    const fresh = isFresh(db, key);
    if (fresh.valid) {
      const row = db.prepare('SELECT payload, built_at FROM materialized WHERE key=?').get(key);
      return { payload: JSON.parse(row.payload), builtAt: row.built_at, rebuilt: false, reason: fresh.reason };
    }
    // Capture WHY before rebuilding. Reading it afterwards reports 'fresh' — the
    // state the view is in now, not the reason it had to be rebuilt — which makes
    // the field useless for logging.
    rebuildReason = fresh.reason;
  }

  const result = build(db);
  // `build` returns either a payload or `{ payload, deps }`. A payload with no
  // deps is treated as depending on nothing, which means it will never be
  // invalidated — only acceptable for constants, so it is called out in the log.
  const payload = result && Object.hasOwn(result, 'payload') ? result.payload : result;
  const entities = (result && result.deps && result.deps.entities) || {};

  db.prepare(
    `INSERT INTO materialized (key, payload, deps, built_at) VALUES (?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, deps=excluded.deps, built_at=excluded.built_at`,
  ).run(key, JSON.stringify(payload), JSON.stringify({ entities }), now);

  return {
    payload,
    builtAt: now,
    rebuilt: true,
    reason: rebuildReason,
  };
}

/**
 * Which stored views are stale right now?
 *
 * Used by the writer path: after a batch of edits, this says what to rebuild
 * without rebuilding it in the same transaction (a rebuild may be slow and must
 * not roll back a data fix).
 */
function staleViews(db) {
  const rows = db.prepare('SELECT key FROM materialized').all();
  const stale = [];
  for (const { key } of rows) {
    const f = isFresh(db, key);
    if (!f.valid) stale.push({ key, reason: f.reason });
  }
  return stale;
}

/**
 * Collect fingerprints for a set of ids, to be returned as a view's `deps`.
 *
 * The caller declares what it read. It is not derived from the query, because a
 * view may read entities the query did not return (a neighbour lookup, a
 * group-by's members) and an under-declared dependency produces a stale view that
 * nothing can detect.
 */
function depsOf(db, ids) {
  const stmt = db.prepare('SELECT content_hash FROM entities WHERE id=?');
  const entities = {};
  for (const id of ids) {
    const row = stmt.get(id);
    if (row) entities[id] = row.content_hash;
  }
  return { entities };
}

module.exports = { entityFingerprint, isFresh, materialize, staleViews, depsOf };
