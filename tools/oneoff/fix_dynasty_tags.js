'use strict';
/**
 * 把 `tags` 里误写成实体 id 的朝代名归回文字。
 *
 * ## 问题
 *
 * 实测 744 个实体的 tags 里存的是 **实体 id** 而不是朝代名：
 *
 *     tags: ["organization:local-000099"]     // 该实体的 name 是「西汉」
 *
 * §4 对 `tags` 的批评是「既存分类词又存 id，两种语义混在一个字符串数组里」。
 * 这里是那个批评的实证：同一批数据里 `tags: ["两汉"]` 和
 * `tags: ["organization:local-000099"]`（实为「西汉」）混着出现。
 *
 * ## 为什么不删了了事
 *
 * 朝代是真实信息（CBDB `c_dy`），删掉等于丢数据。而把这些 id 转成关系边
 * 也不对：朝代是**分类标签**，不是「A 属于 B」的组织隶属关系——虽然
 * 曹魏既是朝代也是政权，但一个人的朝代标签说的是「他活在哪个时代」，
 * 不是「他是哪个政权的成员」。§4 计划把朝代变成 `era` 谓词边，那是 P5 的
 * 事；在那之前，把 id 还原成文字是**修复明显错误**，不是提前做 P5。
 *
 * ## 解析不出来就不动
 *
 * 组织实体不存在时保持原样并记 WARN——「不可裁定的数据保留原状」。
 *
 * 用法：
 *   node tools/oneoff/fix_dynasty_tags.js --dry-run
 *   node tools/oneoff/fix_dynasty_tags.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PERSON_DIR = path.join(ROOT, 'data', 'persons', 'entities');
const ORG_DIR = path.join(ROOT, 'data', 'organizations', 'entities');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');

/** id -> name，只读需要的那些组织。 */
function loadOrgNames() {
  const map = new Map();
  if (!fs.existsSync(ORG_DIR)) return map;
  for (const f of fs.readdirSync(ORG_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const o = JSON.parse(fs.readFileSync(path.join(ORG_DIR, f), 'utf8'));
      if (o.id && o.name) map.set(o.id, o.name);
    } catch { /* 坏分片归别的检查管 */ }
  }
  return map;
}

function main() {
  const orgNames = loadOrgNames();
  let scanned = 0;
  let changedEntities = 0;
  let changedTags = 0;
  let unresolved = 0;
  const samples = [];
  const unresolvedSamples = [];

  for (const f of fs.readdirSync(PERSON_DIR)) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(PERSON_DIR, f);
    let e;
    try { e = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    scanned++;
    if (!Array.isArray(e.tags) || !e.tags.length) continue;

    let touched = false;
    const out = [];
    for (const t of e.tags) {
      if (typeof t === 'string' && t.startsWith('organization:')) {
        const name = orgNames.get(t);
        if (name) {
          out.push(name);
          changedTags++;
          touched = true;
          if (samples.length < 10) samples.push(`${e.id}  ${t} -> ${name}`);
          continue;
        }
        unresolved++;
        if (unresolvedSamples.length < 5) unresolvedSamples.push(`${e.id}  ${t}`);
      }
      out.push(t);
    }

    if (!touched) continue;
    // 去重：原文里可能已有 "西汉"，替换后会重复。
    e.tags = [...new Set(out)];
    changedEntities++;
    if (!DRY) fs.writeFileSync(file, JSON.stringify(e, null, 2) + '\n', 'utf8');
  }

  console.log(`扫描 ${scanned} 实体`);
  console.log(`  修复实体: ${changedEntities}（改写标签 ${changedTags} 条）`);
  console.log(`  组织实体不存在、保留原样: ${unresolved}`);
  for (const s of samples) console.log('   ', s);
  for (const s of unresolvedSamples) console.log('    未解析:', s);
  if (DRY) console.log('\n（dry-run，未写文件）');
}

main();
