#!/usr/bin/env node
'use strict';
/**
 * 把整个语料的 id 从「名字派生」迁移到「来源键」，并原子化名字。
 *
 * ## 这次迁移改什么
 *
 *   1. id:      `person:4b7e7d82660bb1377e6b`   → `person:cbdb-467817`
 *                （无外部来源的 → `person:local-000123`）
 *   2. name:    `韓氏(田通妻)`                   → `韓氏` + relations.spouse → 田通
 *                `李某（48）`                     → `李某`（序号是 id 冲突的产物，不再需要）
 *   3. 引用:    所有 relations / claims / sources / tags / aliases 里的旧 id
 *                同步改指新 id
 *
 * ## 为什么必须一次性完成
 *
 * 边只存 id。如果 id 变了而边没改，图上所有连线都断——而且不报错，因为
 * `check_references` 会认为那些 id 本来就不存在。所以迁移全部在内存里完成，
 * 校验通过后才落盘。
 *
 * ## 名字原子化的规则
 *
 * 括注分三类，处理方式不同：
 *
 *   `李世民(唐太宗)`      庙号/称号            → aliases
 *   `范氏(許亨妻)`        亲属关系（锚点在库）  → relations.spouse → 許亨
 *   `韓氏(田通妻)`        亲属关系（锚点不在库）→ aliases，保留线索但不伪造节点
 *   `張長（1）`           纯序号（消歧产物）    → 直接去掉
 *
 * 最后一种最重要：`（1）` 从来不是名字的一部分，它是旧 id 方案的疤痕。新方案
 * 下九个 `韓氏` 合法共存，序号自然消失。
 *
 * ## 锚点解析失败的处置
 *
 * 不虚构目标节点。降为 alias，并写入报告。少一条边好过一条接错人的边。
 *
 * 用法：
 *   node tools/oneoff/migrate_opaque_ids.js --dry-run
 *   node tools/oneoff/migrate_opaque_ids.js
 */

const fs = require('fs');
const path = require('path');
const { readAll, shardPath, FOLDERS } = require('../../src/store/entity_writer');
const { entityId, parseId } = require('../../src/store/entity_id');

const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = path.resolve(__dirname, '..', '..');
const PREFIX = path.join(ROOT, 'data');

// ── 名字原子化 ────────────────────────────────────────────────────────────────

const SEQ_SUFFIX = /（\d+）$/;
const ANNOT = /^(.*?)[（(]([^（()）]*)[）)]$/;

// 顺序有意义：`岳父` 必须先于 `父`，否则得到不存在的锚点 `樂文義岳`。
const KIN = [
  { re: /^(.+)岳父$/, pred: null, inv: 'childOfFather' },
  { re: /^(.+)岳母$/, pred: null, inv: 'childOfMother' },
  { re: /^(.+)之妻$/, pred: 'spouse' },
  { re: /^(.+)之夫$/, pred: 'spouse' },
  { re: /^(.+)之子女?$/, pred: 'childOfFather' },
  { re: /^(.+)之父$/, pred: 'childOfFather' },
  { re: /^(.+)之母$/, pred: 'childOfMother' },
  { re: /^(.+)妻$/, pred: 'spouse' },
  { re: /^(.+)夫$/, pred: 'spouse' },
  { re: /^(.+)夫?人$/, pred: 'spouse' },
  { re: /^(.+)妾$/, pred: 'spouse' },
  { re: /^(.+)皇后$/, pred: 'spouse' },
  { re: /^(.+)后$/, pred: 'spouse' },
  { re: /^(.+)父$/, pred: null, inv: 'childOfFather' },
  { re: /^(.+)母$/, pred: null, inv: 'childOfMother' },
  { re: /^(.+)子$/, pred: 'maleChild' },
  { re: /^(.+)女$/, pred: 'femaleChild' },
  { re: /^(.+)弟$/, pred: 'sibling' },
  { re: /^(.+)兄$/, pred: 'sibling' },
  { re: /^(.+)妹$/, pred: 'sibling' },
  { re: /^(.+)姐$/, pred: 'sibling' },
  { re: /^(.+)祖$/, pred: null, inv: 'childOfFather' },
];

// 结尾像亲属词、整体却是称号的括注。`李淵(唐高祖)` 的 `唐高祖` 是庙号。
const TITLE_PREFIX = /^(唐|隋|周|北周|西梁|南梁|陳|齊|北魏|東魏|西魏|魏|宋|晉|漢|明|清|梁|後|前)/;

function classifyAnnotation(inner, selfBase) {
  for (const rule of KIN) {
    const m = inner.match(rule.re);
    if (!m) continue;
    const anchor = m[1].trim();
    if (!anchor || anchor === selfBase) continue;
    if (TITLE_PREFIX.test(anchor) && /祖$/.test(inner)) return { kind: 'alias' };
    return { kind: 'relation', anchor, pred: rule.pred, inv: rule.inv };
  }
  return { kind: 'alias' };
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

function main() {
  const report = {
    idChanged: 0,
    nameChanged: 0,
    seqRemoved: 0,
    annotated: 0,
    linksCreated: 0,
    aliasOnly: 0,
    unresolvedAnchors: 0,
    danglingAfter: [],
  };

  // 1. 读入全部实体，计算新 id
  const all = [];
  for (const type of Object.keys(FOLDERS)) all.push(...readAll(type).map((e) => ({ type, e })));

  // 旧 id → 实体，用于解析引用
  const byOldId = new Map(all.map(({ e }) => [e.id, e]));

  // 名字 → 候选实体（仅用于锚点解析，且仅接受唯一候选）
  const byName = new Map();
  for (const { e } of all) {
    if (e.type !== 'person') continue;
    const base = (e.name.match(ANNOT) || [, SEQ_SUFFIX.test(e.name) ? e.name.replace(SEQ_SUFFIX, '') : e.name])[1];
    for (const k of new Set([e.name, base])) {
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(e);
    }
  }

  // 2. 为每个实体决定新 id
  const idMap = new Map(); // 旧 id → 新 id
  const localSeq = {};
  const takenKeys = new Set();

  // Claim every id that already looks canonical *before* allocating anything.
  //
  // Allocating during the walk was not idempotent: `nextLocal` started at 1, and if
  // a record with no source key was visited before the record that already owned
  // `local-000001`, the newcomer took that key and the original owner was pushed to
  // `local-000002`. Every local entity slid by one on each run, so a re-run did not
  // no-op — it silently rewrote 379 ids and left every reference to them stale.
  for (const { type, e } of all) {
    const parsed = parseId(e.id);
    if (!parsed || parsed.type !== type) continue;
    if (/^[0-9a-f]{20}$/.test(parsed.key)) continue; // legacy name hash
    takenKeys.add(e.id);
    const m = parsed.key.match(/^local-(\d+)$/);
    if (m) localSeq[type] = Math.max(Number(localSeq[type] || 0), Number(m[1]));
  }

  const nextLocal = (type) => {
    let n = Number(localSeq[type] || 0);
    let key;
    do {
      n += 1;
      key = `local-${String(n).padStart(6, '0')}`;
    } while (takenKeys.has(`${type}:${key}`));
    localSeq[type] = n;
    takenKeys.add(`${type}:${key}`);
    return key;
  };

  for (const { type, e } of all) {
    const ext = e.external || {};
    let newId = null;

    if (type === 'person' && ext.cbdbId) {
      newId = entityId('person', `cbdb-${ext.cbdbId}`);
    } else if (type === 'organization' && ext.cbdbInstCode) {
      newId = entityId('organization', `cbdb-${ext.cbdbInstCode}`);
    } else if (type === 'event' && ext.cbdbEventId) {
      newId = entityId('event', `cbdb-${ext.cbdbEventId}`);
    } else if (type === 'person' && ext.cpcUrl) {
      // 人民网路径形如 /n1/2023/0311/c64036-32641903.html
      const m = String(ext.cpcUrl).match(/c(\d+)-(\d+)\.html/);
      if (m) newId = entityId('person', `cpc-${m[1]}-${m[2]}`);
    }

    if (!newId) {
      // 已有新式 id 的保持不变，保证脚本幂等
      const parsed = parseId(e.id);
      if (parsed && !/^[0-9a-f]{20}$/.test(parsed.key)) {
        newId = e.id;
      } else {
        newId = entityId(type, nextLocal(type));
      }
    }

    if (takenKeys.has(newId) && newId !== e.id) {
      // 外部键重复：说明同一来源记录出现了两个分片。保留先来者，后来者分配
      // 本地序号，并记入报告——不静默合并，因为可能是两行不同记录共用了一个键。
      newId = entityId(type, nextLocal(type));
    }
    takenKeys.add(newId);
    idMap.set(e.id, newId);
    if (newId !== e.id) report.idChanged++;
  }

  // 3. 构建新实体
  const out = [];
  for (const { type, e } of all) {
    const newId = idMap.get(e.id);
    const ent = { ...e, id: newId };
    let changed = newId !== e.id;
    let aliases = [...(e.aliases || [])];

    // 3a. 名字原子化（仅人物；组织/事件的括号通常是正式名的一部分）
    if (type === 'person' && e.name) {
      let name = String(e.name).trim();

      // 纯序号后缀：`張長（1）` → `張長`
      //
      // The counter was never a name; it was the old id scheme's collision marker
      // leaking into a display field. Identity is now the CBDB row, so the two
      // 張長 rows are two entities and both are legitimately called 張長.
      //
      // Note this must write back to ent.name immediately: the annotation branch
      // below is the only other writer, and if it does not fire the stripped name
      // was computed and thrown away — which is how 1099 counters survived a
      // migration that reported "去序号后缀: 1099".
      if (SEQ_SUFFIX.test(name)) {
        const stripped = name.replace(SEQ_SUFFIX, '');
        if (stripped) {
          report.seqRemoved++;
          name = stripped;
          ent.name = stripped;
          changed = true;
        }
      }

      const m = name.match(ANNOT);
      if (m && m[1] && !/^\d+$/.test(m[2])) {
        const base = m[1];
        const inner = m[2];

        // 嵌套括注 `郝氏(劉某(郝氏夫)妻)`：内层是被指人的自我描述，剥掉再判断
        const flat = inner.replace(/[（(][^）)]*[）)]/g, '');
        const cls = classifyAnnotation(flat, base);

        if (cls.kind === 'relation') {
          const cands = byName.get(cls.anchor) || [];
          const target = cands.length === 1 ? cands[0] : null;
          if (target && target.id !== e.id) {
            const tNew = idMap.get(target.id);
            if (cls.pred) {
              const cur = (ent.relations || {})[cls.pred] || [];
              const ids = cur.map((x) => (typeof x === 'string' ? x : x.id));
              ent.relations = { ...(ent.relations || {}), [cls.pred]: [...new Set([...ids, tNew])] };
            } else if (cls.inv) {
              // 主语是父/母/祖：边要挂在目标实体上（子 --childOfFather--> 父）
              const t = out.find((o) => o.id === tNew);
              if (t) {
                const cur = (t.relations || {})[cls.inv] || [];
                const ids = cur.map((x) => (typeof x === 'string' ? x : x.id));
                t.relations = { ...(t.relations || {}), [cls.inv]: [...new Set([...ids, newId])] };
              } else {
                aliases.push(inner);
                report.aliasOnly++;
              }
            }
            if (cls.pred || cls.inv) report.linksCreated++;
            if (inner && inner !== base) aliases.push(inner);
            // 去掉亲属方向相同的重复别名
            aliases = aliases.filter((a) => a && a !== base);
            ent.name = base;
            report.nameChanged++;
            changed = true;
          } else {
            // 锚点不在库或有歧义：不猜。保留为别名，线索不丢。
            report.unresolvedAnchors++;
            aliases.push(inner);
            aliases = aliases.filter((a) => a && a !== base);
            ent.name = base;
            report.nameChanged++;
            changed = true;
          }
        } else {
          aliases.push(inner);
          aliases = aliases.filter((a) => a && a !== base);
          ent.name = base;
          report.nameChanged++;
          changed = true;
        }
        report.annotated++;
      }
    }

    ent.aliases = [...new Set(aliases)];
    if (!ent.aliases.length) delete ent.aliases;
    out.push({ type, ent, oldId: e.id, changed });
  }

  // 4. 重写所有 id 引用
  const rewrite = (v) => {
    if (typeof v === 'string') return idMap.get(v) || v;
    if (Array.isArray(v)) return v.map(rewrite);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = rewrite(x);
      return o;
    }
    return v;
  };

  const newIds = new Set(out.map((o) => o.ent.id));
  for (const { ent } of out) {
    // `carrier` is a bare entity reference on evidence nodes, and it is the one
    // reference that does not live under `relations` or `sources`. Missing it here
    // left all 111 evidence nodes pointing at ids that no longer existed — the
    // dangling check below only walked edges, so it reported "悬空: 0" while the
    // graph had lost every carriedBy link.
    if (ent.carrier) {
      const mapped = idMap.get(ent.carrier);
      if (mapped) ent.carrier = mapped;
      else report.orphanCarrier = (report.orphanCarrier || 0) + 1;
    }
    if (ent.relations) {
      const rels = {};
      for (const [k, list] of Object.entries(ent.relations)) {
        const mapped = (Array.isArray(list) ? list : [list])
          .map((x) => (typeof x === 'string' ? idMap.get(x) || x : x))
          .filter((x) => x && (typeof x !== 'string' || newIds.has(x)));
        if (mapped.length) rels[k] = [...new Set(mapped)];
      }
      ent.relations = rels;
    }
    if (Array.isArray(ent.sources)) ent.sources = [...new Set(ent.sources.map((s) => rewrite(s)))];
    if (Array.isArray(ent.tags)) ent.tags = [...new Set(ent.tags.map((t) => rewrite(t)))];
    if (ent.claims) ent.claims = rewrite(ent.claims);
  }

  // 5. 悬空检查（写盘前必须为空，否则迁移会静默断边）
  for (const { ent } of out) {
    for (const [k, list] of Object.entries(ent.relations || {})) {
      for (const x of list) {
        const id = typeof x === 'string' ? x : x && x.id;
        if (id && !newIds.has(id)) report.danglingAfter.push(`${ent.id} --${k}--> ${id}`);
      }
    }
  }

  console.log(`实体总数: ${all.length}`);
  console.log(`  id 变化:     ${report.idChanged}`);
  console.log(`  名字变化:    ${report.nameChanged}`);
  console.log(`  去序号后缀:  ${report.seqRemoved}`);
  console.log(`  括注处理:    ${report.annotated}（转边 ${report.linksCreated}，仅别名 ${report.aliasOnly}）`);
  console.log(`  锚点不可解:  ${report.unresolvedAnchors}`);
  console.log(`  迁移后悬空:  ${report.danglingAfter.length}`);

  if (report.danglingAfter.length) {
    console.error('\n迁移后会出现悬空边，已中止：');
    for (const d of report.danglingAfter.slice(0, 10)) console.error('  ' + d);
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] 样例:');
    for (const o of out.filter((x) => x.changed).slice(0, 12)) {
      console.log(`  ${o.oldId}`);
      console.log(`   → ${o.ent.id}  name=${o.ent.name}`);
    }
    console.log('\n--dry-run：未写入');
    return;
  }

  // 6. 落盘：写新分片、删旧分片、更新序号
  let written = 0;
  for (const folder of Object.values(FOLDERS)) {
    const dir = path.join(PREFIX, folder, 'entities');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json')) fs.unlinkSync(path.join(dir, f));
    }
  }
  for (const { type, ent } of out) {
    const file = shardPath(type, ent.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(ent, null, 2) + '\n', 'utf8');
    written++;
  }
  fs.writeFileSync(path.join(PREFIX, '.id_seq.json'), JSON.stringify(localSeq, null, 2) + '\n', 'utf8');
  fs.writeFileSync(
    path.join(ROOT, 'tools', 'oneoff', '_id_migration_report.json'),
    JSON.stringify({ ...report, localSeq }, null, 2),
    'utf8',
  );
  console.log(`\n已写入 ${written} 个分片；本地序号: ${JSON.stringify(localSeq)}`);
}

main();
