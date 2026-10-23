'use strict';
/**
 * The browser predicate module must expose exactly the same modifier semantics
 * as the Node core, otherwise a record written by one side is read wrong by the
 * other. These tests load the browser script into a fake window and compare.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const core = require('../../src/predicates/registry.js');
const coreRegistry = new core.PredicateRegistry();

const sandbox = { window: {} };
require('node:vm').runInNewContext(
  require('fs').readFileSync(path.join(__dirname, '..', '..', 'js', 'core', 'predicates.js'), 'utf8'),
  sandbox,
);
const HM = sandbox.window.HMPredicates;

test('predicates(js): modifier spelling matches the core', () => {
  assert.equal(HM.MODIFIER.INVERSE, core.MODIFIER.INVERSE);
  assert.equal(HM.MODIFIER.NEGATE, core.MODIFIER.NEGATE);
  assert.equal(HM.isNegated('father/negate'), core.isNegated('father/negate'));
  assert.equal(HM.isInversed('father/inverse'), core.isInversed('father/inverse'));
});

test('predicates(js): modifier composition is order independent', () => {
  // Both orderings resolve to the same set of modifiers, whatever the order.
  const a = HM.splitModifiers('father/negate/inverse');
  const b = HM.splitModifiers('father/inverse/negate');
  assert.equal(a.base, 'father');
  assert.equal(b.base, 'father');
  assert.equal(JSON.stringify(a.mods.slice().sort()), JSON.stringify(b.mods.slice().sort()));
  assert.equal(HM.isNegated('father/inverse/negate'), true);
  assert.equal(HM.isInversed('father/negate/inverse'), true);
});

test('predicates(js): synonyms resolve to one canonical key', () => {
  assert.equal(HM.resolve('父亲'), 'father');
  assert.equal(HM.resolve('爸爸'), 'father');
  assert.equal(HM.resolve('任职'), 'memberOf');
  assert.equal(HM.resolve('户籍'), 'residedAt');
  // The core folds 出生地 onto bornAt (the place is the subject there).
  assert.equal(HM.resolve('出生地'), 'bornAt');
  assert.equal(HM.resolve('下属企业'), 'childOrg');
  assert.equal(HM.resolve('开业日期'), 'foundedOn');
  assert.equal(HM.resolve('不是关系词'), null);
});

test('predicates(js): 儿子 and 女儿 are distinct, gender-constrained primitives', () => {
  const son = HM.def('maleChild');
  const daughter = HM.def('femaleChild');
  assert.equal(son.label, '儿子');
  assert.equal(daughter.label, '女儿');
  assert.notEqual(son.key, daughter.key);
  assert.equal(son.objectGender, 'male');
  assert.equal(daughter.objectGender, 'female');
  // A search for 儿子 must only match male children.
  assert.equal(HM.matchesGender('maleChild/inverse', 'male'), true);
  assert.equal(HM.matchesGender('maleChild/inverse', 'female'), false);
  assert.equal(HM.matchesGender('femaleChild/inverse', 'female'), true);
  // Gender-neutral predicates keep matching everybody.
  assert.equal(HM.matchesGender('child', 'female'), true);
});

test('predicates(js): unknown modifier is reported, not swallowed', () => {
  const parts = HM.splitModifiers('father/bogus');
  assert.equal(parts.base, 'father');
  // Arrays created inside the vm sandbox have a different Array prototype,
  // so compare structurally instead of with deepEqual's strict realm check.
  assert.equal(JSON.stringify(parts.unknown), JSON.stringify(['bogus']));
});

test('predicates(js): runtime extension merges new predicates and aliases', () => {
  HM.extend([{ key: 'formedFrom', label: '源自', aliases: ['由…组建'], inverse: null }]);
  assert.equal(HM.resolve('源自'), 'formedFrom');
  assert.equal(HM.def('formedFrom').label, '源自');
});

test('predicates(js): every inverse target is itself a known predicate', () => {
  for (const [key, def] of Object.entries(HM.PREDICATES)) {
    if (key.startsWith('_') || !def || !def.inverse) continue;
    assert.ok(HM.PREDICATES[def.inverse], `${key} -> ${def.inverse} must exist`);
  }
});

test('predicates(js): the browser table matches the core table entry for entry', () => {
  // The whole point of the parity test: adding an alias to one side and not the
  // other is the most likely form of drift, and it silently mislabels data.
  const coreKeys = core.BUILTIN.map(p => p.key).sort();
  const jsKeys = HM.BUILTIN.map(p => p.key).sort();
  assert.equal(JSON.stringify(jsKeys), JSON.stringify(coreKeys), 'same predicate keys');

  for (const c of core.BUILTIN) {
    const b = HM.PREDICATES[c.key];
    assert.ok(b, `${c.key} missing in browser table`);
    assert.equal(b.label, c.label, `${c.key} label`);
    assert.equal(b.inverse || null, c.inverse || null, `${c.key} inverse`);
    assert.equal(b.objectGender || null, c.objectGender || null, `${c.key} objectGender`);
    // Every core alias must resolve to the same key on the browser side...
    for (const a of c.aliases || []) {
      assert.equal(HM.resolve(a), c.key, `alias ${a} -> ${c.key}`);
    }
    // ...and vice versa, for words the browser table declares itself.
    for (const a of b.aliases || []) {
      const coreKey = coreRegistry.resolve(a);
      if (coreKey) assert.equal(coreKey, c.key, `browser alias ${a} must agree with core`);
    }
  }
});

test('predicates(js): Chinese modifiers work in the browser half too', () => {
  // 生成器只重写 BUILTIN 数组，splitModifiers/MODIFIER 是手写的两处副本。
  // 中文修饰符只在 core 加过，浏览器侧漏了——前端搜索「父亲/非」会当成未知修饰符。
  // vm 沙箱里造出的数组原型不同，deepEqual 会因跨 realm 报假失败。
  const mods = (k) => Array.from(HM.splitModifiers(k).mods);
  for (const [cn, en] of [['反', 'inverse'], ['非', 'negate'], ['男', 'male'], ['女', 'female']]) {
    assert.deepEqual(mods(`父亲/${cn}`), [en], `${cn}`);
    assert.deepEqual(mods(`父亲/${cn}`), core.splitModifiers(`父亲/${cn}`).mods, `${cn} vs core`);
  }
  // 与 core 结果逐字相同，而不是“大致等价”。
  assert.deepEqual(mods('父亲/反/非'), core.splitModifiers('父亲/反/非').mods);
  assert.deepEqual(Array.from(HM.splitModifiers('father/bogus').unknown), core.splitModifiers('father/bogus').unknown);
});

test('predicates(js): MODIFIER exposes the same four names as the core', () => {
  // 少一个名字不会报错，只会让该修饰符被当成 unknown 静默丢弃。
  assert.deepEqual(Object.keys(HM.MODIFIER).sort(), Object.keys(core.MODIFIER).sort());
});
