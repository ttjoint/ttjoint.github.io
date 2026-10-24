// 冲突检测器注册表。
//
// ## 为什么检测器要能开关
//
// 「冲突」的判定标准本身是**有争议的**。举两个例子：
//
//   - 「父母与子女年龄差 < 12 岁」——古代 11 岁生子并不罕见。
//     按今天的常识这是异常，按当时是实情。要不要标，取决于你信哪套。
//   - 「同一人有多个生年说法」——这不是错误，是史料分歧。
//     标出来有价值（提醒读者有多种说法），但也可能被视为噪音。
//
// 把判定固化成代码里写死的规则，等于替使用者做了这个判断。
// 所以每条检测器都是**可单独关闭**的，且关闭状态可查。
//
// ## 为什么结果不写进 edges
//
// 判断会随规则变化，事实不会。写进 `edges` 就把两层混了：
//
//   - 开关检测器要重建整个库（200 秒），实际等于没法开关
//   - 多条检测器命中同一条边时单列只能存一个，信息丢失
//   - 聚合统计要解析中文 reason 字符串（试过，输出爆了 26KB）
//
// 结果写 `edge_flags` 表（sidecar），由 `scripts/run_detectors.js`
// 独立重算。`edges` 一条不动。
//
// ## 每条检测器必须声明
//
//   id          稳定标识，写进 edge_flags.detector_id
//   title       给人看的名字
//   rationale   为什么这条规则成立、什么时候它可能是错的
//   severity    'conflict' | 'suspect'
//   defaultOn   默认是否启用
//   run         纯函数 (ctx) => Array<{edgeId, reason}>

'use strict';

const { AGE_BOUNDS } = require('../temporal_bounds.js');

const DAYS_PER_YEAR = 365.25;

/**
 * 从「1037年1月8日」「1037年」「前14年」这类文本里取年份。
 *
 * 用于区分「精度不同」和「说法不同」：同一年内的不同精度不是冲突。
 * 取不出年份返回 null（调用方会把 null 当作「无法判断」，倾向于标注）。
 */
function extractYear(text) {
  const s = String(text || '');
  const m = s.match(/(前)?\s*(\d{1,5})\s*年?/);
  if (!m) return null;
  const y = parseInt(m[2], 10);
  return m[1] ? -y : y;
}

/**
 * 亲子年龄倒挂：父母出生不早于子女。
 *
 * 方向约定：
 *   father/mother        subject=子女, object=父/母
 *   maleChild/femaleChild subject=父/母, object=子女
 */
const parentAgeInverted = {
  id: 'parent-age-inverted',
  title: '父母出生不早于子女',
  rationale:
    '血缘上不可能。但更可能是录入错误，或生年本身是推的（CBDB 的 c_birthyear ' +
    '常是推算而非记载）。系统没有能力判断是哪一种，所以只标注，不改数据。',
  severity: 'suspect',
  defaultOn: true,
  run({ edges, lifespan }) {
    const PARENT_OF = new Set(['father', 'mother']);
    const CHILD_OF = new Set(['maleChild', 'femaleChild', 'childOfFather', 'childOfMother']);
    const out = [];

    for (const e of edges) {
      const isParent = PARENT_OF.has(e.predicate);
      const isChild = CHILD_OF.has(e.predicate);
      if (!isParent && !isChild) continue;

      const childId = isParent ? e.subject : e.object;
      const parentId = isParent ? e.object : e.subject;
      const child = lifespan.get(childId);
      const parent = lifespan.get(parentId);
      if (!child || !parent) continue;
      if (child.validFrom == null || parent.validFrom == null) continue;

      const gap = (child.validFrom - parent.validFrom) / DAYS_PER_YEAR;
      if (gap <= 0) {
        out.push({
          edgeId: e.id,
          reason: `父母出生不早于子女（差 ${gap.toFixed(1)} 岁）`,
        });
      }
    }
    return out;
  },
};

/**
 * 亲子年龄差超出应然范围。
 *
 * 关键：这里用的是**应然**（通常如此），不是**实然**（必然如此）。
 * 用作标注是安全的（只是提醒），用作校验会拒绝真实数据。
 */
const parentAgeOutOfRange = {
  id: 'parent-age-out-of-range',
  title: '亲子年龄差超出应然范围',
  rationale:
    '下限取 12 岁、上限取 70 岁是「通常如此」，不是「必然如此」。' +
    '古代早育常见（实测有 11 岁生子），现代晚育也有超过 70 的个案。' +
    '所以这条规则本身可疑——它可能把真实历史判成异常。' +
    '默认启用是因为「提示可能有录入错误」仍有用，但随时可关。',
  severity: 'suspect',
  defaultOn: true,
  run({ edges, lifespan, ageBounds }) {
    const bounds = ageBounds || AGE_BOUNDS;
    const PARENT_OF = new Set(['father', 'mother']);
    const CHILD_OF = new Set(['maleChild', 'femaleChild', 'childOfFather', 'childOfMother']);
    const out = [];

    for (const e of edges) {
      const isParent = PARENT_OF.has(e.predicate);
      const isChild = CHILD_OF.has(e.predicate);
      if (!isParent && !isChild) continue;

      const childId = isParent ? e.subject : e.object;
      const parentId = isParent ? e.object : e.subject;
      const child = lifespan.get(childId);
      const parent = lifespan.get(parentId);
      if (!child || !parent) continue;
      if (child.validFrom == null || parent.validFrom == null) continue;

      const gap = (child.validFrom - parent.validFrom) / DAYS_PER_YEAR;
      if (gap <= 0) continue; // 倒挂由另一条检测器负责

      // AGE_BOUNDS 里父子方向相反（father.min=12 表示父亲至少大 12 岁；
      // maleChild.min=-70 表示子女至多小 70 岁）。取绝对值后必须重排，
      // 否则得到 [70, 12] 这种倒置区间，会把正常的 30 岁差判成越界。
      const b = bounds[e.predicate] || { min: 12, max: 70 };
      const lo = Math.min(Math.abs(b.min), Math.abs(b.max));
      const hi = Math.max(Math.abs(b.min), Math.abs(b.max));
      if (gap < lo || gap > hi) {
        out.push({
          edgeId: e.id,
          reason: `亲子年龄差 ${gap.toFixed(1)} 岁，超出 [${lo}, ${hi}]`,
        });
      }
    }
    return out;
  },
};

/**
 * 同一主体同一 literal 谓词多个不同值。
 *
 * 这类**不是错误**，是史料分歧（如老子生年有多说）。
 * severity 用 'conflict' 而不是 'suspect'，界面上应并列显示而非警示。
 */
const multipleValues = {
  id: 'multiple-values',
  title: '同一属性有多个不同说法',
  rationale:
    '这不是错误，是史料分歧。系统不应替史学界选一个，而应并列保留并' +
    '标明每种的出处。标出来的价值是提醒读者「这里不只有一种说法」。',
  severity: 'conflict',
  defaultOn: true,
  run({ edges, literalPredicates, mergeMap }) {
    // 按「归并后的规范实体」分组，不是按原始 subject。
    //
    // 这是关键：苏轼的两个来源是两个实体（person:cbdb-3767 与
    // person:wikipedia-xxx），各自一条 birthDate 边。不归并的话
    // 它们落在不同分组里，永远看不出「同一人有两种生年说法」——
    // 检测器形同虚设。实测归并前 multiple-values 恒为 0。
    const canon = (id) => (mergeMap && mergeMap.get(id)) || id;
    const bySubjectPred = new Map();
    for (const e of edges) {
      if (!literalPredicates.has(e.predicate)) continue;
      const k = canon(e.subject) + '\u0000' + e.predicate;
      if (!bySubjectPred.has(k)) bySubjectPred.set(k, []);
      bySubjectPred.get(k).push(e);
    }

    const out = [];
    for (const [, list] of bySubjectPred) {
      const values = new Set(list.map((e) => e.object));
      if (values.size <= 1) continue;

      // 「1037年1月8日」与「1037年」不是冲突，是**精度不同**。
      //
      // 实测 82 条里绝大多数是这一类（维基到日、CBDB 到年）。
      // 把它们标成「多说法」会让读者以为史料有分歧，而实际只是
      // 一方记得更细——这是制造假冲突，比漏标更糟。
      //
      // 判据：把每个值归一到「年」，若年份全相同 → 精度差异，不标。
      const years = new Set(list.map((e) => extractYear(e.object)));
      if (years.size <= 1 && !years.has(null)) continue;

      for (const e of list) {
        out.push({
          edgeId: e.id,
          reason: `同一 ${e.predicate} 有 ${values.size} 种不同说法：${[...values].join(' / ')}`,
        });
      }
    }
    return out;
  },
};

/** 关系成立早于主体出生。 */
const beforeParticipantBirth = {
  id: 'before-participant-birth',
  title: '关系成立早于主体出生',
  rationale: '参与者在出生前不可能进入任何关系。通常说明时间数据有误。',
  severity: 'suspect',
  defaultOn: true,
  run({ edges, lifespan }) {
    const out = [];
    for (const e of edges) {
      if (e.validFrom == null) continue;
      const subj = lifespan.get(e.subject);
      if (!subj || subj.validFrom == null) continue;
      if (e.validFrom < subj.validFrom) {
        out.push({ edgeId: e.id, reason: '关系成立早于主体出生' });
      }
    }
    return out;
  },
};

const ALL = [
  parentAgeInverted,
  parentAgeOutOfRange,
  multipleValues,
  beforeParticipantBirth,
];

/** id → 检测器 */
const BY_ID = new Map(ALL.map((d) => [d.id, d]));

/**
 * 跑指定的检测器。
 *
 * @param {object} ctx  { edges, lifespan, literalPredicates, ageBounds }
 * @param {string[]} [enabledIds]  省略则用各自的 defaultOn
 * @returns {{flags: Array<{edgeId,detectorId,severity,reason}>, byDetector: object, skipped: string[]}}
 */
function runDetectors(ctx, enabledIds) {
  const flags = [];
  const byDetector = {};
  const skipped = [];

  for (const d of ALL) {
    const on = enabledIds ? enabledIds.includes(d.id) : d.defaultOn;
    if (!on) {
      skipped.push(d.id);
      byDetector[d.id] = { title: d.title, severity: d.severity, ran: false, count: 0 };
      continue;
    }
    const hits = d.run(ctx);
    for (const h of hits) {
      flags.push({
        edgeId: h.edgeId,
        detectorId: d.id,
        severity: d.severity,
        reason: h.reason,
      });
    }
    byDetector[d.id] = {
      title: d.title,
      severity: d.severity,
      ran: true,
      count: hits.length,
    };
  }

  return { flags, byDetector, skipped };
}

module.exports = { ALL, BY_ID, runDetectors };
