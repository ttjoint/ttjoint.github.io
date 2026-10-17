'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { loadGraph } = require('../../src/store/graph_source.js');
const { QueryEngine, ALL_CONFIDENCE } = require('../../src/core/query.js');

const ROOT = path.join(__dirname, '..', '..');
const hasData = fs.existsSync(path.join(ROOT, 'data', 'persons', 'entities'));

test('integration: canonical data loads into a graph', { skip: !hasData && 'no entity shards on disk' }, () => {
  const g = loadGraph({ rootDir: ROOT });
  assert.ok(g.nodes.size > 0, 'graph must contain nodes');
  assert.ok(g.stats.edges > 0, 'graph must contain edges');

  const people = [...g.nodes.values()].filter(n => n.type === 'person');
  assert.ok(people.length > 0);
  // Every node id must be unique and carry a name.
  assert.equal(new Set(people.map(p => p.id)).size, people.length);
  assert.ok(people.every(p => p.name && p.name.length > 0 && p.name !== 'undefined'));
});

test('integration: no entity name contains navigation or copyright pollution', { skip: !hasData && 'no entity shards on disk' }, () => {
  const g = loadGraph({ rootDir: ROOT });
  const BAD = /简历-|通行证|不忘初心|责编[:：]|学习路上|分享到|推荐阅读|扫一扫|Copyright|版权所有/i;
  const dirty = [...g.nodes.values()].filter(n => BAD.test(n.name));
  assert.deepEqual(dirty.map(n => `${n.id}:${n.name}`), []);
});

test('integration: no entity name contains mojibake replacement characters', { skip: !hasData && 'no entity shards on disk' }, () => {
  const g = loadGraph({ rootDir: ROOT });
  const dirty = [...g.nodes.values()].filter(n => /[\uFFFD]/.test(n.name));
  assert.deepEqual(dirty.map(n => n.id), []);
});

test('integration: predicate catalog is fully labelled', { skip: !hasData && 'no entity shards on disk' }, () => {
  const g = loadGraph({ rootDir: ROOT });
  const q = new QueryEngine(g);
  const cat = q.predicateCatalog();
  const unlabelled = cat.filter(c => !c.label || c.label === c.key);
  assert.deepEqual(unlabelled.map(c => c.key), []);
});

test('integration: a known official has structured positions as edges', { skip: !hasData && 'no entity shards on disk' }, () => {
  const g = loadGraph({ rootDir: ROOT });
  const li = [...g.nodes.values()].find(n => n.name === '李强');
  if (!li) return; // data set may not include this person
  const posts = g.outgoings(li.id, 'memberOf');
  assert.ok(posts.length > 0, '李强 should have at least one position edge');
});

test('integration: timeline histogram covers the loaded corpus', { skip: !hasData && 'no entity shards on disk' }, () => {
  const g = loadGraph({ rootDir: ROOT });
  const q = new QueryEngine(g);
  const hist = q.timelineHistogram({ bucketYears: 100, confidence: ALL_CONFIDENCE });
  assert.ok(Array.isArray(hist));
  assert.ok(hist.every(h => Number.isFinite(h.count) && Number.isFinite(h.year)));
});

test('integration: external predicate registry is merged in', { skip: !hasData && 'no entity shards on disk' }, () => {
  const { createRegistry, loadPredicateExtensions } = require('../../src/store/graph_source.js');
  const ext = loadPredicateExtensions(ROOT);
  const r = createRegistry(ROOT);
  // Extensions from data/predicates/registry.json must be resolvable.
  for (const p of ext) {
    assert.equal(r.resolve(p.key), p.key, `extension ${p.key} must be registered`);
    assert.ok(r.resolve(p.label), `extension label ${p.label} must resolve`);
  }
  assert.ok(r.list().length > 40, 'builtins plus extensions expected');
});
