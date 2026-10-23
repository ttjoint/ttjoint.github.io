'use strict';
/**
 * Pure helpers used by `scripts/build_db.js`.
 *
 * They live in `src/` rather than in the script for two reasons: the tests import
 * them without triggering a full 90-second rebuild, and the same rules are needed
 * by the layer-1 write path (a bot proposing an edge needs to compute the same
 * edge id the build will compute, or its proposal will not match the row).
 */

const crypto = require('crypto');

/**
 * Stable id for one triple.
 *
 * Derived from the content, not from a counter: the same edge keeps its id when
 * a shard is rewritten or the whole database is rebuilt. Provenance rows, change
 * requests and UI links all refer to edges by id, so an id that shifts on rebuild
 * would orphan them.
 *
 * 12 hex chars = 48 bits. With ~52k edges the collision probability is ~1e-8;
 * `build_db.js` inserts with OR IGNORE and reports the difference, so a collision
 * surfaces as a count mismatch instead of a silent merge.
 *
 * The separator is NUL because no entity id or predicate key can contain it, so
 * ('a|b','c','d') and ('a','b|c','d') cannot hash to the same input.
 */
function edgeId(subject, predicate, object) {
  const digest = crypto
    .createHash('sha256')
    .update(`${subject}\0${predicate}\0${object}`)
    .digest('hex');
  return `edge:${digest.slice(0, 12)}`;
}

/**
 * Stable id for one provenance row.
 *
 * `n` is the row's position within its target's provenance array. Two rows for
 * the same entity must not collide (birth year from BIOG_MAIN, courtesy name from
 * ALTNAME_DATA), and a row must keep its id when an unrelated row is inserted
 * before it — which is why position alone is not enough and the evidence/raw pair
 * is part of the digest.
 */
function provenanceId(target, n, evidenceId, rawRef) {
  const digest = crypto
    .createHash('sha256')
    .update(`${target}\0${n}\0${evidenceId}\0${rawRef || ''}`)
    .digest('hex');
  return `prov:${digest.slice(0, 12)}`;
}

/**
 * Which evidence node covers a raw ref.
 *
 * `raw:cbdb/BIOG_MAIN/12195` is one of 2.47M records that all come from the same
 * database. Storing the evidence id on each provenance row would be 2.47M copies
 * of the string "evidence:cbdb"; a prefix table states it once.
 *
 * Longest prefix wins (not first match) so a future source can point one table at
 * a different document without rewriting every other row.
 *
 * Returns null when nothing matches. That is deliberate: a claim whose source
 * cannot be named is a data bug, and `build_db.js` throws on it rather than
 * storing a sourceless provenance row.
 */
function evidenceForRawRef(rawRef, prefixes) {
  if (!rawRef) return null;
  let best = null;
  for (const [prefix, evId] of prefixes) {
    if (rawRef.startsWith(prefix) && (!best || prefix.length > best[0].length)) {
      best = [prefix, evId];
    }
  }
  return best ? best[1] : null;
}

/**
 * Insert a space between han characters so unicode61 yields per-character tokens.
 *
 * SQLite's `unicode61` tokenizer splits on whitespace and punctuation only. It
 * does not segment CJK, so "歐陽景達" stays a single token and searching for
 * "歐陽" matches nothing at all. Measured against the 67-organization shard:
 * `MATCH '景達'` returned 0 rows before this, 1 after.
 *
 * `trigram` was tried first and rejected: it requires queries of at least three
 * characters, so single-character surnames are unsearchable.
 *
 * Latin runs are left intact; they already split on non-word characters.
 */
function segment(text) {
  return String(text || '')
    .replace(/([\u3400-\u9fff])/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split one entry of `relations[predicate]` into its target and qualifiers.
 *
 * Shards store two shapes, produced by different scripts, both valid:
 *   "kin":    ["person:x"]                          (flat, the common case)
 *   "spouse": [{"id": "person:x", "role": "wife"}]  (wrapped, 4,112 today)
 *
 * The wrapped form carries `role` (what the SUBJECT is in this relationship),
 * `kind` (step/adoptive) or `order` (elder/younger). P5-5b settled that these
 * qualify one relationship rather than naming a new one — "his spouse, who is his
 * wife" is still a spouse edge — so they belong in a column, not in the predicate.
 *
 * Returns null for an entry that cannot be read, so the caller can count it. A
 * row with `object=undefined` would be worse than a skipped row: it would be an
 * edge pointing nowhere.
 *
 * `provenance` 单独取出，不混进 `qualifiers`。两者语义不同：
 *   qualifiers = 这条断言怎么成立（`{role:'嫡'}`、`{order:'第15'}`）
 *   provenance = 这条断言出自哪里（`raw:cbdb/KIN_DATA/…`）
 * 混在一起会让「这条边有没有出处」变成要先解 JSON 才能回答的问题。
 */
function splitRelationEntry(entry) {
  if (typeof entry === 'string') return { object: entry, qualifiers: null, provenance: null };
  if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id) {
    const { id, provenance, ...rest } = entry;
    const keys = Object.keys(rest).filter((k) => rest[k] != null);
    return {
      object: id,
      qualifiers: keys.length ? JSON.stringify(rest, keys.sort()) : null,
      provenance: Array.isArray(provenance) && provenance.length ? provenance : null,
    };
  }
  return null;
}

module.exports = { edgeId, provenanceId, evidenceForRawRef, segment, splitRelationEntry };
