// 检索优先走本地全量库。
//
// 分片只有已发布集合（1900+ 阈值，3,641 人），而本地 `npm run serve` 后面
// 是 48.7 万人的数据库。用户搜「安惇」时，分片路径只会返回无关结果——
// 而数据库就在那里，没有理由不用。
//
// 这里测的是「有没有接上」以及「API 返回空时不回落」。后者容易写错：
// 回落看似更稳健，实际会拿分片里首字相同的无关条目凑数，
// 让「查无此人」变成「查到了别人」。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js', 'core', 'search.js'), 'utf8');

test('search: 有 API 时优先查全量库', () => {
  assert.match(SRC, /this\.api\.isAvailable\(\)/, 'search 必须检查 API 可用性');
  assert.match(SRC, /this\.api\.query\(/, 'search 必须调用 API');
  // FTS 走 `name` + `text`，不是 `prefix`：前缀桶只能匹配首字，
  // 而 FTS 能匹配别名（「趙禎」命中「俞氏」的别名「趙禎妻」）。
  assert.match(SRC, /field:\s*'name',\s*op:\s*'text'/, '应使用全文检索而非前缀匹配');
});

test('search: API 返回空不回落分片', () => {
  // 回落会让「查无此人」变成「查到了别人」——分片里首字相同的条目
  // 会被当成结果返回。空结果是真实答案，必须原样返回。
  const body = SRC.slice(SRC.indexOf('SearchEngine.prototype.search'));
  const apiBlock = body.slice(0, body.indexOf('_candidates'));
  assert.match(apiBlock, /return \[\];/, 'API 空结果应直接返回空数组');
  // 回落只应发生在 catch 里（API 挂了），不是 rows.length === 0 时。
  const catchIdx = apiBlock.indexOf('catch');
  const emptyReturnIdx = apiBlock.indexOf('return [];');
  assert.ok(catchIdx > 0 && emptyReturnIdx < catchIdx,
    '空结果返回必须在 catch 之前，不能是错误处理的一部分');
});

test('search: Api 定义在 SearchEngine 之前', () => {
  // 顺序错了会得到 `Cannot access 'Api' before initialization`——
  // 整个 services.js 加载失败，页面白屏。这不是假设：改动时踩过一次。
  const services = fs.readFileSync(path.join(ROOT, 'js', 'services.js'), 'utf8');
  const apiIdx = services.indexOf('new HM.HMApi.ApiClient(');
  const seIdx = services.indexOf('new HM.HMSearch.SearchEngine(');
  assert.ok(apiIdx > 0 && seIdx > 0, '两处定义都应存在');
  assert.ok(apiIdx < seIdx, 'Api 必须先于 SearchEngine 定义');
  // 且要真的传进去，不能只定义不用。
  assert.match(services, /SearchEngine\(DataStore,\s*\{[^}]*api:\s*Api/,
    'SearchEngine 构造时必须传入 api');
});

test('services: loadEntityDetail 把 API 形状转成 relations', () => {
  // 详情页用 `entity.relations`（按谓词分组），API 给的是
  // `outgoing`/`incoming`（按方向分）。不转换的话详情页拿不到关系，
  // 或者更糟——拿到 `outgoing` 却按 `relations` 读，得到 undefined。
  const services = fs.readFileSync(path.join(ROOT, 'js', 'services.js'), 'utf8');
  assert.match(services, /function relationsFromApiDetail/, '必须有适配函数');
  assert.match(services, /detail\.relations = relationsFromApiDetail\(detail\)/,
    'loadEntityDetail 必须调用适配函数');
});

test('services: 反向边用逆谓词，不是原谓词加 /反', () => {
  // 入边 `X --maleChild--> 我` 意为「X 的儿子是我」，
  // 从我这边看是「X 是我的父亲」= `father/反`。
  // 写成 `maleChild/反` 会在页面上把父亲显示成「儿子（反）」。
  const services = fs.readFileSync(path.join(ROOT, 'js', 'services.js'), 'utf8');
  const block = services.slice(
    services.indexOf('function relationsFromApiDetail'),
    services.indexOf('async function loadEntityDetail'),
  );
  assert.match(block, /const invKey = invOf\(e\.predicate\)/, '反向必须换算成逆谓词');
  assert.match(block, /invKey !== e\.predicate \? invKey : e\.predicate/, '换算后才加 /反');
});
