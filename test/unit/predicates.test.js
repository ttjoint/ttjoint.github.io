'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PredicateRegistry, modifier, splitModifiers, isNegated, baseKey, normLabel, MODIFIER,
} = require('../../src/predicates/registry.js');

test('predicates: aliases resolve to canonical keys', () => {
  const r = new PredicateRegistry();
  assert.equal(r.resolve('父亲'), 'father');
  assert.equal(r.resolve('爸爸'), 'father');
  assert.equal(r.resolve('父'), 'father');
  assert.equal(r.resolve('任职'), 'memberOf');
  assert.equal(r.resolve('子部门'), 'childOrg');
  assert.equal(r.resolve('下属企业'), 'childOrg');
  assert.equal(r.resolve('开业'), 'foundedOn');
  assert.equal(r.resolve('户籍'), 'residedAt');
  assert.equal(r.resolve('不存在的关系'), null);
});

test('predicates: gender-specific child labels stay separate primitives', () => {
  const r = new PredicateRegistry();
  assert.equal(r.resolve('儿子'), 'maleChild');
  assert.equal(r.resolve('女儿'), 'femaleChild');
  assert.equal(r.resolve('子女'), 'childOfFather');
  assert.equal(r.get('maleChild').subjectGender, 'male');
  assert.equal(r.get('femaleChild').subjectGender, 'female');
  // Searching 儿子 must never silently return the gender-neutral predicate.
  assert.notEqual(r.resolve('儿子'), r.resolve('子女'));
});

test('predicates: inverses are declared both ways', () => {
  const r = new PredicateRegistry();
  assert.equal(r.inverseKey('father'), 'childOfFather');
  assert.equal(r.inverseKey('childOfFather'), 'father');
  assert.equal(r.inverseKey('mother'), 'childOfMother');
  assert.equal(r.inverseKey('parentOrg'), 'childOrg');
  assert.equal(r.inverseKey('memberOf'), 'hasMember');
  // Symmetric predicates point at themselves.
  assert.equal(r.get('spouse').symmetric, true);
  assert.equal(r.inverseKey('spouse'), 'spouse');
  assert.equal(r.inverseKey('friend'), 'friend');
});

test('predicates: modifiers compose and round-trip', () => {
  assert.equal(modifier('father', MODIFIER.INVERSE), 'father/inverse');
  assert.equal(modifier('father', MODIFIER.NEGATE), 'father/negate');
  assert.equal(modifier('father', null), 'father');
  assert.deepEqual(splitModifiers('father/negate'), { base: 'father', mods: ['negate'] });
  assert.deepEqual(splitModifiers('father'), { base: 'father', mods: [] });
  assert.equal(isNegated('father/negate'), true);
  assert.equal(isNegated('father/inverse'), false);
  assert.equal(baseKey('father/negate'), 'father');
});

test('predicates: label normalisation strips spacing and colon', () => {
  assert.equal(normLabel(' 父 亲 '), '父亲');
  assert.equal(normLabel('任职：'), '任职');
  assert.equal(normLabel('所属\u3000组织'), '所属组织');
});

test('predicates: conflicting aliases are recorded, never silently dropped', () => {
  const r = new PredicateRegistry();
  // 子女 is legitimately claimed by both father- and mother-side child predicates.
  const conflicts = r.mergeConflicts.filter(c => c.alias === '子女');
  assert.equal(conflicts.length, 1);
  assert.ok(conflicts[0].kept);
  assert.ok(conflicts[0].ignored);
  // The first claim wins and resolution still works.
  assert.equal(r.resolve('子女'), conflicts[0].kept);
});

test('predicates: every declared inverse target exists', () => {
  const r = new PredicateRegistry();
  const dangling = r.list().filter(p => p.inverse && !r.get(p.inverse));
  assert.deepEqual(dangling.map(p => p.key), []);
});

test('predicates: runtime extension via custom registry file', () => {
  const r = new PredicateRegistry([
    { key: 'customRel', label: '自定义', domain: 'person', range: 'person', aliases: ['别名甲'] },
  ]);
  assert.equal(r.resolve('别名甲'), 'customRel');
  assert.equal(r.resolve('自定义'), 'customRel');
});
