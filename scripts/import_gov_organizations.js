#!/usr/bin/env node
/**
 * Import reviewed official organization sources as organization entities.
 *
 * Only sources a human flipped to `enabled: true` in the discovery batch are
 * imported. They land with tag 待核验 so they are visibly provisional.
 */
const path = require('path');
const { readLatestBatch } = require('../src/store/batches');
const { entityId } = require('../src/store/entity_id');
const { orgKeyFromUrl } = require('../src/store/source_key');
const { readAll, upsertAll } = require('../src/store/entity_writer');

function main() {
  const { data: batch } = readLatestBatch('gov-org-', 'npm run discover:gov');

  const enabled = batch.sources.filter((s) => s.enabled);
  if (!enabled.length) {
    console.log('no enabled sources in batch; flip `enabled` after review');
    return;
  }

  const byId = new Map(readAll('organization').map((o) => [o.id, o]));

  for (const s of enabled) {
    // Canonical id keyed on the organization name, not the URL. Two different
    // pages for the same ministry must merge into one node; a URL-derived id
    // would fork them.
    const id = entityId('organization', orgKeyFromUrl(s.url || s.name));
    byId.set(id, {
      id,
      legacyId: s.name,
      name: s.name,
      type: 'organization',
      props: { 类型: '国务院组织机构目录来源', 官网: s.url },
      aliases: [],
      relations: {},
      sources: [{
        id: s.id,
        name: '中国政府网·国务院组织机构',
        url: batch.source,
        accessedAt: batch.discoveredAt,
        note: '由来源发现器生成，待人工核验',
      }],
      external: { officialUrl: s.url, status: 'unreviewed' },
    });
  }

  upsertAll('organization', [...byId.values()]);
  console.log(`imported ${enabled.length} reviewed organization sources`);
}

main();
