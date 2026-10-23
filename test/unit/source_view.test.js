// 文献反向视图：证据文件 → 它支撑了哪些断言。
//
// 现有查询方向都是「实体 → 它的出处」。管理界面（后续 S3）需要反过来看：
// 《宋史》被引用了多少次、支撑了哪些关系、有没有可疑的批量生成。
// 这个方向也是核对出处质量的唯一手段——某个文献的 quote 若高度重复，
// 说明它并非真的被逐条读过。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const VIEW = fs.readFileSync(path.join(ROOT, 'js', 'views', 'source_page.js'), 'utf8');
const API = fs.readFileSync(path.join(ROOT, 'scripts', 'serve_api.js'), 'utf8');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'src', 'store', 'db_schema.js'), 'utf8');

test('sources: provenance 表有 source_title 与 locator 列', () => {
  // source_title 单独存一列而不是每次从 reason 解析《…》：
  //   1. 解析字符串不可靠——reason 是给人看的，格式会变；
  //   2. 反向视图要按文献分组，有列才能走索引。
  assert.match(SCHEMA, /source_title TEXT/);
  assert.match(SCHEMA, /locator\s+TEXT/);
  assert.match(SCHEMA, /idx_prov_source_title/);
});

test('sources: 导入器把文献名写进 locator', () => {
  // build_db 不读 CBDB，所以文献名必须在导入时就带出来，
  // 否则建库时拿不到 TEXT_CODES 的映射。
  const importer = fs.readFileSync(
    path.join(ROOT, 'src', 'importers', 'cbdb_provenance.js'), 'utf8');
  assert.match(importer, /locator\.title = title/);
});

test('sources: API 提供总表与单文献详情', () => {
  assert.match(API, /parts\[1\] === 'sources'/);
  // 总表按 source_title 分组
  assert.match(API, /GROUP BY source_title/);
  // 详情要按 scope 分开统计（边断言 vs 实体断言）
  assert.match(API, /byScope/);
  // distinctQuotes 是质量指标：远小于 total 说明大量断言共用一条引文
  assert.match(API, /COUNT\(DISTINCT quote\)/);
});

test('sources: 页面给出引文多样性判断', () => {
  assert.match(VIEW, /quoteRatio/);
  assert.match(VIEW, /distinctQuotes/);
  // 要有明确的好坏判定，不能只显示数字让用户自己猜
  assert.match(VIEW, /ratioVerdict/);
});

test('sources: 静态模式下显式说明为何不可用', () => {
  // 文献反查要按 source_title 分组统计，静态快照没有这个索引。
  // 不能静默显示空列表——那看起来像「没有文献」。
  assert.match(VIEW, /npm run serve/);
});

test('api: 组件等 probe 完成再判断可用性', () => {
  // isAvailable() 是同步检查，而 probe 在 app.mounted() 里异步跑。
  // 子组件可能先于 probe——那时 isAvailable() 是 false，页面就永远
  // 走「静态模式」，即使后端明明在。/sources 页实测过这个竞态：
  // 控制台里 Api.isAvailable() 是 true，组件里 apiAvailable 是 false。
  const apiSrc = fs.readFileSync(path.join(ROOT, 'js', 'core', 'api.js'), 'utf8');
  assert.match(apiSrc, /ApiClient\.prototype\.whenReady/);
  assert.match(VIEW, /await Api\.whenReady\(\)/);
});
