'use strict';
/**
 * 找出「名字 + （序号）」形式的别名。
 *
 * ## 为什么它是错的
 *
 * `aliases: ["歐陽景達（1）"]` 的 `（1）` 不是名字的一部分，是旧主键时代
 * （`id = sha256(name)`）为了区分同名人而加的计数器。
 *
 * 两条既定约束都被它违反：
 *   - **名字字符串必须原子**——不含括号注记/修饰成分/序号
 *   - **名字不派生主键**——同名多实体合法，用 `type:origin-key` 区分
 *
 * 主键早已改成 `person:cbdb-<id>`，这两个人 `cbdb-12195` 与任何同名者
 * 天然是两个实体，序号失去了唯一的存在理由。留着它还会让搜索
 * 「歐陽景達」多出一条看似他人的结果。
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
// 位置参数才是目录：不能直接取 argv[2]，那里可能是个开关。
const DIR = args.find((a) => !a.startsWith('--'))
  || path.join(__dirname, '..', '..', 'data', 'persons', 'entities');

/** `name` + `（数字）`。全角括号是 CBDB 导入时的写法。 */
function isNumberedVariant(alias, name) {
  if (typeof alias !== 'string' || typeof name !== 'string') return false;
  if (!alias.startsWith(name)) return false;
  const tail = alias.slice(name.length);
  return /^[（(]\d+[）)]$/.test(tail);
}

function main() {
  let total = 0;
  let hitEntities = 0;
  let removed = 0;
  const samples = [];

  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(DIR, f);
    let e;
    try { e = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    total++;
    if (!Array.isArray(e.aliases) || !e.aliases.length) continue;

    const keep = e.aliases.filter((a) => !isNumberedVariant(a, e.name));
    if (keep.length === e.aliases.length) continue;

    hitEntities++;
    removed += e.aliases.length - keep.length;
    if (samples.length < 10) {
      const gone = e.aliases.filter((a) => isNumberedVariant(a, e.name));
      samples.push(`${e.id}  ${e.name}  删别名 ${JSON.stringify(gone)}`);
    }
    if (!DRY) {
      e.aliases = keep;
      fs.writeFileSync(file, JSON.stringify(e, null, 2) + '\n', 'utf8');
    }
  }

  console.log(`扫描 ${total} 实体`);
  console.log(`  含「名字+序号」别名: ${hitEntities} 个实体, ${removed} 条别名`);
  for (const s of samples) console.log('  ', s);
  if (DRY) console.log('\n（dry-run，未写文件）');
}

main();
