'use strict';
/**
 * 修复 `fix_dynasty_tags.js` 引入的简繁不一致。
 *
 * ## 发生了什么
 *
 * `fix_dynasty_tags.js` 把 `tags: ["organization:local-000099"]` 展开成该
 * 组织实体的 `name`。那个实体的名字是简体 **「西汉」**，而 CBDB `DYNASTIES`
 * 表里 `c_dy = 29` 的名字是繁体 **「西漢」**。
 *
 * 于是 739 个实体的朝代标签变成简体，与其余 47 万个繁体标签不一致，
 * 搜索「西漢」搜不到他们，按朝代分组会把「西汉」和「西漢」算成两个。
 *
 * ## 更根本的问题：那个组织实体本身是错的
 *
 * `organization:local-000099` 名为「西汉」，`tags` 里还含它自己的 id
 * （`["统一王朝","organization:local-000099"]`）。一个朝代被建成了组织实体，
 * 还被挂上组织隶属关系。但**朝代不是组织**——曹魏既是朝代也是政权，
 * 唐不是。这整个实体该由 P5 的 `era` 谓词取代，本轮不动，只修名字层面
 * 造成的数据不一致。
 *
 * ## 判据
 *
 * 若某 tags 项（简体）对应的繁体形式在 CBDB `DYNASTIES` 里存在，就换成繁体。
 * 只换朝代名，不动其他标签。
 *
 * 用法：
 *   node tools/oneoff/normalize_dynasty_to_traditional.js --dry-run
 *   node tools/oneoff/normalize_dynasty_to_traditional.js
 */

const fs = require('fs');
const path = require('path');

const { DYNASTY_NAME } = require('../../src/transformers/cbdb-biog.js')._internal;

const ROOT = path.join(__dirname, '..', '..');
const ENTITY_DIR = path.join(ROOT, 'data', 'persons', 'entities');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');

/** CBDB 的繁体朝代名集合。 */
const TRADITIONAL = new Set(DYNASTY_NAME.values());

/**
 * 简体 → 繁体，只为朝代名服务。
 *
 * 不引入 OpenCC：只需要覆盖 `DYNASTIES` 表里出现的那几个字。
 * 逐个列出而不是猜规则——「汉→漢」「齐→齊」能猜，`宋(劉)` 这种带姓注的不能。
 */
const SIMPLIFIED_TO_TRADITIONAL = new Map([
  ['西汉', '西漢'], ['东汉', '東漢'], ['汉', '漢'],
  ['晋', '晉'], ['西晋', '西晉'], ['东晋', '東晉'],
  ['三国', '三國'], ['三国魏', '三國魏'], ['三国吴', '三國吳'], ['三国蜀', '三國蜀'],
  ['南北朝', '南北朝'],
  ['隋', '隋'], ['唐', '唐'],
  ['五代', '五代'], ['后蜀', '後蜀'], ['吴', '吳'], ['南唐', '南唐'], ['吴越', '吳越'],
  ['闽国', '閩國'], ['南汉', '南漢'], ['高丽', '高麗'],
  ['宋', '宋'], ['辽', '遼'], ['金', '金'], ['元', '元'], ['明', '明'], ['清', '清'],
  ['中华民国', '中華民國'], ['中华人民共和国', '中華人民共和國'],
  ['陈', '陳'], ['北魏', '北魏'], ['北周', '北周'], ['南齐', '南齊'],
  ['后梁', '後梁'], ['北齐', '北齊'], ['吴(杨)', '吳(楊)'], ['西梁', '西梁'],
  ['楚(马)', '楚(馬)'], ['前燕', '前燕'], ['西魏', '西魏'], ['东魏', '東魏'],
  ['南梁', '南梁'], ['后秦', '後秦'], ['新', '新'], ['后唐', '後唐'],
  ['后晋', '後晉'], ['后周', '後周'], ['南燕', '南燕'], ['前凉', '前涼'],
  ['后汉', '後漢'], ['南平', '南平'], ['西凉', '西涼'], ['伪齐', '偽齊'],
  ['韩国', '韓國'], ['西辽', '西遼'], ['北燕', '北燕'], ['赢秦', '贏秦'],
  ['北凉', '北涼'], ['后燕', '後燕'], ['后赵', '後趙'], ['前秦', '前秦'],
  ['北汉', '北漢'], ['新罗', '新羅'], ['东梁', '東梁'], ['前赵', '前趙'],
  ['成汉', '成漢'], ['夏', '夏'], ['西秦', '西秦'], ['后凉', '後涼'],
  ['南凉', '南涼'], ['前蜀', '前蜀'], ['西燕', '西燕'], ['周', '周'],
  ['西夏', '西夏'], ['北元', '北元'], ['南明', '南明'],
  ['郑（王世充）', '鄭（王世充）'], ['朝鲜', '朝鮮'], ['大顺', '大順'],
  ['大西', '大西'], ['代', '代'],
  ['汉前', '漢前'], ['秦汉', '秦漢'], ['未详', '未詳'], ['年代不详', '年代不詳'],
]);

function main() {
  let scanned = 0;
  let fixedEntities = 0;
  let fixedTags = 0;
  const samples = [];

  for (const f of fs.readdirSync(ENTITY_DIR)) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(ENTITY_DIR, f);
    let e;
    try { e = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    scanned++;
    if (!Array.isArray(e.tags) || !e.tags.length) continue;

    let touched = false;
    const out = e.tags.map((t) => {
      if (TRADITIONAL.has(t)) return t; // 已是 CBDB 写法
      const trad = SIMPLIFIED_TO_TRADITIONAL.get(t);
      if (!trad || !TRADITIONAL.has(trad)) return t;
      touched = true;
      fixedTags++;
      if (samples.length < 10) samples.push(`${e.id}  ${t} -> ${trad}`);
      return trad;
    });
    if (!touched) continue;

    e.tags = [...new Set(out)];
    fixedEntities++;
    if (!DRY) fs.writeFileSync(file, JSON.stringify(e, null, 2) + '\n', 'utf8');
  }

  console.log(`扫描 ${scanned} 实体`);
  console.log(`  改写实体: ${fixedEntities}（标签 ${fixedTags} 条）`);
  for (const s of samples) console.log('   ', s);
  if (DRY) console.log('\n（dry-run，未写文件）');
}

main();
