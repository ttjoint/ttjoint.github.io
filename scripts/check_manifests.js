#!/usr/bin/env node
'use strict';
/**
 * Verify that the generated indexes still describe the entity shards.
 *
 * Since the index is paged (see scripts/build_index.js), the manifest — not
 * `index.json` — is the source of truth. This checks the invariants that make
 * paging safe:
 *
 *   - page counts sum to the manifest count
 *   - each page file exists and holds exactly its advertised row count
 *   - page ids are unique and match the shard files on disk
 *   - chronology rows are all dated and sorted by JDN
 *   - every search bucket row points at a real shard, and the buckets together
 *     cover the corpus
 *
 * A hash of the sorted id list is printed per type so a run can be compared to
 * the previous one; the ids are what the data actually is, whereas a hash of a
 * page file would change merely by changing the page size.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const { ALL_FOLDERS } = require('../src/store/entity_types');
const DIRS = ALL_FOLDERS;
let errors = 0;

function fail(msg) {
  console.error('  ERROR ' + msg);
  errors++;
}

for (const dir of DIRS) {
  const base = path.join(ROOT, 'data', dir);
  const manifestPath = path.join(base, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    fail(`missing manifest ${manifestPath}`);
    continue;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.version || !manifest.type || !Number.isInteger(manifest.count)) {
    fail(`invalid manifest ${manifestPath}`);
    continue;
  }

  const detailDir = path.join(base, 'entities');
  const shards = new Set(
    fs.readdirSync(detailDir).filter((f) => f.endsWith('.json')).map((f) => decodeURIComponent(f.slice(0, -5))),
  );

  // --- pages -------------------------------------------------------------
  const ids = new Set();
  let pagedRows = 0;
  for (const page of manifest.pages || []) {
    const file = path.join(base, page.file);
    if (!fs.existsSync(file)) {
      fail(`${dir}: missing page ${page.file}`);
      continue;
    }
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (rows.length !== page.count) {
      fail(`${dir}: ${page.file} has ${rows.length} rows, manifest says ${page.count}`);
    }
    pagedRows += rows.length;
    for (const row of rows) {
      if (ids.has(row.id)) fail(`${dir}: duplicate id in pages: ${row.id}`);
      ids.add(row.id);
    }
  }
  if (pagedRows !== manifest.count) {
    fail(`${dir}: pages hold ${pagedRows} rows, manifest count is ${manifest.count}`);
  }

  // --- shard correspondence ---------------------------------------------
  let missingShard = 0;
  for (const id of ids) {
    if (!shards.has(id)) missingShard++;
  }
  if (missingShard) fail(`${dir}: ${missingShard} ids have no shard file`);
  if (shards.size !== ids.size) {
    fail(`${dir}: ${shards.size} shards on disk but ${ids.size} ids in the index`);
  }

  // --- chronology -------------------------------------------------------
  let chronoCount = 0;
  if (manifest.chronology) {
    const file = path.join(base, manifest.chronology);
    if (!fs.existsSync(file)) {
      fail(`${dir}: missing chronology ${manifest.chronology}`);
    } else {
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
      chronoCount = rows.length;
      if (rows.length !== manifest.dated) {
        fail(`${dir}: chronology has ${rows.length} rows, manifest says ${manifest.dated}`);
      }
      for (let i = 0; i < rows.length; i++) {
        if (typeof rows[i].mid !== 'number') fail(`${dir}: chronology row ${i} has no numeric mid`);
        if (i && rows[i - 1].mid > rows[i].mid) fail(`${dir}: chronology is not sorted at ${i}`);
        if (!ids.has(rows[i].id)) fail(`${dir}: chronology references unknown id ${rows[i].id}`);
      }
    }
  }

  // --- search buckets ---------------------------------------------------
  const bucketedIds = new Set();
  for (const bucket of (manifest.search && manifest.search.buckets) || []) {
    const file = path.join(base, bucket.file);
    if (!fs.existsSync(file)) {
      fail(`${dir}: missing search bucket ${bucket.file}`);
      continue;
    }
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (rows.length !== bucket.count) {
      fail(`${dir}: ${bucket.file} has ${rows.length} rows, manifest says ${bucket.count}`);
    }
    for (const row of rows) {
      if (!ids.has(row.id)) fail(`${dir}: search bucket references unknown id ${row.id}`);
      bucketedIds.add(row.id);
    }
  }
  if (bucketedIds.size !== manifest.count) {
    fail(`${dir}: search buckets cover ${bucketedIds.size} of ${manifest.count} entities`);
  }

  const hash = crypto.createHash('sha256')
    .update([...ids].sort().join('\n'))
    .digest('hex');
  console.log(
    `${dir}: ${manifest.count} records (${manifest.pages.length} page(s), `
    + `${chronoCount} dated, ${(manifest.search && manifest.search.buckets || []).length} bucket(s)), `
    + `id-sha256 ${hash.slice(0, 12)}`,
  );
}

process.exitCode = errors ? 1 : 0;
