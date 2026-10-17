#!/usr/bin/env node
'use strict';
/**
 * Generate deterministic lightweight indexes from sharded entity detail files.
 *
 * The index is what the browser loads on startup, so it must stay small while
 * still carrying enough for list rendering and timeline filtering. That is why
 * `lifespan` (a compact JDN range) is included here but the heavy prose fields
 * are not — those live in the per-entity detail shards.
 */
const fs = require('fs');
const path = require('path');
const { lifespanFromProps, rangeFromProp } = require('../src/store/graph_source');

const ROOT = path.join(__dirname, '..', 'data');
const FOLDERS = { persons: 'person', organizations: 'organization', events: 'event' };

function summary(entity, type) {
  const props = entity.props || {};
  const lifespan = type === 'person'
    ? lifespanFromProps(props)
    : rangeFromProp(props['存在时间'] || props['成立时间'] || props['时间']);
  return {
    id: entity.id,
    name: entity.name || entity.legacyId || entity.id,
    type,
    aliases: entity.aliases || [],
    tags: entity.tags || [],
    summary: (props['简介'] || props['描述'] || '').slice(0, 240),
    // Present only when a date could be derived; the UI treats absence as
    // "undated" and hides the entity once a time window is active.
    lifespan: lifespan || null,
    external: entity.external || null,
    detail: `entities/${encodeURIComponent(entity.id)}.json`,
  };
}

let total = 0;
for (const [folder, type] of Object.entries(FOLDERS)) {
  const dir = path.join(ROOT, folder);
  const detail = path.join(dir, 'entities');
  if (!fs.existsSync(detail)) throw Error(`missing ${detail}`);

  const rows = fs.readdirSync(detail)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(detail, f), 'utf8')));

  const index = rows
    .map(x => summary(x, type))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh') || a.id.localeCompare(b.id));

  const dated = index.filter(r => r.lifespan).length;
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    version: 2,
    type,
    count: index.length,
    dated,
    generatedAt: new Date().toISOString(),
    index: 'index.json',
    detailDir: 'entities/',
  }, null, 2) + '\n');

  console.log(`${folder}: ${index.length} entries (${dated} dated)`);
  total += index.length;
}
console.log(`total: ${total}`);
