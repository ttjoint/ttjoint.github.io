'use strict';
/**
 * Layer 0 storage: read, append, verify.
 *
 * ## Append-only, by construction
 *
 * There is no `update` and no `delete`. A correction is a new record carrying
 * `supersedes`, and the old one stays. That is not ceremony: the whole reason
 * layer 0 exists is that the layer above it gets rewritten — 5269 entities lost
 * their props to a bad regeneration in this very project — and once the source
 * statement is gone, the loss is permanent.
 *
 * ## Layout
 *
 *   raw/<source>/<table-or-slug>/batch-NNN.jsonl   records (+ chain hashes)
 *   raw/<source>/<slug>/manifest.json              document identity + files
 *   raw/<source>/<slug>/content.*                  original bytes, never touched
 *   raw/<source>/<slug>/text.txt                   extracted text
 *
 * Batches keep any single file readable; 660k CBDB rows in one JSONL would be
 * 900 MB and un-openable by anything, including this module's own error paths.
 *
 * ## Gzip
 *
 * JSONL of CBDB rows compresses to 12.4% (measured), which is the difference
 * between 1.7 GB and 220 MB on disk. `*.jsonl.gz` is read transparently and is
 * what the ingester writes; plain `*.jsonl` is accepted so an uncompressed
 * source tree still loads.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { contentHashOf, chainHashOf, parseSegmentRef, parseRawId } = require('./raw_schema');

const ROOT = path.join(__dirname, '..', '..', 'raw');
const BATCH_SIZE = 5000;

function rawRoot() {
  return process.env.HUMANMAP_RAW_ROOT
    ? path.resolve(process.env.HUMANMAP_RAW_ROOT)
    : ROOT;
}

/** List `raw/<source>/<group>/` directories that contain batches **/
function listGroups(source) {
  const sourceDir = path.join(rawRoot(), source);
  if (!fs.existsSync(sourceDir)) return [];
  return fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * Read every record of one group, in stored order.
 *
 * Order matters: the chain is only meaningful if it is verified in the order it
 * was written, so batches are sorted numerically (batch-2 before batch-10).
 */
function* readGroup(source, group) {
  const dir = path.join(rawRoot(), source, group);
  if (!fs.existsSync(dir)) return;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^batch-\d+\.jsonl(\.gz)?$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  for (const f of files) {
    const file = path.join(dir, f);
    const buf = fs.readFileSync(file);
    const text = f.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      yield JSON.parse(line);
    }
  }
}

/**
 * Index of every group, keyed by `rawId` → {source, group, line}.
 *
 * Building this eagerly for 2.47M records is ~1 GB of bookkeeping, so callers
 * that only need "does this exist" should use `exists()` or scan one group.
 * `get()` builds a per-group cache instead of a global one.
 */
const groupCache = new Map();

function loadGroup(source, group) {
  const key = source + '/' + group;
  if (groupCache.has(key)) return groupCache.get(key);
  const byId = new Map();
  for (const rec of readGroup(source, group)) byId.set(rec.rawId, rec);
  groupCache.set(key, byId);
  return byId;
}

function clearCache() {
  groupCache.clear();
}

/**
 * Resolve a positional reference to its content.
 *
 * Accepts `raw:a-b-c` (whole record) and `raw:a-b-c#p3` (a segment). Returns
 * null rather than throwing when absent: a transformer citing a deleted source
 * should surface as a validation error with a reference attached, not crash the
 * whole build.
 *
 * @param {string} ref
 */
function get(ref) {
  const { rawId, segId } = parseSegmentRef(ref);
  const rec = getByRawId(rawId);
  if (!rec) return null;

  if (!segId) return rec;

  if (rec.kind !== 'document') {
    throw new Error(`segment ref "${ref}" points into a ${rec.kind}, which has no segments`);
  }
  const seg = (rec.segments || []).find((s) => s.segId === segId);
  if (!seg) return null;
  return { rawId, kind: 'document', segId, text: seg.text, offset: seg.offset, capturedAt: rec.capturedAt };
}

/**
 * Locate a raw record by id without loading every group.
 *
 * The id is `raw:<source>/<group>/<key>`, so the parts name the group directly;
 * only that group is read. This is what keeps `get()` usable on a 2.47M-record
 * tree.
 *
 * The first implementation split on `-` and was wrong: `raw:web-gov-5746205`
 * parsed as source `web`, group `gov`, key `5746205`, so it looked in a group
 * that does not exist and returned null for a document that was right there.
 * Parsing now goes through the same `parseRawId` that built the id.
 */
function getByRawId(rawId) {
  const parts = parseRawId(rawId);
  if (!parts) return null;

  const bag = loadGroup(parts.source, parts.group);
  return bag.get(rawId) || null;
}

/**
 * Does this rawId exist in the layer-0 tree?
 *
 * `get()` already answers this, but a checker only needs the boolean and
 * `get()` reads the whole group into memory to build its cache. The group cache
 * makes the second call cheap, yet a caller that validates 486k references
 * still pins one group's worth of bookkeeping for the run — acceptable for
 * BIOG_MAIN (660k rows), not for a caller that walks every group.
 *
 * The earlier doc comment above `loadGroup()` told callers to use `exists()`,
 * which did not exist — the function was documented but never written, so
 * anyone following the comment got a TypeError. This is that function.
 */
function exists(rawId) {
  const parts = parseRawId(rawId);
  if (!parts) return false;
  return loadGroup(parts.source, parts.group).has(rawId);
}

/** All segments of a document, in order. */
function segments(rawId) {
  const rec = getByRawId(rawId);
  if (!rec) return null;
  if (rec.kind !== 'document') {
    throw new Error(`"${rawId}" is a ${rec.kind}; only documents have segments`);
  }
  return rec.segments || [];
}

/**
 * Append records to a group, maintaining the hash chain.
 *
 * Idempotent: an id already present in the group is skipped, so re-ingesting a
 * source is safe and does not fork the chain. The chain link is taken from the
 * last record *on disk*, not from the incoming array, so appending a second
 * batch continues the same chain.
 *
 * @param {string} source
 * @param {string} group
 * @param {object[]} records
 * @param {{locked?:object}} [opts]
 * @returns {{written:number, skipped:number, head:string}}
 */
function append(source, group, records, opts = {}) {
  const dir = path.join(rawRoot(), source, group);
  fs.mkdirSync(dir, { recursive: true });

  const existing = loadGroup(source, group);
  const last = lastRecordOnDisk(dir);
  let prevHash = last ? last.chainHash : null;

  const fresh = [];
  let skipped = 0;
  for (const rec of records) {
    if (existing.has(rec.rawId)) {
      skipped++;
      continue;
    }
    fresh.push(rec);
  }
  if (!fresh.length) return { written: 0, skipped, head: prevHash };

  // Continue from the highest existing batch number so a re-run appends a new
  // file rather than overwriting batch-000.
  let n = nextBatchIndex(dir);
  for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
    const slice = fresh.slice(i, i + BATCH_SIZE);
    const lines = slice.map((rec) => {
      const chained = {
        ...rec,
        contentHash: rec.contentHash || contentHashOf(rec),
        prevHash,
        ...(opts.locked ? { locked: opts.locked } : {}),
      };
      chained.chainHash = chainHashOf(prevHash, chained.contentHash);
      prevHash = chained.chainHash;
      existing.set(chained.rawId, chained);
      return JSON.stringify(chained);
    });

    const name = `batch-${String(n++).padStart(3, '0')}.jsonl.gz`;
    fs.writeFileSync(path.join(dir, name), zlib.gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8')));
  }

  // 写入后必须清缓存：`loadGroup` 会把「组不存在」缓存成空 Map，
  // 于是紧随其后的 `exists()` / `getByRawId()` 读不到刚写的记录。
  // 这个 bug 实测出现过：CLI 写完 raw 后立刻读回，返回 null。
  groupCache.delete(source + '/' + group);

  // `count` 与 `written` 同义，保留两个名字是因为调用方习惯不同。
  return { written: fresh.length, count: fresh.length, skipped, head: prevHash };
}

function nextBatchIndex(dir) {
  const nums = fs
    .readdirSync(dir)
    .filter((f) => /^batch-\d+\.jsonl(\.gz)?$/.test(f))
    .map((f) => Number(f.match(/\d+/)[0]));
  return nums.length ? Math.max(...nums) + 1 : 0;
}

function lastRecordOnDisk(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^batch-\d+\.jsonl(\.gz)?$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!files.length) return null;
  const file = path.join(dir, files[files.length - 1]);
  const buf = fs.readFileSync(file);
  const text = files[files.length - 1].endsWith('.gz')
    ? zlib.gunzipSync(buf).toString('utf8')
    : buf.toString('utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  return JSON.parse(lines[lines.length - 1]);
}

/**
 * Verify a group's chain.
 *
 * Returns `{ok, checked, brokenAt}`. A broken link names the offending rawId so
 * the failure is actionable — "somewhere in 660k rows" is not.
 */
function verifyGroup(source, group) {
  let prevHash = null;
  let checked = 0;
  for (const rec of readGroup(source, group)) {
    checked++;
    const wantContent = contentHashOf(rec);
    if (rec.contentHash !== wantContent) {
      return { ok: false, checked, brokenAt: rec.rawId, reason: 'contentHash mismatch' };
    }
    const wantChain = chainHashOf(prevHash, rec.contentHash);
    if (rec.chainHash !== wantChain) {
      return { ok: false, checked, brokenAt: rec.rawId, reason: 'chainHash mismatch' };
    }
    prevHash = rec.chainHash;
  }
  return { ok: true, checked, head: prevHash };
}

/** Every `{source, group}` pair present. */
function listAll() {
  const root = rawRoot();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const source of fs.readdirSync(root).sort()) {
    const sd = path.join(root, source);
    if (!fs.statSync(sd).isDirectory()) continue;
    for (const group of fs.readdirSync(sd).sort()) {
      const gd = path.join(sd, group);
      if (!fs.statSync(gd).isDirectory()) continue;
      if (fs.readdirSync(gd).some((f) => /^batch-\d+\.jsonl(\.gz)?$/.test(f))) {
        out.push({ source, group });
      }
    }
  }
  return out;
}

/**
 * Head hash only: the last record of every group.
 *
 * `verifyGroup` is the real check, but it costs 62 s on 2.47M records because
 * it gunzips and parses every line. `npm run check` runs on every edit, so it
 * gets this instead: reading one file per group confirms the files are
 * readable and the head has not moved, in under a second.
 *
 * That is a weaker guarantee and it is meant to be. A silent payload edit in
 * the middle of a batch passes a head check; it does not pass `npm run
 * raw:verify`. The cheap check is there to catch "the tree is gone/corrupt",
 * the expensive one to catch "someone rewrote history".
 */
function headsOnly() {
  const out = [];
  for (const { source, group } of listAll()) {
    const dir = path.join(rawRoot(), source, group);
    const last = lastRecordOnDisk(dir);
    out.push({ source, group, head: last ? last.chainHash : null, rawId: last ? last.rawId : null });
  }
  return out;
}

module.exports = {
  rawRoot,
  listGroups,
  listAll,
  readGroup,
  get,
  getByRawId,
  exists,
  segments,
  append,
  verifyGroup,
  headsOnly,
  clearCache,
  BATCH_SIZE,
};
