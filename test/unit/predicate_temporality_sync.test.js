// 谓词时间性：两处清单必须一致。
//
// `serve_api.js` 硬编码了一份 PERSISTENT_PREDICATES，因为 API 是独立进程、
// 不加载整个谓词注册表。这份清单与 `registry.js` 的 temporality 字段
// 描述同一件事——两边不一致时，切片查询会漏掉或错判某类关系，
// 而这类错误是静默的：页面只是少显示几条边，不会报错。
//
// 所以必须有测试盯着。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function apiPersistentSet() {
  const api = fs.readFileSync(path.join(ROOT, 'scripts', 'serve_api.js'), 'utf8');
  const m = api.match(/const PERSISTENT_PREDICATES = \[([\s\S]*?)\];/);
  assert.ok(m, 'serve_api.js 里应有 PERSISTENT_PREDICATES');
  // 去掉 // 行注释，否则注释文字会被当成谓词名。
  const body = m[1]
    .split(String.fromCharCode(10))
    .filter((l) => !l.trim().startsWith('//'))
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join(String.fromCharCode(10));
  return new Set(
    body.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean),
  );
}

function registryPersistentSet() {
  const registry = require('../../src/predicates/registry.js');
  const reg = new registry.PredicateRegistry();
  const out = new Set();
  for (const def of reg.list()) {
    if (def.temporality === 'persistent') out.add(def.key);
  }
  return out;
}

test('temporality: serve_api 的持久谓词清单与 registry 一致', () => {
  const apiSet = apiPersistentSet();
  const regSet = registryPersistentSet();

  // 两边都必须非空，否则「一致」是无意义的
  assert.ok(apiSet.size > 0, 'API 清单不应为空');
  assert.ok(regSet.size > 0, 'registry 应有 persistent 谓词');

  const onlyApi = [...apiSet].filter((k) => !regSet.has(k));
  const onlyReg = [...regSet].filter((k) => !apiSet.has(k));
  assert.deepEqual(onlyApi, [], `API 有而 registry 没有：${onlyApi.join(', ')}`);
  assert.deepEqual(onlyReg, [], `registry 有而 API 没有：${onlyReg.join(', ')}`);
});

test('temporality: 每个谓词都声明时间性，无默认兜底', () => {
  // 未声明 temporality 的谓词会落进「不知道该怎么切片」的灰区。
  // 要求显式声明，逼作者想清楚这个关系会不会随时间失效。
  const registry = require('../../src/predicates/registry.js');
  const reg = new registry.PredicateRegistry();
  const missing = [];
  for (const def of reg.list()) {
    if (!def.temporality) missing.push(def.key);
  }
  assert.deepEqual(missing, [], `缺 temporality 的谓词：${missing.join(', ')}`);
});

test('temporality: 取值只能是三档之一', () => {
  const registry = require('../../src/predicates/registry.js');
  const reg = new registry.PredicateRegistry();
  const allowed = new Set(['persistent', 'concurrent', 'attribute']);
  const bad = [];
  for (const def of reg.list()) {
    if (def.temporality && !allowed.has(def.temporality)) {
      bad.push(`${def.key}=${def.temporality}`);
    }
  }
  assert.deepEqual(bad, [], `非法 temporality：${bad.join(', ')}`);
});
