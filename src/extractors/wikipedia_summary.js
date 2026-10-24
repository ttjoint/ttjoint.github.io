// 维基百科人物摘要抽取器。
//
// ## 与 web_resume 抽取器的区别
//
// web_resume 处理的是中国官方简历，格式高度一致（「X，男，汉族，1955年7月生，
// 安徽怀宁人」）。维基摘要的自由文本形态完全不同：
//
//   苏轼（1037年1月8日—1101年8月24日），字子瞻，一字和仲，号东坡居士，
//   眉州眉山（今四川省眉山市）人，北宋文學家、政治家、藝術家。
//
// 所以不复用 web_resume 的正则，另写一套。但**谓词完全复用已注册的**
// （birthDate/deathDate/bornAt），不新增——这是本项目的硬约束：
// 不为一个来源造新谓词。
//
// ## 为什么要抽「日」精度
//
// CBDB 的生年只到年（1036），维基到日（1037年1月8日）。表面看是冲突，
// 实际是**精度不同**：北宋「景祐三年十二月十九日」按公历已是 1037 年。
// 两个都对。
//
// 所以抽取时必须保留精度信息（precision: 'day' | 'year'），否则
// 下游无法区分「两个来源说法不同」和「一个来源比另一个更精确」。
// 把 1037-01-08 压成 1037 再和 CBDB 的 1036 比，就成了假冲突。
//
// ## 已知局限
//
// 维基摘要有大量自由变体（「生年不详」「约 1037 年」「一說 1036 年」）。
// 本抽取器只处理明确断言，其余记 warning。宁可少抽，不可猜。

'use strict';

const { parseYearMonth, pointRange, jdnToYear } = require('../time/julian.js');

/** 「X（生卒）」里的生卒段。中文维基常见分隔符：—、－、-、～、~、至 */
const LIFESPAN_RE = /[（(]\s*([^（）()]{4,40}?)\s*(?:—|－|–|〜|～|~|至)\s*([^（）()]{2,30}?)\s*[）)]/;

/**
 * 名字：摘要开头到第一个「（」之前。
 *
 * 只允许汉字（含「·」用于少数民族名）。早先的 `[^\s（(，,。]{2,12}`
 * 会把拉丁字母吃进来——实测维基有条目的原文是「程顥hào（1032年—1085年）」，
 * 数据源本身混入了拼音标注，抽出的人名成了「程顥hào」。
 * 数据源脏不能怪它，但抽取器必须挡住：人名里不该有拉丁字母。
 */
const NAME_RE = /^([一-龥·]{2,12})/;

/**
 * 从摘要文本抽取。
 *
 * @param {string} text  维基摘要正文
 * @param {object} meta  { rawRef, title }
 * @returns {{entities:Array, claims:Array, warnings:Array, person:object|null}}
 */
function extractWikipediaSummary(text, meta) {
  const entities = [];
  const claims = [];
  const warnings = [];
  const rawRef = meta.rawRef;
  const body = String(text || '').trim();

  // 消歧义页不是人物条目。
  //
  // 实测：「張載可以指」——这是维基的消歧义页开头，被当成人名抽出来，
  // 建了一个叫「張載可以指」的实体。这类页面必须挡住，否则脏数据进库。
  if (/可以指|可能指|也可指|是[一几]?个?消歧义/.test(body.slice(0, 40))) {
    warnings.push({ code: 'disambiguation', message: '消歧义页，不是人物条目' });
    return { entities, claims, warnings, person: null };
  }

  const nameMatch = body.match(NAME_RE);
  if (!nameMatch) {
    warnings.push({ code: 'no-name', message: '摘要开头不是人名' });
    return { entities, claims, warnings, person: null };
  }
  // 「張載可以指」这类即使没被上面的规则挡住，名字本身也不该含「可以指」
  if (/可以指|可能指/.test(nameMatch[1])) {
    warnings.push({ code: 'disambiguation', message: '消歧义页，不是人物条目' });
    return { entities, claims, warnings, person: null };
  }
  const personName = nameMatch[1];
  const nameSpan = { start: body.indexOf(personName), end: body.indexOf(personName) + personName.length };

  const personId = 'person:wikipedia-' + Buffer.from(personName, 'utf8').toString('hex').slice(0, 12);

  // ---------------------------------------------------------------- 生卒
  //
  // 关键：保留精度。1037年1月8日 与 1037 不是同一个断言，
  // 前者是精确日期，后者是整年区间。压成同一种会让下游算出假冲突。
  const life = body.match(LIFESPAN_RE);
  if (life) {
    const birthText = life[1].trim();
    const deathText = life[2].trim();

    const birth = parseYearMonth(birthText);
    if (birth) {
      const range = pointRange(birth, { source: 'wikipedia' });
      const at = body.indexOf(birthText);
      claims.push({
        subject: personId,
        predicate: 'birthDate',
        // 客体存原文，不存归一化数字：读者要看的是「1037年1月8日」，
        // 不是 JDN。归一化留给时间列。
        object: birthText,
        span: { start: at, end: at + birthText.length },
        reason: '维基摘要生卒段：' + birthText,
        // 精度随断言走，下游据此判断能否与年粒度来源直接比较。
        precision: birth.day ? 'day' : birth.month ? 'month' : 'year',
        jdn: range ? range.start : null,
        jdnEnd: range ? range.end : null,
      });
    } else {
      warnings.push({ code: 'birth-unparsed', message: `生年无法解析：${birthText}` });
    }

    const death = parseYearMonth(deathText);
    if (death) {
      const range = pointRange(death, { source: 'wikipedia' });
      const at = body.indexOf(deathText);
      claims.push({
        subject: personId,
        predicate: 'deathDate',
        object: deathText,
        span: { start: at, end: at + deathText.length },
        reason: '维基摘要生卒段：' + deathText,
        precision: death.day ? 'day' : death.month ? 'month' : 'year',
        jdn: range ? range.start : null,
        jdnEnd: range ? range.end : null,
      });
    } else {
      warnings.push({ code: 'death-unparsed', message: `卒年无法解析：${deathText}` });
    }
  } else {
    // 「生卒年不详」是合法状态，不是错误——但也不能编造。
    warnings.push({ code: 'no-lifespan', message: '摘要里没有生卒段' });
  }

  // ---------------------------------------------------------------- 籍贯
  //
  // 「眉州眉山（今四川省眉山市）人」→ bornAt 眉山。
  //
  // 取「（今…）」之前的那个地名，因为括号里是现代对应地名，
  // 括号外是当时的行政区划——后者才是这个人「籍贯」的原始表述。
  // 籍贯必须紧贴「（今…）」结构，否则会误抓。
  //
  // 实测反例：「号东坡居士、鐵冠道人，眉州眉山（今四川省眉山市）人」
  // ——宽松的 `([^，,。（(]{2,12}?)人[，,。]` 会从上一个逗号开始抓，
  // 得到「号东坡居士、鐵冠道」这种垃圾。
  //
  // 正确做法：先定位「（今…）」或「人」，再向左取**最后一个**逗号
  // 之后的内容，并且排除以「号/字/一字/谥/封/世称」开头的片段
  // （那些是别号，不是籍贯）。
  const origin = body.match(/([^，,。；（(]{2,14}?)(?:（[^）]*）)?人[，,。；]/);
  const placeRaw = origin ? origin[1].trim() : null;
  const isAlias = placeRaw && /^(号|號|字|一字|谥|諡|封|世称|世稱|又号|又號|自号|自號|别号|別號|晚号|晚號)/.test(placeRaw);
  if (placeRaw && !isAlias) {
    const place = placeRaw;
    const at = body.indexOf(place);
    claims.push({
      subject: personId,
      predicate: 'bornAt',
      object: place,
      span: { start: at, end: at + place.length + 1 },
      reason: '维基摘要：' + place + '人',
    });
    // 合法类型前缀只有 person/organization/event/thing/evidence。
    // 籍贯用 thing（一个地名实体），不是自造 place 前缀。
    entities.push({ id: 'thing:' + hashId(place), type: 'thing', name: place, props: { kind: 'place' },
      span: { start: at, end: at + place.length } });
  } else if (isAlias) {
    warnings.push({ code: 'origin-is-alias', message: `疑似别号不是籍贯：${placeRaw}` });
  } else {
    warnings.push({ code: 'no-origin', message: '未找到籍贯' });
  }

  entities.unshift({ id: personId, type: 'person', name: personName, props: {} });

  return {
    entities,
    claims,
    warnings,
    person: { name: personName, span: nameSpan, id: personId },
  };
}

function hashId(name) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update('wikipedia:' + name).digest('hex').slice(0, 12);
}

module.exports = { extractWikipediaSummary, LIFESPAN_RE };
