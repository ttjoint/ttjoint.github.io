#!/usr/bin/env node
'use strict';
/**
 * Validate entity identity and shape.
 *
 * Reads the complete entity set via src/store/data_reader.js. It used to read
 * `data/<type>/index.json`, which is now a truncated compatibility file, so this
 * previously checked only the first index page without reporting that.
 */
const { readEntities, allFolders, typeOf } = require('../src/store/data_reader');
const { isHollow, wasWrittenFromIndex } = require('../src/store/entity_shape');

let errors = 0;
let total = 0;

function fail(msg) {
  console.error('  ERROR ' + msg);
  errors++;
}

/**
 * Fields that only `build_index.js` may produce.
 *
 * An index row is a SUMMARY: `detail` is the pointer back to the shard it was
 * derived from. Finding `detail` inside a shard means the shard was written from
 * an index row rather than from an entity, which is exactly how 5269 shards lost
 * their props (see the note in .gitignore). The field is meaningless in the
 * authoritative store and its presence is proof of that round trip.
 */
const GENERATED_FIELDS = ['detail'];

for (const folder of allFolders()) {
  const type = typeOf(folder);
  const entities = readEntities(folder);
  total += entities.length;
  const hollow = [];
  const gaps = [];
  const ids = new Set();
  for (const x of entities) {
    if (!x || !x.id) {
      fail(`${folder}: entity without id`);
      continue;
    }
    if (ids.has(x.id)) fail(`${folder}: duplicate id ${x.id}`);
    ids.add(x.id);

    // Ids must be `type:hash` so renaming an entity cannot change its key.
    if (!x.id.includes(':')) fail(`${folder}: unstable id ${x.id}`);
    const prefix = String(x.id).split(':')[0];
    if (prefix !== type) fail(`${folder}: id ${x.id} has type prefix '${prefix}', expected '${type}'`);

    if (!x.name || !String(x.name).trim()) fail(`${folder}: ${x.id} has no name`);
    if (x.type && x.type !== type) fail(`${folder}: ${x.id} declares type '${x.type}' but lives in ${folder}`);
    if (x.relations && typeof x.relations !== 'object') fail(`${folder}: ${x.id} relations must be an object`);
    if (x.props && typeof x.props !== 'object') fail(`${folder}: ${x.id} props must be an object`);

    for (const field of GENERATED_FIELDS) {
      if (field in x) {
        fail(`${folder}: ${x.id} carries generated field '${field}' — the shard was written from an index row, not an entity`);
      }
    }

    // A shard with no content at all is either damage or a data gap. The two are
    // not distinguishable from the entity alone, so the reproducible proof is
    // used: `detail` in a shard can only come from an index row. Everything else
    // hollow is reported as a gap to fill, not as a failure.
    if (isHollow(x, type)) {
      if (wasWrittenFromIndex(x)) hollow.push(x.name || x.id);
      else gaps.push(x.name || x.id);
    }
  }

  console.log(`${folder}: ${entities.length} entities, ${ids.size} unique ids`);

  if (hollow.length) {
    // One line per empty shard would bury the real signal at 5k entities, so
    // report the count and a sample that can be inspected.
    fail(`${folder}: ${hollow.length}/${entities.length} entities were written from index rows and lost their content (e.g. ${hollow.slice(0, 5).join(', ')})`);
  }
  if (gaps.length) {
    // Not a failure: these were entered with only a name. Reported so
    // the gap stays visible instead of being found later as "some pages are
    // blank", and so the number cannot quietly grow.
    console.warn(`  WARN ${folder}: ${gaps.length}/${entities.length} entities have no props yet (e.g. ${gaps.slice(0, 5).join(', ')})`);
  }
}

if (errors) {
  console.error(`\nvalidate_data: ${total} entities checked, ${errors} error(s)`);
} else {
  console.log(`validate_data: ${total} entities OK`);
}
process.exitCode = errors ? 1 : 0;
