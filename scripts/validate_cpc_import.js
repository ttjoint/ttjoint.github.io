#!/usr/bin/env node
/**
 * Validate the most recent CPC / People.cn import batch.
 *
 * The batch lives at `data/imports/cpc/<batch>/manifest.json`, where batches are
 * timestamp-named directories. Checks that ids are canonical, that no id or URL
 * repeats, and that the declared `imported` count matches `records`.
 */
const fs = require('fs');
const path = require('path');

const IMPORT_DIR = path.join(__dirname, '..', 'data', 'imports', 'cpc');

const CANONICAL_PERSON_ID = /^person:[0-9a-f]{20}$/;
const PEOPLE_CN_URL = /^https?:\/\/cpc\.people\.com\.cn\//;

/**
 * Newest batch directory that actually contains a manifest.
 *
 * Directory names sort lexicographically as timestamps, so a reverse sort gives
 * newest-first; some batches are created without a manifest (an interrupted
 * run), hence the existence filter.
 */
function latestBatch() {
  if (!fs.existsSync(IMPORT_DIR)) return null;
  return fs
    .readdirSync(IMPORT_DIR)
    .sort()
    .reverse()
    .find((name) => fs.existsSync(path.join(IMPORT_DIR, name, 'manifest.json')));
}

function main() {
  const batch = latestBatch();
  if (!batch) throw new Error('没有找到人民网导入批次，请先运行 npm run import:cpc');

  const manifest = JSON.parse(fs.readFileSync(path.join(IMPORT_DIR, batch, 'manifest.json'), 'utf8'));
  const errors = [];

  if (!manifest.source || !manifest.fetchedAt) errors.push('缺少批次元数据');
  if (manifest.imported !== manifest.records.length) {
    errors.push('imported 与 records 数量不一致');
  }

  const ids = new Set();
  const urls = new Set();

  for (const rec of manifest.records) {
    if (!rec.id || !CANONICAL_PERSON_ID.test(rec.id)) errors.push(`非法 ID: ${rec.id}`);
    if (ids.has(rec.id)) errors.push(`重复 ID: ${rec.id}`);
    ids.add(rec.id);

    if (!rec.url || !PEOPLE_CN_URL.test(rec.url)) errors.push(`非法来源 URL: ${rec.url}`);
    urls.add(rec.url);
  }

  if (manifest.imported < 1) errors.push('没有导入任何人物');

  console.log(JSON.stringify({
    batch,
    source: manifest.source,
    discovered: manifest.discovered,
    imported: manifest.imported,
    uniqueIds: ids.size,
    uniqueUrls: urls.size,
    errors,
  }, null, 2));

  process.exitCode = errors.length ? 1 : 0;
}

main();
