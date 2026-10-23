'use strict';
/**
 * Layer 0 raw-record schema.
 *
 * ## What this layer is for
 *
 * Everything above it (entities, indexes, SQLite, views) can be rebuilt from
 * here; nothing here can be rebuilt from above. That asymmetry is the whole
 * point: the importers used to write straight into `data/*\/entities/`, so
 * "the CBDB death-year column was misnamed" meant re-importing 486k persons
 * through the same buggy code path, and "the index was written over the
 * shards" meant 5269 entities lost their props with no way back.
 *
 * So this module is deliberately dumb. It does not know what a father is, or
 * that CBDB uses 0 to mean "unknown", or that a web page has a title. It knows
 * how to say "source X, at location Y, captured at time T, said this".
 *
 * ## Two kinds of carrier
 *
 * `record`  — a row in a table. CBDB. Strongly structured, addressed by the
 *             primary key the source already gave it.
 * `document` — a page, a book, a filing. There is no row; there is text, and
 *             a citation has to be able to point at the *paragraph*, not at
 *             "somewhere in the Ming Shi". Hence `segments`.
 *
 * A single `payload` field cannot serve both: an edge that points at
 * `raw:x` cannot name a passage unless documents are segmented, and CBDB rows
 * gain nothing from being chopped into paragraphs.
 */

const crypto = require('crypto');

const KINDS = ['record', 'document'];

/**
 * Canonical JSON: sorted keys, no whitespace.
 *
 * `contentHash` must not change because a key moved. Node preserves insertion
 * order, so `JSON.stringify` on the same object built two different ways gives
 * two different strings — which would make every re-ingest look like tampering.
 */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function sha256(text) {
  return 'sha256:' + crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * The hash a record contributes to the chain.
 *
 * Deliberately covers only `payload`/`segments` and the identity fields — not
 * `capturedAt`, not `locked`. Re-ingesting the same source on a later day must
 * produce the same `contentHash`, otherwise every ingest would look like a
 * mutation of the previous one.
 */
function contentHashOf(rec) {
  const material =
    rec.kind === 'document'
      ? { rawId: rec.rawId, kind: rec.kind, text: rec.text, segments: rec.segments }
      : { rawId: rec.rawId, kind: rec.kind, payload: rec.payload };
  return sha256(canonical(material));
}

/**
 * Chain hash: `sha256(prevHash || thisContentHash)`.
 *
 * Costs 42% more than a bare per-record hash (measured: 1029 ms vs 721 ms per
 * 200k records, i.e. ~12.8 s for all 2.47M CBDB rows), and buys detection of
 * *deletion*, which a per-record hash cannot: a deleted record leaves no trace,
 * but a rewritten one breaks every hash after it.
 */
function chainHashOf(prevHash, contentHash) {
  return sha256(String(prevHash || '') + '|' + contentHash);
}

/**
 * Build a `record` raw entry.
 *
 * rawId shape: `raw:<source>/<sourceTable>/<sourceKey>`.
 *
 * The separator is `/`, not `-`, and that is load-bearing. The first version
 * used dashes, which cannot be parsed back: a group named `gov-5746205` is
 * indistinguishable from source `gov` + key `5746205`, so `get()` resolved to
 * the wrong group and silently returned null instead of the document. Slashes
 * cannot appear inside a part (the ingester scrubs them), so splitting is
 * unambiguous in both directions.
 *
 * @param {object} o
 * @param {string} o.source         e.g. 'cbdb'
 * @param {string} o.sourceTable    e.g. 'BIOG_MAIN'
 * @param {string|number} o.sourceKey  the source's own primary key
 * @param {string} o.capturedAt     ISO timestamp, injected by the caller's clock
 * @param {object} o.payload        raw columns, unmodified
 */
function makeRecord(o) {
  const rawId = makeRawId(o.source, o.sourceTable, o.sourceKey);
  const base = {
    rawId,
    kind: 'record',
    source: o.source,
    sourceTable: o.sourceTable,
    sourceKey: String(o.sourceKey),
    capturedAt: o.capturedAt,
    payload: o.payload,
  };
  base.contentHash = contentHashOf(base);
  return base;
}

/**
 * Canonical rawId for a record: `raw:<source>/<group>/<key>`.
 *
 * Exported so the ingester and the store cannot drift apart on the format —
 * the one thing that must never be duplicated is identity.
 */
function makeRawId(source, group, key) {
  const clean = (s) => String(s).replace(/[\/#]/g, '_');
  return `raw:${clean(source)}/${clean(group)}/${clean(key)}`;
}

/**
 * Split a rawId back into its parts.
 *
 * Returns null rather than throwing for a malformed id: callers ask
 * `get('raw:c://...')` for unregistered strings often enough that an exception
 * would be noise, and a null is what they already handle.
 */
function parseRawId(rawId) {
  const s = String(rawId);
  if (!s.startsWith('raw:')) return null;
  const parts = s.slice(4).split('/');
  if (parts.length < 3) return null;
  // The key may itself contain slashes after scrubbing, but never more than
  // the three we produced, because parts 1 and 2 are single path components.
  const [source, group, ...rest] = parts;
  return { source, group, key: rest.join('/') };
}

/**
 * Build a `document` raw entry.
 *
 * `text` is the extracted plain text; the original bytes live beside it in the
 * manifest's `files`. Segmenting happens here rather than in a transformer so
 * that every extraction downstream inherits a citation that names a passage.
 *
 * @param {object} o
 * @param {string} o.rawId
 * @param {string} o.source
 * @param {string} o.capturedAt
 * @param {string} o.text
 * @param {Array<{segId:string,text:string,offset:number,length:number}>} o.segments
 */
function makeDocument(o) {
  const base = {
    rawId: o.rawId,
    kind: 'document',
    source: o.source,
    capturedAt: o.capturedAt,
    url: o.url || null,
    title: o.title || null,
    occurredAt: o.occurredAt || null,
    text: o.text,
    segments: o.segments,
    files: o.files || {},
  };
  base.contentHash = contentHashOf(base);
  return base;
}

/**
 * Positional reference into a raw entry.
 *
 * `raw:cbdb-BIOG_MAIN-100001`            — a whole record
 * `raw:web-gov-2023-...-5746205#p3`      — paragraph 3 of a document
 *
 * Kept as a string because it is written into every entity that cites it, and
 * an object there would triple the size of 486k shards.
 */
function segmentRef(rawId, segId) {
  return segId ? `${rawId}#${segId}` : rawId;
}

function parseSegmentRef(ref) {
  const s = String(ref);
  const at = s.indexOf('#');
  if (at < 0) return { rawId: s, segId: null };
  return { rawId: s.slice(0, at), segId: s.slice(at + 1) };
}

/**
 * Split plain text into paragraph segments.
 *
 * Blank-line-delimited, which is what every extracted web page and every
 * digital edition produces, and what a human reading the source would call a
 * paragraph. Offsets are kept so a citation can be highlighted in the original.
 *
 * A single-paragraph document yields one segment rather than none: "the whole
 * thing" and "no segments" must not be the same value.
 */
function segmentText(text) {
  const segments = [];
  const re = /[^\n](?:[\s\S]*?[^\n])?(?=\n\s*\n|$)/g;
  let m;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    const body = m[0];
    if (!body.trim()) continue;
    segments.push({
      segId: 'p' + (++i),
      text: body,
      offset: m.index,
      length: body.length,
    });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  if (!segments.length && text.trim()) {
    segments.push({ segId: 'p1', text, offset: 0, length: text.length });
  }
  return segments;
}

module.exports = {
  KINDS,
  canonical,
  sha256,
  contentHashOf,
  chainHashOf,
  makeRawId,
  parseRawId,
  makeRecord,
  makeDocument,
  segmentRef,
  parseSegmentRef,
  segmentText,
};
