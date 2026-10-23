'use strict';
/**
 * Read the full entity set of a type, regardless of how the index is laid out.
 *
 * Why this exists
 * ---------------
 * `data/<type>/index.json` used to be the complete entity list. It is now a
 * generated compatibility pointer holding only the first index page (see
 * scripts/build_index.js), with the real rows spread across
 * `index/page-*.json` and the authoritative data in `entities/*.json`.
 *
 * Several validator scripts still read `index.json` directly. At 5.3k entities
 * that meant they silently validated 2000 of 5287 — `npm run check` stayed green
 * while 62% of the corpus went unchecked. Centralising the read here means a
 * future layout change breaks one file instead of quietly shrinking every
 * validation's scope.
 *
 * Preference order:
 *   1. entities/ shards on disk  (authoritative, always complete)
 *   2. manifest.json page list   (complete, and what the browser sees)
 *   3. index.json                (legacy; may be truncated)
 */
const fs = require('fs');
const path = require('path');

// This file lives in src/store/, so the repo root is two levels up.
const DATA_ROOT = path.resolve(__dirname, '..', '..', 'data');
const { TYPE_OF_FOLDER: FOLDERS, ALL_FOLDERS } = require('./entity_types');

/** All entity detail objects for one folder ('persons' etc.). */
function readEntities(folder) {
  const dir = path.join(DATA_ROOT, folder);
  const detail = path.join(dir, 'entities');
  if (!fs.existsSync(detail)) {
    throw new Error(`missing ${detail} (run npm run shard:data or publish first)`);
  }
  return fs
    .readdirSync(detail)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(detail, f), 'utf8')));
}

/** Summary/rows for one folder, complete even when index.json is truncated. */
function readIndexRows(folder) {
  const dir = path.join(DATA_ROOT, folder);

  const manifestPath = path.join(dir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (Array.isArray(manifest.pages) && manifest.pages.length) {
      const rows = [];
      for (const page of manifest.pages) {
        const file = path.join(dir, page.file);
        if (!fs.existsSync(file)) throw new Error(`missing index page ${file}`);
        rows.push(...JSON.parse(fs.readFileSync(file, 'utf8')));
      }
      return rows;
    }
  }

  const legacy = path.join(dir, 'index.json');
  if (!fs.existsSync(legacy)) throw new Error(`missing ${legacy}`);
  const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8'));
  // index.json is an object wrapper ({_truncated, _count, rows}) so the marker
  // survives serialisation; accept a bare array from older builds too.
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.rows)) return parsed.rows;
  throw new Error(`${legacy}: expected {rows:[...]} or [...]`);
}

/** 'persons' | 'things' | ... -> singular type, or throw. */
function typeOf(folder) {
  if (!FOLDERS[folder]) throw new Error(`unknown folder ${folder}`);
  return FOLDERS[folder];
}

function allFolders() {
  return [...ALL_FOLDERS];
}

module.exports = { readEntities, readIndexRows, typeOf, allFolders, FOLDERS, DATA_ROOT };
