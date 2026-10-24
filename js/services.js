/* ============================================
   HumanMap — 服务层装配（services）

   职责边界：把 js/core/*.js 的纯逻辑模块装配成组件可直接使用的服务对象，
   以及环境探测、实体类型表、关系词兼容视图。

   这里不放任何 Vue 组件：组件在 js/views/，路由与挂载在 js/app.js。
   加载顺序：js/core/*.js → 本文件 → js/views/*.js → js/app.js（见 index.html）。
   ============================================ */

// ==================== 环境检测 ====================
const isLocalMode = (() => {
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '' || host.startsWith('192.168.');
})();

// ==================== 实体类型定义 ====================
//
// The single source of truth for type -> label/icon/route in the browser.
//
// This used to be three types, and every view independently re-declared
// `{ person: '/person/', organization: '/org/', event: '/event/' }` — six copies
// in total. When `thing` and `evidence` were added, all six stayed at three
// entries, so those entities silently linked to /person/ and showed a raw type
// key instead of a label.
const EntitySchema = {
  person:       { label: '人物',     icon: '👤', route: 'person' },
  thing:        { label: '非人实体', icon: '📰', route: 'thing' },
  organization: { label: '组织',     icon: '🏛', route: 'org' },
  event:        { label: '事件',     icon: '⚔', route: 'event' },
  evidence:     { label: '证据',     icon: '📄', route: 'evidence' }
};

/** Human-readable label for any type, falling back to the raw key. */
function typeLabel(type) {
  return (EntitySchema[type] && EntitySchema[type].label) || type;
}

/**
 * Router path for an entity, e.g. ('person', 'person:abc') -> '/person/person:abc'.
 * Unknown types fall back to /person/ so a bad type never produces '/undefined/'.
 */
function typeRoute(type, id) {
  const schema = EntitySchema[type];
  return '/' + (schema ? schema.route : 'person') + '/' + id;
}

// ==================== 核心模块装配 ====================
//
// The browser entry point is deliberately thin: implementation lives in
// js/core/*.js as plain, testable modules (no Vue, no DOM), and this file wires
// them into Vue components.
//
//   js/core/predicates.js     谓词原语：词形归一、反向/否定前缀、性别约束
//   js/core/timeline.js       时间轴：儒略日换算 + 三档置信度（与 src/time/julian.js 对齐）
//   js/core/data_store.js     实体缓存、索引加载、localStorage 覆盖层
//   js/core/relations.js      关系分组、反向写入、性别检索
//   js/core/search.js         模糊检索（Fuse 可选，缺失时退化子串匹配）
//   js/core/source_parser.js  源码 ⇄ 实体（关系词由谓词表判定）
//   js/core/direction.js      图谱箭头方向（由谓词对称性推导）
//   js/core/graph_render.js   D3 力导向渲染

const HM = window;

/**
 * RelationRegistry — compatibility view over the predicate table.
 *
 * Older component code reads the relation vocabulary as
 * `RelationRegistry[word] -> { targetType, inverse, hasRole, hasDate }`.
 * Rather than keeping a second table in sync by hand (which had already drifted
 * from the Node registry), we derive that shape on demand.
 */
const RelationRegistry = new Proxy({}, {
  get(_t, key) {
    if (typeof key !== 'string') return undefined;
    const def = HM.HMPredicates.def(key);
    if (!def) return undefined;
    const quals = def.qualifiers || [];
    return {
      key: def.key,
      label: def.label,
      targetType: def.range,
      inverse: def.inverse,
      hasRole: quals.indexOf('role') >= 0,
      hasDate: quals.indexOf('dates') >= 0,
      multi: def.inverse === def.key,
      symmetric: !!def.symmetric,
      objectGender: def.objectGender || null,
      icon: def.icon || '•',
    };
  },
  has(_t, key) {
    return typeof key === 'string' && !!HM.HMPredicates.def(key);
  },
  ownKeys() {
    return Object.keys(HM.HMPredicates.PREDICATES);
  },
  getOwnPropertyDescriptor(_t, key) {
    // Required for Object.keys()/spread to work on a Proxy over an empty target.
    const value = HM.HMPredicates.def(key);
    if (!value) return undefined;
    return { configurable: true, enumerable: true, writable: false, value };
  },
});

/** Every registered relation word, for editor dropdowns and panel listings. */
function listRelationWords() {
  return Object.keys(HM.HMPredicates.PREDICATES).map((key) => {
    const def = HM.HMPredicates.PREDICATES[key];
    return { key, label: def.label, targetType: def.range, icon: def.icon || '•' };
  });
}

// ==================== 数据存储层 ====================
const DataStore = new HM.HMDataStore.DataStore({
  isLocalMode,
  fetchJson: (url) => fetch(url).then((r) => r.json()),
});
DataStore.init = DataStore.init.bind(DataStore);
DataStore.loadEntity = DataStore.loadEntity.bind(DataStore);
DataStore.getEntity = DataStore.getEntity.bind(DataStore);
DataStore.getType = DataStore.getType.bind(DataStore);
DataStore.resolveName = DataStore.resolveName.bind(DataStore);
DataStore.resolveType = DataStore.resolveType.bind(DataStore);
DataStore.getProp = DataStore.getProp.bind(DataStore);
DataStore.resolveRef = DataStore.resolveRef.bind(DataStore);
DataStore.getAllEntities = DataStore.getAllEntities.bind(DataStore);
DataStore.exportAll = DataStore.exportAll.bind(DataStore);

// ==================== 关系层 ====================
const relations = new HM.HMRelations.RelationManager(DataStore, {
  predicates: HM.HMPredicates,
  isLocalMode,
});

// 只读的关系辅助方法。写路径（syncInverseRelations / cleanupReferences）
// 已随前端编辑入口一起删除——反向关系在查询时由谓词的 `inverse` 推导。
DataStore._getInverseKey = (relKey) => relations.inverseKey(relKey);
DataStore.groupRelations = (entity) => relations.group(entity).groups;
DataStore.unresolvedRelationWords = (entity) => relations.group(entity).unresolved;
DataStore.searchByGender = (entities, word, gender) => relations.searchByGender(entities, word, gender);

/**
 * Built-in relation words came from the predicate registry; anything the user
 * adds at runtime is "custom" and editable. There is no second hard-coded table
 * any more, which is what had drifted from the Node registry before.
 */
const BUILTIN_RELATION_KEYS = new Set(HM.HMPredicates.BUILTIN.map((p) => p.key));

// 缺省反向关系前缀：谓词表未声明 inverse 的关系词使用 ←关系名 作为反向键
const DEFAULT_INVERSE_PREFIX = '←';
const isDefaultInverse = (key) => !!key && key.startsWith(DEFAULT_INVERSE_PREFIX);
const defaultInverseKey = (relKey) => DEFAULT_INVERSE_PREFIX + relKey;

/**
 * 谓词表（只读）。
 *
 * 这里曾支持用户在界面上增删改自定义关系词，存 localStorage。
 * 已删除：谓词是**代码资产**（`src/predicates/registry.js`），
 * 改动要走代码审查，不能在界面上随手加一个「叔叔」——
 * 那会立刻产生一批只有这个浏览器认识的谓词，而这些谓词产生的边
 * 没有 registry 里的 domain/range 约束，也没有出处校验。
 *
 * 保留的只有查询：给谓词页和实体详情渲染用。
 */
const RelationManager = {
  getAll() {
    const out = {};
    for (const [key, def] of Object.entries(HM.HMPredicates.PREDICATES)) {
      out[key] = {
        key,
        label: def.label,
        domain: def.domain,
        targetType: def.range,
        inverse: def.inverse || null,
        aliases: def.aliases || [],
        symmetric: !!def.symmetric,
        negatable: !!def.negatable,
        qualifiers: def.qualifiers || [],
        hasRole: (def.qualifiers || []).indexOf('role') >= 0,
        hasDate: (def.qualifiers || []).indexOf('dates') >= 0,
        icon: def.icon || '•',
      };
    }
    return out;
  },

  getTargetTypes() {
    return [
      { value: 'person', label: '人物' },
      { value: 'organization', label: '组织' },
      { value: 'event', label: '事件' },
    ];
  },
};

// ==================== 查询 API ====================
//
// The SQLite index, reached over HTTP. DataStore stays the source for what the
// static shards already carry; this covers what they cannot: recursive family
// trees, ranged timeline queries, full-text search across 486k names, and cursor
// paging. Every call is gated on `probe()`, so a static deployment without the
// backend degrades to the shard path instead of failing.
//
// Probing is a one-shot promise, started here and awaited by app.js before the
// first render, so views never see status 'unknown'.
const Api = new HM.HMApi.ApiClient({});

// ==================== 搜索引擎 ====================
// `api` 传进去，让检索优先查全量库（48.7 万）而不是发布切片（3,641）。
const SearchEngine = new HM.HMSearch.SearchEngine(DataStore, { Fuse: window.Fuse, api: Api });
SearchEngine.search = SearchEngine.search.bind(SearchEngine);
SearchEngine.searchNow = SearchEngine.searchNow.bind(SearchEngine);
SearchEngine.resolveEntities = SearchEngine.resolveEntities.bind(SearchEngine);
SearchEngine.invalidateCache = SearchEngine.invalidateCache.bind(SearchEngine);

// ==================== 源码解析器 ====================
const SourceParser = new HM.HMSource.SourceParser(HM.HMPredicates);
SourceParser.parse = SourceParser.parse.bind(SourceParser);
SourceParser.stringify = SourceParser.stringify.bind(SourceParser);
SourceParser.parseBracketValues = SourceParser.parseBracketValues.bind(SourceParser);

// ==================== 图谱方向 ====================
const relationDirection = new HM.HMDirection.RelationDirection(HM.HMPredicates);
const RelationDirection = new Proxy({}, {
  get(_t, key) {
    if (typeof key !== 'string') return undefined;
    return relationDirection.directional(key, true);
  },
  has(_t, key) {
    return typeof key === 'string' && !!HM.HMPredicates.def(key);
  },
});

/**
 * Query entities through the SQLite index, falling back to nothing.
 *
 * Rejects rather than returning [] when the API is down: an empty array renders
 * as "no results", which is a different statement from "the query did not run".
 */
async function apiQuery(desc) {
  return Api.query(desc);
}

/**
 * 把 API 的 `outgoing`/`incoming` 数组转成分片用的 `relations` 对象。
 *
 * 两种形状不是随意选的：
 *   分片  relations = { father: [{id, provenance}] }   按谓词分组，适合渲染
 *   API   outgoing/incoming = [{predicate, other}]      按方向分，适合遍历
 *
 * 详情页用前者，所以在这里转一次。不把转换逻辑放进视图：
 * 家谱页、图谱、详情页都要用同一个实体，各转一遍就会各错一遍。
 */
function relationsFromApiDetail(detail) {
  const relations = {};
  const push = (pred, entry) => {
    if (!relations[pred]) relations[pred] = [];
    // 同一目标可能有多条边（例如既是父亲又是老师），按 id 去重但保留第一条的出处。
    const dup = relations[pred].some((v) => (typeof v === 'string' ? v : v && v.id) === entry.id);
    if (!dup) relations[pred].push(entry);
  };

  for (const e of detail.outgoing || []) {
    push(e.predicate, {
      id: e.other,
      // 名字和类型直接带上：视图据此判断「这个对象是否存在」。
      // 只靠 DataStore 查不到全量库里的实体（它们不在发布切片里）。
      name: e.other_name || null,
      type: e.other_type || null,
      provenance: e.provenance || [],
      // 关系起止（整数年）。null 表示时间不详。
      validFrom: e.validFrom == null ? null : e.validFrom,
      validTo: e.validTo == null ? null : e.validTo,
      // 数据质量标注。这是「判断」不是「事实」——与出处（provenance）分属
      // 两层：出处回答「凭什么这么说」，标注回答「这条记录本身可疑」。
      flags: Array.isArray(e.flags) ? e.flags : [],
      ...(e.qualifiers ? { qualifiers: e.qualifiers } : {}),
    });
  }
  // 反向边用 `/反` 修饰符表示，与 predicates.js 的约定一致（§「反向改用修饰符」）。
  // 反向边：只在「没有对应的正向边」时补。
  //
  // CBDB 的 KIN_DATA 一条记录只写一个方向（「此人的父亲是某人」），
  // 但 API 的 `incoming` 会把别人写的那条翻过来给你看。两个方向都列，
  // 页面上就会出现「父亲 → 額爾德穆」和「父亲（反） → 壽聿彭」并列——
  // 同一个人既是父亲又是儿子，看着像数据错了。
  //
  // §「反向不是另一个谓词，而是同一关系的另一个视角」：反向是查询时的事，
  // 不是把同一批边展示两遍。只有当某人**只有入边**（例如族谱里只记了
  // 「某人的儿子是张三」，没记「张三的父亲是谁」）时，才用 `/反` 补上。
  // 判重要把「互为镜像的谓词」算进去：`wife` 与 `husband` 是同一段婚姻的
  // 两个视角，若只看谓词名相同，页面会出现「妻 → 黃曾葵」和「夫（反） → 黃曾葵」
  // 并列——同一段婚姻被讲了两遍。
  const invOf = (k) => {
    const d = HM.HMPredicates.def(k);
    return d && d.inverse ? d.inverse : k;
  };
  const outgoingKeys = new Set();
  for (const e of detail.outgoing || []) {
    outgoingKeys.add(e.predicate + '|' + e.other);
    outgoingKeys.add(invOf(e.predicate) + '|' + e.other);
  }
  for (const e of detail.incoming || []) {
    // 同一对实体、同向或镜像谓词已经在 outgoing 里 → 跳过。
    //
    // 检查时也要换算成逆谓词：入边是 `maleChild|X`，而 outgoing 里存的是
    // `father|X`（因为「X 的儿子是我」=「我的父亲是 X」）。不换算就漏判。
    if (outgoingKeys.has(e.predicate + '|' + e.other)) continue;
    if (outgoingKeys.has(invOf(e.predicate) + '|' + e.other)) continue;
    // 反向要用**逆谓词**，不是原谓词加 `/反`。
    //
    // 入边 `X --maleChild--> 我` 的意思是「X 的儿子是我」，
    // 从「我」的角度看是「X 是我的父亲」——即 `father/反`。
    // 若写成 `maleChild/反`，页面上会显示「儿子（反）→ X」，
    // 把父亲说成儿子。
    const invKey = invOf(e.predicate);
    push((invKey !== e.predicate ? invKey : e.predicate) + '/反', {
      id: e.other,
      name: e.other_name || null,
      type: e.other_type || null,
      provenance: e.provenance || [],
      ...(e.qualifiers ? { qualifiers: e.qualifiers } : {}),
    });
  }
  return relations;
}

/**
 * One entity, preferring the API so both edge directions and provenance arrive
 * together. Falls back to DataStore.loadEntity, which has the shard but only the
 * outgoing relations recorded in it.
 */
async function loadEntityDetail(id, type) {
  // 等 probe 完成再判断。isAvailable() 是同步检查，而 probe 在 app.mounted()
  // 里异步跑——子组件可能先于它，于是这里返回 false，页面永远走分片路径，
  // 显示「未找到该实体」。/sources 页实测过同一个竞态。
  await Api.whenReady();
  if (Api.isAvailable()) {
    try {
      // 路由参数不带类型前缀（`/person/web-xxx`），而实体 id 带
      // （`person:web-xxx`）。不补前缀 API 会 404，于是页面回落分片、
      // 显示「未找到该实体」——即使数据就在库里。
      //
      // 分片路径靠文件名匹配（文件名含前缀），所以这个 bug 在 CBDB
      // 实体上一直没暴露；新导入的网页实体没有分片，才显出来。
      const fullId = String(id).includes(':') ? id : ((type || 'person') + ':' + id);
      const detail = await Api.entity(fullId);
      // 统一成 `relations`，让视图不必知道数据是从 API 还是分片来的。
      detail.relations = relationsFromApiDetail(detail);
      // API 把出处平铺在 `provenance` 里（带 evidence_name/evidence_url），
      // 而视图的气泡读 `entity.sources`。不转换的话，气泡只剩 reason 一行，
      // 看不到「这条数据出自哪个库」。
      if (!Array.isArray(detail.sources) || !detail.sources.length) {
        const seen = new Set();
        const sources = [];
        for (const p of detail.provenance || []) {
          if (!p || !p.evidence_id || seen.has(p.evidence_id)) continue;
          seen.add(p.evidence_id);
          // 只放 id，不放对象：详情页的 `loadEvidence()` 按 id 去
          // DataStore 取完整证据节点（含 medium/carrier/reliability），
          // 才能渲染「媒介：二手数据库」这类结构化行。
          // 直接放对象会走另一个分支，拿到的是没有 `_evidenceRows` 的裸对象，
          // 气泡里只剩一个名字。
          sources.push(p.evidence_id);
        }
        if (sources.length) detail.sources = sources;
      }
      const dtype = detail.type || 'person';
      const folder = { person: 'persons', thing: 'things', organization: 'organizations', event: 'events', evidence: 'evidence' }[dtype];
      if (folder && DataStore[folder]) {
        DataStore[folder][fullId] = { ...detail, _full: true };
        DataStore._refreshLists();
      }
      return detail;
    } catch (e) {
      // 404 is a real answer; anything else means the API broke mid-flight and the
      // shard is the better fallback.
      if (e.status === 404) return null;
      if (window.console) console.warn('API 详情失败，回落到分片', id, e.message);
    }
  }
  return DataStore.loadEntity(id);
}

/** Family tree in one direction; resolves to null when there is no backend. */
async function apiTree(id, opts) {
  if (!Api.isAvailable()) return null;
  return Api.tree(id, opts);
}

/** Entities overlapping a Julian-day window; resolves to null without a backend. */
async function apiTimeline(from, to, opts) {
  if (!Api.isAvailable()) return null;
  return Api.timeline(from, to, opts);
}



/**
 * renderGraph — thin adapter over js/core/graph_render.js.
 *
 * Kept as a function so existing call sites in the detail view do not change;
 * the implementation takes its dependencies explicitly.
 */
function renderGraph(container, focusId, focusType, onNodeClick) {
  return window.HMGraph.renderGraph(container, focusId, focusType, onNodeClick, {
    DataStore,
    RelationDirection,
    d3: window.d3,
  });
}

