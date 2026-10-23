'use strict';
/**
 * 阻断「关系边用了注册表里不存在的谓词 key」这类回归。
 *
 * ## 背景
 *
 * P5-5a 之前有 26,891 个实体带 34,700 条非法谓词边（`wife` / `stepMother` /
 * `daughter` / `concubine` / `son` / `olderSibling`）。这些 key 不在
 * `src/predicates/registry.js` 里，导致：
 *
 *   - 前端 `relations.js` 找不到 label，只能显示英文 key
 *   - `checkAssertion` 无法校验 domain/range
 *   - 反查（`/反`）无从实现，因为注册表里没有 `inverse`
 *
 * ## 为什么以前没被发现
 *
 * 没有任何测试读过实体的 `relations` 去比对注册表。`validate_data.js` 只查
 * id 唯一性和必需字段。这个测试补上这个缺口。
 *
 * ## 唯一被放行的例外
 *
 * `daughter` 在 2 个实体上保留原样（CBDB 源数据自相矛盾，见
 * `tools/oneoff/fix_unregistered_predicates.js` 的 `CONTRADICTORY` 注释）。
 * 这里显式列出它，让例外是「有据可查的一条」而不是「一堆噪声」。
 *
 * ## 为什么一次扫描而不是两个测试各扫一遍
 *
 * 486,786 个文件读一遍要 ~70s。拆成两个 `test()` 各读一遍就是 140s，
 * 而它们检查的是同一批数据。单次扫描后分别断言，成本减半。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { BUILTIN } = require('../../src/predicates/registry');

const ROOT = path.join(__dirname, '..', '..');
const PERSON_DIR = path.join(ROOT, 'data', 'persons', 'entities');

/**
 * 允许保留的非法 key，每个都必须在 `CONTRADICTORY` 注释里有理由。
 * 这是白名单，不是逃生门：新增条目必须同时写明为什么不能自动修。
 */
const ALLOWED_LEGACY = new Set(['daughter']);

/** 谓词 key 可能带修饰符（`spouse/非`），比对时只取基座。 */
const baseKey = (k) => String(k).split('/')[0];

/**
 * 单次全量扫描，返回两类问题：
 *   - `unregistered`：注册表里没有的谓词 key → Map<key, sampleIds[]>
 *   - `malformed`   ：id 里出现多个 `person:` 前缀（双重拼接 bug）
 */
function scanRelations() {
  const known = new Set(BUILTIN.map((p) => p.key));
  const unregistered = new Map();
  const malformed = [];

  for (const f of fs.readdirSync(PERSON_DIR)) {
    if (!f.endsWith('.json')) continue;
    let e;
    try {
      e = JSON.parse(fs.readFileSync(path.join(PERSON_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(e.relations || {})) {
      const b = baseKey(k);
      if (!known.has(b) && !ALLOWED_LEGACY.has(b)) {
        if (!unregistered.has(b)) unregistered.set(b, []);
        const arr = unregistered.get(b);
        if (arr.length < 5) arr.push(e.id);
      }
      for (const o of Array.isArray(v) ? v : [v]) {
        const id = String(o && o.id ? o.id : o);
        if ((id.match(/person:/g) || []).length > 1 && malformed.length < 5) {
          malformed.push(`${e.id} --${k}--> ${id}`);
        }
      }
    }
  }
  return { unregistered, malformed };
}

test('relation edges use only registered predicate keys and well-formed ids', () => {
  const { unregistered, malformed } = scanRelations();

  if (unregistered.size) {
    const detail = [...unregistered].map(([k, ids]) => `${k} (${ids.join(', ')})`).join('; ');
    assert.fail(`unregistered predicate keys in data: ${detail}`);
  }

  // 一个真实发生过的 bug：把 `person:local-000307` 统一拼成 `person:cbdb-${oid}`，
  // 产生了 `person:cbdb-person:local-000307`。判据是 `person:` 只应出现一次。
  assert.deepStrictEqual(
    malformed,
    [],
    `malformed relation ids: ${malformed.join('; ')}`,
  );
});
