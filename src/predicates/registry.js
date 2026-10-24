'use strict';
/**
 * Predicate primitives (关系词原语).
 *
 * Every edge in the graph is an assertion:
 *
 *     (predicate, subject, object, qualifiers)
 *
 * A predicate is NOT a free-text label. It is a registered primitive with:
 *   key         canonical id, e.g. 'father'
 *   label       default display label, e.g. '父亲'
 *   domain      subject type: person | thing | organization | event | evidence
 *   range       object type:   person | thing | organization | event | evidence | literal
 *
 * `domain` and `range` accept several types separated by `|` when a predicate
 * is valid for more than one (e.g. `author` takes a person *or* an organisation).
 * `literal` is the escape hatch for assertions whose object is text rather than
 * a node reference.
 *   inverse     key of the reverse predicate (父亲 <-> 子女)
 *   aliases     synonyms folded onto this primitive (父, 爸爸, 家父 ...)
 *   symmetric   显式声明，不再从 `inverse === key` 推导
 *   negatable   whether a /非 assertion is meaningful
 *   objectGender 客体性别约束（「A 的儿子是 B」→ B 是男）
 *   qualifiers  which extra fields are allowed: role, dates, place, note
 *
 * ## 「inverse 为何保留」——§8.5 曾结论删除，实测后推翻
 *
 * `inverse` 不只是别名索引，它让「查 father」能同时召回 `childOfFather` 的边
 * （`Graph.edgesByPredicate` 与 `Query._collectRows` 都靠它）。删掉字段就必须
 * 先建一套等价的 /反 展开机制，否则每次查询会静默漏掉一半断言。
 *
 * 而 §8.5 预期的收益（谓词数减半）在本项目不成立：实测 57 个谓词里只有 11 个
 * 有边，其余 46 个是能力声明（组织/事件/物的关系尚未导入），不是重复定义。
 * 在零边的谓词上做合并只减少数量，不减少真实复杂度。
 *
 * 所以：**`inverse` 保留，/反 修饰符保留为查询时机制，两者互补而非互斥。**
 * 真正删掉的是 `subjectGender`/`genderFamily`——它们从未生效且语义指错方向。
 *
 * 中文写法等价（`splitModifiers` 归一）：`父亲/反` `父亲/非` `兄弟/男` `兄弟/女`。
 *
 * Modifiers are prefixes on the predicate key, never separate predicates:
 *   father          a 的父亲是 b          (a, father, b)
 *   father/inverse  a 的子女含 b          (b, inverse(father), a)
 *   father/negate   a 的父亲不是 b        (a, negate(father), b)  — explicitly false
 *
 * ## 方向语义：从属视角
 *
 * `label` 与边的读法是**同一个视角**：`A --father--> B` 读作
 * 「**A 的父亲是 B**」，与 label「父亲」一致。
 *
 * 曾有一版注释写成「a 是 b 的父亲」（语言学主谓），与实际数据相反，
 * 导致 P5-5a 修复时误判 `split_relational_names.js` 方向写反。
 * 实证来自 CBDB 源数据自身的记法：
 *
 *     30148 朱元璋 --W---> 118451 馬氏(朱元璋妻)  female=1
 *     30148 朱元璋 --S1--> 67200 朱標           female=0（长子）
 *
 * 即 `c_personid --c_kinrel--> c_kin_id` 读作「c_personid 的 c_kinrel 是 c_kin_id」。
 * 任何新谓词都必须按这个视角定义读法。
 *
 * Gender-specific kinship is expressed with gendered object constraints rather
 * than exploding the predicate table, so that searching "儿子" resolves to
 * (negate-aware) "inverse of father" restricted to male subjects.
 */

const MODIFIER = Object.freeze({
  INVERSE: 'inverse',
  NEGATE: 'negate',
  MALE: 'male',
  FEMALE: 'female',
});

/**
 * 中文修饰符 → 内部名。
 *
 * 用户在搜索框里输「父亲/非」「兄弟/女」，不该要求他打英文。
 * 英文名仍保留为唯一内部表示，因为数据里已经存了 `father/negate` 这类 key。
 */
const MODIFIER_ALIAS = Object.freeze({
  '反': MODIFIER.INVERSE,
  '非': MODIFIER.NEGATE,
  '男': MODIFIER.MALE,
  '女': MODIFIER.FEMALE,
});

/** Qualifier flags a predicate may carry. */
const QUAL = Object.freeze({
  ROLE: 'role',
  DATES: 'dates',
  PLACE: 'place',
  NOTE: 'note',
  SOURCE: 'source',
});

/**
 * Built-in registry. Additional predicates can be merged in from
 * data/predicates/registry.json without touching code.
 */
const BUILTIN = [
  // ---------- kinship: parent/child ----------
  {
    key: 'father', label: '父亲', domain: 'person', range: 'person',
    temporality: 'persistent',
    inverse: 'childOfFather', aliases: ['父', '爸爸', '家父', '父上'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'childOfFather', label: '子女', domain: 'person', range: 'person',
    temporality: 'persistent',
    inverse: 'father', aliases: ['孩子'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
    // Deliberately does NOT claim 儿子/女儿: those resolve to the gender-specific
    // primitives below so that a lone "儿子" query stays gender-correct.
  },
  {
    key: 'maleChild', label: '儿子', domain: 'person', range: 'person',
    temporality: 'persistent',
    inverse: 'father', aliases: ['子', '男儿', '长子', '次子', '幼子'],
    negatable: true, objectGender: 'male',
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
    // 「A --maleChild--> B」读作「A 的儿子是 B」——**B 是男**。
    //
    // 曾经写成 `subjectGender: 'male'`，注释还说「constraint on the SUBJECT
    // of this edge (the child)」——但**主体不是孩子**，主体是父。
    // 这个错误从未生效（`checkAssertion` 不校验性别），只是持续误导。
    // P5-5c 改名为 `objectGender` 并指回客体。
  },
  {
    key: 'femaleChild', label: '女儿', domain: 'person', range: 'person',
    temporality: 'persistent',
    inverse: 'father', aliases: ['女', '闺女', '长女', '次女', '幼女'],
    negatable: true, objectGender: 'female',
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'mother', label: '母亲', domain: 'person', range: 'person',
    temporality: 'persistent',
    inverse: 'childOfMother', aliases: ['母', '妈妈', '家母'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'childOfMother', label: '子女', domain: 'person', range: 'person',
    temporality: 'persistent',
    inverse: 'mother', aliases: [],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },

  // ---------- kinship: spouse and siblings ----------
  {
    key: 'spouse', label: '配偶', domain: 'person', range: 'person',
    temporality: 'concurrent',
    inverse: 'spouse', symmetric: true, aliases: ['夫妻', '配偶', '伴侣'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  // ---------- kinship: 6 個基礎原語（見 docs §8.4）----------
  //
  // 為什麼需要 husband/wife 而不是只有 symmetric 的 spouse：
  // 邊的讀法跟 label 同一個視角。「A --wife--> B」讀作「A 的妻是 B」，
  // 主体必须是夫、客体是妻。衹有 symmetric 的 spouse 表達不了這個区分，
  // 只能靠 `{role:'wife'}` 屬性攜帶——而那個屬性曾經被寫反過（P5-5b）。
  // 兩端性別相反的邊（佔 98.7%）拆成 husband/wife；同性或性別未知的邊
  // 留在 spouse 上，它不是臨時狀態，同性配偶本就該用它。
  {
    key: 'wife', label: '妻', domain: 'person', range: 'person',
    temporality: 'concurrent',
    inverse: 'husband', aliases: ['妻子', '太太', '夫人', '正室'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'husband', label: '夫', domain: 'person', range: 'person',
    temporality: 'concurrent',
    inverse: 'wife', aliases: ['丈夫', '先生', '夫君'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'sibling', label: '兄弟姐妹', domain: 'person', range: 'person',
    temporality: 'persistent',
    inverse: 'sibling', symmetric: true, aliases: ['手足', '同胞'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  // brother/sister 跟 sibling 的区分看**客体**性別：
  // 「A --brother--> B」讀作「A 的兄弟是 B」，B 必须是男。
  {
    key: 'brother', label: '兄弟', domain: 'person', range: 'person',
    temporality: 'persistent',
    inverse: 'brother', symmetric: true, aliases: ['兄弟', '哥', '弟'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'sister', label: '姊妹', domain: 'person', range: 'person',
    temporality: 'persistent',
    inverse: 'sister', symmetric: true, aliases: ['姊妹', '姐妹', '姐', '妹'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  // `elderBrother` / `youngerSibling` 已删除（P5-5b）。两个理由：
  //  1. 它们的 `subjectGender` 看的是**主体**，而 label「兄」说的是**客体**——
  //     语义不自洽（例如男甲的兄可以是女吗？该字段无法回答）。
  //  2. 它们的全部表达能力已被 `brother`/`sister` + `{order:'elder'|'younger'}`
  //     覆盖，保留只会制造别名冲突（`弟`/`妹` 曾同时被两边声明）。

  // `kin`（亲属）已删除。它是与 `era`、`tags` 同类的杂物箱：
  //
  //   宾语说不出具体关系时往这里塞一个「亲属」，读起来像一条事实，
  //   实际什么也没说。CBDB 的 `A`（姻親）码就是典型：334 行「姻親」
  //   落成了 299 条 `kin` 边，而源数据自己都承认不知道是哪种姻亲。
  //
  // 设计 §8.1 的原则是「有称呼就用称呼」：父亲、母亲、兄、弟、夫、妻、
  // 子、女——每一个都是独立的谓词。说不出的就不记。
  //
  // 复合路径（`SS`=孫、`WF`=岳父）按 §8.6 由单步边组合得出，也不靠 `kin` 兜底。

  // ---------- person -> organization ----------
  {
    key: 'memberOf', label: '所属组织', domain: 'person', range: 'organization',
    temporality: 'concurrent',
    inverse: 'hasMember', aliases: ['任职', '供职', '供职于', '所属', '加入'],
    negatable: true, aliasesNote: '任职 uses dates qualifier',
    qualifiers: [QUAL.ROLE, QUAL.DATES, QUAL.PLACE, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'hasMember', label: '成员', domain: 'organization', range: 'person',
    temporality: 'concurrent',
    inverse: 'memberOf', aliases: ['成员', '人员'],
    negatable: true, qualifiers: [QUAL.ROLE, QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'employer', label: '任职于', domain: 'person', range: 'organization',
    temporality: 'concurrent',
    inverse: 'employee', aliases: ['就职于', '工作于', '隶属于'],
    negatable: true, qualifiers: [QUAL.ROLE, QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'employee', label: '员工', domain: 'organization', range: 'person',
    temporality: 'concurrent',
    inverse: 'employer', aliases: [], negatable: true,
    qualifiers: [QUAL.ROLE, QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },

  // ---------- organization hierarchy ----------
  {
    key: 'parentOrg', label: '上级组织', domain: 'organization', range: 'organization',
    temporality: 'concurrent',
    inverse: 'childOrg', aliases: ['上级', '主管部门', '隶属', '所属上级'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'childOrg', label: '下级组织', domain: 'organization', range: 'organization',
    temporality: 'concurrent',
    inverse: 'parentOrg', aliases: ['下级', '子部门', '下属机构', '下属企业', '子公司'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'owns', label: '控股', domain: 'organization', range: 'organization',
    temporality: 'concurrent',
    inverse: 'ownedBy', aliases: ['持股', '全资', '控股'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.ROLE, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'ownedBy', label: '被控股', domain: 'organization', range: 'organization',
    temporality: 'concurrent',
    inverse: 'owns', aliases: [], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.ROLE, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'successorOf', label: '前身', domain: 'organization', range: 'organization',
    temporality: 'concurrent',
    inverse: 'predecessorOf', aliases: ['前身', '承继'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'predecessorOf', label: '后继', domain: 'organization', range: 'organization',
    temporality: 'concurrent',
    inverse: 'successorOf', aliases: ['后继', '沿革'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },

  // ---------- events ----------
  {
    key: 'participantIn', label: '参与事件', domain: 'person', range: 'event',
    temporality: 'concurrent',
    inverse: 'hasParticipant', aliases: ['参与', '参加', '参战'],
    negatable: true, qualifiers: [QUAL.ROLE, QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'hasParticipant', label: '参与人物', domain: 'event', range: 'person',
    temporality: 'concurrent',
    inverse: 'participantIn', aliases: [], negatable: true,
    qualifiers: [QUAL.ROLE, QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'eventAt', label: '发生地', domain: 'event', range: 'organization',
    temporality: 'concurrent',
    inverse: 'hostsEvent', aliases: ['地点', '发生地'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'hostsEvent', label: '相关事件', domain: 'organization', range: 'event',
    temporality: 'concurrent',
    inverse: 'eventAt', aliases: [], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'precededBy', label: '前置事件', domain: 'event', range: 'event',
    temporality: 'concurrent',
    inverse: 'followedBy', aliases: ['前因'], negatable: false,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'followedBy', label: '后续事件', domain: 'event', range: 'event',
    temporality: 'concurrent',
    inverse: 'precededBy', aliases: ['后果'], negatable: false,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },

  // ---------- social ----------
  {
    key: 'teacherOf', label: '老师', domain: 'person', range: 'person',
    temporality: 'concurrent',
    inverse: 'studentOf', aliases: ['师', '老师', '业师', '座师'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'studentOf', label: '学生', domain: 'person', range: 'person',
    temporality: 'concurrent',
    inverse: 'teacherOf', aliases: ['学生', '门生', '弟子'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'colleague', label: '同僚', domain: 'person', range: 'person',
    temporality: 'concurrent',
    inverse: 'colleague', symmetric: true, aliases: ['同事', '同僚', '同官'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'friend', label: '朋友', domain: 'person', range: 'person',
    temporality: 'persistent',
    inverse: 'friend', symmetric: true, aliases: ['友', '朋友', '好友', '友人'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'recommendedBy', label: '荐举人', domain: 'person', range: 'person',
    temporality: 'persistent',
    inverse: 'recommended', aliases: ['举荐', '推荐', '保举'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'recommended', label: '被荐举人', domain: 'person', range: 'person',
    temporality: 'persistent',
    inverse: 'recommendedBy', aliases: [], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },

  // ---------- attributes expressed as predicates ----------
  {
    key: 'gender', label: '性别', domain: 'person', range: 'literal',
    temporality: 'attribute',
    aliases: ['性别'], negatable: true, qualifiers: [QUAL.SOURCE],
  },
  {
    key: 'ethnicity', label: '民族', domain: 'person', range: 'literal',
    temporality: 'attribute',
    aliases: ['民族'], negatable: true, qualifiers: [QUAL.SOURCE],
  },
  {
    key: 'education', label: '学历', domain: 'person', range: 'literal',
    temporality: 'attribute',
    aliases: ['学历', '学位', '教育'], negatable: true, qualifiers: [QUAL.SOURCE],
  },
  {
    key: 'birthDate', label: '出生时间', domain: 'person', range: 'literal',
    temporality: 'attribute',
    aliases: ['出生年月', '出生日期', '生辰'], negatable: true, qualifiers: [QUAL.SOURCE],
  },
  {
    // `era` was removed. It carried no primary record of its own: the CBDB importer
    // derived it by banding the year into 先秦/秦/两汉/三国/晋/南北朝/隋唐及以后,
    // and the last band swallowed everything from 589 onward — 97.5% of all era
    // edges read 隋唐及以后, i.e. they meant "we don't know". That is exactly the
    // 年代不详 category this design forbids, wearing a dynasty-shaped disguise.
    //
    // The design (docs/architecture/节点类型与谓词.md §2.6) says a person known only
    // to be "of the Warring States" gets a *fuzzy date range* on birthDate/deathDate,
    // not an invented abstract node. Era classification is a query-time derivation
    // from those dates, never stored data.
    key: 'deathDate', label: '逝世时间', domain: 'person', range: 'literal',
    temporality: 'attribute',
    aliases: ['逝世时间', '卒年', '去世'], negatable: true, qualifiers: [QUAL.SOURCE],
  },
  {
    key: 'existedDuring', label: '存在时间', domain: 'organization', range: 'literal',
    temporality: 'attribute',
    aliases: ['存在时间', '存续期间'], negatable: false, qualifiers: [QUAL.SOURCE],
  },
  {
    key: 'bornAt', label: '出生地', domain: 'person', range: 'organization',
    temporality: 'persistent',
    inverse: 'birthplaceOf', aliases: ['出生地', '生于', '出生於'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'birthplaceOf', label: '出生名人', domain: 'organization', range: 'person',
    temporality: 'persistent',
    inverse: 'bornAt', aliases: [], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'residedAt', label: '户籍', domain: 'person', range: 'organization',
    temporality: 'concurrent',
    inverse: 'residentHere', aliases: ['户籍', '籍贯', '居住地', '居於'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'residentHere', label: '居民', domain: 'organization', range: 'person',
    temporality: 'concurrent',
    inverse: 'residedAt', aliases: [], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'foundedOn', label: '开业日期', domain: 'organization', range: 'literal',
    temporality: 'attribute',
    aliases: ['成立', '开业', '创办', '始建于'], negatable: false,
    qualifiers: [QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'dissolvedOn', label: '解散日期', domain: 'organization', range: 'literal',
    temporality: 'attribute',
    aliases: ['解散', '撤销', '停业'], negatable: false,
    qualifiers: [QUAL.NOTE, QUAL.SOURCE],
  },

  // ---------- non-person entities (thing) ----------
  //
  // A thing is anything with identity that is not a person, organisation or
  // event: a newspaper, a book, a treaty, a law, a building, an artefact.
  // These predicates exist so a thing can be *about* something, rather than
  // being flattened into a free-text prop.
  {
    key: 'publisher', label: '出版方', domain: 'thing', range: 'organization',
    temporality: 'concurrent',
    inverse: 'publishedBy', aliases: ['出版方', '出版者', '出版单位'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'publishedBy', label: '出版', domain: 'organization', range: 'thing',
    temporality: 'concurrent',
    inverse: 'publisher', aliases: ['出版', '刊行', '发行'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'author', label: '作者', domain: 'thing', range: 'person|organization',
    temporality: 'persistent',
    inverse: 'authored', aliases: ['作者', '撰写者', '著者', '编者'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.ROLE, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'authored', label: '著作', domain: 'person|organization', range: 'thing',
    temporality: 'persistent',
    inverse: 'author', aliases: ['著作', '撰写', '编著', '编写'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'about', label: '主题', domain: 'thing', range: 'person|organization|event|thing',
    temporality: 'persistent',
    inverse: 'topicOf', aliases: ['主题', '关于', '记述'], negatable: true,
    qualifiers: [QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'topicOf', label: '相关文献', domain: 'person|organization|event|thing', range: 'thing',
    temporality: 'persistent',
    inverse: 'about', aliases: [], negatable: true,
    qualifiers: [QUAL.NOTE, QUAL.SOURCE],
  },

  // ---------- evidence ----------
  //
  // Evidence is a node, not a field: "the People's Daily of 1978-05-11 carried
  // such-and-such an article". Its carrier must itself be an entity, so the
  // question "who says so" always has a node for an answer. These predicates
  // are not negatable: asserting that a record does *not* say something is a
  // statement about interpretation, not a boolean fact about the record.
  {
    key: 'documentedBy', label: '见于', domain: 'person|thing|organization|event',
    temporality: 'persistent',
    range: 'evidence', inverse: 'documents', aliases: ['见于', '记载于', '出处', '据'],
    negatable: false, qualifiers: [QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'documents', label: '记载', domain: 'evidence',
    temporality: 'persistent',
    range: 'person|thing|organization|event', inverse: 'documentedBy', aliases: ['记载', '记录'],
    negatable: false, qualifiers: [QUAL.ROLE, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'carriedBy', label: '载于', domain: 'evidence', range: 'thing|organization',
    temporality: 'persistent',
    inverse: 'carries', aliases: ['载于', '刊于', '收录于', '发表于'],
    negatable: false, qualifiers: [QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'carries', label: '载有', domain: 'thing|organization', range: 'evidence',
    temporality: 'persistent',
    inverse: 'carriedBy', aliases: ['载有', '刊载', '收录'],
    negatable: false, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
];

/** Normalise a label for alias lookup: strip whitespace, unify punctuation. */
function normLabel(s) {
  return String(s == null ? '' : s).trim().replace(/[\s　]+/g, '').replace(/[：:]/g, '');
}

class PredicateRegistry {
  constructor(defs = BUILTIN) {
    this.byKey = new Map();
    this.byAlias = new Map();
    this.mergeConflicts = [];
    this._load(defs);
  }

  _load(defs) {
    for (const d of defs) this._register(d);
    this._linkInverses();
  }

  _register(def) {
    if (!def || !def.key) return;
    const existing = this.byKey.get(def.key);
    if (existing) {
      // Merge aliases, but never silently change semantics.
      for (const a of def.aliases || []) this._addAlias(a, def.key);
      return;
    }
    const entry = {
      key: def.key,
      label: def.label || def.key,
      domain: def.domain || 'person',
      range: def.range || 'person',
      inverse: def.inverse || null,
      aliases: [...new Set((def.aliases || []).map(normLabel).filter(Boolean))],
      symmetric: !!def.symmetric,
      negatable: def.negatable !== false,
      // 性别约束的是**客体**（「A 的儿子是 B」中的 B），不是主体。
      objectGender: def.objectGender || null,
      qualifiers: def.qualifiers || [],
      // 时间性（文档 §2.2）。三档之一，必填。
      //
      // 为什么必填：未声明就会落进「不知道怎么切片」的灰区——查询时
      // 要么被静默掠过，要么被当成永久成立。两者都是错的，而且不报错。
      //
      // 未声明时**不兜底**成 'persistent'：兜底会让新谓词悄悄变成
      // 「永久成立」，这正是「时间必须是必备度量」要避免的。
      // 缺省为 null，由测试强制要求显式声明。
      temporality: def.temporality || null,
      source: def.source || (BUILTIN.some(b => b.key === def.key) ? 'builtin' : 'extension'),
    };
    this.byKey.set(entry.key, entry);
    this._addAlias(entry.label, entry.key);
    for (const a of entry.aliases) this._addAlias(a, entry.key);
  }

  _addAlias(alias, key) {
    const a = normLabel(alias);
    if (!a) return;
    const prev = this.byAlias.get(a);
    if (prev && prev !== key) {
      // Two primitives claiming the same synonym: keep the first, record it.
      this.mergeConflicts.push({ alias: a, kept: prev, ignored: key });
      return;
    }
    this.byAlias.set(a, key);
  }

  _linkInverses() {
    for (const entry of this.byKey.values()) {
      if (!entry.inverse) continue;
      const inv = this.byKey.get(entry.inverse);
      if (!inv) {
        this.mergeConflicts.push({ alias: `inverse:${entry.key}`, kept: null, ignored: entry.inverse });
        continue;
      }
      // Ensure symmetry of the inverse link.
      if (!inv.inverse) inv.inverse = entry.key;
    }
  }

  get(key) {
    return this.byKey.get(key) || null;
  }

  /** Resolve free text (label or alias) to a predicate key. */
  resolve(text) {
    const n = normLabel(text);
    if (!n) return null;
    if (this.byKey.has(n)) return n;
    return this.byAlias.get(n) || null;
  }

  inverseKey(key) {
    const e = this.get(key);
    return e ? (e.inverse || null) : null;
  }

  label(key) {
    const e = this.get(key);
    return e ? e.label : key;
  }

  /**
   * Does `type` satisfy a `domain`/`range` spec such as `'person|organization'`?
   *
   * The spec is a `|`-separated list. `literal` never matches an entity type:
   * it marks an assertion whose object is text, so only a literal object is
   * valid there.
   *
   * @param {string} spec  the predicate's domain or range
   * @param {string} type  an entity type, or 'literal'
   */
  acceptsType(spec, type) {
    if (!spec) return true;
    return String(spec).split('|').map((s) => s.trim()).includes(type);
  }

  /**
   * Check an assertion's subject/object types against its predicate.
   *
   * Returns a list of human-readable problems; empty means the assertion is
   * type-correct. Unregistered predicates are reported rather than ignored,
   * because a typo in a predicate key otherwise produces an edge nothing can
   * query by name.
   *
   * @param {string} key
   * @param {string} subjectType
   * @param {string} objectType  entity type, or 'literal'
   * @returns {string[]}
   */
  checkAssertion(key, subjectType, objectType) {
    const base = baseKey(key).replace(/\/(inverse|negate)$/, '');
    const entry = this.get(base);
    if (!entry) return [`unregistered predicate "${base}"`];
    const problems = [];
    // For an inverse assertion the declared domain/range swap roles.
    const inverted = isInversed(key);
    const wantSubject = inverted ? entry.range : entry.domain;
    const wantObject = inverted ? entry.domain : entry.range;
    if (!this.acceptsType(wantSubject, subjectType)) {
      problems.push(`${base}: subject must be ${wantSubject}, got ${subjectType}`);
    }
    if (!this.acceptsType(wantObject, objectType)) {
      problems.push(`${base}: object must be ${wantObject}, got ${objectType}`);
    }
    return problems;
  }

  list() {
    return [...this.byKey.values()];
  }

  /**
   * Suggest merges for unregistered labels: group labels that differ only by
   * whitespace/punctuation, or that are a registered alias. Returns proposals
   * for human confirmation — nothing is applied automatically.
   */
  suggestMerges(labels) {
    const proposals = [];
    const seen = new Map();
    for (const raw of labels) {
      const n = normLabel(raw);
      if (!n) continue;
      const key = this.resolve(n);
      if (key) {
        if (normLabel(raw) !== n || raw !== this.label(key)) {
          proposals.push({ label: raw, suggestedKey: key, reason: 'known-alias' });
        }
        continue;
      }
      seen.set(n, (seen.get(n) || 0) + 1);
    }
    return proposals;
  }
}

/** Compose a modified predicate key, e.g. modifier('father', 'inverse'). */
function modifier(key, mod) {
  if (!mod) return key;
  return `${key}/${mod}`;
}

/** Split 'father/inverse' -> { base: 'father', mods: ['inverse'], unknown: [] }. */
function splitModifiers(key) {
  // 同时接受内部英文名和中文写法：「父亲/非」与「father/negate」等价。
  const known = [MODIFIER.INVERSE, MODIFIER.NEGATE, MODIFIER.MALE, MODIFIER.FEMALE];
  const parts = String(key || '').split('/').map(s => s.trim());
  const base = parts.shift() || '';
  const mods = [];
  const unknown = [];
  for (const p of parts) {
    if (!p) continue;
    const canonical = MODIFIER_ALIAS[p] || p;
    if (!known.includes(canonical)) { unknown.push(p); continue; }
    if (!mods.includes(canonical)) mods.push(canonical);
  }
  return { base, mods, unknown };
}

/** Is this key explicitly negated? */
function isNegated(key) {
  return splitModifiers(key).mods.includes(MODIFIER.NEGATE);
}

/** Is this key stored in the inverse orientation? */
function isInversed(key) {
  return splitModifiers(key).mods.includes(MODIFIER.INVERSE);
}

/** Strip modifiers, returning the primitive key. */
function baseKey(key) {
  return splitModifiers(key).base;
}

module.exports = {
  MODIFIER,
  QUAL,
  BUILTIN,
  PredicateRegistry,
  modifier,
  splitModifiers,
  isNegated,
  isInversed,
  baseKey,
  normLabel,
};
