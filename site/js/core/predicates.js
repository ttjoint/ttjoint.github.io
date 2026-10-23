/**
 * Predicate primitives — browser half.
 *
 * The canonical definition lives in `src/predicates/registry.js` (Node core).
 * The browser cannot require() it without a build step, so this file mirrors
 * the same table and modifier rules; `data/predicates/registry.json` extends
 * both at runtime. `test/unit/predicates_browser.test.js` pins the invariants
 * that must never diverge:
 *
 *   - modifier prefixes are "inverse" and "negate", spelled identically
 *   - a negated assertion never counts as a positive relation
 *   - 儿子 / 女儿 stay separate primitives with an objectGender constraint, so
 *     a search for 儿子 returns only male inverse-father rows
 *   - every `inverse` target is itself a registered predicate
 *
 * Adding a predicate: add it to BOTH this file and the core registry, then run
 * `npm test` — the parity test fails loudly if the two drift apart.
 */
(function (global) {
  'use strict';

  var MODIFIER = { INVERSE: 'inverse', NEGATE: 'negate', MALE: 'male', FEMALE: 'female' };

  // 中文修饰符 → 内部名。与 core registry 一致。
  var MODIFIER_ALIAS = { '反': 'inverse', '非': 'negate', '男': 'male', '女': 'female' };
  // Qualifier flags, spelled exactly as in the core registry.
  var QUAL = {
    ROLE: 'role', DATES: 'dates', PLACE: 'place', NOTE: 'note',
    AMOUNT: 'amount', SOURCE: 'source',
  };

  /**
   * Built-in primitives, in the same order and with the same inverted pairs as
   * the core table. `objectGender` marks gendered kinship (constrains the object).
   */
  var BUILTIN = [
    { key: "father", label: "父亲", domain: "person", range: "person", inverse: "childOfFather", aliases: ["父","爸爸","家父","父上"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "childOfFather", label: "子女", domain: "person", range: "person", inverse: "father", aliases: ["孩子"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "maleChild", label: "儿子", domain: "person", range: "person", inverse: "father", aliases: ["子","男儿","长子","次子","幼子"], symmetric: false, negatable: true, objectGender: "male", qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "femaleChild", label: "女儿", domain: "person", range: "person", inverse: "father", aliases: ["女","闺女","长女","次女","幼女"], symmetric: false, negatable: true, objectGender: "female", qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "mother", label: "母亲", domain: "person", range: "person", inverse: "childOfMother", aliases: ["母","妈妈","家母"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "childOfMother", label: "子女", domain: "person", range: "person", inverse: "mother", aliases: [], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "spouse", label: "配偶", domain: "person", range: "person", inverse: "spouse", aliases: ["夫妻","配偶","伴侣"], symmetric: true, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "wife", label: "妻", domain: "person", range: "person", inverse: "husband", aliases: ["妻子","太太","夫人","正室"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "husband", label: "夫", domain: "person", range: "person", inverse: "wife", aliases: ["丈夫","先生","夫君"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "sibling", label: "兄弟姐妹", domain: "person", range: "person", inverse: "sibling", aliases: ["手足","同胞"], symmetric: true, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "brother", label: "兄弟", domain: "person", range: "person", inverse: "brother", aliases: ["兄弟","哥","弟"], symmetric: true, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "sister", label: "姊妹", domain: "person", range: "person", inverse: "sister", aliases: ["姊妹","姐妹","姐","妹"], symmetric: true, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    // `kin`（亲属）已删除：与 era/tags 同类的杂物箱。说不出具体关系的就不记。
    { key: "memberOf", label: "所属组织", domain: "person", range: "organization", inverse: "hasMember", aliases: ["任职","供职","供职于","所属","加入"], symmetric: false, negatable: true, qualifiers: [QUAL.ROLE,QUAL.DATES,QUAL.PLACE,QUAL.NOTE,QUAL.SOURCE] },
    { key: "hasMember", label: "成员", domain: "organization", range: "person", inverse: "memberOf", aliases: ["成员","人员"], symmetric: false, negatable: true, qualifiers: [QUAL.ROLE,QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "employer", label: "任职于", domain: "person", range: "organization", inverse: "employee", aliases: ["就职于","工作于","隶属于"], symmetric: false, negatable: true, qualifiers: [QUAL.ROLE,QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "employee", label: "员工", domain: "organization", range: "person", inverse: "employer", aliases: [], symmetric: false, negatable: true, qualifiers: [QUAL.ROLE,QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "parentOrg", label: "上级组织", domain: "organization", range: "organization", inverse: "childOrg", aliases: ["上级","主管部门","隶属","所属上级"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "childOrg", label: "下级组织", domain: "organization", range: "organization", inverse: "parentOrg", aliases: ["下级","子部门","下属机构","下属企业","子公司"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "owns", label: "控股", domain: "organization", range: "organization", inverse: "ownedBy", aliases: ["持股","全资","控股"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.ROLE,QUAL.NOTE,QUAL.SOURCE] },
    { key: "ownedBy", label: "被控股", domain: "organization", range: "organization", inverse: "owns", aliases: [], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.ROLE,QUAL.NOTE,QUAL.SOURCE] },
    { key: "successorOf", label: "前身", domain: "organization", range: "organization", inverse: "predecessorOf", aliases: ["前身","承继"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "predecessorOf", label: "后继", domain: "organization", range: "organization", inverse: "successorOf", aliases: ["后继","沿革"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "participantIn", label: "参与事件", domain: "person", range: "event", inverse: "hasParticipant", aliases: ["参与","参加","参战"], symmetric: false, negatable: true, qualifiers: [QUAL.ROLE,QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "hasParticipant", label: "参与人物", domain: "event", range: "person", inverse: "participantIn", aliases: [], symmetric: false, negatable: true, qualifiers: [QUAL.ROLE,QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "eventAt", label: "发生地", domain: "event", range: "organization", inverse: "hostsEvent", aliases: ["地点","发生地"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "hostsEvent", label: "相关事件", domain: "organization", range: "event", inverse: "eventAt", aliases: [], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "precededBy", label: "前置事件", domain: "event", range: "event", inverse: "followedBy", aliases: ["前因"], symmetric: false, negatable: false, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "followedBy", label: "后续事件", domain: "event", range: "event", inverse: "precededBy", aliases: ["后果"], symmetric: false, negatable: false, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "teacherOf", label: "老师", domain: "person", range: "person", inverse: "studentOf", aliases: ["师","老师","业师","座师"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "studentOf", label: "学生", domain: "person", range: "person", inverse: "teacherOf", aliases: ["学生","门生","弟子"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "colleague", label: "同僚", domain: "person", range: "person", inverse: "colleague", aliases: ["同事","同僚","同官"], symmetric: true, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "friend", label: "朋友", domain: "person", range: "person", inverse: "friend", aliases: ["友","朋友","好友","友人"], symmetric: true, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "recommendedBy", label: "荐举人", domain: "person", range: "person", inverse: "recommended", aliases: ["举荐","推荐","保举"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "recommended", label: "被荐举人", domain: "person", range: "person", inverse: "recommendedBy", aliases: [], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "gender", label: "性别", domain: "person", range: "literal", aliases: ["性别"], symmetric: false, negatable: true, qualifiers: [QUAL.SOURCE] },
    { key: "ethnicity", label: "民族", domain: "person", range: "literal", aliases: ["民族"], symmetric: false, negatable: true, qualifiers: [QUAL.SOURCE] },
    { key: "education", label: "学历", domain: "person", range: "literal", aliases: ["学历","学位","教育"], symmetric: false, negatable: true, qualifiers: [QUAL.SOURCE] },
    { key: "birthDate", label: "出生时间", domain: "person", range: "literal", aliases: ["出生年月","出生日期","生辰"], symmetric: false, negatable: true, qualifiers: [QUAL.SOURCE] },
    // `era` was removed: it was a derived band (97.5% of its edges read 隋唐及以后,
    // meaning "unknown"). Fuzzy dates belong on birthDate/deathDate per design §2.6.
    { key: "deathDate", label: "逝世时间", domain: "person", range: "literal", aliases: ["逝世时间","卒年","去世"], symmetric: false, negatable: true, qualifiers: [QUAL.SOURCE] },
    { key: "existedDuring", label: "存在时间", domain: "organization", range: "literal", aliases: ["存在时间","存续期间"], symmetric: false, negatable: false, qualifiers: [QUAL.SOURCE] },
    { key: "bornAt", label: "出生地", domain: "person", range: "organization", inverse: "birthplaceOf", aliases: ["出生地","生于","出生於"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "birthplaceOf", label: "出生名人", domain: "organization", range: "person", inverse: "bornAt", aliases: [], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "residedAt", label: "户籍", domain: "person", range: "organization", inverse: "residentHere", aliases: ["户籍","籍贯","居住地","居於"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "residentHere", label: "居民", domain: "organization", range: "person", inverse: "residedAt", aliases: [], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "foundedOn", label: "开业日期", domain: "organization", range: "literal", aliases: ["成立","开业","创办","始建于"], symmetric: false, negatable: false, qualifiers: [QUAL.NOTE,QUAL.SOURCE] },
    { key: "dissolvedOn", label: "解散日期", domain: "organization", range: "literal", aliases: ["解散","撤销","停业"], symmetric: false, negatable: false, qualifiers: [QUAL.NOTE,QUAL.SOURCE] },
    { key: "publisher", label: "出版方", domain: "thing", range: "organization", inverse: "publishedBy", aliases: ["出版方","出版者","出版单位"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "publishedBy", label: "出版", domain: "organization", range: "thing", inverse: "publisher", aliases: ["出版","刊行","发行"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "author", label: "作者", domain: "thing", range: "person|organization", inverse: "authored", aliases: ["作者","撰写者","著者","编者"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.ROLE,QUAL.NOTE,QUAL.SOURCE] },
    { key: "authored", label: "著作", domain: "person|organization", range: "thing", inverse: "author", aliases: ["著作","撰写","编著","编写"], symmetric: false, negatable: true, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
    { key: "about", label: "主题", domain: "thing", range: "person|organization|event|thing", inverse: "topicOf", aliases: ["主题","关于","记述"], symmetric: false, negatable: true, qualifiers: [QUAL.NOTE,QUAL.SOURCE] },
    { key: "topicOf", label: "相关文献", domain: "person|organization|event|thing", range: "thing", inverse: "about", aliases: [], symmetric: false, negatable: true, qualifiers: [QUAL.NOTE,QUAL.SOURCE] },
    { key: "documentedBy", label: "见于", domain: "person|thing|organization|event", range: "evidence", inverse: "documents", aliases: ["见于","记载于","出处","据"], symmetric: false, negatable: false, qualifiers: [QUAL.NOTE,QUAL.SOURCE] },
    { key: "documents", label: "记载", domain: "evidence", range: "person|thing|organization|event", inverse: "documentedBy", aliases: ["记载","记录"], symmetric: false, negatable: false, qualifiers: [QUAL.ROLE,QUAL.NOTE,QUAL.SOURCE] },
    { key: "carriedBy", label: "载于", domain: "evidence", range: "thing|organization", inverse: "carries", aliases: ["载于","刊于","收录于","发表于"], symmetric: false, negatable: false, qualifiers: [QUAL.NOTE,QUAL.SOURCE] },
    { key: "carries", label: "载有", domain: "thing|organization", range: "evidence", inverse: "carriedBy", aliases: ["载有","刊载","收录"], symmetric: false, negatable: false, qualifiers: [QUAL.DATES,QUAL.NOTE,QUAL.SOURCE] },
  ];

  var PREDICATES = {};
  var aliasIndex = {};

  function normLabel(s) {
    return String(s || '').replace(/[\s:：·]/g, '').trim();
  }

  /**
   * Index one predicate's surface forms.
   *
   * Two passes so the result does not depend on table order the way the core's
   * first-writer-wins loop does: every predicate first claims its own key and
   * label, then aliases are added only for words still unclaimed. The core
   * merges a conflicting alias onto the *first declared* predicate, which for
   * the built-in table is the one declared earlier, so ordering stays stable.
   */
  function register(def) {
    if (!def || !def.key) return;
    var entry = Object.assign({ aliases: [], qualifiers: [], negatable: true }, def);
    PREDICATES[entry.key] = entry;
  }

  BUILTIN.forEach(register);

  BUILTIN.forEach(function (def) {
    [def.key, def.label].forEach(function (n) {
      var k = normLabel(n);
      if (k && !aliasIndex[k]) aliasIndex[k] = def.key;
    });
  });

  BUILTIN.forEach(function (def) {
    (def.aliases || []).forEach(function (a) {
      var k = normLabel(a);
      if (k && !aliasIndex[k]) aliasIndex[k] = def.key;
    });
  });

  /**
   * Split a stored key like "father/negate/inverse" into its base and modifiers.
   * Unknown pieces are reported in `unknown` rather than silently dropped, so
   * validation can surface typos instead of inventing predicates.
   */
  function splitModifiers(raw) {
    var known = [MODIFIER.INVERSE, MODIFIER.NEGATE, MODIFIER.MALE, MODIFIER.FEMALE];
    var parts = String(raw == null ? '' : raw).split('/').map(function (s) { return s.trim(); });
    var base = parts.shift() || '';
    var mods = [];
    var unknown = [];
    parts.forEach(function (p) {
      if (!p) return;
      // 中文写法与内部英文名等价，与 src/predicates/registry.js 保持一致。
      var canonical = MODIFIER_ALIAS[p] || p;
      if (known.indexOf(canonical) < 0) { unknown.push(p); return; }
      if (mods.indexOf(canonical) < 0) mods.push(canonical);
    });
    return { base: base, mods: mods, unknown: unknown };
  }

  function baseKey(raw) { return splitModifiers(raw).base; }

  function modifier(rawKey, mod) {
    if (!mod) return rawKey;
    var parts = splitModifiers(rawKey);
    var mods = parts.mods.slice();
    if (mods.indexOf(mod) < 0) mods.push(mod);
    return [parts.base].concat(mods).join('/');
  }

  function isInversed(rawKey) { return splitModifiers(rawKey).mods.indexOf(MODIFIER.INVERSE) >= 0; }
  function isNegated(rawKey) { return splitModifiers(rawKey).mods.indexOf(MODIFIER.NEGATE) >= 0; }

  /** Resolve a user-facing word ("儿子", "任职") to its canonical base key. */
  function resolve(word) {
    if (!word) return null;
    return aliasIndex[normLabel(word)] || null;
  }

  /**
   * Look up a predicate by primitive key OR by any of its surface forms, so
   * callers holding stored data ('父亲', '所属组织') do not have to resolve first.
   */
  function def(rawKey) {
    if (rawKey == null || rawKey === '') return null;
    var base = splitModifiers(rawKey).base;
    return PREDICATES[base] || PREDICATES[aliasIndex[normLabel(base)]] || null;
  }

  /** Display label for a stored key, including 反向 / 否定 markers. */
  function label(rawKey) {
    var parts = splitModifiers(rawKey);
    var d = PREDICATES[parts.base];
    var text = d ? d.label : parts.base;
    if (parts.mods.indexOf(MODIFIER.INVERSE) >= 0) text += '（反）';
    if (parts.mods.indexOf(MODIFIER.NEGATE) >= 0) text += '（否）';
    return text;
  }

  function inverseOf(rawKey) {
    var d = def(rawKey);
    return d && d.inverse ? d.inverse : null;
  }

  /**
   * Whether an assertion with this key can describe a subject of `gender`.
   * maleChild / femaleChild carry objectGender so 儿子 / 女儿 stay searchable
   * without exploding the predicate table. The constraint is on the OBJECT:
   * 「A --maleChild--> B」读作「A 的儿子是 B」—— B 是男，不是 A。
   */
  function matchesGender(rawKey, gender) {
    var d = def(rawKey);
    if (!d || !d.objectGender) return true;
    if (!gender) return false;
    return d.objectGender === gender;
  }

  global.HMPredicates = {
    MODIFIER: MODIFIER,
    QUAL: QUAL,
    BUILTIN: BUILTIN,
    PREDICATES: PREDICATES,
    splitModifiers: splitModifiers,
    baseKey: baseKey,
    modifier: modifier,
    isInversed: isInversed,
    isNegated: isNegated,
    resolve: resolve,
    def: def,
    label: label,
    inverseOf: inverseOf,
    matchesGender: matchesGender,
    normLabel: normLabel,
    /** Merge predicates loaded from data/predicates/registry.json at runtime. */
    extend: function (list) {
      (list || []).forEach(function (def) {
        register(def);
        [def.key, def.label].concat(def.aliases || []).forEach(function (n) {
          var k = normLabel(n);
          if (k && !aliasIndex[k]) aliasIndex[k] = def.key;
        });
      });
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
