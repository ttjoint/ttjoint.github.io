// 详情页「引用来源」气泡的回归测试。
//
// 这两个断言各自守住一个真实出现过的 bug，都是“页面看起来正常、但某类数据
// 静默消失”的类型，光靠人眼浏览发现不了：
//
//   1. 只读 `sources` 不读 `provenance` —— CBDB 人物没有 sources，只有
//      provenance，于是 96% 的实体点开气泡是空的。
//   2. `_evidenceRows` 直接读 `.length` —— 未解析的 source 没有这个字段，
//      在 computed 里抛出会让整个详情视图挂掉（按钮渲染出来但点了没反应）。
//
// 这里直接对源码做结构断言，而不是起浏览器：组件依赖 Vue 运行时，单元测试
// 里跑不起来；而这两个 bug 的本质是“漏读了一类字段”，源码层面即可判定。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'js', 'views', 'entity_detail.js'),
  'utf8',
);

test('引用来源气泡同时覆盖 provenance 与 sources', () => {
  // citeRows 是气泡的唯一数据来源，两路数据都要在里面出现。
  const start = SRC.indexOf('citeRows() {');
  assert.ok(start > 0, '找不到 citeRows');
  const end = SRC.indexOf('\n      },', start);
  assert.ok(end > start, 'citeRows 体边界异常');
  const body = SRC.slice(start, end);

  assert.match(body, /provenance/, '气泡必须读 provenance（CBDB 人物只有它）');
  assert.match(body, /resolvedSources/, '气泡必须读 resolvedSources（evidence 实体）');
});

test('_evidenceRows 只在确认是数组后才取 length', () => {
  // 裸的 s._evidenceRows.length / s._evidenceRows || [] 都可能漏，
  // 唯一安全的写法是先判断类型。
  const offenders = [];
  const lines = SRC.split('\n');
  lines.forEach((line, i) => {
    if (!line.includes('_evidenceRows')) return;
    // 模板里的 `src._evidenceRows && src._evidenceRows.length` 是安全的守卫写法。
    if (line.includes('&&')) return;
    if (/Array\.isArray\([^)]*_evidenceRows\)/.test(line)) return;
    if (/^\s*\/\//.test(line)) return; // 纯注释行
    if (/_evidenceRows:/.test(line)) return; // 赋值处
    // v-for 行由上一行的 v-if="src._evidenceRows && …" 守卫，本身不取 length。
    if (/v-for=/.test(line)) return;
    offenders.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepEqual(offenders, [], '这些行在没有类型判断的情况下读了 _evidenceRows');
});

test('字段级来源按钮有对应的数据来源（fieldCites）', () => {
  // P2 拆分后：fieldCites 计算留在主文件（它依赖实体的 provenance），
  // 但模板里的字段表移到了 info_card.js——两半都要查。
  const cardSrc = fs.readFileSync(path.join(ROOT, 'js', 'views', 'entity', 'info_card.js'), 'utf8');
  assert.match(SRC, /fieldCites\(\)/, '缺少按字段分组的 provenance 索引');
  assert.match(cardSrc, /fieldCites\[key\]/, '模板没有用 fieldCites 决定是否显示字段按钮');
  assert.match(SRC, /provenance/, 'fieldCites 必须从 provenance.reason 派生');
});

test('未发布的关系目标标记 _missing，且不渲染裸 id 为可点链接', () => {
  // 发布切片按时间窗口过滤，关系目标可能不在切片内。原先 `resolveName` 找不到
  // 实体就回退到裸 id，于是页面显示 `person:cbdb-136147`，还把它做成链接——
  // 点进去是一片空白。静态页早已显示「未收录」，前端必须一致。
  const start = SRC.indexOf('resolvedRelations() {');
  assert.ok(start > 0, '找不到 resolvedRelations');
  const end = SRC.indexOf('\n      },', start);
  const body = SRC.slice(start, end);

  assert.match(body, /_missing/, 'resolvedRelations 必须标记未加载的目标');
  assert.match(body, /getEntity\(/, '必须用 getEntity 判断目标是否真的在切片里');

  // 模板里不能出现无条件的 navigate(r.id || r.target)
  assert.doesNotMatch(
    SRC,
    /@click="!r\._literal && navigate\(r\.id \|\| r\.target/,
    '未收录的关系项仍然可点击',
  );
  assert.match(SRC, /!r\._missing/, '模板必须排除 _missing 项');
});
