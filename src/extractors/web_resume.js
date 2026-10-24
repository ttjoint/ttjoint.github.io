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
  // 政协 / 人大 / 政府
  '全国政协', '全国人大常委会', '全国人大', '国务院',
  // 党派（全称优先于简称，靠下面的「最长前缀优先」保证）
  '中国共产党中央委员会', '中共中央', '中国共产党',
  '中国致公党', '致公党', '中国国民党革命委员会', '民革',
  '中国民主同盟', '民盟', '中国民主建国会', '民建',
  '中国民主促进会', '民进', '中国农工民主党', '农工党',
  '九三学社', '台湾民主自治同盟', '台盟',
  // 国家机构
  '中华人民共和国中央军事委员会', '中华人民共和国主席',
  '中央军事委员会', '国家监察委员会', '最高人民法院', '最高人民检察院',
  // 党中央部门与专门委员会
  //
  // 这些在简历里极常见（「中央政治局委员」「中央组织部部长」）。
  // 不列入白名单就只能整个跳过——79 条 post-no-org 全出自这里，
  // 意味着「现任职务」这个最关键的字段在 73 个页面里大半丢失。
  '中央政治局常务委员会', '中央政治局', '中央书记处',
  '中央纪律检查委员会', '中央全面深化改革委员会', '中央外事工作委员会',
  '中央财经委员会', '中央国家安全委员会', '中央网络安全和信息化委员会',
  '中央办公厅', '中央组织部', '中央宣传部', '中央统战部',
  '中央政法委员会', '中央和国家机关工作委员会', '中央党校',
  // 地方党委
  '北京市委', '上海市委', '天津市委', '重庆市委', '广东省委',
  // 部委
  '外交部', '国防部', '教育部', '科学技术部', '工业和信息化部',
  '国家民族事务委员会', '公安部', '国家安全部', '民政部', '司法部',
  '财政部', '人力资源和社会保障部', '自然资源部', '生态环境部',
  '住房和城乡建设部', '交通运输部', '水利部', '农业农村部',
  '商务部', '文化和旅游部', '国家卫生健康委员会', '退役军人事务部',
  '应急管理部', '中国人民银行', '审计署',
  // 高校
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
    // 「中共二十届中央委员」的届次在「中共」之后，不在开头。
    // 只匹配开头的 `^第?X届` 会漏掉这一大类（实测 13 条，最高频）。
    //
    // 但「中共」本身是党派前缀，不能整个吃掉——它要留在组织名里，
    // 因为「中共中央委员会」是完整组织名。所以拆成：
    //   前缀（可选） + 届次 + 余下
    const partyLead = s.match(/^(中共|中国共产党)/);
    const lead = partyLead ? partyLead[0] : '';
    const afterLead = s.slice(lead.length);
    const sessionMatch = afterLead.match(/^第?[一二三四五六七八九十百\d]+届/);
    const session = sessionMatch ? sessionMatch[0] : '';
    // 还原成「中共 + 余下」的形式（去掉届次），保持组织名前缀可匹配。
    const rest = lead + (session ? afterLead.slice(session.length) : afterLead);

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
  //
  // 但页面形态是异构的，实测至少两种：
  //
  //   政协网  蒋作君简历
  //   人民网  习近平同志简历--资料中心--人民网
  //
  // 严格匹配 `^(.+?)简历$` 只认第一种，第二种被判「no-name」，
  // 整页零抽取——数据抓到了却抽不出来，而且只是 warning 不报错。
  //
  // 放宽：允许「同志」后缀，允许「简历」后面还有 `--栏目--站名`
  // 这种标题装饰。
  const firstLine = text.split('\n')[0].trim();
  // 剥掉标题装饰（`--资料中心--人民网`、`_人民网`、` - 某某网`）
  const titleCore = firstLine.split(/\s*(?:--|_|\|)\s*/)[0].trim() || firstLine;
  const nameMatch = titleCore.match(/^(.+?)简历$/)
    || titleCore.match(/^(.+?)同志简历$/)
    // 兜底：取「简历」前的连续中文名（允许「·」用于少数民族名）
    || titleCore.match(/^([\u4e00-\u9fa5·]{2,8})(?:同志)?简历/);
  if (!nameMatch) {
    warnings.push({ code: 'no-name', message: `首行不是「X简历」格式：${firstLine}` });
    return { entities, claims, warnings, person: null };
  }
  // 去掉可能残留的「同志」
  const personName = nameMatch[1].replace(/同志$/, '');
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
  //
  // 注意：这些是**现任**职务，原文没说何时就任。所以 memberOf 的 dates
  // 留空——「现任」是状态描述，不是起点。
  //
  // 不把「1974年3月参加工作」当作任何 memberOf 的起始时间：那是参加工作
  // 的日期，不是加入党派或就任该职的日期。用它填 dates 就是编造。
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
