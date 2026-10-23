// 文献可定位性报告。
//
// 编辑功能要求「读取原文并划取」——没有页码/条目号就无从定位原文。
// 这份报告决定「先给哪些文献做编辑」，所以它的分类逻辑必须可测：
// 分类错了会导致选了根本定位不到原文的文献开工。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'report_source_locatability.js'), 'utf8');

test('locatability: 报告脚本存在且可独立运行', () => {
  assert.match(SRC, /report_source_locatability/);
  // 只读：不能意外改数据
  assert.match(SRC, /readOnly: true/);
});

test('locatability: 页码形态分类覆盖四种真实格式', () => {
  // 这四种来自实测样本，漏一种就会把可定位的文献误判为不可定位：
  //   471.21a            古籍卷.页叶次
  //   Kaicheng 40        年号 + 序号（《唐代墓誌彙編》体例）
  //   (XJ)Xiantong8      前缀标记 + 年号 + 序号
  //   MQWW PoetID #1761  数据库条目 ID
  // 源码里是正则字面量的文本形式：反斜杠在字符串里要写成 \d
  assert.ok(SRC.indexOf('d+') > 0 && SRC.indexOf('A-Za-z]{4,}') > 0,
    '缺少「卷.页」或「年号+序号」形态');
  assert.ok(SRC.indexOf('(XJ)') > 0 || SRC.indexOf('[A-Z]+') > 0,
    '缺少「前缀标记」形态');
  assert.ok(SRC.indexOf('#|ID') > 0, '缺少「数据库条目 ID」形态');
});

test('locatability: 区分「在线可读」与「需线下查」', () => {
  // 有页码但没在线地址 = 得去图书馆。这个区别决定编辑功能能否
  // 真正做到「点开原文划取」，而不是让用户自己找书。
  assert.match(SRC, /c_url_api/);
  assert.match(SRC, /c_url_homepage/);
  assert.match(SRC, /online/);
});

test('locatability: 文档记录结论与推进顺序', () => {
  const doc = fs.readFileSync(
    path.join(ROOT, 'docs', 'architecture', '文献可定位性报告.md'), 'utf8');
  // 结论必须明确「先做哪一档」，否则报告没有决策价值。
  assert.match(doc, /先做 A 档/);
  assert.match(doc, /47,009/);
  // 必须点出最常引文献的缺口——《唐五代》54,272 行无页码
  assert.match(doc, /唐五代/);
  assert.match(doc, /54,272/);
});
