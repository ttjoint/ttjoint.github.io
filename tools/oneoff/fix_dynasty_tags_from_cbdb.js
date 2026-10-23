'use strict';
/**
 * 用 CBDB `c_dy` 修正被写错的朝代标签。
 *
 * ## 问题
 *
 * 385 个人物的 `tags` 与 raw 里的 `c_dy` 不符。例：
 * `person:cbdb-11151`（傅燮，?-187，東漢末）的 tags 是 `["西汉"]`，
 * 而 raw 里 `c_dy = 25` = 東漢。
 *
 * ## 追到的根因
 *
 * 这些人的 tags 曾是 `["organization:local-000099"]`——一个**组织实体 id**。
 * 该实体名叫「西汉」，于是 `fix_dynasty_tags.js` 把 id 展开成名字时，
 * 把那个本就可疑的名字一并继承了。
 *
 * 而 `organization:local-000099` 自身也不干净：它的 `tags` 里含它自己的 id
 * （`["统一王朝","organization:local-000099"]`），说明有脚本曾经把
 * 「朝代」当作「组织隶属」来写。这条链上的每一个环节都是同一类错误：
 * **把分类标签当成实体关系**。
 *
 * ## 裁决依据
 *
 * `c_dy` 是 CBDB 自己标的朝代，是权威。年份分档、组织实体名、手工录入
 * 都是从它派生的东西，派生链一旦出错就以源为准覆盖。
 *
 * 用法：
 *   node tools/oneoff/fix_dynasty_tags_from_cbdb.js --dry-run
 *   node tools/oneoff/fix_dynasty_tags_from_cbdb.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const biog = require('../../src/transformers/cbdb-biog.js');
const { dynastyTag, DYNASTY_NAME } = biog._internal;

const ROOT = path.join(__dirname, '..', '..');
const ENTITY_DIR = path.join(ROOT, 'data', 'persons', 'entities');
const RAW_DIR = path.join(ROOT, 'raw', 'cbdb', 'BIOG_MAIN');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');

/** 旧导入器用年份分档得出的粗档名，以及组织实体名展开的朝代名。 */
const DERIVED_TAGS = new Set([
  ...DYNASTY_NAME.values(),
  '先秦', '秦', '两汉', '三国', '晋', '南北朝', '隋唐及以后', '年代不详',
]);

const cbdbKey = (id) => {
  const m = /^person:cbdb-(\d+)$/.exec(String(id));
  return m ? m[1] : null;
};

function loadRaw() {
  const map = new Map();
  for (const f of fs.readdirSync(RAW_DIR).filter((x) => x.endsWith('.gz'))) {
    let text;
    try { text = zlib.gunzipSync(fs.readFileSync(path.join(RAW_DIR, f))).toString('utf8'); }
    catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.payload) map.set(String(r.payload.c_personid), r.payload);
    }
  }
  return map;
}

function main() {
  const raw = loadRaw();
  console.log(`raw 记录：${raw.size}`);

  let scanned = 0;
  let fixed = 0;
  const samples = [];

  for (const f of fs.readdirSync(ENTITY_DIR)) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(ENTITY_DIR, f);
    let e;
    try { e = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    scanned++;
    const key = cbdbKey(e.id);
    if (!key) continue;
    const payload = raw.get(key);
    if (!payload) continue;

    const correct = dynastyTag(payload);
    const tags = Array.isArray(e.tags) ? e.tags : [];
    // 只换「派生的朝代标签」，不动其他标签。
    const others = tags.filter((t) => !DERIVED_TAGS.has(t));
    const derived = tags.filter((t) => DERIVED_TAGS.has(t));
    if (derived.length === 1 && derived[0] === correct) continue;

    const next = [...new Set([...others, correct])];
    if (samples.length < 10) {
      samples.push(`${e.id}  ${payload.c_name_chn || ''}  ${JSON.stringify(tags)} -> ${JSON.stringify(next)}`);
    }
    fixed++;
    if (!DRY) {
      e.tags = next;
      fs.writeFileSync(file, JSON.stringify(e, null, 2) + '\n', 'utf8');
    }
  }

  console.log(`扫描 ${scanned} 实体`);
  console.log(`  按 c_dy 修正 tags: ${fixed}`);
  for (const s of samples) console.log('   ', s);
  if (DRY) console.log('\n（dry-run，未写文件）');
}

main();
