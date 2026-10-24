// 边级起止时间（valid_from / valid_to）。
//
// 文档 §2.1 定则：「节点存自身存续区间，边存关系本身的起止。」
// 此前 edges 表没有这两列——设计存在，实现缺失，等于「分阶段关系」
//（两次任同一职）根本无法表达。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { splitRelationEntry } = require('../../src/store/db_build_helpers.js');

test('dates: 分片条目的 dates 拆成独立列，不留在 qualifiers', () => {
  // 语义不同：role/kind 回答「哪一个」，dates 回答「什么时候成立」。
  // 后者要参与时间切片查询，埋在 JSON 里就只能全表扫。
  const r = splitRelationEntry({ id: 'organization:x', role: '主席', dates: { from: 1995, to: 2000 } });
  assert.equal(r.validFrom, 1995);
  assert.equal(r.validTo, 2000);
  assert.ok(!r.qualifiers.includes('dates'), 'dates 不应残留在 qualifiers');
  assert.ok(r.qualifiers.includes('role'));
});

test('dates: from/to 可各自单独存在——未知不等于不存在', () => {
  // 「加入致公党时间不详」是一条成立的断言，只是缺时间。
  // 强制非空会逼人编造日期，或者干脆不录入——两者都比留空更糟。
  const onlyFrom = splitRelationEntry({ id: 'o:x', dates: { from: 2010 } });
  assert.equal(onlyFrom.validFrom, 2010);
  assert.equal(onlyFrom.validTo, null);

  const onlyTo = splitRelationEntry({ id: 'o:x', dates: { to: 2000 } });
  assert.equal(onlyTo.validFrom, null);
  assert.equal(onlyTo.validTo, 2000);

  const none = splitRelationEntry({ id: 'o:x', role: '成员' });
  assert.equal(none.validFrom, null);
  assert.equal(none.validTo, null);
});

test('dates: schema 有 valid_from/valid_to 两列与索引', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'src', 'store', 'db_schema.js'), 'utf8');
  assert.match(schema, /edges \([\s\S]*valid_from\s+INTEGER[\s\S]*valid_to\s+INTEGER/);
  assert.match(schema, /idx_edges_time/);
});

test('dates: build_db 写入两列', () => {
  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build_db.js'), 'utf8');
  assert.match(build, /valid_from, valid_to/);
});

test('dates: API 返回 validFrom/validTo，前端透传', () => {
  const api = fs.readFileSync(path.join(ROOT, 'scripts', 'serve_api.js'), 'utf8');
  assert.match(api, /validFrom: e\.valid_from == null \? null : e\.valid_from/);
  const services = fs.readFileSync(path.join(ROOT, 'js', 'services.js'), 'utf8');
  assert.match(services, /validFrom: e\.validFrom/);
});

test('dates: 抽取器不为「现任」编造时间', () => {
  // 「现任」是状态描述，不是起点。原文没说就任时间就留空。
  const src = fs.readFileSync(path.join(ROOT, 'src', 'extractors', 'web_resume.js'), 'utf8');
  assert.ok(src.includes('参加工作'), '抽取器必须明确注释为什么不拿工作日期当入党日期');
});
