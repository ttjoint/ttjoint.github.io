#!/usr/bin/env node
/**
 * Import approved discovered official sources into the canonical source registry.
 *
 * Only sources a human flipped to `enabled: true` are registered. Existing ids
 * and URLs are skipped so re-running is safe.
 */
const fs = require('fs');
const path = require('path');
const { readLatestBatch } = require('../src/store/batches');

const CONFIG = path.join(__dirname, '..', 'data', 'sources', 'official.json');

function main() {
  const { data: batch } = readLatestBatch('gov-org-', 'npm run discover:gov');
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

  const ids = new Set(cfg.sources.map((s) => s.id));
  const urls = new Set(cfg.sources.map((s) => s.url));

  let added = 0;
  for (const s of batch.sources.filter((x) => x.enabled)) {
    if (ids.has(s.id) || urls.has(s.url)) continue;
    cfg.sources.push({ ...s, kind: 'official-organization-directory' });
    ids.add(s.id);
    urls.add(s.url);
    added++;
  }

  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`registered ${added} approved official sources`);
}

main();
