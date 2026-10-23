'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PredicateRegistry, modifier, splitModifiers, isNegated, isInversed, baseKey, normLabel, MODIFIER,
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
  assert.equal(r.get('maleChild').objectGender, 'male');
  assert.equal(r.get('femaleChild').objectGender, 'female');
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
  assert.deepEqual(splitModifiers('father/negate'), { base: 'father', mods: ['negate'], unknown: [] });
  assert.deepEqual(splitModifiers('father'), { base: 'father', mods: [], unknown: [] });
  // Unknown modifiers are reported rather than silently dropped.
  assert.deepEqual(splitModifiers('father/bogus').unknown, ['bogus']);
  // Modifiers are a set: repeating one changes nothing, order is irrelevant.
  assert.deepEqual(splitModifiers('father/negate/negate').mods, ['negate']);
  assert.deepEqual(splitModifiers('father/inverse/negate').mods.slice().sort(), ['inverse', 'negate']);
  assert.equal(isInversed('father/negate/inverse'), true);
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

test('predicates: the six kinship primitives exist and point at each other', () => {
  const r = new PredicateRegistry();
  // §8.4: 真正的独立原语只有 6 个。father/mother 是不对称的，
  // husband/wife 互为反向，brother/sister 各自对称。
  assert.equal(r.inverseKey('husband'), 'wife');
  assert.equal(r.inverseKey('wife'), 'husband');
  assert.equal(r.inverseKey('brother'), 'brother');
  assert.equal(r.inverseKey('sister'), 'sister');

  // 通用词仍然存在，供性别未知/同性配偶使用。
  assert.equal(r.get('spouse').symmetric, true);
  assert.equal(r.get('sibling').symmetric, true);

  // 被删掉的旧 key 不应复活。它们的 subjectGender 看主体，而 label 说的是客体，
  // 语义不自洽；表达能力已被 brother/sister + {order} 覆盖。
  assert.equal(r.get('elderBrother'), null);
  assert.equal(r.get('youngerSibling'), null);
});

test('predicates: reading direction is possessive, matching the label', () => {
  const r = new PredicateRegistry();
  // 这是 P5-5b 修过的真实 bug：曾把 `A --wife--> B` 理解成「A 是 B 的妻」，
  // 而正确读法是「A 的妻是 B」（从属视角，与 label「妻」一致）。
  // 判据：wife 的 label 是「妻」，所以主体持有这个谓词，客体才是被指的那个人。
  assert.equal(r.get('wife').label, '妻');
  assert.equal(r.get('husband').label, '夫');
  // husband 的反向必须是 wife，不能自指——否则性别信息在往返中丢失。
  assert.notEqual(r.inverseKey('husband'), 'husband');
});

test('predicates: Chinese modifier spellings normalise to the internal names', () => {
  // 用户在搜索框输中文，不该要求他打英文；但内部表示只有一套。
  assert.deepEqual(splitModifiers('父亲/非').mods, ['negate']);
  assert.deepEqual(splitModifiers('父亲/反').mods, ['inverse']);
  assert.deepEqual(splitModifiers('兄弟/男').mods, ['male']);
  assert.deepEqual(splitModifiers('兄弟/女').mods, ['female']);
  // 英文写法必须仍然等价，否则存量数据里的 `father/negate` 会失效。
  assert.deepEqual(splitModifiers('father/negate').mods, splitModifiers('father/非').mods);
  assert.equal(baseKey('父亲/反'), '父亲');
  // 未知修饰符不静默吞掉，交给调用方报错。
  assert.deepEqual(splitModifiers('father/bogus').unknown, ['bogus']);
});

test('predicates: gendered kinship constrains the object, not the subject', () => {
  const r = new PredicateRegistry();
  // 「A --maleChild--> B」读作「A 的儿子是 B」——B 是男。主体是父亲，不是孩子。
  // 曾经写成 subjectGender，注释却说是「constraint on the subject (the child)」，
  // 而主体根本不是孩子。该字段从未被 checkAssertion 校验，只是持续误导。
  assert.equal(r.get('maleChild').objectGender, 'male');
  assert.equal(r.get('femaleChild').objectGender, 'female');
  assert.equal(r.get('maleChild').subjectGender, undefined);
  assert.equal(r.get('maleChild').genderFamily, undefined);
  // 非性别谓词不应凭空获得约束。
  assert.equal(r.get('father').objectGender, null);
});
