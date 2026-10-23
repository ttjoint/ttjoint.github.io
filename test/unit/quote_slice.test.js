// 引文必须从原文截取，不能由提交者填写。
//
// 若允许直接写 quote，它与手写一条断言没有区别——任何内容都能被塞进
// 「原文摘录」，而校验无法分辨是抄的还是编的。改成只收 span、服务端截取，
// 编造在结构上就不可能。

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectRecord, locate, resolveQuote, TEXT_FORMAT_VERSION } = require('../../src/store/quote_slice.js');

const REC = {
  rawId: 'raw:test/PAGE/t1',
  payload: {
    url: 'https://example.org/a',
    c_notes: '初附王安石',
    c_personid: 77,
    empty: '',
    nul: null,
  },
};

test('quote: 投影是纯文本，字段名<TAB>值，按名排序', () => {
  const p = projectRecord(REC);
  assert.equal(p.version, TEXT_FORMAT_VERSION);
  const lines = p.text.split('\n');
  // 排序后：c_notes, c_personid, empty, nul, url
  assert.ok(lines[0].startsWith('c_notes\t'));
  assert.equal(lines[0], 'c_notes\t初附王安石');
  // null 与空串都投影为空值，没有「null」字样
  assert.ok(lines.includes('nul\t'));
  assert.ok(!p.text.includes('null'));
});

test('quote: 投影确定性——同一条记录两次投影逐字节相同', () => {
  // 否则今天存的 span 明天指向别的位置，引文就错了。
  const a = projectRecord(REC).text;
  const b = projectRecord(JSON.parse(JSON.stringify(REC))).text;
  assert.equal(a, b);
});

test('quote: 中文与引号不被转义，span 与界面显示一一对应', () => {
  // 用 JSON.stringify 会把「」变成 \u300c，用户在界面上划取的是渲染后的
  // 文字，两者偏移对不上。行式格式没有转义字符。
  const p = projectRecord(REC);
  assert.ok(p.text.includes('初附王安石'));
  assert.ok(!p.text.includes(String.fromCharCode(92) + 'u'));
});

test('quote: 网页类记录直接用 payload.text', () => {
  const rec = { payload: { url: 'x', text: '正文第一句。\n正文第二句。' } };
  const p = projectRecord(rec);
  assert.equal(p.text, '正文第一句。\n正文第二句。');
  assert.deepEqual(p.fields, ['text']);
});

test('quote: 按 span 截取，返回前后文', () => {
  const text = projectRecord(REC).text;
  const start = text.indexOf('初附王安石');
  const r = locate(REC, { start, end: start + 5 });
  assert.equal(r.ok, true);
  assert.equal(r.quote, '初附王安石');
  assert.equal(r.before.endsWith('c_notes\t'), true);
});

test('quote: 越界、空区间、非整数都被拒绝', () => {
  const len = projectRecord(REC).text.length;
  assert.equal(locate(REC, { start: 0, end: len + 1 }).code, 'span-out-of-range');
  assert.equal(locate(REC, { start: 5, end: 5 }).code, 'span-out-of-range');
  assert.equal(locate(REC, { start: 'a', end: 5 }).code, 'bad-span');
});

test('quote: 提交的 quote 与截取结果不一致时拒绝', () => {
  // 不是「信任」提交者的值，而是暴露前端划取逻辑的 bug——
  // 静默采用其一会掩盖问题。
  const text = projectRecord(REC).text;
  const start = text.indexOf('初附王安石');
  const r = resolveQuote(REC, { span: { start, end: start + 5 }, quote: '我编的' });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'quote-mismatch'));
});

test('quote: 版本不符时拒绝，提示 span 可能错位', () => {
  const text = projectRecord(REC).text;
  const start = text.indexOf('初附王安石');
  const r = resolveQuote(REC, {
    span: { start, end: start + 5 },
    formatVersion: TEXT_FORMAT_VERSION - 1,
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'format-version-mismatch'));
});

test('quote: 记录不存在时报 raw-not-found', () => {
  const r = resolveQuote(null, { span: { start: 0, end: 1 } });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].code, 'raw-not-found');
});

test('quote: 截取结果是原文子串——编造在结构上不可能', () => {
  // 这是整个设计的核心断言：无论怎么提交，quote 一定来自原文。
  const text = projectRecord(REC).text;
  for (let s = 0; s < text.length; s += 7) {
    for (let e = s + 1; e < Math.min(text.length, s + 12); e++) {
      const r = locate(REC, { start: s, end: e });
      if (!r.ok) continue;
      assert.equal(text.slice(s, e), r.quote);
    }
  }
});
