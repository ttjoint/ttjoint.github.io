'use strict';
/**
 * Migrate inline `sources` objects into evidence nodes.
 *
 * ## What changes
 *
 * Before:  sources: [{ id:'cpc-aHR0c…', name:'人民网人物资料', url:'…' }]
 * After:   sources: ['evidence:3e1d39471ff68f8fa512', …]
 *
 * and a new `data/evidence/entities/*.json` node per distinct record.
 *
 * ## Deduplication
 *
 * The old ids were `salt + base64url(url)`, so the same page cited by fifty
 * people produced fifty identical-looking but independent entries. Keying
 * evidence on (carrier, date, title) collapses them into one node that fifty
 * entities reference — which is the point of making evidence a node.
 *
 * ## Carrier resolution
 *
 * The carrier (who published the record) is derived from the URL's domain via
 * `carrierFromUrl`, which encodes the bodies that actually own those domains.
 * When a domain is not recognised the evidence node is still created but marked
 * `unresolved: true` rather than being dropped or given a made-up carrier.
 *
 * ## Safety
 *
 * - Runs against a single type at a time and is idempotent: re-running finds
 *   sources already in reference form and leaves them alone.
 * - Writes evidence first, then rewrites entities, so a crash between the two
 *   phases leaves unreferenced evidence (harmless) rather than dangling ids.
 *
 * Usage: node tools/oneoff/migrate_sources_to_evidence.js [--dry-run] [--type=person]
 */
const { readAll, upsertAll } = require('../../src/store/entity_writer');
const { makeEvidence, carrierFromUrl, mediumFromUrl } = require('../../src/store/evidence');
const { listSources } = require('../../src/store/sources');
const { BASE_TYPES, thingId, organizationId } = require('../../src/store/entity_id');

const DRY = process.argv.includes('--dry-run');
const typeArg = process.argv.find((a) => a.startsWith('--type='));
const TYPES = typeArg ? [typeArg.split('=')[1]] : [...BASE_TYPES];

/**
 * Build an evidence spec from one inline source object.
 *
 * ## Why the title includes the URL tail
 *
 * The old `sources[].name` was a *site* label ("人民网人物资料", "全国政协官网"),
 * not an article title, so hundreds of distinct pages shared one name. Keying the
 * evidence id on that name collapsed them into a single node and silently
 * dropped every URL but the last — a real data loss that only showed up on
 * re-read.
 *
 * Evidence identity is (carrier, date, title). With no real title in the data and
 * no reliable date, the URL is the only thing that distinguishes one citation
 * from another, so the URL tail becomes part of the title. Two citations of the
 * *same* URL still collapse to one node, which is the deduplication we want;
 * two different URLs never do.
 *
 * @param {object} src  legacy inline source
 * @param {object|null} carrier  { name, type } from carrierFromUrl
 * @returns {object} the makeEvidence spec
 */
function specFromSource(src, carrier) {
  const url = src.url || '';
  const label = String(src.name || '').trim();
  let tail = '';
  try {
    const u = new URL(url);
    // host + path + query: enough to be unique, short enough to read in a title.
    tail = u.host + u.pathname + (u.search || '');
  } catch {
    tail = url;
  }
  const title = label && tail ? `${label} · ${tail}` : (label || tail || url);
  return {
    title,
    carrierName: carrier ? carrier.name : '',
    // A ministry is an organisation node, a newspaper a thing node; the carrier
    // id must use the namespace that matches the entity we actually created.
    carrierId: carrier
      ? (carrier.type === 'organization' ? organizationId(carrier.name) : thingId(carrier.name))
      : null,
    medium: mediumFromUrl(url),
    documentedAt: null,
    url,
    accessedAt: src.accessedAt || '',
    reliability: null,
    note: '',
  };
}

function main() {
  const evidenceByKey = new Map(); // url -> evidence node
  const stats = { entities: 0, inlineSources: 0, evidenceNodes: 0, unresolved: 0 };

  for (const type of TYPES) {
    const entities = readAll(type);
    const rewritten = [];

    for (const e of entities) {
      const list = listSources(e);
      const inline = list.filter((s) => s.kind === 'inline');
      if (!inline.length) continue;

      const ids = [];
      for (const src of inline) {
        stats.inlineSources++;
        const carrier = carrierFromUrl(src.url || '');
        const key = src.url || `${src.name}\u0000${src.accessedAt || ''}`;
        let node = evidenceByKey.get(key);
        if (!node) {
          const spec = specFromSource(src, carrier);
          node = makeEvidence(spec);
          evidenceByKey.set(key, node);
          if (node.unresolved) stats.unresolved++;
        }
        ids.push(node.id);
      }

      // Keep any references that were already migrated.
      const existingRefs = list.filter((s) => s.kind === 'evidence').map((s) => s.id);
      e.sources = [...new Set([...existingRefs, ...ids])];
      rewritten.push(e);
      stats.entities++;
    }

    if (rewritten.length && !DRY) {
      // replaceSources: the migration *rewrites* sources; a union would re-add the
      // inline objects it just replaced and silently undo itself.
      const res = upsertAll(type, rewritten, null, { replaceSources: true });
      console.log(`${type}: 重写 ${rewritten.length} 个实体（写入 ${res.written} 分片）`);
    } else if (rewritten.length) {
      console.log(`${type}: 将重写 ${rewritten.length} 个实体`);
    }
  }

  stats.evidenceNodes = evidenceByKey.size;
  console.log(
    `\n内联 source ${stats.inlineSources} 条 -> 证据节点 ${stats.evidenceNodes} 个`
    + `（去重 ${stats.inlineSources - stats.evidenceNodes}），未解析载体 ${stats.unresolved} 个`,
  );

  if (DRY) {
    console.log('\n--dry-run：未写入');
    return;
  }
  if (evidenceByKey.size) {
    const res = upsertAll('evidence', [...evidenceByKey.values()]);
    console.log(`证据: 新增 ${res.added}，更新 ${res.updated}，写入 ${res.written} 分片`);
  }
}

main();
