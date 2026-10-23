'use strict';
/**
 * 删掉与 `出生年月` 重复的 `生卒` 键。
 *
 * ## 为什么这是冗余而不是数据
 *
 * `props['生卒']` 是 `c_index_year` 的**故意的退化形式**：
 * 导入器只在没有 `c_birthyear` / `c_deathyear` 时才写它，因为 index year
 * 常常是活动年份而非生年（王利用: index 14, death 77）。
 *
 * 但 `backfill_cbdb_dates.js` 后来补 `出生年月` 时**没删旧的 `生卒`**，
 * 于是实测 **2,743 个实体**同时有两个键，且 **值完全相同**（不同的 0 个）。
 *
 * 同一个年份以两种键出现，读取方要处理两种形状，索引要为 `生卒` 单独开
 * 一条 fallback 分支（`graph_source.lifespanFromProps` 里那段），
 * 而它携带的信息量为零。
 *
 * ## 只删「值完全相同」的
 *
 * 值不同说明两个键指向不同年份，那是真的两个信息（虽然也该查为什么），
 * 不动，只报告。
 *
 * 用法：
 *   node tools/oneoff/prune_duplicate_lifespan.js --dry-run
 *   node tools/oneoff/prune_duplicate_lifespan.js
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const DIR = args.find((a) => !a.startsWith('--'))
  || path.join(__dirname, '..', '..', 'data', 'persons', 'entities');

function main() {
  let total = 0;
  let sameValue = 0;
  let differentValue = 0;
  const diffSamples = [];

  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(DIR, f);
    let e;
    try { e = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    total++;
    const p = e.props;
    if (!p || !('生卒' in p)) continue;
    // 没有 出生年月 时，生卒 是唯一日期，必须留着。
    if (!('出生年月' in p) && !('逝世时间' in p)) continue;

    if (p['生卒'] === p['出生年月'] || p['生卒'] === p['逝世时间']) {
      sameValue++;
      if (!DRY) {
        delete p['生卒'];
        // 删完 props 可能变空对象——那是合法的（空壳实体本就存在），
        // 但保留 {} 比删掉键更符合现有形状，不另造特例。
        fs.writeFileSync(file, JSON.stringify(e, null, 2) + '\n', 'utf8');
      }
    } else {
      differentValue++;
      if (diffSamples.length < 8) {
        diffSamples.push(`${e.id} 出生年月=${JSON.stringify(p['出生年月'])} 逝=${JSON.stringify(p['逝世时间'])} 生卒=${JSON.stringify(p['生卒'])}`);
      }
    }
  }

  console.log(`扫描 ${total} 实体`);
  console.log(`  删除重复 生卒（值相同）: ${sameValue}`);
  console.log(`  值不同、保留待查: ${differentValue}`);
  for (const s of diffSamples) console.log('   ', s);
  if (DRY) console.log('\n（dry-run，未写文件）');
}

main();
