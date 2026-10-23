// 提交校验：任何写入意义网的改动都必须先过这一关。
//
// ## 为什么单独成模块
//
// 编辑界面的价值不在于「能改」，而在于**改得可信**。一个没有校验的
// 编辑框等于把前端曾经做过的事（localStorage 假写）搬到后端重演一遍。
//
// 校验规则来自 `docs/architecture/节点类型与谓词.md` §6：
//   - `quote` 必填非空（§6.2）
//   - `rawRef` 必填且能在 raw 层解析（§6.1）
//   - `commitId` 必填（§6.2）
//   - 谓词必须在注册表里（否则边无法被查询理解）
//   - 宾语类型必须符合谓词的 domain/range
//
// ## 设计原则
//
// 校验失败返回**全部**错误，不是遇到第一个就抛。用户提交一次表单，
// 应该一次看到所有问题，而不是改一个、再试、再发现下一个。
//
// 本模块不写盘、不改库，纯函数。写入由调用方负责。

'use strict';

const { PredicateRegistry } = require('../predicates/registry.js');

/**
 * @typedef {object} ValidationIssue
 * @property {string} field   出问题的字段（'quote' / 'rawRef' / 'predicate' …）
 * @property {string} code    机器可读的错误码
 * @property {string} message 给人看的说明
 */

/**
 * 校验一条待提交的断言。
 *
 * @param {object} claim
 *   @param {string} claim.subject     主语实体 id
 *   @param {string} claim.predicate   谓词 key
 *   @param {string} claim.object      宾语实体 id，或 literal 值
 *   @param {object} claim.provenance  { rawRef, quote, locator?, reason? }
 * @param {object} ctx
 *   @param {function} [ctx.rawExists]  (rawRef) => boolean，验证第 0 层存在
 *   @param {object}   [ctx.registry]   PredicateRegistry 实例
 * @param {Set}       [ctx.entityIds]  已存在的实体 id 集合（可选）
 * @returns {{ ok: boolean, issues: ValidationIssue[], normalized: object|null }}
 */
function validateClaim(claim, ctx = {}) {
  const issues = [];
  const registry = ctx.registry || new PredicateRegistry();
  const rawExists = ctx.rawExists || null;

  if (!claim || typeof claim !== 'object') {
    return { ok: false, issues: [{ field: '*', code: 'not-an-object', message: '提交内容不是一个对象' }], normalized: null };
  }

  // ---------------------------------------------------------------- 端点
  const subject = String(claim.subject || '').trim();
  const object = String(claim.object || '').trim();
  const predicate = String(claim.predicate || '').trim();

  if (!subject) issues.push({ field: 'subject', code: 'required', message: '缺少主语' });
  if (!object) issues.push({ field: 'object', code: 'required', message: '缺少宾语' });
  if (!predicate) issues.push({ field: 'predicate', code: 'required', message: '缺少谓词' });

  if (subject && subject === object) {
    // 自指几乎总是录入失误。真正的自反关系（如「自己与自己同乡」）没有实际意义。
    issues.push({ field: 'object', code: 'self-reference', message: '主语与宾语相同' });
  }

  // ---------------------------------------------------------------- 谓词
  let def = null;
  if (predicate) {
    def = registry.get(predicate);
    if (!def) {
      // 未注册谓词不拒绝入库会怎样：这条边能被写入，但查询层不认识它，
      // 于是它既不能被「父亲」查到，也不会出现在任何关系卡片里——
      // 一条存在但看不见的边，比不存在更糟。
      issues.push({
        field: 'predicate',
        code: 'unknown-predicate',
        message: `谓词 "${predicate}" 不在注册表中`,
      });
    }
  }

  // ---------------------------------------------------------------- 出处
  const prov = claim.provenance || {};
  const rawRef = String(prov.rawRef || '').trim();
  const quote = String(prov.quote || '').trim();

  if (!rawRef) {
    issues.push({ field: 'rawRef', code: 'required', message: '缺少 rawRef（第 0 层定位）' });
  } else if (rawExists) {
    // 只在调用方给了校验函数时才检查。纯逻辑测试不需要真的 raw/ 目录。
    if (!rawExists(rawRef)) {
      issues.push({
        field: 'rawRef',
        code: 'raw-not-found',
        message: `rawRef "${rawRef}" 在 raw 层找不到对应记录`,
      });
    }
  }

  if (!quote) {
    // 空 quote 等于没出处。这正是清理 111 条空 excerpt 证据时要消灭的东西。
    issues.push({
      field: 'quote',
      code: 'required',
      message: '缺少 quote（原文摘录）——没有它，这条断言无从核对',
    });
  }

  // ---------------------------------------------------------------- 类型
  // 只在两端都能判定类型时检查。literal 谓词不检查宾语。
  if (def && object && def.range !== 'literal' && ctx.entityIds) {
    const objType = object.split(':')[0];
    if (ctx.entityIds.has(object) || ['person', 'organization', 'event', 'thing', 'evidence'].includes(objType)) {
      // 谓词的 range 可能是具体类型，也可能是 'literal'
      if (def.range && objType && def.range !== objType && def.range !== 'literal') {
        issues.push({
          field: 'object',
          code: 'range-mismatch',
          message: `谓词 "${predicate}" 的宾语类型应为 ${def.range}，实际是 ${objType}`,
        });
      }
    }
  }

  const ok = issues.length === 0;
  return {
    ok,
    issues,
    normalized: ok
      ? {
          subject,
          predicate,
          object,
          provenance: {
            rawRef,
            quote,
            locator: prov.locator && typeof prov.locator === 'object' ? prov.locator : undefined,
            reason: prov.reason ? String(prov.reason) : undefined,
          },
        }
      : null,
  };
}

/**
 * 校验一批断言。返回逐条结果与汇总。
 *
 * @param {Array} claims
 * @param {object} ctx  同 validateClaim
 * @returns {{ ok: boolean, total: number, failed: number, results: Array }}
 */
function validateBatch(claims, ctx = {}) {
  const list = Array.isArray(claims) ? claims : [];
  const results = list.map((c, i) => ({ index: i, ...validateClaim(c, ctx) }));
  const failed = results.filter((r) => !r.ok).length;
  return { ok: failed === 0 && list.length > 0, total: list.length, failed, results };
}

/**
 * 从一组校验通过的断言生成提交记录。
 *
 * `commitId` 由调用方分配（当前是 `c-` + 6 位序号）。
 * 本函数只负责组装结构，不负责写盘。
 */
function buildCommit(claims, meta = {}) {
  const ids = new Set();
  for (const c of claims) {
    ids.add(c.subject);
    ids.add(c.object);
  }
  return {
    commitId: meta.commitId || null,
    at: meta.at || new Date().toISOString(),
    author: meta.author || 'unknown',
    message: meta.message || '',
    parentId: meta.parentId || null,
    stats: {
      claims: claims.length,
      entities: ids.size,
      // 记录每条断言的 rawRef，便于事后核对「这次提交读了哪些原始记录」
      rawRefs: claims.map((c) => c.provenance.rawRef),
    },
    anchor: meta.anchor || null,
  };
}

module.exports = { validateClaim, validateBatch, buildCommit };
