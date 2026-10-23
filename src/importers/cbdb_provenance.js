// 边级出处的构造：把 CBDB 的一行原始记录变成一条 provenance。
//
// 设计依据 docs/architecture/节点类型与谓词.md §6.1/§6.2：
//
//   节点 provenance = 这个实体本身被记载于哪里
//   边   provenance = **这条断言**出自哪里
//
// 二者不可互推：同一个人的生年出自 BIOG_MAIN，父子关系出自 KIN_DATA，
// 是两条不同的原始记录。所以出处必须挂在边的实例上，而不是谓词定义上——
// 「张三是李四的父亲」和「王五是赵六的父亲」是同一种谓词，两处出处。
//
// rawRef 格式（§6.1 的例子）：
//   raw:cbdb/KIN_DATA/<personid>|<kin_id>|<kin_code>
// 三元组能唯一定位 KIN_DATA 的一行，是第 0 层定位。
//
// 关于 quote 必填（§6.4）：CBDB 有 80.2% 的亲属行没有 c_notes，13.4% 没有
// 文献出处。此时用「对源行字段的直接重述」作为 quote——这不是编造引文，
// 任何人拿 rawRef 都能核对这几个字段。空 quote 才是问题：它等于没出处。

/** 文献目录缓存：c_source → 书名。 */
function buildTextTitles(readRows, db) {
  const map = new Map();
  try {
    for (const r of readRows(db, 'TEXT_CODES')) {
      map.set(r.c_textid, r.c_title_chn || r.c_title || '');
    }
  } catch (e) {
    // 没有 TEXT_CODES 时仍能工作：只是拿不到书名。
  }
  return map;
}

/**
 * 一行 KIN_DATA → provenance 数组（通常只有一条，但 CBDB 允许同关系多源）。
 *
 * @param {object} row     KIN_DATA 的原始行
 * @param {object} opts    { titles, kinLabel }
 * @returns {Array<object>}
 */
function provenanceFromKinRow(row, opts = {}) {
  const titles = opts.titles || new Map();
  const rawRef = `raw:cbdb/KIN_DATA/${row.c_personid}|${row.c_kin_id}|${row.c_kin_code}`;

  const notes = String(row.c_notes || '').trim();
  const autogen = String(row.c_autogen_notes || '').trim();

  // quote：优先 CBDB 自己写的注记；否则重述源行字段。
  let quote = notes || autogen;
  if (!quote) {
    const label = opts.kinLabel || '';
    quote = `c_kin_code=${row.c_kin_code}${label ? `（${label}）` : ''}`
      + ` c_personid=${row.c_personid} c_kin_id=${row.c_kin_id}`;
  }

  // locator：文献载体内部位置。c_pages 是古籍页码/篇名。
  const locator = {};
  const pages = String(row.c_pages || '').trim();
  if (pages) locator.pages = pages;
  // c_source=0 在 CBDB 里对应一条叫「未知」的 TEXT_CODES 记录。它不是一本书，
  // 是「没有记载出处」。当成 sourceId 存进去会让「这条断言出自哪本书」的答案
  // 变成一本叫《未知》的书。
  const hasSource = !!(row.c_source && row.c_source !== 0);
  if (hasSource) locator.sourceId = row.c_source;

  const title = hasSource ? (titles.get(row.c_source) || '') : '';
  const reason = [
    opts.kinLabel ? `c_kin_code=${row.c_kin_code} → ${opts.kinLabel}` : `c_kin_code=${row.c_kin_code}`,
    // 「经 CBDB」不能省。`出处《宋史》` 读起来像我们直接查了《宋史》，
    // 实际是 CBDB 声称它据《宋史》。两者差别在于：前者我们能对原文负责，
    // 后者只能对 CBDB 的转述负责——而 CBDB 的转述可能断章、可能错系。
    title ? `经 CBDB 转述，出处《${title}》` : 'CBDB 未记文献出处',
    autogen ? 'CBDB 自动生成' : '',
  ].filter(Boolean).join('；');

  return [{
    rawRef,
    locator,
    quote,
    reason,
    commitId: 'c-000001',
  }];
}

module.exports = { buildTextTitles, provenanceFromKinRow };
