'use strict';
/**
 * /negate assertions: "c is NOT b's father" / "已不在该地任职".
 *
 * Requirements
 *  - A negated assertion never appears as a positive relation anywhere.
 *  - Negation is time-bounded: the same fact can be true, then negated later.
 *  - Negated rows stay queryable when explicitly requested.
 *  - /negate and /inverse can coexist as deterministic prefixes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { GraphStore, makeEdge } = require('../../src/core/graph.js');
const { QueryEngine } = require('../../src/core/query.js');
const J = require('../../src/time/julian.js');
const {
  modifier, splitModifiers, isNegated, MODIFIER,
} = require('../../src/predicates/registry.js');

function fixture() {
  const g = new GraphStore();
  for (const [id, name] of [['p:a', '甲'], ['p:b', '乙'], ['p:c', '丙'], ['o:x', '某部']]) {
    g.addNode({ id, type: id.startsWith('o:') ? 'organization' : 'person', name });
  }
  return g;
}

test('negate: a negated edge is not a positive relation', () => {
  const g = fixture();
  g.addEdge(makeEdge({ key: 'father', subject: 'p:a', object: 'p:b' }));
  g.addEdge(makeEdge({ key: 'father/negate', subject: 'p:c', object: 'p:b' }));

  // 甲 is 乙's father; 丙 is explicitly NOT.
  assert.equal(g.outgoings('p:a', 'father').length, 1);
  assert.equal(g.outgoings('p:c', 'father').length, 0, 'negated edge must not surface as positive');
  assert.equal(g.outgoings('p:c', 'father/negate').length, 1);

  // Neighbour traversal hides it unless asked.
  assert.deepEqual(g.neighbours('p:c').map(n => n.key), []);
  assert.deepEqual(g.neighbours('p:c', { includeNegated: true }).map(n => n.key), ['father/negate']);
});

test('negate: query rows expose the negated flag and can be excluded', () => {
  const g = fixture();
  g.addEdge(makeEdge({ key: 'father', subject: 'p:a', object: 'p:b' }));
  g.addEdge(makeEdge({ key: 'father/negate', subject: 'p:c', object: 'p:b' }));
  const q = new QueryEngine(g);

  const all = q.edgesFor('父亲', { includeNegated: true });
  assert.equal(all.length, 2);
  assert.deepEqual(all.map(r => r.negated).sort(), [false, true]);

  const positiveOnly = q.edgesFor('父亲', { includeNegated: false });
  assert.equal(positiveOnly.length, 1);
  assert.equal(positiveOnly[0].subject.name, '甲');
});

test('negate: membership removal is time bounded and does not delete history', () => {
  const g = fixture();
  const TENURE = J.lifespanRange({ birth: '2001年', death: '2005年' });
  const REMOVED = J.lifespanRange({ birth: '2005年', death: '2008年' });
  g.addEdge(makeEdge({ key: 'memberOf', subject: 'p:a', object: 'o:x', role: '部长', range: TENURE }));
  g.addEdge(makeEdge({ key: 'memberOf/negate', subject: 'p:a', object: 'o:x', role: '部长', range: REMOVED }));

  const q = new QueryEngine(g);
  // Window inside the tenure: the positive assertion applies.
  const inTenure = q.edgesFor('memberOf', {
    includeNegated: true,
    lo: J.julianToJdn(2002, 1, 1), hi: J.julianToJdn(2003, 1, 1),
  });
  assert.equal(inTenure.length, 1);
  assert.equal(inTenure[0].negated, false);

  // Window inside the negation: only the negated assertion applies.
  const afterLeaving = q.edgesFor('memberOf', {
    includeNegated: true,
    lo: J.julianToJdn(2006, 1, 1), hi: J.julianToJdn(2007, 1, 1),
  });
  assert.equal(afterLeaving.length, 1);
  assert.equal(afterLeaving[0].negated, true);

  // Positive-only view over the negation window is empty: he really had left.
  const positiveAfter = q.edgesFor('memberOf', {
    includeNegated: false,
    lo: J.julianToJdn(2006, 1, 1), hi: J.julianToJdn(2007, 1, 1),
  });
  assert.equal(positiveAfter.length, 0);
});

test('negate: modifier composition is deterministic', () => {
  assert.equal(modifier('father', MODIFIER.NEGATE), 'father/negate');
  assert.equal(modifier(modifier('father', MODIFIER.NEGATE), MODIFIER.INVERSE), 'father/negate/inverse');
  const known = ['inverse', 'negate'];
  for (const raw of ['father/negate', 'father/inverse', 'father/negate/inverse', 'father/inverse/negate']) {
    const mods = splitModifiers(raw).mods;
    assert.ok(mods.every(m => known.includes(m)), `${raw} must only use known modifiers`);
  }
  assert.equal(isNegated('father/negate/inverse'), true);
});
