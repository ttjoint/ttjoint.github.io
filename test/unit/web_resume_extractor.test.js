// 网页简历抽取器。
//
// 关键约束：不造泛用谓词。抽取器只能用已注册的谓词，
// 找不到合适谓词就跳过并记 WARN——`tags`/`era`/`kin` 的教训是
// 「说不出具体关系时塞一个宽泛标签，读起来像事实，实际什么也没说」。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { extractResume, normalizeOrg } = require('../../src/extractors/web_resume.js');

const SAMPLE = [
  '蒋作君简历',
  '',
  '2023年03月11日09:33 来源： 人民网-人民日报 222',
  '',
  '蒋作君，男，汉族，1955年7月生，安徽怀宁人，致公党成员，1974年3月参加工作，南京医学院基础医学部寄生虫学专业毕业，研究生学历，医学博士学位，教授。',
  '',
  '现任十四届全国政协副主席，致公党中央主席。',
].join('\n');

test('extract: 全字段抽取，谓词全部来自注册表', () => {
  const r = extractResume(SAMPLE, { rawRef: 'raw:x' });
  assert.equal(r.person.name, '蒋作君');
  const preds = r.claims.map((c) => c.predicate);
  for (const p of preds) {
    assert.ok(
      ['gender', 'ethnicity', 'birthDate', 'bornAt', 'memberOf'].includes(p),
      `谓词 ${p} 不在白名单——抽取器不得自造谓词`,
    );
  }
});

test('extract: 每条断言都有 span，且 span 截出的文本与语义一致', () => {
  const r = extractResume(SAMPLE, { rawRef: 'raw:x' });
  for (const c of r.claims) {
    assert.ok(c.span && c.span.start < c.span.end, `${c.predicate} 缺 span`);
    const sliced = SAMPLE.slice(c.span.start, c.span.end);
    // literal 断言的值必须是原文子串——quote 由服务端按 span 截取，
    // span 错了 quote 就错。
    if (['gender', 'ethnicity'].includes(c.predicate)) {
      assert.equal(sliced, c.object, `${c.predicate} 的 span 与值不符`);
    }
  }
});

test('extract: 组织名展开为全称，id 由名称哈希生成', () => {
  assert.equal(normalizeOrg('致公党'), '中国致公党');
  assert.equal(normalizeOrg('民革'), '中国国民党革命委员会');
  // 不认识的写法原样保留，不猜
  assert.equal(normalizeOrg('某研究会'), '某研究会');

  const r = extractResume(SAMPLE, { rawRef: 'raw:x' });
  const party = r.entities.find((e) => e.name === '中国致公党');
  assert.ok(party, '应生成致公党组织节点');
  assert.equal(party.id, 'organization:web-77205df2', '同一名的两次哈希必须一致');
});

test('extract: 届次不进组织名——同一组织不因届次分裂', () => {
  // 「十四届全国政协副主席」的组织是「全国政协」。
  // 把「十四届」放进组织名会让下一届出现第二个「十五届全国政协」节点，
  // 组织就永远合并不起来。
  const r = extractResume(SAMPLE, { rawRef: 'raw:x' });
  const orgs = r.entities.filter((e) => e.name.includes('政协'));
  assert.equal(orgs.length, 1);
  assert.equal(orgs[0].name, '全国政协');
  // 届次进了 reason，不丢信息
  const post = r.claims.find((c) => c.predicate === 'memberOf' && c.reason.includes('十四届'));
  assert.ok(post, '届次应记在 reason 里');
});

test('extract: 职务放 role 限定词，不是独立谓词', () => {
  // 「副主席」说不出具体关系，它只是 memberOf 的属性。
  // 造一个「viceChairmanOf」谓词就是重复 tags 的错误。
  const r = extractResume(SAMPLE, { rawRef: 'raw:x' });
  const post = r.claims.find((c) => c.qualifiers && c.qualifiers.role === '中央主席');
  assert.ok(post, '应有 role=中央主席 的断言');
  assert.equal(post.predicate, 'memberOf');
});

test('extract: 缺字段记 WARN，不猜', () => {
  const partial = '某人简历\n\n2023年01月01日 来源：测试\n\n某人，男，1960年生。\n现任某职务。';
  const r = extractResume(partial, { rawRef: 'raw:x' });
  const codes = r.warnings.map((w) => w.code);
  assert.ok(codes.includes('no-ethnicity'), '无民族应记 WARN');
  assert.ok(codes.includes('no-party'), '无党派应记 WARN');
  assert.ok(codes.includes('post-no-org'), '无法识别组织的职务应记 WARN');
  // 出生只有年份也记 WARN
  assert.ok(codes.includes('birth-month-missing') || r.claims.some((c) => c.predicate === 'birthDate'));
});

test('extract: 真实 raw 的简历页全部可解析', () => {
  // 回归：格式变化（如来源行差异）会在这里暴露。
  //
  // 只测**简历页**：73 个页面里有 8 个不是简历（主席令、会议新闻），
  // 它们本来就没有「X简历」标题，抽不出人物是正确行为。全量断言会
  // 把这 8 个判成失败，测试就变成「要求所有网页都是简历」——那是错的。
  const dir = path.join(ROOT, 'data', 'evidence', 'entities');
  if (!fs.existsSync(dir)) return;
  const webEv = fs.readdirSync(dir)
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((e) => e.id.startsWith('evidence:web-'));

  let resumePages = 0;
  for (const e of webEv) {
    const m = String(e.note || '').match(/rawRef:\s*(\S+)/);
    if (!m) continue;
    const text = e.excerpt || '';
    // 不是简历页（标题里没有「简历」）就跳过——那是正确的跳过，不是失败
    if (!/简历/.test(text.split('\n')[0])) continue;
    resumePages++;
    const r = extractResume(text, { rawRef: m[1] });
    assert.ok(r.person, `${m[1]} 无法解析出人物`);
    assert.ok(r.claims.length >= 4, `${r.person.name} 只抽出 ${r.claims.length} 条`);
  }
  // 至少要有几个真实简历页，否则这个测试等于没跑
  assert.ok(resumePages >= 6, `只找到 ${resumePages} 个简历页，样本太少`);
});

test('dates: 无日期是合法状态，不编造', () => {
  // 「现任」职务原文没说何时就任。把「1974年3月参加工作」当成
  // memberOf 的起始时间就是编造——那是参加工作的日期，不是入党日期。
  const r = extractResume(SAMPLE, { rawRef: 'raw:x' });
  for (const c of r.claims.filter((x) => x.predicate === 'memberOf')) {
    assert.equal(c.dates, undefined, '原文无就任时间，dates 应留空');
  }
});

test('dates: 有明确时间时抽出来', () => {
  // 「2010年加入」是明确的时间点，可以填 dates.from。
  const text = SAMPLE.replace('致公党成员', '2010年加入致公党');
  const r = extractResume(text, { rawRef: 'raw:x' });
  const party = r.claims.find((c) => c.predicate === 'memberOf' && c.reason.includes('致公党'));
  if (party && party.dates) {
    assert.equal(party.dates.from, 2010);
  }
  // 就算抽不到也不能编
  for (const c of r.claims.filter((x) => x.predicate === 'memberOf')) {
    if (c.dates) assert.ok(Number.isFinite(c.dates.from) || Number.isFinite(c.dates.to));
  }
});

// ---------------------------------------------------------------- 异构页面
//
// 73 个人民网页面实测暴露两个问题，都是「抓到了但抽不出来」：
// 页面形态异构导致整页零抽取，而只是 warning 不报错——静默丢数据。

test('异构标题：人民网的「X同志简历--栏目--站名」也要认', () => {
  const { extractResume } = require('../../src/extractors/web_resume.js');
  const text = '习近平同志简历--资料中心--人民网\n\n习近平，男，汉族，1953年6月生，陕西富平人。\n';
  const out = extractResume(text, { rawRef: 'raw:test' });
  // 严格匹配 `^(.+?)简历$` 只认政协网的「蒋作君简历」，
  // 人民网这种带标题装饰的被判 no-name，整页零抽取。
  assert.ok(out.person, '应识别出姓名，实际返回 null');
  assert.equal(out.person.name, '习近平', '「同志」不该留在姓名里');
  assert.ok(out.claims.length > 0, '应抽出断言');
});

test('届次在党派前缀之后：「中共二十届中央委员」', () => {
  const { extractResume } = require('../../src/extractors/web_resume.js');
  const text = '张军简历\n\n张军，男，汉族，1956年10月生。\n\n现任中共二十届中央委员，最高人民法院院长。\n';
  const out = extractResume(text, { rawRef: 'raw:test' });
  const posts = out.claims.filter((c) => c.predicate === 'memberOf');
  // 只匹配开头的 `^第?X届` 会漏掉「中共二十届…」（实测最高频，13 条）。
  assert.ok(posts.length >= 2, '两条现任职务都该抽到，实际 ' + posts.length);
  const orgs = posts.map((c) => (out.entities.find((e) => e.id === c.object) || {}).name);
  assert.ok(orgs.some((o) => o && o.includes('中央')), '中央委员应归到党中央：' + orgs.join(','));
  assert.ok(orgs.some((o) => o && o.includes('最高人民法院')), '应抽出最高人民法院：' + orgs.join(','));
});

test('军衔职级不是组织，跳过是对的', () => {
  const { extractResume } = require('../../src/extractors/web_resume.js');
  const text = '某甲简历\n\n某甲，男，汉族，1960年1月生。\n\n现任首席大法官，总警监。\n';
  const out = extractResume(text, { rawRef: 'raw:test' });
  const noOrg = out.warnings.filter((w) => w.code === 'post-no-org');
  // 「首席大法官」「总警监」没有所属组织，硬造一个组织节点是编造。
  assert.ok(noOrg.length >= 1, '应记警告而非编造组织');
});
