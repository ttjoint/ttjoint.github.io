// 从网页 raw 文本抽取断言（人民网简历格式）。
//
// ## 设计约束：不造泛用谓词
//
// 抽取器**只能使用已注册的谓词**。找不到合适谓词就跳过并记 WARN，
// 不新增「标签」式的宽泛谓词（`tags`/`era`/`kin` 的教训：说不出具体
// 关系时塞一个宽泛标签，读起来像事实，实际什么也没说）。
//
// 本格式能表达的都对应到已有谓词：
//
//   原文                      谓词        宾语
//   ─────────────────────────────────────────────────────
//   男 / 女                    gender      literal
//   汉族                       ethnicity   literal
//   1955年7月生                birthDate   literal
//   安徽怀宁人                 bornAt      organization（籍贯）
//   致公党成员                 memberOf    organization
//   十四届全国政协副主席       memberOf    organization + role 限定
//
// 「现任十四届全国政协副主席，致公党中央主席」拆成两条 `memberOf`：
// 组织分别是「全国政协」和「中国致公党」，职务放 `role` 限定词。
//
// ## 每一条都必须带 span
//
// 抽取结果不是最终数据，是**候选**。每条都记录在原文中的字符区间，
// 提交时由服务端按 span 重新截取 quote——抽取器自己算的 quote 不作数。
//
// ## 输出
//
// 返回 `{entities, claims, warnings}`：
//   entities  需要新建的节点（组织/籍贯），带 id 与名称
//   claims    断言（含 literal 属性的边）
//   warnings  抽不出的部分，不猜、不丢，记下来供人工看

'use strict';

/**
 * 在文本中定位子串，返回 span。找不到返回 null。
 *
 * 用 `indexOf` 而非正则 exec，因为要的是精确字符偏移（span 用）。
 */
function spanOf(text, needle, from = 0) {
  const i = text.indexOf(needle, from);
  return i < 0 ? null : { start: i, end: i + needle.length };
}

/**
 * 组织名规范化。
 *
 * 原文常写简称（「致公党」「民革」「民盟」），节点名应写全称，
 * 否则同一组织会因不同页面写法不同而分裂成多个节点。
 *
 * 只做**已知的**展开，不做推断——不认识的写法原样保留并记 WARN。
 */
const ORG_ALIASES = {
  致公党: '中国致公党',
  民革: '中国国民党革命委员会',
  民盟: '中国民主同盟',
  民建: '中国民主建国会',
  民进: '中国民主促进会',
  农工党: '中国农工民主党',
  九三学社: '九三学社',
  台盟: '台湾民主自治同盟',
};

function normalizeOrg(name) {
  return ORG_ALIASES[name] || name;
}

/**
 * 组织 id。
 *
 * 用名称的稳定哈希而不是序号：同一组织在不同页面出现时应落到同一 id，
 * 否则「中国致公党」会有多个节点，查询时分散。
 */
function orgId(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return 'organization:web-' + (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * 解析「现任……」那一句里的职务。
 *
 * 格式：「现任十四届全国政协副主席，致公党中央主席。」
 * 逗号分隔多项，每项形如 `<组织><职务>`。
 *
 * 已知的组织前缀按长度降序匹配（避免「全国政协」被「政协」抢先）。
 */
const ORG_PREFIXES = [
  '全国政协', '全国人大常委会', '全国人大', '国务院', '中共中央',
  '中国致公党', '致公党', '中国国民党革命委员会', '民革',
  '中国民主同盟', '民盟', '中国民主建国会', '民建',
  '中国民主促进会', '民进', '中国农工民主党', '农工党',
  '九三学社', '台湾民主自治同盟', '台盟',
  '清华大学', '北京大学',
];

function parsePosts(sentence) {
  const out = [];
  for (const part of sentence.split(/[，,]/)) {
    const s = part.trim().replace(/[。.]$/, '');
    if (!s) continue;

    // 「十四届全国政协副主席」→ 去掉届次前缀「十四届」后再匹配组织。
    // 届次是组织的**届**，不是组织名的一部分：「十四届全国政协」与
    // 「全国政协」是同一组织的不同届。把届次放进组织名会让同一组织
    // 因届次不同而分裂成多个节点。
    const sessionMatch = s.match(/^第?[一二三四五六七八九十百\d]+届/);
    const session = sessionMatch ? sessionMatch[0] : '';
    const rest = session ? s.slice(session.length) : s;

    // 最长前缀优先：「全国政协」优先于「政协」
    const prefix = ORG_PREFIXES
      .slice()
      .sort((a, b) => b.length - a.length)
      .find((p) => rest.startsWith(p));

    if (!prefix) {
      out.push({ org: null, role: s, raw: s });
      continue;
    }
    const role = rest.slice(prefix.length).trim();
    out.push({ org: prefix, role, raw: s, session });
  }
  return out;
}

/**
 * 主抽取函数。
 *
 * @param {string} text  清洗后的正文
 * @param {object} meta   { rawRef, title }
 * @returns {{entities:Array, claims:Array, warnings:Array, person:{name:string,span:object}}}
 */
function extractResume(text, meta) {
  const entities = [];
  const claims = [];
  const warnings = [];
  const rawRef = meta.rawRef;

  const push = (claim) => claims.push(claim);

  // ---------------------------------------------------------------- 姓名
  //
  // 首行「蒋作君简历」。去掉「简历」二字即姓名。
  const firstLine = text.split('\n')[0].trim();
  const nameMatch = firstLine.match(/^(.+?)简历$/);
  if (!nameMatch) {
    warnings.push({ code: 'no-name', message: `首行不是「X简历」格式：${firstLine}` });
    return { entities, claims, warnings, person: null };
  }
  const personName = nameMatch[1];
  const nameSpan = spanOf(text, personName);
  if (!nameSpan) {
    warnings.push({ code: 'name-span-lost', message: '找不到姓名位置' });
    return { entities, claims, warnings, person: null };
  }

  const personId = 'person:web-' + Buffer.from(personName, 'utf8').toString('hex').slice(0, 12);

  // ---------------------------------------------------------------- 性别
  //
  // 「蒋作君，男，汉族，……」
  const genderMatch = text.match(/，(男|女)，/);
  if (genderMatch) {
    const v = genderMatch[1];
    const sp = spanOf(text, v, nameSpan.end);
    push({ subject: personId, predicate: 'gender', object: v, span: sp, reason: '原文：' + v });
  } else {
    warnings.push({ code: 'no-gender', message: '未找到性别' });
  }

  // ---------------------------------------------------------------- 民族
  const ethMatch = text.match(/，(汉族|[\u4e00-\u9fa5]{1,4}族)，/);
  if (ethMatch) {
    const v = ethMatch[1];
    const sp = spanOf(text, v, nameSpan.end);
    push({ subject: personId, predicate: 'ethnicity', object: v, span: sp, reason: '原文：' + v });
  } else {
    warnings.push({ code: 'no-ethnicity', message: '未找到民族' });
  }

  // ---------------------------------------------------------------- 出生
  //
  // 「1955年7月生」。只取到「生」之前的年月，不推断具体日。
  const birthMatch = text.match(/(\d{4})年(\d{1,2})月生/);
  if (birthMatch) {
    const v = birthMatch[0].replace(/生$/, '');
    const sp = spanOf(text, birthMatch[0], nameSpan.end);
    push({ subject: personId, predicate: 'birthDate', object: v, span: sp, reason: '原文：' + birthMatch[0] });
  } else {
    // 可能只到年：「1955年生」
    const yearOnly = text.match(/(\d{4})年生/);
    if (yearOnly) {
      const v = yearOnly[1] + '年';
      const sp = spanOf(text, yearOnly[0], nameSpan.end);
      push({ subject: personId, predicate: 'birthDate', object: v, span: sp, reason: '原文：' + yearOnly[0] });
      warnings.push({ code: 'birth-month-missing', message: '只有出生年份，无月份' });
    } else {
      warnings.push({ code: 'no-birth', message: '未找到出生时间' });
    }
  }

  // ---------------------------------------------------------------- 籍贯
  //
  // 「安徽怀宁人」。建 organization 节点表示籍贯地。
  //
  // 为什么用 organization 而不是 literal：籍贯是地理实体，将来会有
  // 「出生名人」反向查询（birthplaceOf），literal 做不到。
  const originMatch = text.match(/([\u4e00-\u9fa5]{2,8}(?:市|县|区|省)?)人(?=[，,])/);
  if (originMatch) {
    const place = originMatch[1];
    const sp = spanOf(text, place, nameSpan.end);
    const pid = orgId(place);
    entities.push({ id: pid, type: 'organization', name: place, props: {}, span: sp, reason: '原文籍贯' });
    push({ subject: personId, predicate: 'bornAt', object: pid, span: sp, reason: '原文：' + place + '人' });
  } else {
    warnings.push({ code: 'no-origin', message: '未找到籍贯' });
  }

  // ---------------------------------------------------------------- 党派
  //
  // 「致公党成员」。组织名展开成全称。
  const partyMatch = text.match(/([\u4e00-\u9fa5]{2,10}?)(?:成员|党员|盟员|会员)/);
  if (partyMatch) {
    const short = partyMatch[1];
    const full = normalizeOrg(short);
    const sp = spanOf(text, partyMatch[0], nameSpan.end);
    const pid = orgId(full);
    entities.push({ id: pid, type: 'organization', name: full, props: {}, span: sp, reason: '原文：' + partyMatch[0] });
    push({ subject: personId, predicate: 'memberOf', object: pid, span: sp, reason: '原文：' + partyMatch[0] });
    if (full !== short) {
      warnings.push({
        code: 'org-name-expanded',
        message: `组织名「${short}」展开为「${full}」——若展开有误请修正`,
      });
    }
  } else {
    warnings.push({ code: 'no-party', message: '未找到党派' });
  }

  // ---------------------------------------------------------------- 职务
  //
  // 「现任十四届全国政协副主席，致公党中央主席。」
  const postMatch = text.match(/现任([^。\n]+)[。]/);
  if (postMatch) {
    const posts = parsePosts(postMatch[1]);
    let searchFrom = text.indexOf(postMatch[1]);
    for (const p of posts) {
      if (!p.org) {
        // 没有可识别的组织前缀。不猜，记 WARN。
        warnings.push({ code: 'post-no-org', message: `职务「${p.role}」找不到所属组织，已跳过` });
        continue;
      }
      const full = normalizeOrg(p.org);
      const pid = orgId(full);
      const sp = spanOf(text, p.raw, searchFrom);
      if (sp) searchFrom = sp.end;

      if (!entities.some((e) => e.id === pid)) {
        entities.push({ id: pid, type: 'organization', name: full, props: {}, span: sp, reason: '原文职务所属组织' });
      }
      push({
        subject: personId,
        predicate: 'memberOf',
        object: pid,
        span: sp,
        reason: `原文：${p.raw}（职务：${p.role}${p.session ? '，' + p.session : ''}）`,
        // role 作为限定词，不是独立谓词——「副主席」说不出具体关系，
        // 它只是 memberOf 的一个属性。
        qualifiers: { role: p.role },
      });
    }
  } else {
    warnings.push({ code: 'no-posts', message: '未找到「现任…」职务句' });
  }

  return { entities, claims, warnings, person: { name: personName, id: personId, span: nameSpan } };
}

module.exports = { extractResume, spanOf, normalizeOrg, orgId, parsePosts };
