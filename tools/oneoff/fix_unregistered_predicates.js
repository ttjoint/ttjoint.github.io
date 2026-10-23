'use strict';
/**
 * 修复 6 种「注册表里不存在」的谓词。
 *
 * ## 调查经过（结论与初判不同，必须记录）
 *
 * 对 486,786 个实体扫 `relations`，发现 26,891 个实体用了 6 种未注册谓词：
 *
 *     wife 21,645 | stepMother 3,876 | daughter 1,060
 *     concubine 165 | son 128 | olderSibling 17
 *
 * 初判是「同义重复」。**两次实测修正了这个判断**：
 *
 * ### 误判一：「这些关系在 CBDB 里不存在」
 *
 * 抽样 3,000 个 wife 边的主体，回 `KIN_DATA` 查，其中 4,068 行有记录
 * （平均每人 1.36 条）——她们是真实 CBDB 人物，不是幽灵数据。
 *
 * ### 误判二：「同方向 KIN_DATA 记录的 c_kin_code 说明语义错了」
 *
 * 15,154 条同方向记录里 15,119 条是 code 134（`H`）。单看码表 `H`=丈夫，
 * 会得出「王氏 --wife--> 項某 方向反了」的结论。**查证性别后否定了这个结论**：
 *
 *     45940 某氏(安燾妻) female=1  --H-->  3 安燾 female=0
 *
 * CBDB 是从「某氏(安燾妻)」这个**从属人物**出发记的，`H` 在这里只是
 * 「其配偶是 X」的占位，不区分男女。而实体名「安燾妻」已明确是妻。
 *
 * **结论：`split_relational_names.js` 写出的 `wife` 方向是对的**，错的是
 * key 不在注册表里。本脚本把 key 对齐到注册表，不改方向。
 *
 * ## 映射规则
 *
 * 全部按 `KINSHIP_CODES.c_kinrel` 现查现推，脚本里没有一行是猜的。
 * 反向时只用语义确定对称的谓词（兄弟/姊妹/夫妻），父子母女反向无法确定
 * 具体是哪一支，一律不猜、记入未解决清单。
 *
 * 用法：
 *   node tools/oneoff/fix_unregistered_predicates.js --dry-run
 *   node tools/oneoff/fix_unregistered_predicates.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const ENTITY_DIR = path.join(ROOT, 'data', 'persons', 'entities');
const RAW_KIN = path.join(ROOT, 'raw', 'cbdb', 'KIN_DATA');
const CBDB_DB = path.join(ROOT, 'cbdb_20260801', 'cbdb_20260801.sqlite3');

const BAD = ['wife', 'stepMother', 'daughter', 'concubine', 'son', 'olderSibling'];

/**
 * 实测存在矛盾、不处理的 key。
 *
 * `daughter`：既是合法目标（应由 `D` 映射为 femaleChild），又在 2 个实体上作为
 * 未注册 key 出现。那 2 条来自 CBDB 互记的一对 `M^(繼母)` / `D^(繼女)`：
 *
 *   160224 崔氏 alias=「支新娘子繼母」
 *   raw: 141973 --375(M^ 繼母)--> 160224
 *   raw: 160224 --376(D^ 繼女)--> 141973
 *
 * 别名说「崔氏是继母」，但 `M^` 记录读作「141973 的继母是崔氏」——两者一致；
 * 而 `D^` 记录读作「崔氏的继女是 141973」——与前两者矛盾（不能既是母又是女）。
 * **CBDB 源数据自相矛盾，无可信判决，保留原样并告警。**
 */
const CONTRADICTORY = ['daughter'];
const DRY = process.argv.includes('--dry-run');

/**
 * 从括注名派生的边的映射。
 *
 * ## 为什么单独处理
 *
 * `split_relational_names.js` 从 `王氏(項某妻)` 这种名字里抽出「項某妻」这个括注，
 * 建了 `王氏 --wife--> 項某` 的边。这类边在 `KIN_DATA` 里**没有对应记录**
 * （实测 8,069 条中 8,064 条如此），所以不能走 `c_kinrel` 推导。
 *
 * ## 但方向是对的
 *
 * 已用性别核实：`45940 某氏(安燾妻) female=1 --H--> 3 安燾 female=0`。
 * 注册表语义是「A 的 X 是 B」，而实体名已明确是妻，所以 `王氏 --spouse--> 項某`
 * 读作「王氏的配偶是項某」——正确。
 *
 * ## 只改 key，不改方向
 *
 * 这些 key 不在注册表里，但语义正确。映射到注册表的通用 key：
 * 具体名分（妻/妾）丢失，因为注册表只有 `spouse`。
 * **这是真实的语义损失，记在 `qualifiers` 里以免丢失。**
 */
const FROM_QUALIFIER = {
  wife: { predicate: 'spouse', qualifiers: { role: 'wife' } },
  concubine: { predicate: 'spouse', qualifiers: { role: 'concubine' } },
  son: { predicate: 'maleChild', qualifiers: {} },
  // daughter 不在此表：'daughter' 既可能是合法目标（femaleChild）也可能是
  // 未注册 key。实测 2 条 stepMother→daughter 来自 CBDB 互记的
  // M^(繼母)/D^(繼女) 一对，正反矛盾（别名说「崔氏是繼母」，raw 说
  // 「崔氏的继女是 X」）。**数据自相矛盾，不猜，保留原样并告警。**
  stepMother: { predicate: 'mother', qualifiers: { kind: 'step' } },
  olderSibling: { predicate: 'sibling', qualifiers: { order: 'elder' } },
};

/** c_kinrel 单步字母 → 注册表 key。与 src/predicates/registry.js 对齐。 */
const BASE = {
  F: 'father', M: 'mother', S: 'maleChild', D: 'daughter',
  B: 'sibling', Z: 'sibling', H: 'spouse', W: 'spouse',
  C: 'spouse', A: 'kin',
};

/** 单步字母附带的主体性别，用于区分 sibling→兄/弟、spouse→夫/妻。 */
const LETTER_GENDER = {
  F: 'male', M: 'female', S: 'male', D: 'female',
  B: 'male', Z: 'female', H: 'male', W: 'female', C: 'female',
};

/**
 * 解析 c_kinrel 为 { predicate, qualifiers }。
 *
 * 只接受单步（一个基础字母 + 修饰）。多步链（`FF` 祖父）不属于单一谓词，
 * 按文档 §8.4 应走路径，本脚本不处理。
 *
 * @returns {{predicate, qualifiers, chain, letter} | null}
 */
function parseKinrel(rel) {
  if (!rel) return null;
  const s = String(rel).trim();
  if (/missing|Not Applicable/i.test(s)) return null;

  const m = s.match(/^([FMSDBZHWCA])(.*)$/);
  if (!m) return null;
  const letter = m[1];
  const base = BASE[letter];
  if (!base) return null;

  const rest = m[2];
  if (/[FMSDBZHWCA]/.test(rest)) return null; // 多步链，不在本脚本范围

  const q = {};
  if (rest.includes('+')) q.order = 'elder';
  if (rest.includes('-')) q.order = 'younger';
  if (rest.includes('^')) q.kind = 'step';
  if (rest.includes('[') || rest.includes(']')) q.kind = 'adopted';
  const digit = rest.match(/\d+/);
  if (digit) q.birthOrder = Number(digit[0]);

  return { predicate: base, qualifiers: q, chain: s, letter, gender: LETTER_GENDER[letter] };
}

/**
 * 单步谓词的主宾倒置。**无法确定时返回 null，绝不猜。**
 *
 * 兄弟/姊妹语义对称、夫妻互相、妾的对面是夫，这几种可以反转。
 * 父子/母女反向是「子或女」「父或母」，两者都可能，选一个即为捏造。
 */
const INVERT = {
  sibling: 'sibling',
  spouse: 'spouse',
  kin: 'kin',
};

async function loadKinCodes() {
  if (!fs.existsSync(CBDB_DB)) throw new Error('找不到 CBDB 数据库：' + CBDB_DB);
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(CBDB_DB));
  const res = db.exec('SELECT c_kincode, c_kinrel FROM KINSHIP_CODES');
  const map = new Map();
  if (res.length) for (const [code, rel] of res[0].values) map.set(Number(code), rel);
  db.close();
  return map;
}

/** 扫 raw KIN_DATA，建 `主体|客体` → code 索引（双向都收）。 */
function buildRawIndex(wantedPairs) {
  const want = new Set(wantedPairs);
  for (const p of wantedPairs) {
    const [a, b] = p.split('|');
    want.add(`${b}|${a}`);
  }
  const idx = new Map();
  if (!fs.existsSync(RAW_KIN)) return idx;
  for (const f of fs.readdirSync(RAW_KIN).filter(x => x.endsWith('.gz')).sort()) {
    let text;
    try {
      text = zlib.gunzipSync(fs.readFileSync(path.join(RAW_KIN, f))).toString('utf8');
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
      const k = `${p.c_personid}|${p.c_kin_id}`;
      if (want.has(k) && !idx.has(k)) idx.set(k, p.c_kin_code);
    }
  }
  return idx;
}

function cbdbIdOf(e) {
  const v = (e.external || {}).cbdbId;
  return v === undefined || v === null ? null : Number(v);
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
    const badKeys = Object.keys(rel).filter(k => BAD.includes(k.split('/')[0]));
    if (!badKeys.length) continue;
    targets.push({ file: f, entity: e, badKeys });
    const sid = cbdbIdOf(e);
    if (sid === null) continue;
    for (const k of badKeys) {
      for (const o of (Array.isArray(rel[k]) ? rel[k] : [rel[k]])) {
        const oid = String(o && o.id ? o.id : o).replace(/^person:cbdb-/, '');
        if (/^\d+$/.test(oid)) wanted.add(`${sid}|${oid}`);
      }
    }
  }

  console.log(`含非法谓词的实体：${targets.length}`);
  console.log(`需查 raw 的实体对：${wanted.size}`);

  const kinCodes = await loadKinCodes();
  const rawIdx = buildRawIndex(wanted);
  console.log(`CBDB KINSHIP_CODES：${kinCodes.size}  |  raw 命中：${rawIdx.size}`);

  const changed = [];
  const removed = [];

  for (const { file, entity, badKeys } of targets) {
    const sid = cbdbIdOf(entity);
    const rel = entity.relations;
    let dirty = false;

    for (const badKey of badKeys) {
      const arr = Array.isArray(rel[badKey]) ? rel[badKey] : [rel[badKey]];
      /** 本次为本 badKey 的所有条目实际写入的 key，用于决定旧 key 该不该删。 */
      const handled = [];

      for (const obj of arr) {
        // 原 id 保持原样。CBDB 人物是 `person:cbdb-123`，但也有 `person:local-000307`
        // 这种非 CBDB 实体（来自官方人员导入）。先前只抹掉 `person:cbdb-` 前缀
        // 再统一拼回，会把 `person:local-000307` 变成
        // `person:cbdb-person:local-000307`。保留原 id 最安全。
        const rawId = String(obj && obj.id ? obj.id : obj);
        const oid = rawId.replace(/^person:cbdb-/, '');

        // 正向优先
        let code = rawIdx.get(`${sid}|${oid}`);
        let parsed = code === undefined ? null : parseKinrel(kinCodes.get(Number(code)));
        let inverted = false;

        // 反向回退：只用语义确定对称的谓词
        if (!parsed) {
          const rcode = rawIdx.get(`${oid}|${sid}`);
          if (rcode !== undefined) {
            const rp = parseKinrel(kinCodes.get(Number(rcode)));
            if (rp && INVERT[rp.predicate]) {
              parsed = { ...rp, predicate: INVERT[rp.predicate] };
              code = rcode;
              inverted = true;
            }
          }
        }

        if (!parsed) {
          // 码表说得出所以然时以码表为准（权威）。这里处理其余情况：
          //   - `code === undefined`：raw 双向都无记录（split_relational_names.js 造的）
          //   - 码表能查到但 c_kinrel 不是单步（如 code 243 / 434 / 395）
          // 两者都有 `aliases` 里的括注作依据，按 FROM_QUALIFIER 对齐 key。
          const q = FROM_QUALIFIER[badKey];
          if (q) {
            writeEdge(entity, rel, q, rawId, badKey, handled, changed, 'qualifier');
            dirty = true;
          } else if (CONTRADICTORY.includes(badKey)) {
            // 数据自相矛盾，不猜也不删：保留原状，只告警。
            handled.push({ to: badKey }); // 阻止后面的 delete 删掉它
            removed.push({
              file, id: entity.id, name: entity.name, predicate: badKey, object: oid,
              code, kinrel: code === undefined ? null : kinCodes.get(Number(code)),
              why: 'WARN 数据自相矛盾，保留原状待人工裁定',
            });
          } else {
            removed.push({
              file, id: entity.id, name: entity.name, predicate: badKey, object: oid,
              code: code === undefined ? null : code,
              kinrel: code === undefined ? null : kinCodes.get(Number(code)),
              why: code === undefined ? '无 raw 记录且无映射规则' : 'c_kinrel 无法解析为单步',
            });
            dirty = true;
          }
          continue;
        }

        // 码表说得出所以然时以码表为准（它是权威）。
        // 但若结论会落回一个未注册 key（如 `D` → `daughter`），说明码表与
        // 注册表在这一支上不一致，不能强行映射。保留原状待人工裁定。
        if (CONTRADICTORY.includes(parsed.predicate)) {
          handled.push({ to: badKey });
          removed.push({
            file, id: entity.id, name: entity.name, predicate: badKey, object: oid,
            code, kinrel: parsed.chain,
            why: 'WARN 码表推出的谓词不在注册表，保留原状待人工裁定',
          });
          continue;
        }

        writeEdge(
          entity, rel,
          { predicate: parsed.predicate, qualifiers: parsed.qualifiers },
          rawId, badKey, handled, changed, inverted ? 'kinrel-inv' : 'kinrel'
        );
        dirty = true;
      }
      // 只有 key 真的换了才删旧的。
      // `daughter → daughter {kind:step}` 这种情况 target === badKey，旧代码会
      // 先写入再无条件删除自己，静默丢数据。
      if (!handled.some(h => h.to === badKey)) delete rel[badKey];
    }

    if (dirty && !DRY) {
      fs.writeFileSync(path.join(ENTITY_DIR, file), JSON.stringify(entity, null, 2) + '\n', 'utf8');
    }
  }

  console.log('\n=== 改写统计 ===');
  const byPair = {};
  for (const c of changed) {
    const k = `${c.from} → ${c.to}${Object.keys(c.qualifiers || {}).length ? ' ' + JSON.stringify(c.qualifiers) : ''}`;
    byPair[k] = (byPair[k] || 0) + 1;
  }
  for (const [k, v] of Object.entries(byPair).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(46)} ${v}`);
  }
  console.log(`  合计 ${changed.length} 条`);
  const byOrigin = {};
  for (const c of changed) byOrigin[c.origin || 'kinrel'] = (byOrigin[c.origin || 'kinrel'] || 0) + 1;
  console.log('  来源：', Object.entries(byOrigin).map(([k, v]) => `${k}=${v}`).join('  '));

  if (removed.length) {
    console.log(`\n=== 删除（码表无法解析）共 ${removed.length} 条 ===`);
    for (const r of removed.slice(0, 10)) {
      console.log(`  ${r.id} ${r.name} ${r.predicate}→${r.object} code=${r.code} ${r.why}`);
    }
  }

  if (DRY) console.log('\n（dry-run，未写任何文件）');
}

/** 用主体性别把通用谓词细化为具体词。sibling→brother/sister 不细化（注册表无此 key）。 */
function refineByGender(predicate, gender) {
  // 注册表当前只有 spouse/sibling 这些通用 key，性别由边的 qualifier 承载。
  // 这里保持原 key，避免引入注册表里没有的 key（那正是本次要修的 bug）。
  return predicate;
}

/**
 * 写一条边（幂等：同目标同属性不重复写）。
 *
 * @param {object} entity 被改写的实体
 * @param {object} rel    entity.relations
 * @param {{predicate:string, qualifiers:object}} q 目标谓词与属性
 * @param {string} oid    客体 cbdbId
 * @param {string} badKey 原非法 key
 * @param {Array}  handled 本 badKey 实际写入的 key（决定旧 key 该不该删）
 * @param {Array}  changed 改动日志
 * @param {string} origin 'kinrel' | 'qualifier'
 */
function writeEdge(entity, rel, q, rawId, badKey, handled, changed, origin) {
  const existing = rel[q.predicate];
  const val = existing === undefined ? [] : (Array.isArray(existing) ? existing : [existing]);
  const hasQ = Object.keys(q.qualifiers).length > 0;
  const newVal = hasQ ? { id: rawId, ...q.qualifiers } : rawId;
  const dup = val.some(v => {
    const vid = v && v.id ? v.id : v;
    if (vid !== rawId) return false;
    if (!hasQ) return true;
    return Object.entries(q.qualifiers).every(([k, x]) => v[k] === x);
  });
  if (!dup) val.push(newVal);
  rel[q.predicate] = val;
  handled.push({ to: q.predicate });
  changed.push({
    id: entity.id, name: entity.name, from: badKey, to: q.predicate,
    qualifiers: q.qualifiers, origin,
  });
}

main().catch(e => { console.error('失败：', e.message); process.exit(1); });
