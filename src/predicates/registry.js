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
 *   domain      subject type: person | organization | event
 *   range       object type:   person | organization | event | literal
 *   inverse     key of the reverse predicate (父亲 <-> 子女)
 *   aliases     synonyms folded onto this primitive (父, 爸爸, 家父 ...)
 *   symmetric   true when inverse === key
 *   negatable   whether a /非 assertion is meaningful
 *   qualifiers  which extra fields are allowed: role, dates, place, note
 *
 * Modifiers are prefixes on the predicate key, never separate predicates:
 *   father          a 是 b 的父亲          (a, father, b)
 *   father/inverse  b 是 a 的子女          (b, inverse(father), a)
 *   father/negate   c 不是 b 的父亲        (c, negate(father), b)  — explicitly false
 *
 * Gender-specific kinship is expressed with gendered object constraints rather
 * than exploding the predicate table, so that searching "儿子" resolves to
 * (negate-aware) "inverse of father" restricted to male subjects.
 */

const MODIFIER = Object.freeze({
  INVERSE: 'inverse',
  NEGATE: 'negate',
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
    inverse: 'childOfFather', aliases: ['父', '爸爸', '家父', '父上'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'childOfFather', label: '子女', domain: 'person', range: 'person',
    inverse: 'father', aliases: ['孩子'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
    // Deliberately does NOT claim 儿子/女儿: those resolve to the gender-specific
    // primitives below so that a lone "儿子" query stays gender-correct.
  },
  {
    key: 'maleChild', label: '儿子', domain: 'person', range: 'person',
    inverse: 'father', aliases: ['子', '男儿', '长子', '次子', '幼子'],
    negatable: true, subjectGender: 'male',
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
    // Gender is a hard constraint on the SUBJECT of this edge (the child).
    // Searching "儿子" therefore means: inverse-of-father edges whose subject is male.
    genderFamily: 'child',
  },
  {
    key: 'femaleChild', label: '女儿', domain: 'person', range: 'person',
    inverse: 'father', aliases: ['女', '闺女', '长女', '次女', '幼女'],
    negatable: true, subjectGender: 'female',
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
    genderFamily: 'child',
  },
  {
    key: 'mother', label: '母亲', domain: 'person', range: 'person',
    inverse: 'childOfMother', aliases: ['母', '妈妈', '家母'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'childOfMother', label: '子女', domain: 'person', range: 'person',
    inverse: 'mother', aliases: [],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },

  // ---------- kinship: spouse and siblings ----------
  {
    key: 'spouse', label: '配偶', domain: 'person', range: 'person',
    inverse: 'spouse', symmetric: true, aliases: ['妻', '夫', '妻子', '丈夫', '夫妻', '配偶'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'sibling', label: '兄弟姐妹', domain: 'person', range: 'person',
    inverse: 'sibling', symmetric: true, aliases: ['兄弟', '姐妹', '手足', '同胞'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'elderBrother', label: '兄', domain: 'person', range: 'person',
    inverse: 'youngerSibling', aliases: ['哥哥', '兄长', '长兄'],
    negatable: true, subjectGender: 'male',
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'youngerSibling', label: '弟妹', domain: 'person', range: 'person',
    inverse: 'elderBrother', aliases: ['弟弟', '妹妹', '弟', '妹'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },

  // ---------- kinship: generic ----------
  {
    key: 'kin', label: '亲属', domain: 'person', range: 'person',
    inverse: 'kin', symmetric: true, aliases: ['亲戚', '族人', '族属', '宗族'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },

  // ---------- person -> organization ----------
  {
    key: 'memberOf', label: '所属组织', domain: 'person', range: 'organization',
    inverse: 'hasMember', aliases: ['任职', '供职', '供职于', '所属', '加入'],
    negatable: true, aliasesNote: '任职 uses dates qualifier',
    qualifiers: [QUAL.ROLE, QUAL.DATES, QUAL.PLACE, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'hasMember', label: '成员', domain: 'organization', range: 'person',
    inverse: 'memberOf', aliases: ['成员', '人员'],
    negatable: true, qualifiers: [QUAL.ROLE, QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'employer', label: '任职于', domain: 'person', range: 'organization',
    inverse: 'employee', aliases: ['就职于', '工作于', '隶属于'],
    negatable: true, qualifiers: [QUAL.ROLE, QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'employee', label: '员工', domain: 'organization', range: 'person',
    inverse: 'employer', aliases: [], negatable: true,
    qualifiers: [QUAL.ROLE, QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },

  // ---------- organization hierarchy ----------
  {
    key: 'parentOrg', label: '上级组织', domain: 'organization', range: 'organization',
    inverse: 'childOrg', aliases: ['上级', '主管部门', '隶属', '所属上级'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'childOrg', label: '下级组织', domain: 'organization', range: 'organization',
    inverse: 'parentOrg', aliases: ['下级', '子部门', '下属机构', '下属企业', '子公司'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'owns', label: '控股', domain: 'organization', range: 'organization',
    inverse: 'ownedBy', aliases: ['持股', '全资', '控股'],
    negatable: true, qualifiers: [QUAL.DATES, QUAL.ROLE, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'ownedBy', label: '被控股', domain: 'organization', range: 'organization',
    inverse: 'owns', aliases: [], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.ROLE, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'successorOf', label: '前身', domain: 'organization', range: 'organization',
    inverse: 'predecessorOf', aliases: ['前身', '承继'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'predecessorOf', label: '后继', domain: 'organization', range: 'organization',
    inverse: 'successorOf', aliases: ['后继', '沿革'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },

  // ---------- events ----------
  {
    key: 'participantIn', label: '参与事件', domain: 'person', range: 'event',
    inverse: 'hasParticipant', aliases: ['参与', '参加', '参战'],
    negatable: true, qualifiers: [QUAL.ROLE, QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'hasParticipant', label: '参与人物', domain: 'event', range: 'person',
    inverse: 'participantIn', aliases: [], negatable: true,
    qualifiers: [QUAL.ROLE, QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'eventAt', label: '发生地', domain: 'event', range: 'organization',
    inverse: 'hostsEvent', aliases: ['地点', '发生地'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'hostsEvent', label: '相关事件', domain: 'organization', range: 'event',
    inverse: 'eventAt', aliases: [], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'precededBy', label: '前置事件', domain: 'event', range: 'event',
    inverse: 'followedBy', aliases: ['前因'], negatable: false,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'followedBy', label: '后续事件', domain: 'event', range: 'event',
    inverse: 'precededBy', aliases: ['后果'], negatable: false,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },

  // ---------- social ----------
  {
    key: 'teacherOf', label: '老师', domain: 'person', range: 'person',
    inverse: 'studentOf', aliases: ['师', '老师', '业师', '座师'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'studentOf', label: '学生', domain: 'person', range: 'person',
    inverse: 'teacherOf', aliases: ['学生', '门生', '弟子'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'colleague', label: '同僚', domain: 'person', range: 'person',
    inverse: 'colleague', symmetric: true, aliases: ['同事', '同僚', '同官'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'friend', label: '朋友', domain: 'person', range: 'person',
    inverse: 'friend', symmetric: true, aliases: ['友', '朋友', '好友', '友人'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'recommendedBy', label: '荐举人', domain: 'person', range: 'person',
    inverse: 'recommended', aliases: ['举荐', '推荐', '保举'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'recommended', label: '被荐举人', domain: 'person', range: 'person',
    inverse: 'recommendedBy', aliases: [], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },

  // ---------- attributes expressed as predicates ----------
  {
    key: 'gender', label: '性别', domain: 'person', range: 'literal',
    aliases: ['性别'], negatable: true, qualifiers: [QUAL.SOURCE],
  },
  {
    key: 'ethnicity', label: '民族', domain: 'person', range: 'literal',
    aliases: ['民族'], negatable: true, qualifiers: [QUAL.SOURCE],
  },
  {
    key: 'education', label: '学历', domain: 'person', range: 'literal',
    aliases: ['学历', '学位', '教育'], negatable: true, qualifiers: [QUAL.SOURCE],
  },
  {
    key: 'birthDate', label: '出生时间', domain: 'person', range: 'literal',
    aliases: ['出生年月', '出生日期', '生辰'], negatable: true, qualifiers: [QUAL.SOURCE],
  },
  {
    key: 'deathDate', label: '逝世时间', domain: 'person', range: 'literal',
    aliases: ['逝世时间', '卒年', '去世'], negatable: true, qualifiers: [QUAL.SOURCE],
  },
  {
    key: 'existedDuring', label: '存在时间', domain: 'organization', range: 'literal',
    aliases: ['存在时间', '存续期间'], negatable: false, qualifiers: [QUAL.SOURCE],
  },
  {
    key: 'bornAt', label: '出生地', domain: 'person', range: 'organization',
    inverse: 'birthplaceOf', aliases: ['出生地', '生于', '出生於'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'birthplaceOf', label: '出生名人', domain: 'organization', range: 'person',
    inverse: 'bornAt', aliases: [], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'residedAt', label: '户籍', domain: 'person', range: 'organization',
    inverse: 'residentHere', aliases: ['户籍', '籍贯', '居住地', '居於'], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'residentHere', label: '居民', domain: 'organization', range: 'person',
    inverse: 'residedAt', aliases: [], negatable: true,
    qualifiers: [QUAL.DATES, QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'foundedOn', label: '开业日期', domain: 'organization', range: 'literal',
    aliases: ['成立', '开业', '创办', '始建于'], negatable: false,
    qualifiers: [QUAL.NOTE, QUAL.SOURCE],
  },
  {
    key: 'dissolvedOn', label: '解散日期', domain: 'organization', range: 'literal',
    aliases: ['解散', '撤销', '停业'], negatable: false,
    qualifiers: [QUAL.NOTE, QUAL.SOURCE],
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
      symmetric: !!def.symmetric || def.inverse === def.key,
      negatable: def.negatable !== false,
      subjectGender: def.subjectGender || null,
      genderFamily: def.genderFamily || null,
      qualifiers: def.qualifiers || [],
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

/** Split 'father/inverse' -> { base: 'father', mods: ['inverse'] }. */
function splitModifiers(key) {
  const parts = String(key || '').split('/');
  return { base: parts[0], mods: parts.slice(1).filter(Boolean) };
}

/** Is this key explicitly negated? */
function isNegated(key) {
  return splitModifiers(key).mods.includes(MODIFIER.NEGATE);
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
  baseKey,
  normLabel,
};
