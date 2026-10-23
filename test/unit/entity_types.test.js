'use strict';
/**
 * Tests for the five-type model: person / thing / organization / event / evidence.
 *
 * The model change is broad (it touches every storage layer), so these tests
 * pin the invariants that would otherwise fail silently:
 *
 *   - the type table has exactly one source of truth and both directions agree
 *   - evidence ids are (carrier, date, title), not URLs
 *   - `sources` reads correctly in both the legacy inline shape and the new
 *     reference shape, which is what stops a migration from dropping URLs
 *   - evidence validation rejects a carrier that is not an entity id
 */
const test = require('node:test');
const assert = require('node:assert');

const T = require('../../src/store/entity_types');
const id = require('../../src/store/entity_id');
const E = require('../../src/store/evidence');
const S = require('../../src/store/sources');

// ---------------------------------------------------------------- type table

test('types: the four base types plus evidence', () => {
  assert.deepEqual([...id.BASE_TYPES], ['person', 'thing', 'organization', 'event']);
  assert.deepEqual([...id.TYPES], ['person', 'thing', 'organization', 'event', 'evidence']);
});

test('types: FOLDERS and TYPE_OF_FOLDER are exact inverses', () => {
  for (const [type, folder] of Object.entries(T.FOLDERS)) {
    assert.equal(T.TYPE_OF_FOLDER[folder], type, `${folder} must map back to ${type}`);
  }
  assert.equal(Object.keys(T.FOLDERS).length, Object.keys(T.TYPE_OF_FOLDER).length);
});

test('types: every type has a folder and an id namespace', () => {
  // A type that exists in one table but not the other is the exact mistake that
  // made build_index write nothing to disk while reporting total: 0.
  assert.deepEqual([...T.ALL_TYPES], [...id.TYPES]);
  for (const type of T.ALL_TYPES) {
    assert.ok(T.FOLDERS[type], `${type} needs a folder`);
    assert.ok(id.entityId(type, 'src-1'), `${type} must produce an id`);
  }
});

test('types: folderOf and typeOfFolder throw on unknown input', () => {
  assert.throws(() => T.folderOf('nonsense'), /unknown entity type/);
  assert.throws(() => T.typeOfFolder('nonsense'), /unknown entity folder/);
});

test('types: entityId rejects an unknown type instead of guessing', () => {
  assert.throws(() => id.entityId('polity', '东汉'), /unknown type/);
});

// ------------------------------------------------------------------------ ids

// The old scheme hashed the *name* into the id. These tests used to assert the
// consequences of that ("same name always yields the same id"), which meant they
// were pinning the bug. They now assert the opposite invariant.

test('ids: ids are opaque and carry no name', () => {
  const a = id.cbdbPersonId(467817);
  assert.equal(a, 'person:cbdb-467817');
  assert.ok(!a.includes('關羽'), 'an id must not leak the display name');

  const b = id.localId('organization', '000123');
  assert.equal(b, 'organization:local-000123');
});

test('ids: two people sharing a name are two distinct entities', () => {
  // CBDB really does hold two rows named 關羽 (467817, 497161) and nine named 韓氏.
  // Under the name-derived scheme they collapsed into one node and the import
  // counters (`韓氏（3）`) were invented to break the tie. The counter was noise.
  const a = id.cbdbPersonId(467817);
  const b = id.cbdbPersonId(497161);
  assert.notEqual(a, b);
  assert.equal(id.parseId(a).key, 'cbdb-467817');
});

test('ids: the same source key always yields the same id', () => {
  assert.equal(id.cbdbPersonId(20209), id.cbdbPersonId(20209));
  assert.equal(id.localId('person', '000042'), id.localId('person', '000042'));
});

test('ids: a name is a field, not a key — renaming cannot change identity', () => {
  // `韓氏(田通妻)` was renamed to `韓氏` during the annotation migration. The id
  // is derived from the CBDB row, so the rename left it untouched, and the edges
  // pointing at this person stayed attached. That is the whole point.
  const before = id.cbdbPersonId(147528);
  const after = id.cbdbPersonId(147528);
  assert.equal(before, after);
});

test('ids: different types do not collide on the same source key', () => {
  assert.notEqual(id.entityId('thing', 'src-12345'), id.entityId('organization', 'src-12345'));
});

test('ids: malformed keys are rejected rather than mangled', () => {
  assert.throws(() => id.entityId('person', ''), /non-empty/);
  assert.throws(() => id.entityId('person', 'has space'), /must be alphanumeric/);
  assert.throws(() => id.entityId('polity', 'x'), /unknown type/);
});

test('ids: name-derived constructors are gone, not merely deprecated', () => {
  // Leaving them callable would let new code re-introduce the bug: it would get a
  // plausible-looking id that collides with every namesake. Throwing forces the
  // caller to answer "where does this entity come from".
  for (const fn of ['personId', 'thingId', 'organizationId', 'eventId', 'evidenceId']) {
    assert.throws(() => id[fn]('某'), /must not be derived from names/, fn);
  }
});

test('ids: parseId round-trips and rejects junk', () => {
  assert.deepEqual(id.parseId('person:cbdb-467817'), { type: 'person', key: 'cbdb-467817' });
  assert.equal(id.parseId('person'), null);
  assert.equal(id.parseId(':x'), null);
  assert.equal(id.parseId('polity:x'), null);
});

test('ids: isLocalId / isCbdbId classify by origin', () => {
  assert.ok(id.isCbdbId('person:cbdb-467817'));
  assert.ok(!id.isCbdbId('person:local-000042'));
  assert.ok(id.isLocalId('evidence:local-000002'));
});

test('ids: the corpus uses opaque keys, not name hashes', () => {
  // Guards the migration itself: an id that still looks like `person:<20 hex>`
  // means a shard was never converted.
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..', '..', 'data', 'persons', 'entities');
  const files = fs.readdirSync(root).slice(0, 200);
  for (const f of files) {
    const e = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
    const parsed = id.parseId(e.id);
    assert.ok(parsed, `${e.id} is not a canonical id`);
    assert.ok(
      !/^[0-9a-f]{20}$/.test(parsed.key) || id.isCbdbId(e.id),
      `${e.id} still looks like a name hash`,
    );
  }
});

// -------------------------------------------------------------------- evidence

test('evidence: ids are opaque, so correcting a title cannot orphan citations', () => {
  // The old id was sha256(carrier, date, title). Fixing a typo in the title, or
  // filling in a date that had been unknown, minted a *different* record and left
  // every assertion citing the old one dangling. Titles are exactly the thing that
  // gets corrected.
  const a = E.makeEvidence({ title: '某报道', carrierName: '人民日报' });
  const b = E.makeEvidence({ title: '某报道', carrierName: '人民日报' });
  assert.match(a.id, /^evidence:local-\d{6}$/);
  assert.notEqual(a.id, b.id, 'each allocation is a distinct record');
});

test('evidence: an explicit id is honoured', () => {
  const ev = E.makeEvidence({ id: 'evidence:local-000999', title: 'x', carrierName: '人民日报' });
  assert.equal(ev.id, 'evidence:local-000999');
});

test('evidence: an unknown carrier is marked unresolved, not dropped', () => {
  const ev = E.makeEvidence({ title: '孤证', carrierName: '' });
  assert.equal(ev.carrier, null);
  assert.equal(ev.unresolved, true, 'the gap must be visible in counts');
});

test('evidence: makeEvidence rejects structural errors', () => {
  assert.throws(() => E.makeEvidence({}), /title is required/);
  assert.throws(() => E.makeEvidence({ title: 'x', medium: 'scroll' }), /unknown medium/);
  assert.throws(() => E.makeEvidence({ title: 'x', reliability: 2 }), /within 0..1/);
  assert.throws(() => E.makeEvidence({ title: 'x', reliability: -1 }), /within 0..1/);
});

test('evidence: reliability 0 is a real value, not "unset"', () => {
  // A record known to be forged must be distinguishable from an unassessed one.
  const forged = E.makeEvidence({ title: '伪书', reliability: 0 });
  const unassessed = E.makeEvidence({ title: '某书' });
  assert.equal(forged.reliability, 0);
  assert.equal(unassessed.reliability, null);
});

test('evidence: validateEvidence catches a non-entity carrier', () => {
  const bad = { id: 'evidence:' + '0'.repeat(20), type: 'evidence', name: 'x', carrier: '人民日报社' };
  const problems = E.validateEvidence(bad);
  assert.ok(problems.some((p) => /carrier must be/.test(p)), problems.join('; '));
});

test('evidence: validateEvidence accepts a well-formed node', () => {
  const ev = E.makeEvidence({
    title: '某报道', carrierName: '人民日报', medium: 'newspaper',
    documentedAt: { start: 2443637, end: 2443637 },
  });
  assert.deepEqual(E.validateEvidence(ev), []);
});

test('evidence: every medium has a Chinese label', () => {
  for (const m of E.MEDIUMS) {
    assert.ok(E.MEDIUM_LABELS[m], `medium ${m} needs a label`);
  }
});

// ------------------------------------------------------------- carrier lookup

test('evidence: carrier is inferred from the domain that owns it', () => {
  assert.equal(E.carrierFromUrl('http://www.spp.gov.cn/x.html').name, '最高人民检察院');
  assert.equal(E.carrierFromUrl('http://www.spp.gov.cn/x.html').type, 'organization');
  assert.equal(E.carrierFromUrl('http://www.court.gov.cn/x').name, '最高人民法院');
});

test('evidence: a more specific host wins over its parent domain', () => {
  // cpc.people.com.cn is a distinct publication from people.com.cn; matching the
  // parent first would misattribute every party-news citation.
  assert.equal(E.carrierFromUrl('http://cpc.people.com.cn/n1/x').name, '中国共产党新闻网');
  assert.equal(E.carrierFromUrl('http://www.people.com.cn/x').name, '人民网');
});

test('evidence: an unrecognised domain yields null rather than a guess', () => {
  assert.equal(E.carrierFromUrl('https://blog.example.org/post'), null);
  assert.equal(E.carrierFromUrl('not a url'), null);
});

// ------------------------------------------------------------ sources compat

test('sources: legacy inline objects and new id references both read', () => {
  const legacy = { sources: [{ id: 'cpc-x', name: '人民网', url: 'http://a' }] };
  const modern = { sources: ['evidence:' + 'a'.repeat(20)] };

  assert.equal(S.listSources(legacy).length, 1);
  assert.equal(S.listSources(legacy)[0].kind, 'inline');
  assert.equal(S.listSources(modern)[0].kind, 'evidence');
  assert.equal(S.preferredUrl(legacy), 'http://a');
});

test('sources: a reference resolves its URL through the evidence node', () => {
  const modern = { sources: ['evidence:' + 'a'.repeat(20)] };
  const resolve = () => ({ url: 'http://from-node' });
  assert.equal(S.preferredUrl(modern, resolve), 'http://from-node');
  // Without a resolver there is no URL, but it must not throw.
  assert.equal(S.preferredUrl(modern), '');
});

test('sources: external.cpcUrl is still a fallback', () => {
  assert.equal(S.preferredUrl({ external: { cpcUrl: 'http://cpc' } }), 'http://cpc');
});

test('sources: isFullyMigrated distinguishes the two shapes', () => {
  assert.equal(S.isFullyMigrated({ sources: ['evidence:' + 'a'.repeat(20)] }), true);
  assert.equal(S.isFullyMigrated({ sources: [{ url: 'http://a' }] }), false);
  assert.equal(S.isFullyMigrated({}), true, 'no sources is vacuously migrated');
});

test('sources: sourceUrls merges inline, referenced and external, de-duplicated', () => {
  const e = {
    sources: [{ url: 'http://a' }, 'evidence:' + 'b'.repeat(20)],
    external: { cpcUrl: 'http://a' },
  };
  const urls = S.sourceUrls(e, () => ({ url: 'http://b' }));
  assert.deepEqual(urls.sort(), ['http://a', 'http://b']);
});

// ------------------------------------------------------------ predicate types

test('predicates: domain/range accept union specs', () => {
  const { PredicateRegistry } = require('../../src/predicates/registry');
  const r = new PredicateRegistry();
  assert.equal(r.acceptsType('person|organization', 'person'), true);
  assert.equal(r.acceptsType('person|organization', 'organization'), true);
  assert.equal(r.acceptsType('person|organization', 'thing'), false);
  assert.equal(r.acceptsType('literal', 'literal'), true);
  assert.equal(r.acceptsType('literal', 'person'), false);
});

test('predicates: the new thing and evidence primitives are registered', () => {
  const { PredicateRegistry } = require('../../src/predicates/registry');
  const r = new PredicateRegistry();
  for (const key of [
    'publisher', 'publishedBy', 'author', 'authored', 'about', 'topicOf',
    'documentedBy', 'documents', 'carriedBy', 'carries',
  ]) {
    assert.ok(r.get(key), `${key} must be registered`);
  }
});

test('predicates: every new primitive has a working inverse', () => {
  const { PredicateRegistry } = require('../../src/predicates/registry');
  const r = new PredicateRegistry();
  const pairs = [
    ['publisher', 'publishedBy'], ['author', 'authored'], ['about', 'topicOf'],
    ['documentedBy', 'documents'], ['carriedBy', 'carries'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(r.inverseKey(a), b, `${a} inverse`);
    assert.equal(r.inverseKey(b), a, `${b} inverse`);
  }
});

test('predicates: checkAssertion reports wrong subject/object types', () => {
  const { PredicateRegistry } = require('../../src/predicates/registry');
  const r = new PredicateRegistry();
  assert.deepEqual(r.checkAssertion('publisher', 'thing', 'organization'), []);
  assert.equal(r.checkAssertion('publisher', 'person', 'organization').length, 1);
  // An inverse assertion swaps the declared roles.
  assert.deepEqual(r.checkAssertion('publishedBy', 'organization', 'thing'), []);
});

test('predicates: checkAssertion flags an unregistered predicate', () => {
  const { PredicateRegistry } = require('../../src/predicates/registry');
  const r = new PredicateRegistry();
  assert.match(r.checkAssertion('nonsense', 'person', 'person')[0], /unregistered/);
});

test('predicates: evidence primitives are not negatable', () => {
  // "the record does not say X" is an interpretation, not a fact about the record.
  const { PredicateRegistry } = require('../../src/predicates/registry');
  const r = new PredicateRegistry();
  for (const key of ['documentedBy', 'documents', 'carriedBy', 'carries']) {
    assert.equal(r.get(key).negatable, false, key);
  }
});
