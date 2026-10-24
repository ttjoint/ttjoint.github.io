// 时间下界推导：把「时间不详」变成「有界但宽」。
//
// ## 为什么需要
//
// 文档 §2.2.1：任何成立的断言，其成立时刻必然落在某个可推导的区间内，
// 因为参与者的存在本身就有边界。`valid_from`/`valid_to` 全空等于宣称
// 「这个关系在任意时刻都可能成立」——那放弃了时间分析，而时间是本系统
// 的基本度量。
//
// ## 推导 vs 编造
//
// 推导只用**已有数据**，不引入任何外部知识：
//
//   - 人物生卒（`entities.valid_from`/`valid_to`）
//   - 组织成立/解散
//   - 谓词的应然约束（生育年龄、任职年龄）
//
// 推导结果必须标注 `boundsSource`，让人一眼看出「这是推的，不是原文说的」。
// 原文明确记载的时间永远优先，推导只在缺失时兜底。
//
// ## 应然约束为什么合理
//
// 这些数字不是精确值，用途也不是断言「一定在这个区间内」，而是**排除不可能**：
// 一个人不可能 1000 岁还在任，不可能在出生前任职。作为**宽边界**它们是
// 安全的——宁可区间过宽（可能包含错误时刻），也不要区间过窄（排除真实时刻）。
//
// ## 已知局限
//
// 推导出的下界可能远宽于真实值。例如「某人 1050 年任某职」只知生年是
// 1000，推导出「≥1012（15 岁）」——但实际可能 1049 年才就任。
// 这没关系：推导的用途是**让切片查询能命中**，不是声称精确。

'use strict';

// 实体与边的时间列都存 **Julian day number**（JDN），不是年份。
// 推导里的「岁」要乘 365.25 换算——早期版本按年份算，结果推出
// 2101658 这种数字，切片传 1050 永远对不上。
const DAYS_PER_YEAR = 365.25;

function yearsToDays(n) {
  return Math.round(n * DAYS_PER_YEAR);
}

/**
 * 谓词的应然年龄约束（岁）。
 *
 * `min` 是「不可能早于此」，`max` 是「不可能晚于此」。
 * 只用于推导，不用于校验——校验若用这些值会拒绝真实数据。
 */
const AGE_BOUNDS = {
  // 生育：父母年龄
  father: { min: 12, max: 70 },
  mother: { min: 12, max: 50 },
  childOfFather: { min: -70, max: -12 },
  childOfMother: { min: -50, max: -12 },
  maleChild: { min: -70, max: -12 },
  femaleChild: { min: -70, max: -12 },

  // 婚姻
  wife: { min: 12, max: 100 },
  husband: { min: 12, max: 100 },
  spouse: { min: 12, max: 100 },

  // 任职与成员
  memberOf: { min: 15, max: 100 },
  employer: { min: 15, max: 100 },
  teacherOf: { min: 15, max: 100 },
  studentOf: { min: 5, max: 100 },
  colleague: { min: 15, max: 100 },
};

/** 默认：成年后。用于未列出的 concurrent 谓词。 */
const DEFAULT_MIN_AGE = 15;

/**
 * 推导一条边的时间下界。
 *
 * @param {object} edge
 *   @param {string} edge.predicate
 *   @param {number|null} edge.validFrom
 *   @param {number|null} edge.validTo
 *   @param {number|null} edge.observedAt
 *   @param {object|null} subject  主体实体 {valid_from, valid_to}
 *   @param {object|null} object   客体实体（literal 谓词为 null）
 * @param {string} temporality    'persistent' | 'concurrent' | 'attribute'
 * @returns {{validFrom:number|null, validTo:number|null, boundsSource:string|null}}
 */
function inferBounds(edge, subject, object, temporality) {
  // 已有显式时间：不动。原文说了什么就是什么。
  if (edge.validFrom != null || edge.validTo != null) {
    return { validFrom: edge.validFrom, validTo: edge.validTo, boundsSource: 'stated' };
  }
  // 观测点：它本身就是一个「有界」的答案（点区间），不需要推导。
  if (edge.observedAt != null) {
    return { validFrom: edge.observedAt, validTo: edge.observedAt, boundsSource: 'observed' };
  }

  // attribute 档不参与时间切片，不推导。
  if (temporality === 'attribute') {
    return { validFrom: null, validTo: null, boundsSource: null };
  }

  const subjBirth = subject ? subject.valid_from : null;
  const subjDeath = subject ? subject.valid_to : null;
  const objBirth = object ? object.valid_from : null;
  const objDeath = object ? object.valid_to : null;

  const bound = AGE_BOUNDS[edge.predicate] || { min: DEFAULT_MIN_AGE, max: 100 };

  let from = null;
  let to = null;

  // 下界：主体最早可能成立的时刻。
  //
  // 出生年 + 最小年龄。对逆向谓词（childOfFather）bound.min 是负数，
  // 表示「客体出生前 N 年」——这里主体是子女，下界就是自己的出生年。
  if (subjBirth != null) {
    // persistent 档的关系（父子、朋友、师承）不设年龄下限：
    // 它们一旦成立就永久成立，成立时刻最早只能到「主体出生」。
    //
    // 早期版本对 persistent 也套了 DEFAULT_MIN_AGE=15，结果「安惇 1042 年生」
    // 的朋友关系下界被推到 1057 年，而那位朋友 1051 年就死了——
    // 关系在数据库里存在，却永远查不到。年龄约束只对需要「具备行为能力」
    // 的 concurrent 关系（任职、婚姻）才有意义。
    const minAge = temporality === 'persistent' ? 0 : Math.max(0, bound.min);
    from = subjBirth + yearsToDays(minAge);
  }
  // 客体存在更晚时，关系不可能早于客体诞生。
  if (objBirth != null) {
    from = from == null ? objBirth : Math.max(from, objBirth);
  }

  // 上界：任一参与者死亡即终止。
  const deaths = [subjDeath, objDeath].filter((v) => v != null);
  if (deaths.length) to = Math.min(...deaths);

  // 上界的另一种约束：主体不可能活过 max 岁。用于死亡年缺失时。
  if (to == null && subjBirth != null && bound.max != null) {
    to = subjBirth + yearsToDays(bound.max);
  }

  // 一端都没推出来：这是真正的缺损。返回 null 让调用方知道
  // 「这条边的时间无法推导」，而不是假装推出来了。
  if (from == null && to == null) {
    return { validFrom: null, validTo: null, boundsSource: null };
  }

  return { validFrom: from, validTo: to, boundsSource: 'inferred' };
}

module.exports = { inferBounds, AGE_BOUNDS, DEFAULT_MIN_AGE, yearsToDays, DAYS_PER_YEAR };
