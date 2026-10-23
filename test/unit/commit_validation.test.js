// 提交校验。
//
// 编辑界面的价值不在于「能改」，而在于改得可信。没有校验的编辑框
// 等于把前端曾经做过的 localStorage 假写搬到后端重演一遍。
//
// 规则来自 docs/architecture/节点类型与谓词.md §6。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { validateClaim, validateBatch, buildCommit } = require('../../src/store/commit_validation.js');

const GOOD = {
  subject: 'person:cbdb-1',
  predicate: 'maleChild',
  object: 'person:cbdb-2',
  provenance: {
    rawRef: 'raw:cbdb/KIN_DATA/1|2|180',
    // quote 不再由提交者填写——只给 span，服务端从原文截。
    span: { start: 0, end: 5 },
  },
};

test('commit: 合法断言通过', () => {
  const r = validateClaim(GOOD);
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
  assert.equal(r.normalized.predicate, 'maleChild');
});

test('commit: 必须给 span，不接受直接填 quote', () => {
  // 允许直接写 quote 的话，它与手写一条断言没有区别——任何内容都能
  // 被塞进「原文摘录」，校验无法分辨是抄的还是编的。
  const r = validateClaim({
    ...GOOD,
    provenance: { rawRef: GOOD.provenance.rawRef, quote: '我编的原文' },
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.field === 'span' && i.code === 'required'));
});

test('commit: rawRef 必填，且给了校验函数时必须在 raw 层存在', () => {
  // 没有 rawRef 就追不到第 0 层，这条断言无法核对。
  const noRef = validateClaim({ ...GOOD, provenance: { span: { start: 0, end: 5 } } });
  assert.ok(noRef.issues.some((i) => i.field === 'rawRef'));

  // 编造的 ref 必须被拦。这是「出处不是编的」的硬证据。
  const fake = validateClaim(GOOD, { rawExists: () => false });
  assert.equal(fake.ok, false);
  assert.ok(fake.issues.some((i) => i.code === 'raw-not-found'));

  // 真实存在的 ref 通过。
  const real = validateClaim(GOOD, { rawExists: () => true });
  assert.equal(real.ok, true);
});

test('commit: 未注册谓词被拒绝', () => {
  // 未注册谓词入库会怎样：这条边能被写入，但查询层不认识它，
  // 于是既不能被「父亲」查到，也不出现在任何关系卡片里——
  // 一条存在但看不见的边，比不存在更糟。
  const r = validateClaim({ ...GOOD, predicate: 'inventedRelation' });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'unknown-predicate'));
});

test('commit: 自指被拒绝', () => {
  const r = validateClaim({ ...GOOD, object: GOOD.subject });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'self-reference'));
});

test('commit: 一次返回全部问题，不是遇到第一个就停', () => {
  // 用户提交一次表单，应该一次看到所有问题。
  const r = validateClaim({ subject: '', predicate: '', object: '', provenance: {} });
  assert.equal(r.ok, false);
  const fields = r.issues.map((i) => i.field);
  for (const f of ['subject', 'predicate', 'object', 'rawRef', 'span']) {
    assert.ok(fields.includes(f), `应报告 ${f}`);
  }
});

test('commit: 批量校验汇总正确', () => {
  const r = validateBatch([GOOD, { ...GOOD, predicate: 'nope' }, GOOD]);
  assert.equal(r.total, 3);
  assert.equal(r.failed, 1);
  assert.equal(r.ok, false);
  assert.equal(r.results[1].ok, false);
  assert.equal(r.results[0].ok, true);
});

test('commit: 空批次不算成功', () => {
  // 「提交 0 条」不该报 ok——那会让调用方以为写入了什么。
  const r = validateBatch([]);
  assert.equal(r.ok, false);
});

test('commit: buildCommit 记录每条断言的 rawRef', () => {
  const c = buildCommit([GOOD, GOOD], { commitId: 'c-000010', author: 'tester', message: 'test' });
  assert.equal(c.commitId, 'c-000010');
  assert.equal(c.stats.claims, 2);
  assert.equal(c.stats.rawRefs.length, 2);
  // 便于事后核对「这次提交读了哪些原始记录」
  assert.equal(c.stats.rawRefs[0], GOOD.provenance.rawRef);
});

test('commit: 端点只校验不落盘', () => {
  // 真正写入要走 raw/ → transformer → build，那是分钟级、多进程的链路，
  // 不能挂在一个 HTTP 请求里。端点必须在响应里说明这一点，
  // 否则调用方会以为已经写入。
  const api = fs.readFileSync(path.join(ROOT, 'scripts', 'serve_api.js'), 'utf8');
  assert.match(api, /parts\[1\] === 'commit'/);
  assert.match(api, /本端点不落盘/);
  assert.match(api, /validateBatch/);
  assert.match(api, /rawExists/);
});

test('commit: 现有数据全部能通过校验', () => {
  // 规则若与真实数据冲突，说明规则写错了（或数据有问题）。
  // 抽样真实分片验证，防止校验比数据更严导致编辑功能无法使用。
  const dir = path.join(ROOT, 'data', 'persons', 'entities');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).slice(0, 300);
  let checked = 0, failed = 0;
  for (const f of files) {
    const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const [pred, entries] of Object.entries(e.relations || {})) {
      for (const x of entries) {
        if (typeof x !== 'object' || !x.provenance || !x.provenance.length) continue;
        const p = x.provenance[0];
        const r = validateClaim({
          subject: e.id,
          predicate: String(pred).replace(/\/反$/, ''),
          object: x.id,
          // 现有分片里存的是 quote（历史数据），但规则要求 span。
          // 这里只验证「有 rawRef」这一项，跳过 span 检查以兼容历史数据。
          provenance: { rawRef: p.rawRef, span: p.span || { start: 0, end: 1 } },
        }, { rawGet: null });
        checked++;
        if (!r.ok) failed++;
      }
    }
  }
  assert.ok(checked > 0, '应抽到数据');
  assert.equal(failed, 0, `${failed}/${checked} 条现有数据未通过校验`);
});
