// 谓词页：/predicate 与 /predicate/:key。
//
// 谓词原先塞在弹窗抽屉里（relation_panel），既不能深链接，又带增删改。
// 谓词是代码资产（src/predicates/registry.js），不该由界面改——
// 否则会立刻产生一批只有某个浏览器认识的谓词，而它们产生的边
// 没有 domain/range 约束，也没有出处校验。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js', 'views', 'predicate_page.js'), 'utf8');

test('predicate: 两个页面都注册了路由', () => {
  const app = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  assert.match(app, /path: '\/predicate'/);
  assert.match(app, /path: '\/predicate\/:key'/);
});

test('predicate: 页面上没有任何编辑控件', () => {
  // 这是本页存在的理由之一：谓词只读。
  assert.doesNotMatch(SRC, /addRelation/);
  assert.doesNotMatch(SRC, /updateRelation/);
  assert.doesNotMatch(SRC, /deleteRelation/);
  // 输入框只能是搜索，不能是表单。
  assert.match(SRC, /v-model="filter"/);
  assert.doesNotMatch(SRC, /<input[^>]*v-model="form/);
});

test('predicate: 按 domain→range 分组而不是平铺', () => {
  // 平铺 56 条看不出结构，而结构正是最有信息量的部分：
  // person→person 有 18 个，organization→organization 只有 6 个。
  assert.match(SRC, /p\.domain \|\| '\?'\) \+ '→' \+ \(p\.targetType/);
});

test('predicate: 边数从 /api/predicates 来，静态模式下降级不报错', () => {
  assert.match(SRC, /Api\.get\('\/api\/predicates'\)/);
  // 静态部署没有后端：counts 保持 null，页面仍可读，只是不显示次数。
  //
  // 必须用 whenReady() 而不是 isAvailable()：后者是同步检查，而 probe 在
  // app.mounted() 里异步跑，子组件可能先于它——那时 isAvailable() 是 false，
  // 页面就永远走「静态模式」，即使后端明明在。/sources 页实测过这个竞态。
  assert.match(SRC, /await Api\.whenReady\(\)/);
});

test('predicate: 反向谓词单独一节', () => {
  // 反向不是独立关系，是同一段关系的另一个视角。
  // 「A 是 B 的父亲」与「B 是 A 的儿子」说的是同一件事，
  // 所以详情页要能列出「谁把我当反向」。
  assert.match(SRC, /inverseOf/);
  assert.match(SRC, /p\.inverse === this\.key/);
});

test('predicate: 实体详情的谓词名可点击跳转', () => {
  const detail = fs.readFileSync(path.join(ROOT, 'js', 'views', 'entity_detail.js'), 'utf8');
  assert.match(detail, /class="card-title predicate-link"/);
  assert.match(detail, /#\/predicate\//);
  // `_predicate` 必须保留原始键：`父亲（反）` 的 label 是显示用的，
  // 跳转要用 `father/反`。
  assert.match(detail, /_predicate: relKey/);
});

// ---------------------------------------------------------------- P3 CSS 分层验收

test('css: components 层无字面色值', () => {
  // 立规矩：components/ 只引用 tokens 的变量。7 处字面值曾是历史遗留，
  // 一次暗色模式改动就会漏掉它们——变量有暗色定义，字面值没有。
  const fs2 = require('fs');
  const dir = path.join(ROOT, 'css', 'components');
  const offenders = [];
  for (const f of fs2.readdirSync(dir)) {
    const src = fs2.readFileSync(path.join(dir, f), 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      // 允许 var() 中的引用；只抓裸十六进制。
      if (/#[0-9a-fA-F]{3,8}\b/.test(line) && !line.includes('var(--')) {
        offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 60)}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});

test('css: tokens 有暗色徽标定义', () => {
  const tokens = fs.readFileSync(path.join(ROOT, 'css', 'tokens.css'), 'utf8');
  assert.match(tokens, /--badge-person-bg/);
  assert.match(tokens, /--badge-org-fg/);
  // body.dark 块里也要有——忘了就是暗色模式下徽标仍是浅色底。
  const dark = tokens.slice(tokens.indexOf('body.dark'));
  assert.match(dark, /--badge-person-bg/);
});

test('css: style.css 是 @import 入口，分层齐全', () => {
  const entry = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
  assert.match(entry, /@import url\('tokens\.css'\)/);
  assert.match(entry, /@import url\('base\.css'\)/);
  assert.match(entry, /@import url\('components\/card\.css'\)/);
  assert.match(entry, /@import url\('views\/app\.css'\)/);
});
