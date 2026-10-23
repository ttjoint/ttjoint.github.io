'use strict';
/**
 * CBDB `KIN_DATA` → 亲属边。
 *
 * ## 方向语义
 *
 * 全局约定（见 `节点类型与谓词.md` §8）：`A --X--> B` 读作「**A 的 X 是 B**」。
 * `KIN_DATA` 一行 `(c_personid=P, c_kin_id=K, c_kin_code=C)` 的含义正是
 * 「**P 的 C 是 K**」——`c_personid` 是主语，`c_kin_id` 是那个亲属。
 *
 * 所以边直接是 `P --predicate(C)--> K`，不反向。曾经有一个手写映射表把
 * 父/母映射到 `maleChild`（即反了），`cbdb_kinship.js` 的
 * `assertNoDirectionInversion()` 就是为那次事故留的钩子。
 *
 * ## 映射逻辑不在这里重写
 *
 * `c_kinrel` → 谓词的推导（基础字母提取、修饰符剥离、模糊符号降级）已经
 * 写在 `src/importers/cbdb_kinship.js` 的 `derivePredicate()` 里，并有
 * `src/importers/` 侧的测试。**本文件直接复用它**，不复制一份。
 *
 * 复制会让 P2 变成「两套映射并存」，正是这次重构要消灭的东西。
 *
 * ## 为什么需要 `cbdb-kin-codes.json`
 *
 * `KIN_DATA` 行里只有 `c_kin_code`（数字），`c_kinrel`（`"B-"`=弟）在
 * `KINSHIP_CODES` 表里。而 `KINSHIP_CODES` 是**码表**——它解释别的表，
 * 自己不是被记载的内容，所以不进 raw 层。
 *
 * 于是把 488 行 `code → c_kinrel` 导出成 JSON 放在本目录。它是
 * `cbdb_20260801.sqlite3` 的 `SELECT c_kincode, c_kinrel FROM KINSHIP_CODES`
 * 的原样导出，不是手写表。重新生成的方式见文件末尾注释。
 *
 * ## 复合路径不建边
 *
 * `FF`(祖父)、`SS`(孫)、`WF`(岳父) 这类多字母码按 §8.6 是**第二层**的
 * 东西：它们由两条单步边组合得出（`A --F--> X --F--> B` = A 的祖父是 B），
 * 不该另存一条 `grandfather` 边。同一事实有两个来源，改一处就会自相矛盾。
 *
 * `derivePredicate()` 对复合码返回 `{key:'kin', chain:[...]}`，即只在
 * **确实无法组合**时才落一条 `kin` 边。这里沿用它的结果，不另行裁决。
 */

const { derivePredicate, VAGUE } = require('../importers/cbdb_kinship.js');
const KIN_REL = require('./cbdb-kin-codes.json');

/** `person:cbdb-<id>`，与 `cbdb-biog` 保持一致。 */
const personId = (cbdbId) => `person:cbdb-${cbdbId}`;

/**
 * 把 `spouse` 细化为 `husband`/`wife`。
 *
 * `derivePredicate()` 是 P5-5b 之前的代码，把 H/W/C 都归到 `spouse`。P5-5b
 * 把亲缘谓词拆成性别原语后，`H`（丈夫）对应 `husband`、`W`（妻子）对应 `wife`，
 * `spouse` 退为「性别未知」的兜底。当前 `data/` 里 21,897 条 `husband`、
 * 364 条 `wife`、301 条 `spouse`，就是这个形状。
 *
 * 为什么不在 `derivePredicate()` 里改：那个函数是**码表推导**层，回答「`B-`
 * 是什么关系」；`husband` 与 `wife` 的区分来自**谓词表设计**（§8.4）。两层
 * 混在一起，以后改谓词表就要动码表推导。
 *
 * `C`（妾）不单独拆：它也是配偶且是女性，但「妾」的信息属于**主体的角色**，
 * 不是一种新关系（§8.4 推翻了自己的 `C` 独立原语方案）。实测当前数据里
 * `C` 码实际落到了 `husband`，因为源数据记的是「她是某人的妾」= 她的配偶是丈夫。
 */
function refineSpouse(step, key) {
  if (key !== 'spouse') return key;
  if (step === 'H') return 'husband';
  if (step === 'W') return 'wife';
  if (step === 'C') return 'husband';
  return key;
}

/**
 * `c_kin_code` → `{predicate, qualifiers}`；无法解析返回 `null`。
 *
 * 记忆化：559,940 行 KIN_DATA 只用到 438 个 code，`derivePredicate()` 每次
 * 都要跑正则，不缓存会让全量重算多花几分钟。
 */
const cache = new Map();
function resolveKinCode(code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return null;
  if (cache.has(n)) return cache.get(n);
  const kinrel = KIN_REL[n];
  let out = null;
  if (kinrel !== undefined) {
    const d = derivePredicate({ c_kincode: n, c_kinrel: kinrel });
    if (d.resolved) {
      // 基础字母链恰好一个 → 单步关系，用推导出的 key。
      // 多字母（复合路径）按 §8.6 不建派生边，因此不出边。
      if (d.chain.length === 1) {
        // 模糊符号（G 直系祖先 / K 同族长辈 / P 表親 / U 未詳）不建边。
        //
        // `kin` 谓词的意思是「知道是亲属、但谓词表里没有对应 key」（如 A 姻親）。
        // 而 G/K/P/U 是另一回事：源数据自己就说不出关系。`G` = 往上几代、
        // 几代未知，`U` = 未詳——为它们建边相当于把「不知道」当成一条事实记下来，
        // 而 `A --kin--> B` 读作「A 的亲属是 B」，听起来像我们知道了什么。
        //
        // 实测这些码占 15 万行以上（`G` 一个就占了单字母码的一半），全建成
        // `kin` 会让边总数从 5 万膨到 40 万，而新增的那些边携带的信息量是零。
        if (VAGUE.has(d.chain[0])) {
          out = { vague: d.chain[0] };
        } else {
          // 把原始关系描述存进 qualifiers。
          //
          // 复合码（`SS` = 孫、`WF` = 岳父）按 §8.6 不另建谓词，只落一条 `kin` 边。
          // 但「孙」和「九世祖」都变成 `kin` 之后，页面上只剩「亲属」两个字——
          // 源数据说得很清楚的关系名被丢了。113,328 条 kin 边的 qualifiers
          // 全是 null，就是这个后果。
          //
          // `chain` 是字母链（§8.6 的编码），`chainLabel` 是中文关系名。
          // 两者都存：字母链可与 CBDB 源数据对齐，中文名供展示。
          const qualifiers = {};
          if (d.chain.length > 1) qualifiers.path = d.chain.join('');
          if (d.chainLabel && d.chainLabel !== d.key) qualifiers.label = d.chainLabel;
          out = { predicate: refineSpouse(d.chain[0], d.key), qualifiers };
        }
      } else {
        out = { derived: true, chain: d.chain }; // 复合路径，调用方不出边
      }
    }
  }
  cache.set(n, out);
  return out;
}

/**
 * 一行 `KIN_DATA` → 至多一条边。
 *
 * 返回 `{subject, predicate, object, rawRef, qualifiers?}`，由写入层决定
 * 落到 `relations[predicate] = [object]` 还是别的形状。
 */
function transform(rawRecord) {
  const p = rawRecord && rawRecord.payload;
  if (!p) return { entities: [], edges: [] };

  const subjectId = Number(p.c_personid);
  const objectId = Number(p.c_kin_id);
  if (!Number.isFinite(subjectId) || !Number.isFinite(objectId)) {
    return { entities: [], edges: [], skipped: 'non-numeric id' };
  }
  // 自己和自己没有亲属关系；这种行是数据错误，不建边也不静默算成功。
  if (subjectId === objectId) {
    return { entities: [], edges: [], skipped: 'self-reference' };
  }

  const hit = resolveKinCode(p.c_kin_code);
  if (!hit) {
    return { entities: [], edges: [], skipped: `unknown c_kin_code ${p.c_kin_code}` };
  }
  if (hit.derived) {
    // 复合路径：按 §8.6 由单步边组合，这里不建边。
    return { entities: [], edges: [], derivedChart: hit.chain };
  }
  if (hit.vague) {
    // 模糊符号：源数据说不出关系，不建边（原因见 `resolveKinCode`）。
    return { entities: [], edges: [], vagueStep: hit.vague };
  }

  const edge = {
    subject: personId(subjectId),
    predicate: hit.predicate,
    object: personId(objectId),
    // 边的出处指回这一行：一条边只是两人之间的一个断言，没有出处无从核验。
    rawRef: rawRecord.rawId,
  };
  if (Object.keys(hit.qualifiers).length) edge.qualifiers = hit.qualifiers;
  return { entities: [], edges: [edge] };
}

module.exports = {
  name: 'cbdb-kin',
  version: '2.0.0',
  appliesTo: { kind: 'record', source: 'cbdb', sourceTable: 'KIN_DATA', locked: true },
  transform,
  _internal: { resolveKinCode, personId, refineSpouse, KIN_REL },
};

/*
 * 重新生成 `cbdb-kin-codes.json`（CBDB 换版本时才需要）：
 *
 *   node -e "const S=require('sql.js'),fs=require('fs');(async()=>{
 *     const db=new (await S())(fs.readFileSync('cbdb_20260801/cbdb_20260801.sqlite3'));
 *     const o={};for(const [c,k] of db.exec('SELECT c_kincode,c_kinrel FROM KINSHIP_CODES')[0].values)o[c]=String(k||'');
 *     fs.writeFileSync('src/transformers/cbdb-kin-codes.json',JSON.stringify(o,null,0));
 *   })()"
 */
