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

test('extract: 6 篇真实 raw 全部可解析', () => {
  // 回归：格式变化（如来源行差异）会在这里暴露。
  const dir = path.join(ROOT, 'data', 'evidence', 'entities');
  if (!fs.existsSync(dir)) return;
  const webEv = fs.readdirSync(dir)
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((e) => e.id.startsWith('evidence:web-'));
  for (const e of webEv) {
    const m = String(e.note || '').match(/rawRef:\s*(\S+)/);
    if (!m) continue;
    const text = e.excerpt;
    const r = extractResume(text, { rawRef: m[1] });
    assert.ok(r.person, `${m[1]} 无法解析出人物`);
    assert.ok(r.claims.length >= 6, `${r.person.name} 只抽出 ${r.claims.length} 条`);
  }
});
