'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { GraphStore, makeEdge } = require('../../src/core/graph.js');
const { PredicateRegistry } = require('../../src/predicates/registry.js');
const { QueryEngine, CONFIDENCE, ALL_CONFIDENCE } = require('../../src/core/query.js');
const J = require('../../src/time/julian.js');

function person(id, name, extra = {}) {
  return { id, type: 'person', name, aliases: [], tags: [], summary: '', ...extra };
}

function buildFixture() {
  const g = new GraphStore();
  const a = person('p:a', '甲', { lifespan: J.pointRange({ year: 1950, month: 1, day: 1, precision: 'exact' }) });
  const b = person('p:b', '乙', { lifespan: J.pointRange({ year: 1975, month: 1, day: 1, precision: 'exact' }) });
  const c = person('p:c', '丙', { lifespan: J.fuzzyRange(-1200, 400) });
  g.addNode(a); g.addNode(b); g.addNode(c);
  g.addNode({ id: 'o:x', type: 'organization', name: '某部' });
  return { g, a, b, c };
}

test('graph: edges are indexed in both directions', () => {
  const { g } = buildFixture();
  g.addEdge(makeEdge({ key: 'father', subject: 'p:a', object: 'p:b' }));
  assert.equal(g.outgoings('p:a').length, 1);
  assert.equal(g.incomings('p:b').length, 1);
  assert.equal(g.edgesByPredicate('father').length, 1);
  // Inverse lookup also finds it.
  assert.equal(g.edgesByPredicate('childOfFather').length, 1);
});

test('graph: parallel literal edges are preserved, not deduplicated away', () => {
  const { g } = buildFixture();
  g.addEdge(makeEdge({ key: 'memberOf', subject: 'p:a', object: '总理', literal: true, role: '总理' }));
  g.addEdge(makeEdge({ key: 'memberOf', subject: 'p:a', object: '党组书记', literal: true, role: '党组书记' }));
  g.addEdge(makeEdge({ key: 'memberOf', subject: 'p:a', object: '某部', literal: false, role: '部长' }));
  assert.equal(g.outgoings('p:a').length, 3, 'three distinct posts must survive');
});

test('graph: identical edges collapse via explicit dedupe counter', () => {
  const { g } = buildFixture();
  g.addEdge(makeEdge({ key: 'father', subject: 'p:a', object: 'p:b' }));
  g.addEdge(makeEdge({ key: 'father', subject: 'p:a', object: 'p:b' }));
  assert.equal(g.outgoings('p:a').length, 1);
  assert.equal(g.stats.skippedDuplicateEdges, 1);
});

test('graph: negated edges are hidden by default in neighbours', () => {
  const { g } = buildFixture();
  g.addEdge(makeEdge({ key: 'father', subject: 'p:a', object: 'p:b' }));
  g.addEdge(makeEdge({ key: 'father/negate', subject: 'p:c', object: 'p:b' }));
  assert.equal(g.neighbours('p:c').length, 0);
  assert.equal(g.neighbours('p:c', { includeNegated: true }).length, 1);
});

test('graph: neighbours include literal-valued assertions', () => {
  const { g } = buildFixture();
  g.addEdge(makeEdge({ key: 'gender', subject: 'p:a', object: '男', literal: true }));
  const ns = g.neighbours('p:a');
  assert.equal(ns.length, 1);
  assert.equal(ns[0].node.type, 'literal');
  assert.equal(ns[0].node.name, '男');
  assert.equal(ns[0].label, '性别');
});

test('graph: subgraph respects depth and time window', () => {
  const { g } = buildFixture();
  g.addEdge(makeEdge({ key: 'father', subject: 'p:a', object: 'p:b' }));
  g.addEdge(makeEdge({ key: 'father', subject: 'p:b', object: 'p:c' }));
  const d1 = g.subgraph('p:a', { depth: 1 });
  assert.equal(d1.nodes.length, 2);
  const d2 = g.subgraph('p:a', { depth: 2 });
  assert.equal(d2.nodes.length, 3);
});

test('query: nodeInWindow honours the three confidence buckets', () => {
  const { g } = buildFixture();
  const q = new QueryEngine(g);
  // 甲/乙 are precise to the day; 丙 is a wide fuzzy point; 某部 carries no dates.
  const exactOnly = q.search({ confidence: new Set([CONFIDENCE.EXACT]) });
  assert.deepEqual(exactOnly.map(n => n.name).sort(), ['乙', '甲'].sort());
  const vagueOnly = q.search({ confidence: new Set([CONFIDENCE.VAGUE]) });
  assert.deepEqual(vagueOnly.map(n => n.name), ['丙']);
  // Asking for every bucket is equivalent to "no date filter", so undated nodes
  // (某部) reappear alongside the dated ones.
  const all = q.search({ confidence: ALL_CONFIDENCE });
  assert.deepEqual(all.map(n => n.name).sort(), ['丙', '乙', '某部', '甲'].sort());
});

test('query: time window narrows results by lifespan overlap', () => {
  const { g } = buildFixture();
  const q = new QueryEngine(g);
  const modern = q.search({
    lo: J.julianToJdn(1940, 1, 1),
    hi: J.julianToJdn(1960, 1, 1),
    confidence: ALL_CONFIDENCE,
  });
  assert.deepEqual(modern.map(n => n.name), ['甲']);
});

test('query: free text matches name, alias and summary', () => {
  const { g } = buildFixture();
  g.addNode(person('p:z', '张三', { aliases: ['张先生'], summary: '某地人' }));
  const q = new QueryEngine(g);
  assert.deepEqual(q.search({ text: '张三' }).map(n => n.name), ['张三']);
  assert.deepEqual(q.search({ text: '张先生' }).map(n => n.name), ['张三']);
  assert.deepEqual(q.search({ text: '某地' }).map(n => n.name), ['张三']);
});

test('query: predicate filter restricts to nodes participating in that relation', () => {
  const { g } = buildFixture();
  g.addEdge(makeEdge({ key: 'father', subject: 'p:a', object: 'p:b' }));
  const q = new QueryEngine(g);
  const hits = q.search({ predicates: ['父亲'] });
  assert.deepEqual(hits.map(n => n.name).sort(), ['乙', '甲'].sort());
});

test('query: edgesFor expands inverse and negate forms', () => {
  const { g } = buildFixture();
  g.addEdge(makeEdge({ key: 'father', subject: 'p:a', object: 'p:b' }));
  g.addEdge(makeEdge({ key: 'childOfFather/inverse', subject: 'p:b', object: 'p:a' }));
  g.addEdge(makeEdge({ key: 'father/negate', subject: 'p:c', object: 'p:b' }));
  const q = new QueryEngine(g);
  const rows = q.edgesFor('父亲');
  assert.equal(rows.length, 3);
  assert.equal(rows.filter(r => r.negated).length, 1);
  assert.equal(rows.filter(r => r.inverse).length, 1);
});

test('query: predicate catalog exposes labels and counts', () => {
  const { g } = buildFixture();
  g.addEdge(makeEdge({ key: 'father', subject: 'p:a', object: 'p:b' }));
  const q = new QueryEngine(g);
  const cat = q.predicateCatalog();
  const father = cat.find(c => c.key === 'father');
  assert.equal(father.label, '父亲');
  assert.equal(father.count, 1);
  assert.ok(cat.every(c => c.label && c.label !== c.key), 'every predicate needs a Chinese label');
});

test('query: timeline histogram buckets lifespans', () => {
  const { g } = buildFixture();
  const q = new QueryEngine(g);
  const hist = q.timelineHistogram({ bucketYears: 50 });
  assert.ok(hist.length >= 1);
  assert.ok(hist.every(h => typeof h.count === 'number' && h.year != null));
});
