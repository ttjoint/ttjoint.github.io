// 名字里的括注必须转成谓词边，不能存成 props。
//
// 背景：CBDB 有 50,638 行把关系写进名字——`郭氏(趙禎妻)`、`雷氏(孛朮魯遠妻)`。
// 中途一度把这些括注塞进 `props['名字括注']`，那是错的：
//
//   1. **关系是边，不是属性。** 存成 props 等于把三元组压平成一个字符串，
//      「趙禎的妻子是谁」这种反向查询就永远查不到。
//   2. **属性不是越多越好。** 每个塞进 props 的字段都是绕过谓词表的一条暗路，
//      既不参与引用校验，也不会出现在关系图谱里。
//
// 正确划分（这也是回答「每个连线都是三元组吗」的依据）：
//   - 宾语是**独立可识别的实体** → 谓词三元组（妻/夫/父/母…）
//   - 宾语只是一个**值** → literal 边或 props（生卒日期、字、号）
//   括注里的「趙禎」是一个人，所以它是边，不是属性。
//
// 性能：语料 48.7 万个分片，逐个 JSON.parse 要一分钟以上。这里抽样读
// 若干分片即可判定——漏掉的概率极低，而测试慢到没人愿意跑就等于没有测试。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', '..', 'data', 'persons', 'entities');
const SAMPLE = 4000;

/** 均匀抽样分片名，避免只读到按 id 排序的前几段。 */
function sampleShards(n) {
  const files = fs.readdirSync(DATA).filter((f) => f.endsWith('.json'));
  const step = Math.max(1, Math.floor(files.length / n));
  const out = [];
  for (let i = 0; i < files.length && out.length < n; i += step) out.push(files[i]);
  return out;
}

function readSample() {
  return sampleShards(SAMPLE).map((f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')));
}

test('名字括注已清除，且名字本身不含括注', () => {
  const offenders = [];
  for (const e of readSample()) {
    if (e.props && e.props['名字括注']) offenders.push(`${e.id} 残留 props`);
    if (/[（(][^（()）]*[）)]$/.test(String(e.name || ''))) offenders.push(`${e.id} 名字含括注 ${e.name}`);
    if (offenders.length >= 5) break;
  }
  assert.deepEqual(offenders, [], '名字括注必须已转成边');
});

test('原括注里的关系确实进了 relations（不是被丢掉）', () => {
  // 这是「转成三元组」而非「删掉了事」的关键证据：husband 的宾语
  // 必须是实体 id，不能是名字字符串。
  const sample = readSample();
  const withHusband = sample.filter((e) => Array.isArray(e.relations?.husband) && e.relations.husband.length);
  assert.ok(withHusband.length > 0, '抽样里应当存在 husband 边');
  for (const e of withHusband.slice(0, 50)) {
    const target = e.relations.husband[0];
    // 条目有两种形状：裸 id 字符串，或 `{id, provenance}`（带边级出处）。
    // 两者都合法，但都必须是实体 id，不能是名字字符串。
    const tid = typeof target === 'string' ? target : target && (target.id || target.target);
    assert.match(String(tid), /^person:/, `${e.id} 的 husband 宾语不是实体 id: ${tid}`);
  }
});

test('字/号是字面量属性，不建实体（别名走 aliases）', () => {
  // `徐宗卿(字)` 这类不是关系，是名字的注记。它们应留在 aliases，
  // 而不是变成一条指向某个「字」实体的边——那会造出 5 万个空壳节点。
  const sample = readSample();
  const offenders = sample.filter((e) =>
    Object.keys(e.relations || {}).some((k) => /^(alias|zi|hao)$/i.test(k)));
  assert.deepEqual(offenders.map((e) => e.id), [], '别名不应建谓词边');
});
