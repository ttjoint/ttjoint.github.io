'use strict';
/**
 * P5-5b：亲缘谓词改为 §8.4 的 6 个基础原语。
 *
 * ## 依据
 *
 * `docs/architecture/节点类型与谓词.md` §8.4：真正独立的原语只有 6 个，
 * 因为父子/夫妻是同一关系的两个方向，镜像不必各占一个 key。
 *
 * | 原语 | 字母 | 现在 | 目标 |
 * | --- | --- | --- | --- |
 * | 父 | `F` | `father` | `father`（不变） |
 * | 母 | `M` | `mother` | `mother`（不变） |
 * | 兄弟/姊妹 | `B`/`Z` | `sibling`（不分男女） | 按**客体**性别拆 `brother`/`sister` |
 * | 夫/妻 | `H`/`W` | `spouse` + `role` 属性 | 按性别拆 `husband`/`wife` |
 * | 妾 | `C` | `spouse {role:'concubine'}` | `concubine` |
 *
 * ## 方向语义（易错点，务必先读）
 *
 * `A --father--> B` 读作「**A 的父亲是 B**」（从属视角，与 label「父亲」一致）。
 * 实测依据（CBDB 源数据自身记法）：
 *
 *     30148 朱元璋 --W---> 118451 馬氏(朱元璋妻)  female=1
 *     30148 朱元璋 --S1--> 67200 朱標           female=0（长子）
 *
 * 所以 `A --wife--> B` 读作「A 的妻是 B」，即 **A 是夫、B 是妻**。
 * 兄弟边同理看**客体**性别：「A 的兄是 B」中的 B 是男 → `brother`。
 *
 * ## 性别怎么定
 *
 * 实测 22,562 条 `spouse` 边里 22,260 条（98.7%）两端性别相反，可定方向；
 * 仅 200 条同性、102 条有未知端。取值用 CBDB `BIOG_MAIN.c_female`（权威）：
 * `1`=女、`0`=男、其他=未知。
 *
 * ## 不确定时怎么办
 *
 * **不猜**，保留 `spouse`/`sibling` 原样并记入报告。这两个 key 仍留在注册表里
 * 作为「性别不限的配偶/兄弟姐妹」，不是临时状态：同性配偶本来就该用它。
 *
 * 用法：
 *   node tools/oneoff/split_kinship_primitives.js --dry-run
 *   node tools/oneoff/split_kinship_primitives.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const ENTITY_DIR = path.join(ROOT, 'data', 'persons', 'entities');
const RAW_BIOG = path.join(ROOT, 'raw', 'cbdb', 'BIOG_MAIN');

const DRY = process.argv.includes('--dry-run');

/** 需要处理的旧 key。`sibling` 不清空，只把能拆的拆出去。 */
const OLD = new Set(['spouse', 'sibling', 'elderBrother', 'youngerSibling']);

/**
 * 载入 `c_personid -> 'male'|'female'|null`。
 *
 * 只收本脚本关心的 id，避免把 66 万行全塞进内存。
 */
function loadGender(wanted) {
  const map = new Map();
  if (!fs.existsSync(RAW_BIOG)) return map;
  for (const f of fs.readdirSync(RAW_BIOG).filter(x => x.endsWith('.gz')).sort()) {
    let text;
    try {
      text = zlib.gunzipSync(fs.readFileSync(path.join(RAW_BIOG, f))).toString('utf8');
    } catch (e) {
      console.warn('WARN 跳过损坏分片', f, e.message);
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      const p = r.payload;
      if (!p) continue;
      const id = String(p.c_personid);
      if (!wanted.has(id)) continue;
      // 1 = 女, 0 = 男, 其余（null / 2 / 其他）= 未知
      map.set(id, p.c_female === 1 ? 'female' : p.c_female === 0 ? 'male' : null);
    }
  }
  return map;
}

/** `person:cbdb-123` -> `123`；非 cbdb 实体返回 null。 */
function cbdbKey(id) {
  const m = String(id).match(/^person:cbdb-(\d+)$/);
  return m ? m[1] : null;
}

/** 边的目标 id（字符串或 {id,...} 对象）。 */
const oidOf = (v) => String(v && typeof v === 'object' && v.id ? v.id : v);

/**
 * 一条边解析后的去向。
 * @typedef {{predicate: string, qualifiers: object} | null} Resolution
 */

/**
 * 解析 `spouse` 边。
 *
 * @param {('male'|'female'|null)} sg 主体性别
 * @param {('male'|'female'|null)} og 客体性别
 * @param {string|null} role 原边 role 属性
 * @returns {Resolution}
 */
function resolveSpouse(sg, og, role) {
  // 妾：`C` 在 §8.4 里列为独立原语，但那是**字母链视角**（「某人的妾是 X」）。
  // 本项目的边存「主体→客体」且读法为「A 的 X 是 B」，所以 `A --concubine--> B`
  // 只能读作「**A 的妾是 B**」——A 是夫、B 是妾。
  //
  // 但实测 37 条 role=concubine 的边全是「妾 --spouse--> 其夫」：
  //     郭氏(劉仁妾) --spouse{role:concubine}--> 劉仁
  // 主体是妾。若强行写成 `郭氏 --concubine--> 劉仁`，读作「郭氏的妾是刘仁」——荒谬。
  //
  // **所以妾的身份用 husband + qualifier 表达**，不新设 `concubine` 谓词：
  //     郭氏 --husband{role:concubine}--> 劉仁   （郭氏的丈夫是刘仁，身份是妾）
  // 这与 `role` 字段的原意「**主体**扮演的角色」一致。
  if (role === 'concubine') {
    return sg === 'female' ? { predicate: 'husband', qualifiers: { role: 'concubine' } } : null;
  }

  // 两端性别已知且相反 → 「A 的妻是 B」当且仅当 A 男 B 女
  if (sg === 'male' && og === 'female') return { predicate: 'wife', qualifiers: {} };
  if (sg === 'female' && og === 'male') return { predicate: 'husband', qualifiers: {} };

  // 不凭 role 猜方向。
  // `role` 记录的是「**主体**扮演的角色」（`FROM_QUALIFIER` 写进来的），
  // 但谓词的读法看的是客体：「A --wife--> B」= 「A 的妻是 B」。
  // 所以 role=wife（主体是妻）对应的边应该是 `husband`，不是 `wife`。
  // 曾写反过：`role==='wife' && sg!=='male'` 返回 wife，把女性标成了妻。
  // 两端性别都已知时上面两行已经处理完，走到这里性别必有缺口——不猜。

  // 同性 / 未知 → 保留 spouse（性别不限的配偶），不猜
  return null;
}

/**
 * 解析兄弟边。**看客体性别**，因为 label「兄/兄弟」说的是客体。
 *
 * @param {('male'|'female'|null)} og 客体性别
 * @param {('elder'|'younger'|null)} order
 * @returns {Resolution}
 */
function resolveSibling(og, order) {
  const q = order ? { order } : {};
  if (og === 'male') return { predicate: 'brother', qualifiers: q };
  if (og === 'female') return { predicate: 'sister', qualifiers: q };
  return null;
}

/** 统一分派：给定旧 key 与边，返回解析结果。 */
function resolve(base, sg, og, role, order) {
  if (base === 'spouse') return resolveSpouse(sg, og, role);
  // elderBrother / youngerSibling 的 order 来自 key 本身
  const ord = order || (base === 'elderBrother' ? 'elder' : base === 'youngerSibling' ? 'younger' : null);
  return resolveSibling(og, ord);
}

async function main() {
  console.log(`模式：${DRY ? 'DRY-RUN（不写文件）' : '实际写入'}`);

  const files = fs.readdirSync(ENTITY_DIR).filter(f => f.endsWith('.json'));
  const targets = [];
  const wanted = new Set();

  for (const f of files) {
    let e;
    try { e = JSON.parse(fs.readFileSync(path.join(ENTITY_DIR, f), 'utf8')); } catch { continue; }
    const rel = e.relations || {};
    const keys = Object.keys(rel).filter(k => OLD.has(k.split('/')[0]));
    if (!keys.length) continue;
    targets.push({ file: f, entity: e, keys });
    const sk = cbdbKey(e.id);
    if (sk) wanted.add(sk);
    for (const k of keys) {
      for (const o of (Array.isArray(rel[k]) ? rel[k] : [rel[k]])) {
        const ok = cbdbKey(oidOf(o));
        if (ok) wanted.add(ok);
      }
    }
  }

  console.log(`含旧亲缘谓词的实体：${targets.length}`);
  const gender = loadGender(wanted);
  console.log(`性别已知：${gender.size} / ${wanted.size}`);

  const changed = [];
  const kept = [];

  for (const { file, entity, keys } of targets) {
    const rel = entity.relations;
    const sg = gender.get(cbdbKey(entity.id)) || null;
    let dirty = false;

    for (const oldKey of keys) {
      const base = oldKey.split('/')[0];
      const arr = Array.isArray(rel[oldKey]) ? rel[oldKey] : [rel[oldKey]];

      // 先全部解析，再决定旧 key 的去留，避免边遍历边改集合
      const toWrite = [];
      let resolvedThisKey = 0;

      for (const o of arr) {
        const oid = oidOf(o);
        const role = (o && typeof o === 'object' && o.role) || null;
        const order = (o && typeof o === 'object' && o.order) || null;
        const og = gender.get(cbdbKey(oid)) || null;

        const res = resolve(base, sg, og, role, order);

        if (!res) {
          kept.push({ id: entity.id, name: entity.name, base, object: oid, sg, og, role });
          toWrite.push({ key: oldKey, value: o });
          continue;
        }

        const hasQ = Object.keys(res.qualifiers).length > 0;
        // 去掉原 role/order 等已由谓词 key 表达的字段，只留本次算出的属性
        const value = hasQ ? { id: oid, ...res.qualifiers } : oid;
        toWrite.push({ key: res.predicate, value });
        changed.push({
          id: entity.id, name: entity.name, from: base, to: res.predicate,
          qualifiers: res.qualifiers, object: oid, sg, og,
        });
        resolvedThisKey++;
      }

      // 本 key 一条都没解析出来就原样留着（不能因别的 key 拆成功就清空它）
      if (!resolvedThisKey) continue;
      dirty = true;

      delete rel[oldKey];
      for (const { key, value } of toWrite) {
        if (!rel[key]) rel[key] = [];
        const vid = oidOf(value);
        const exists = rel[key].some(x => oidOf(x) === vid);
        if (!exists) rel[key].push(value);
      }
    }

    if (dirty && !DRY) {
      fs.writeFileSync(path.join(ENTITY_DIR, file), JSON.stringify(entity, null, 2) + '\n', 'utf8');
    }
  }

  // 报告
  console.log('\n=== 改写统计 ===');
  const by = {};
  for (const c of changed) {
    const k = `${c.from} → ${c.to}${Object.keys(c.qualifiers).length ? ' ' + JSON.stringify(c.qualifiers) : ''}`;
    by[k] = (by[k] || 0) + 1;
  }
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(40)} ${v}`);
  }
  console.log(`  合计 ${changed.length} 条`);

  if (kept.length) {
    console.log(`\n=== 保留原样（无法判定）共 ${kept.length} 条 ===`);
    const why = {};
    for (const k of kept) {
      const w = k.sg === null ? '主体性别未知'
        : k.og === null ? '客体性别未知'
        : '两端同性（或 role 与性别冲突）';
      why[w] = (why[w] || 0) + 1;
    }
    for (const [w, n] of Object.entries(why).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(6)}  ${w}`);
    }
    for (const k of kept.slice(0, 5)) {
      console.log(`  例：${k.id} ${k.name} ${k.base}→${k.object} (主体=${k.sg} 客体=${k.og})`);
    }
  }

  if (DRY) console.log('\n（dry-run，未写任何文件）');
}

main().catch(e => { console.error('失败：', e.message); process.exit(1); });
