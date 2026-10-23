// 页码可定位性报告：判断哪些文献适合先做划取式抽取。
//
// 编辑功能要求「读取原文并划取」——没有页码/条目号，就无从定位原文。
// 本脚本按三个维度分类全部 481 种文献：
//
//   1. 有页码/条目号吗（locator.pages 非空）
//   2. 页码形态能对到纸书吗
//      - `471.21a`        卷.页叶次，能对纸书
//      - `Kaicheng 40`    年号+序号，能对《唐代墓誌彙編》体例
//      - `MQWW PoetID #1761`  数据库条目 ID，只能对数据库
//      - `第三甲第四十六名`    榜次名次，能对登科录
//   3. 有在线地址吗（c_url_api / c_url_homepage），能直接打开原文 vs 得去图书馆
//
// 用法：node scripts/report_source_locatability.js

'use strict';

// 页码可定位性报告：判断哪些文献适合先做划取式抽取。
//
// 三个维度决定「能不能从断言定位到原文」：
//   1. 有页码/条目号吗（locator.pages）
//   2. 页码形态能对到纸书吗（"471.21a" 能，"MQWW PoetID #1761" 只能对到数据库）
//   3. 有在线地址吗（能直接打开原文 vs 得去图书馆）
const { DatabaseSync } = require('node:sqlite');

const path = require('path');
const ROOT = path.join(__dirname, '..');
const db = new DatabaseSync(path.join(ROOT, 'cbdb_20260801', 'cbdb_20260801.sqlite3'), { readOnly: true });

const rows = db.prepare(`
  SELECT k.c_source AS src, t.c_title_chn AS title,
         t.c_url_api AS api, t.c_url_homepage AS home,
         COUNT(*) AS n,
         SUM(CASE WHEN k.c_pages IS NOT NULL AND TRIM(k.c_pages) <> '' THEN 1 ELSE 0 END) AS withPages
    FROM KIN_DATA k
    LEFT JOIN TEXT_CODES t ON t.c_textid = k.c_source
   WHERE k.c_source IS NOT NULL AND k.c_source <> 0
   GROUP BY k.c_source
   ORDER BY n DESC
`).all();

// 页码形态判定：看样本
function pageShape(src) {
  const s = db.prepare(`
    SELECT c_pages FROM KIN_DATA
     WHERE c_source = ? AND c_pages IS NOT NULL AND TRIM(c_pages) <> ''
     LIMIT 20
  `).all(src).map((x) => String(x.c_pages));
  if (!s.length) return 'none';
  const t = s.map((x) => x.trim());
  // 古籍卷页：`471.21a`（卷.页叶次）、`Kaicheng 40`（年号+序号）
  // 古籍卷页/篇次。形态很多：
  //   471.21a          卷.页叶次
  //   Kaicheng 40      年号 + 序号（《唐代墓誌彙編》体例）
  //   (XJ)Xiantong8    前缀标记 + 年号 + 序号
  const hasVolumePage = t.some((p) => /^\d+\.\d+[a-z]?$/i.test(p)
    || /^[A-Za-z]{4,}\s*\d+$/.test(p)
    || /^\([A-Z]+\)[A-Za-z]+\d+$/.test(p)
    || /^[A-Za-z]+\s*\d+$/i.test(p));
  // 数据库条目 ID：`MQWW PoetID #1761`、`YP NewEpitaphID=3040`
  const hasEntryId = t.some((p) => /#|ID\s*=/i.test(p));
  // 榜次名次：`第三甲第四十六名`
  const hasRank = t.some((p) => /第.+名/.test(p));
  // 纯数字：通常是条目序号（`15184`），能唯一定位但要对数据库
  const allNumeric = t.every((p) => /^\d+$/.test(p));
  if (hasEntryId) return 'entry-id';
  if (hasRank) return 'rank';
  if (allNumeric) return 'record-no';
  if (hasVolumePage) return 'volume-page';
  return 'other';
}

const SHAPE_LABEL = {
  'volume-page': '卷/页（可对纸书）',
  'entry-id': '数据库条目 ID',
  'rank': '名次（榜次）',
  'record-no': '条目序号（对数据库）',
  'other': '其他',
  'none': '无',
};

const classified = rows.map((r) => ({
  ...r,
  pct: r.n ? r.withPages / r.n : 0,
  shape: pageShape(r.src),
  online: !!(r.api || r.home),
}));

const total = rows.reduce((a, r) => a + r.n, 0);
const withPages = rows.reduce((a, r) => a + r.withPages, 0);

console.log('=== 总览 ===');
console.log('KIN_DATA 有文献来源:', total.toLocaleString(), '行');
console.log('有页码/条目号:', withPages.toLocaleString(), `(${(withPages / total * 100).toFixed(1)}%)`);
console.log('文献种类:', rows.length);
console.log();

// 分档：优先做哪个
const groups = {
  'A 可立即做（有页码 + 在线可读）': classified.filter((r) => r.pct >= 0.8 && r.online),
  'B 有页码但需线下查（可对纸书）': classified.filter((r) => r.pct >= 0.8 && !r.online && r.shape === 'volume-page'),
  'C 有页码但形态是数据库 ID': classified.filter((r) => r.pct >= 0.8 && !r.online && r.shape !== 'volume-page'),
  'D 页码缺失': classified.filter((r) => r.pct < 0.8),
};

for (const [label, arr] of Object.entries(groups)) {
  const n = arr.reduce((a, r) => a + r.n, 0);
  const p = arr.reduce((a, r) => a + r.withPages, 0);
  console.log(`--- ${label} ---`);
  console.log(`    ${arr.length} 种文献，${n.toLocaleString()} 行，有页码 ${p.toLocaleString()} 行`);
  for (const r of arr.slice(0, 6)) {
    console.log('    ' + String(r.title || ('id' + r.src)).slice(0, 30).padEnd(32),
      String(r.n).padStart(6), (r.pct * 100).toFixed(0).padStart(4) + '%',
      SHAPE_LABEL[r.shape].padEnd(20), r.online ? '在线' : '线下');
  }
  if (arr.length > 6) console.log(`    … 另有 ${arr.length - 6} 种`);
  console.log();
}

// 结论
const aRows = groups['A 可立即做（有页码 + 在线可读）'].reduce((a, r) => a + r.n, 0);
console.log('=== 结论 ===');
console.log(`可立即做划取式抽取的文献：${groups['A 可立即做（有页码 + 在线可读）'].length} 种，${aRows.toLocaleString()} 行断言`);
console.log(`占比 ${(aRows / total * 100).toFixed(1)}%`);
