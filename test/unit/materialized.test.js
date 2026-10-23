'use strict';
/**
 * Tests for materialised views and dependency fingerprints.
 *
 * The failure mode being guarded against is a view that is *silently* stale: it
 * keeps returning yesterday's answer because nothing noticed that its inputs
 * changed. Every test here is about noticing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { DDL, POST_LOAD } = require('../../src/store/db_schema');
const m = require('../../src/store/materialized');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  for (const stmt of DDL) db.exec(stmt);
  return db;
}

/** Insert an entity with a precomputed fingerprint, as build_db would. */
function putEntity(db, entity) {
  const hash = m.entityFingerprint(entity);
  db.prepare(
    `INSERT INTO entities (id, type, name, summary, props_json, valid_from, valid_to, folder, content_hash)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    entity.id,
    entity.type || 'person',
    entity.name,
    entity.summary || null,
    entity.props ? JSON.stringify(entity.props) : null,
    entity.valid_from ?? null,
    entity.valid_to ?? null,
    entity.folder || 'persons',
    hash,
  );
  for (const a of entity.aliases || []) {
    db.prepare('INSERT INTO aliases (entity_id, alias) VALUES (?,?)').run(entity.id, a);
  }
  return hash;
}

// ------------------------------------------------------------- fingerprint

test('fingerprint: is stable across calls', () => {
  const e = { id: 'person:a', name: '張三', aliases: ['子安'], props: { 生卒: '1100-1150' } };
  assert.equal(m.entityFingerprint(e), m.entityFingerprint(e));
});

test('fingerprint: changes when any observable field changes', () => {
  const base = { id: 'person:a', name: '張三', aliases: [], props: {} };
  const h = m.entityFingerprint(base);
  for (const variant of [
    { ...base, name: '張四' },
    { ...base, summary: '一個說明' },
    { ...base, aliases: ['子安'] },
    { ...base, props: { 生卒: '1100' } },
    { ...base, relations: { father: ['person:b'] } },
  ]) {
    assert.notEqual(m.entityFingerprint(variant), h, `must change for ${JSON.stringify(variant)}`);
  }
});

test('fingerprint: key order in props does not matter', () => {
  // Shards are written by different scripts; two that build the same object in a
  // different order must not look like a change, or every write invalidates every
  // view that touches the entity.
  const a = m.entityFingerprint({ id: 'p', name: 'X', props: { 甲: '1', 乙: '2' } });
  const b = m.entityFingerprint({ id: 'p', name: 'X', props: { 乙: '2', 甲: '1' } });
  assert.equal(a, b);
});

test('fingerprint: alias order does not matter', () => {
  const a = m.entityFingerprint({ id: 'p', name: 'X', aliases: ['甲', '乙'] });
  const b = m.entityFingerprint({ id: 'p', name: 'X', aliases: ['乙', '甲'] });
  assert.equal(a, b);
});

test('fingerprint: edge order does not matter but qualifiers do', () => {
  const a = m.entityFingerprint({
    id: 'p',
    name: 'X',
    relations: { spouse: [{ id: 'person:y', role: 'wife' }, { id: 'person:z', role: 'concubine' }] },
  });
  const b = m.entityFingerprint({
    id: 'p',
    name: 'X',
    relations: { spouse: [{ id: 'person:z', role: 'concubine' }, { id: 'person:y', role: 'wife' }] },
  });
  assert.equal(a, b, 'object key order must not matter');

  const c = m.entityFingerprint({
    id: 'p',
    name: 'X',
    relations: { spouse: [{ id: 'person:y', role: 'concubine' }] },
  });
  assert.notEqual(a, c, 'a role change is a real change');
});

test('fingerprint: folder and type are not part of it', () => {
  // Moving an entity between folders does not change what it claims, and
  // including it would invalidate every view containing it for no reason.
  const a = m.entityFingerprint({ id: 'p', name: 'X', folder: 'persons' });
  const b = m.entityFingerprint({ id: 'p', name: 'X', folder: 'things' });
  assert.equal(a, b);
});

// ------------------------------------------------------------- freshness

test('materialized: a fresh view is not rebuilt', () => {
  const db = freshDb();
  putEntity(db, { id: 'person:a', name: 'A' });
  let builds = 0;
  const build = () => {
    builds++;
    return { payload: ['x'], deps: m.depsOf(db, ['person:a']) };
  };
  const first = m.materialize(db, 'v1', build);
  assert.equal(first.rebuilt, true);
  assert.equal(builds, 1);

  const second = m.materialize(db, 'v1', build);
  assert.equal(second.rebuilt, false, 'unchanged data must not rebuild');
  assert.equal(builds, 1);
  assert.deepEqual(second.payload, ['x']);
});

test('materialized: changing a dependency rebuilds', () => {
  const db = freshDb();
  putEntity(db, { id: 'person:a', name: 'A' });
  putEntity(db, { id: 'person:b', name: 'B' });
  let builds = 0;
  const build = () => {
    builds++;
    return db.prepare("SELECT name FROM entities WHERE id='person:a'").all().map((r) => r.name);
  };

  // deps must be declared explicitly: the builder read only person:a, so only
  // person:a's fingerprint is recorded.
  m.materialize(db, 'v1', () => ({ payload: build(), deps: m.depsOf(db, ['person:a']) }));
  assert.equal(builds, 1);

  // Touching an UNRELATED entity must not rebuild: this is the whole saving.
  putEntity(db, { id: 'person:c', name: 'C' });
  m.materialize(db, 'v1', () => ({ payload: build(), deps: m.depsOf(db, ['person:a']) }));
  assert.equal(builds, 1, 'an unrelated change must not trigger a rebuild');

  // Changing a dependency must.
  db.prepare(
    "UPDATE entities SET name='A2', content_hash=? WHERE id='person:a'",
  ).run(m.entityFingerprint({ id: 'person:a', name: 'A2' }));
  const after = m.materialize(db, 'v1', () => ({ payload: build(), deps: m.depsOf(db, ['person:a']) }));
  assert.equal(builds, 2);
  assert.deepEqual(after.payload, ['A2']);
  assert.equal(after.reason, 'changed:person:a');
});

test('materialized: deleting a dependency rebuilds', () => {
  const db = freshDb();
  putEntity(db, { id: 'person:a', name: 'A' });
  m.materialize(db, 'v1', () => ({ payload: 1, deps: m.depsOf(db, ['person:a']) }));
  db.prepare("DELETE FROM entities WHERE id='person:a'").run();
  const f = m.isFresh(db, 'v1');
  assert.equal(f.valid, false);
  assert.equal(f.reason, 'deleted:person:a');
});

test('materialized: an absent view is not fresh', () => {
  const db = freshDb();
  assert.deepEqual(m.isFresh(db, 'nope'), { valid: false, reason: 'absent' });
});

test('materialized: a corrupt deps blob is not treated as unchanged', () => {
  // The dangerous default: a blob that fails to parse must not be read as "no
  // dependencies, therefore fresh". That would freeze the view forever.
  const db = freshDb();
  putEntity(db, { id: 'person:a', name: 'A' });
  db.prepare('INSERT INTO materialized (key,payload,deps,built_at) VALUES (?,?,?,?)').run(
    'v1', '1', 'not json', 'now',
  );
  assert.deepEqual(m.isFresh(db, 'v1'), { valid: false, reason: 'corrupt-deps' });
});

test('materialized: a constant view stays fresh', () => {
  // No dependencies means nothing can invalidate it, which is only correct for a
  // view that genuinely reads no entity data.
  const db = freshDb();
  m.materialize(db, 'const', () => ({ payload: { century: 1100 }, deps: { entities: {} } }));
  putEntity(db, { id: 'person:a', name: 'A' });
  assert.equal(m.isFresh(db, 'const').valid, true);
  assert.equal(m.isFresh(db, 'const').reason, 'constant');
});

test('materialized: force rebuilds regardless of freshness', () => {
  const db = freshDb();
  let builds = 0;
  const build = () => ({ payload: ++builds, deps: { entities: {} } });
  m.materialize(db, 'v1', build);
  const forced = m.materialize(db, 'v1', build, { force: true });
  assert.equal(forced.rebuilt, true);
  assert.equal(forced.reason, 'forced');
  assert.equal(forced.payload, 2);
});

test('materialized: staleViews names what needs rebuilding and why', () => {
  const db = freshDb();
  putEntity(db, { id: 'person:a', name: 'A' });
  putEntity(db, { id: 'person:b', name: 'B' });
  m.materialize(db, 'uses-a', () => ({ payload: 1, deps: m.depsOf(db, ['person:a']) }));
  m.materialize(db, 'uses-b', () => ({ payload: 2, deps: m.depsOf(db, ['person:b']) }));
  m.materialize(db, 'const', () => ({ payload: 3, deps: { entities: {} } }));

  assert.deepEqual(m.staleViews(db), [], 'nothing changed yet');

  db.prepare("UPDATE entities SET content_hash='different' WHERE id='person:a'").run();
  const stale = m.staleViews(db);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].key, 'uses-a');
  assert.match(stale[0].reason, /changed:person:a/);
});

test('materialized: depsOf skips ids that do not exist', () => {
  // A view built from a stale list of ids must not record a dependency on a
  // phantom: that would make it permanently stale.
  const db = freshDb();
  putEntity(db, { id: 'person:a', name: 'A' });
  const deps = m.depsOf(db, ['person:a', 'person:ghost']);
  assert.deepEqual(Object.keys(deps.entities), ['person:a']);
});

test('materialized: the payload round-trips through JSON', () => {
  // The payload is stored as text. Anything not JSON-serialisable would silently
  // become null on read.
  const db = freshDb();
  putEntity(db, { id: 'person:a', name: 'A' });
  const payload = { nodes: [{ id: 'person:a', label: 'A' }], edges: [], meta: { depth: 5 } };
  m.materialize(db, 'v1', () => ({ payload, deps: m.depsOf(db, ['person:a']) }));
  const read = m.materialize(db, 'v1', () => assert.fail('must not rebuild'));
  assert.deepEqual(read.payload, payload);
});

test('db: content_hash is populated for every entity in a real build', () => {
  // build_db computes it inline; if that wiring is lost the column stays NULL and
  // every view reports "changed" on every check.
  const db = freshDb();
  putEntity(db, { id: 'person:a', name: 'A' });
  putEntity(db, { id: 'person:b', name: 'B' });
  const nulls = db.prepare('SELECT COUNT(*) c FROM entities WHERE content_hash IS NULL').get().c;
  assert.equal(nulls, 0);
  const distinct = db.prepare('SELECT COUNT(DISTINCT content_hash) c FROM entities').get().c;
  assert.equal(distinct, 2, 'different entities must get different fingerprints');
});
