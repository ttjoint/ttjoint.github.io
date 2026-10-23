// 网页信源：先落 raw，再从 raw 抽取。
//
// 顺序不能反。抽取算法会变、网页会消失；若第一次抽取只留结构化结果，
// 后来发现漏抽字段就只能重抓——那时页面可能已改版或下线。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'fetch_web_raw.js'), 'utf8');

test('web raw: 抓取脚本保留原始 HTML 与清洗文本', () => {
  // 保留 HTML 意味着清洗规则变了可以重做，不必重新抓。
  assert.match(SRC, /html:\s*res\.body/);
  // `text` 是可截取引文的正文，必须是纯文本
  assert.match(SRC, /text:\s*body\.text/);
});

test('web raw: 区分 selector 与 fallback 抽取', () => {
  // 兜底全文质量差（含导航页脚），必须标记出来以便事后复核。
  // 但不能因为质量差就丢数据——抓到了就存，之后再修。
  assert.match(SRC, /extraction:\s*'selector'/);
  assert.match(SRC, /extraction:\s*'fallback'/);
});

test('web raw: rawId 由 URL 哈希生成，同一 URL 幂等', () => {
  // 重复抓取应落到同一 rawId，append 才能按 id 去重。
  assert.match(SRC, /sha1/);
  assert.ok(SRC.includes('raw:web/'), 'rawId 前缀');
  assert.ok(SRC.includes('${site}'), 'rawId 含站点');
});

test('web raw: 正文容器候选覆盖异构站点', () => {
  // 不同站点正文容器不同，必须有多个候选 + 兜底。
  assert.match(SRC, /CONTENT_SELECTORS/);
  assert.ok(SRC.includes('text_con'), '人民网容器');
  assert.ok(SRC.includes('article'), '通用 article 兜底');
});

test('web evidence: excerpt 放清洗后文本而非 URL', () => {
  // 这是核心原则：信息源是清洗后的文本，不是会变动的外链。
  const dir = path.join(ROOT, 'data', 'evidence', 'entities');
  if (!fs.existsSync(dir)) return;
  const web = fs.readdirSync(dir)
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((e) => e.id.startsWith('evidence:web-'));
  for (const e of web) {
    assert.ok(String(e.excerpt || '').trim().length > 0, `${e.id} 的 excerpt 为空`);
    assert.ok(!/^https?:\/\//.test(String(e.excerpt)), `${e.id} 的 excerpt 是 URL`);
    // note 记录对应 rawId，build_db 靠它做精确映射
    assert.match(String(e.note || ''), /rawRef:\s*raw:web\//);
  }
});

test('web evidence: 每条证据精确映射到自己的 rawId', () => {
  // 前缀映射适合「同一数据库百万条记录」，但网页是每篇独立文档。
  // 用 raw:web 前缀会把所有文章归到一个证据节点，等于说
  // 「这份简历出自人民网（整个网站）」，追不到具体文章。
  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build_db.js'), 'utf8');
  // 源码里是正则字面量 /rawRef:\s*(\S+)/，测试按子串匹配
  assert.ok(build.includes('rawRef:'), 'note 里的 rawRef 标记');
  assert.ok(build.includes('evidencePrefixes.set(m[1], e.id)'), '精确映射写入');
});

test('web evidence: 空壳证据已清除', () => {
  // 111 个只有标题+URL、excerpt 为空、零引用的占位节点已删。
  // 它们不是可用出处——出处必须有可读的原文。
  const dir = path.join(ROOT, 'data', 'evidence', 'entities');
  if (!fs.existsSync(dir)) return;
  const shells = fs.readdirSync(dir)
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((e) => !String(e.excerpt || '').trim());
  assert.equal(shells.length, 0, `仍有 ${shells.length} 个空壳证据`);
});
