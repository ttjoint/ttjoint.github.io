// 第 0 层记录的纯文本投影。
//
// ## 为什么需要它
//
// `quote` 不能由提交者填写（否则与手写断言无异），必须从原文按字符区间
// 截取。而 `raw/` 存的是结构化记录（`payload` 对象），不是一段散文。
//
// 于是需要一层**确定性投影**：把任意 raw 记录映射成一段纯文本。
// 「确定性」是硬要求：
//
//   - 同一条记录，任何时间、任何进程，投影结果必须逐字节相同；
//   - 否则今天存的 span 明天指向别的位置，引文就错了。
//
// ## 为什么不用 JSON
//
// 最初想用 `JSON.stringify(payload)`，但有两个问题：
//
//   1. **转义污染 span**。中文引号、换行在 JSON 里变成 `\"` `\n`，
//      用户在界面上划取的是**渲染后**的文字，两者偏移对不上。
//   2. **人读不了**。一行几百字符的 JSON，录入员看不出哪段是「原文」。
//
// 改用行式格式：每行 `字段名<TAB>值`，空值写成空字符串。这样：
//
//   - 没有转义字符，界面显示的就是投影本身，span 一一对应；
//   - 每行一个字段，录入员能直接看出「这句注释是原文」；
//   - 按字段名排序，顺序稳定。
//
// ## 版本化
//
// 格式一旦改变，旧的 span 全部失效。所以投影带 `version`，
// 并与 quote 一起记录。读取时版本不符 → 拒绝信任旧 span，
// 要求重新核对。宁可让用户重做一次，也不要展示错位的引文。
//
// ## 反向还原
//
// 重新编辑时，需要把已有 quote 的 span 还原成高亮区间。
// `locate()` 做这件事：给定记录与 span，返回原文、引文、前后文。

'use strict';

const crypto = require('crypto');

/**
 * 当前投影格式版本。任何影响输出的改动都必须 +1。
 *
 * v1: `字段名<TAB>值` 每行一个，字段名升序，null/undefined 写空串。
 */
const TEXT_FORMAT_VERSION = 1;

/** 字段名与值之间的分隔符。用 TAB：正文里不会出现，且视觉上对齐。 */
const FIELD_SEP = '\t';

/**
 * 值的字符串化。必须无歧义：
 *   - null / undefined -> 空串（两者在「原文里有没有这个值」上等价）
 *   - 数字 -> 十进制，不用科学计数法（避免 1e+21 这类不稳定输出）
 *   - 布尔 -> true/false
 *   - 对象/数组 -> 紧凑 JSON（这种情况少见，但要有确定行为）
 */
function stringifyValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') {
    // 整数直接用 toString；浮点用 toPrecision 保证跨引擎一致
    return Number.isInteger(v) ? String(v) : v.toPrecision(15);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return JSON.stringify(v);
}

/**
 * 把 raw 记录投影成纯文本。
 *
 * @param {object} record raw 记录（需有 payload）
 * @returns {{version:number, text:string, fields:string[]}}
 */
function projectRecord(record) {
  const payload = record && record.payload;
  if (!payload || typeof payload !== 'object') {
    return { version: TEXT_FORMAT_VERSION, text: '', fields: [] };
  }

  // 网页类记录：抓取时已把正文清洗进 `text`。直接用，不再加字段前缀——
  // 它就是原文，加前缀反而破坏「投影 == 原文」的直觉。
  if (typeof payload.text === 'string') {
    return { version: TEXT_FORMAT_VERSION, text: payload.text, fields: ['text'] };
  }

  // 数据库类记录：字段名升序，逐行 `名<TAB>值`。
  const fields = Object.keys(payload).sort();
  const lines = fields.map((k) => k + FIELD_SEP + stringifyValue(payload[k]));
  return {
    version: TEXT_FORMAT_VERSION,
    text: lines.join('\n'),
    fields,
  };
}

/** 投影文本的指纹。用来检测「记录变了但 span 没跟着变」。 */
function textFingerprint(text) {
  return 'sha256:' + crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 把 span 还原成可展示的片段。重新编辑时用。
 *
 * @param {object} record
 * @param {{start:number, end:number}} span
 * @returns {{ok:boolean, version?:number, text?:string, quote?:string,
 *            before?:string, after?:string, fingerprint?:string,
 *            code?:string, message?:string}}
 */
function locate(record, span) {
  const proj = projectRecord(record);
  const text = proj.text;

  if (!text) {
    return { ok: false, code: 'no-text', message: '这条 raw 记录没有可投影的文本' };
  }
  if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end)) {
    return { ok: false, code: 'bad-span', message: 'span 必须是 {start, end} 整数对', version: proj.version, text };
  }

  const { start, end } = span;
  if (start < 0 || end > text.length || start >= end) {
    return {
      ok: false,
      code: 'span-out-of-range',
      message: `span [${start}, ${end}) 超出范围 [0, ${text.length}) 或长度为零`,
      version: proj.version,
      text,
    };
  }

  const quote = text.slice(start, end);
  if (!quote.trim()) {
    return { ok: false, code: 'empty-quote', message: '截取结果为空或全空白', version: proj.version, text };
  }

  return {
    ok: true,
    version: proj.version,
    text,
    quote,
    // 前后文供界面高亮显示：让录入员看到「划的是哪一句」
    before: text.slice(Math.max(0, start - 40), start),
    after: text.slice(end, Math.min(text.length, end + 40)),
    fingerprint: textFingerprint(quote),
  };
}

/**
 * 校验一条引用：span 必须落在原文里，quote 必须是截取结果。
 *
 * @param {object} record raw 记录
 * @param {object} prov   { rawRef, span, quote?, formatVersion? }
 * @returns {{ok:boolean, quote?:string, span?:object, formatVersion?:number,
 *            fingerprint?:string, issues:Array}}
 */
function resolveQuote(record, prov) {
  const issues = [];

  if (!record) {
    return { ok: false, issues: [{ field: 'rawRef', code: 'raw-not-found', message: 'rawRef 对应的记录不存在' }] };
  }

  const located = locate(record, prov && prov.span);
  if (!located.ok) {
    return { ok: false, issues: [{ field: 'span', code: located.code, message: located.message }] };
  }

  // 版本不符：说明投影格式变过，旧 span 已不可信。
  // 用 != null 而非真值判断：formatVersion 为 0 也是合法值，
  // 用 `&&` 会把它当「未提供」而跳过检查。
  if (prov && prov.formatVersion != null && prov.formatVersion !== located.version) {
    issues.push({
      field: 'formatVersion',
      code: 'format-version-mismatch',
      message: `引用记录于格式 v${prov.formatVersion}，当前是 v${located.version}——span 可能已错位，请重新划取`,
    });
  }

  // 提交者若给了 quote，必须与截取结果一致。
  // 不是「信任」它，而是暴露前端划取逻辑的 bug——静默采用其一会掩盖问题。
  if (prov && typeof prov.quote === 'string' && prov.quote.trim() && prov.quote !== located.quote) {
    issues.push({
      field: 'quote',
      code: 'quote-mismatch',
      message: '提交的 quote 与按 span 截取的结果不一致——前端划取区间可能有误',
    });
  }

  if (issues.length) return { ok: false, issues };

  return {
    ok: true,
    quote: located.quote,
    span: { start: prov.span.start, end: prov.span.end },
    formatVersion: located.version,
    fingerprint: located.fingerprint,
    issues: [],
  };
}

module.exports = {
  TEXT_FORMAT_VERSION,
  FIELD_SEP,
  projectRecord,
  stringifyValue,
  textFingerprint,
  locate,
  resolveQuote,
};
