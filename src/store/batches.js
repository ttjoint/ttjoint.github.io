'use strict';
/**
 * Batch files under `data/imports/official/`.
 *
 * The scraping scripts form a pipeline where each stage writes
 * `<prefix>-<timestamp>.json` and the next stage picks up "the latest one".
 * Five scripts implemented that lookup independently, with small differences:
 *
 *   - some used `.filter(...).sort().at(-1)`
 *   - others used `.sort().reverse().find(...)`
 *   - one forgot the `.filter` and would pick the wrong file entirely
 *
 * Sorting by filename only works because the timestamp is ISO-derived
 * (`2026-08-01T12-00-00-000Z`), which sorts lexicographically. That is a
 * fragile invariant to re-derive in five places, so it lives here once.
 */

const fs = require('fs');
const path = require('path');

/** Absolute path to `data/imports/official`. */
function officialDir(root = path.join(__dirname, '..', '..')) {
  return path.join(root, 'data', 'imports', 'official');
}

/**
 * Timestamp suitable for filenames: `2026-08-01T12-00-00-000Z`.
 *
 * Colons and dots are illegal on Windows and are what breaks naive
 * `new Date().toISOString()` usage.
 */
function batchStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * List batch files whose name starts with `prefix`.
 *
 * @param {string} prefix  e.g. 'cppcc-verified-'
 * @param {string} [dir]
 * @returns {string[]} filenames, oldest first
 */
function listBatches(prefix, dir = officialDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort();
}

/**
 * Path of the most recent batch for `prefix`, or null when there is none.
 *
 * Filename sort order is chronological because `batchStamp` is ISO-formatted.
 */
function latestBatchPath(prefix, dir = officialDir()) {
  const files = listBatches(prefix, dir);
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

/**
 * Read the latest batch, throwing a helpful error when the pipeline stage has
 * not run yet. The message names the npm script, because "file not found" sends
 * people looking in the wrong place.
 *
 * @param {string} prefix
 * @param {string} hint  e.g. 'npm run verify:cppcc'
 */
function readLatestBatch(prefix, hint, dir = officialDir()) {
  const file = latestBatchPath(prefix, dir);
  if (!file) {
    throw new Error(`no "${prefix}*" batch found in ${dir}; run: ${hint}`);
  }
  return { file, name: path.basename(file), data: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

/**
 * Write a batch, creating the directory if needed.
 *
 * @returns {string} the path written
 */
function writeBatch(prefix, payload, dir = officialDir(), date = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${prefix}${batchStamp(date)}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
  return file;
}

module.exports = {
  officialDir,
  batchStamp,
  listBatches,
  latestBatchPath,
  readLatestBatch,
  writeBatch,
};
