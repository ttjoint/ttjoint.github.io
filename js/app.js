/* ============================================
   HumanMap - 人际关系·家族图谱 核心应用 v2
   灵活属性系统 + 源码编辑器 + 事件实体
   ============================================ */

// ==================== 环境检测 ====================
const isLocalMode = (() => {
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '' || host.startsWith('192.168.');
})();

// ==================== 实体类型定义 ====================
const EntitySchema = {
  person:       { label: '人物', icon: '👤', route: 'person' },
  organization: { label: '组织', icon: '🏛', route: 'org' },
  event:        { label: '事件', icon: '⚔', route: 'event' }
};

// ==================== 关系词注册表 ====================
// 关系词 → { targetType, inverse, hasRole, hasDate, multi, icon }
// multi: true 表示反向关系可以追加（如多个子女），false 表示反向唯一（如父母通常唯一）
// 运行时注册表，初始化时合并默认值 + 用户自定义（localStorage）
const DEFAULT_RELATION_REGISTRY = {
  // 人物关系
  '父母':     { targetType: 'person', inverse: '子女',     hasRole: false, hasDate: false, multi: false, icon: '👴' },
  '子女':     { targetType: 'person', inverse: '父母',     hasRole: false, hasDate: false, multi: true,  icon: '👶' },
  '配偶':     { targetType: 'person', inverse: '配偶',     hasRole: false, hasDate: false, multi: false, icon: '💑' },
  '兄弟姐妹': { targetType: 'person', inverse: '兄弟姐妹', hasRole: false, hasDate: false, multi: true,  icon: '👫' },
  '亲属':     { targetType: 'person', inverse: '亲属',     hasRole: false, hasDate: false, multi: true,  icon: '👪' },

  // 组织关系
  '所属组织': { targetType: 'organization', inverse: '成员',     hasRole: true,  hasDate: true,  multi: true,  icon: '🏛' },
  '成员':     { targetType: 'person',       inverse: '所属组织', hasRole: true,  hasDate: true,  multi: true,  icon: '👤' },
  '上级组织': { targetType: 'organization', inverse: '下级组织', hasRole: false, hasDate: false, multi: false, icon: '⬆' },
  '下级组织': { targetType: 'organization', inverse: '上级组织', hasRole: false, hasDate: false, multi: true,  icon: '⬇' },

  // 事件关系
  '参战方':   { targetType: 'organization', inverse: '参战事件', hasRole: true,  hasDate: false, multi: true,  icon: '🏛' },
  '参战事件': { targetType: 'event',        inverse: '参战方',   hasRole: true,  hasDate: false, multi: true,  icon: '⚔' },
  '参与人物': { targetType: 'person',       inverse: '参与事件', hasRole: true,  hasDate: false, multi: true,  icon: '👤' },
  '参与事件': { targetType: 'event',        inverse: '参与人物', hasRole: true,  hasDate: false, multi: true,  icon: '⚔' },
  '前置事件': { targetType: 'event',        inverse: '后续事件', hasRole: false, hasDate: false, multi: false, icon: '⏪' },
  '后续事件': { targetType: 'event',        inverse: '前置事件', hasRole: false, hasDate: false, multi: false, icon: '⏩' },
  '关键地点': { targetType: 'organization', inverse: '关键事件', hasRole: true,  hasDate: false, multi: true,  icon: '📍' },
  '关键事件': { targetType: 'event',        inverse: '关键地点', hasRole: true,  hasDate: false, multi: true,  icon: '⚔' },

  // CBDB 社会关系
  '师生':     { targetType: 'person', inverse: '师生',     hasRole: false, hasDate: false, multi: true,  icon: '🎓' },
  '同僚':     { targetType: 'person', inverse: '同僚',     hasRole: false, hasDate: false, multi: true,  icon: '🤝' },
  '朋友':     { targetType: 'person', inverse: '朋友',     hasRole: false, hasDate: false, multi: true,  icon: '👥' },
  '门客':     { targetType: 'person', inverse: '门客',     hasRole: false, hasDate: false, multi: true,  icon: '🏠' },
  '政敌':     { targetType: 'person', inverse: '政敌',     hasRole: false, hasDate: false, multi: true,  icon: '⚡' },
  '学术':     { targetType: 'person', inverse: '学术',     hasRole: false, hasDate: false, multi: true,  icon: '📚' },
  '文学':     { targetType: 'person', inverse: '文学',     hasRole: false, hasDate: false, multi: true,  icon: '✍' },
  '同乡':     { targetType: 'person', inverse: '同乡',     hasRole: false, hasDate: false, multi: true,  icon: '🏘' },
  '荐举':     { targetType: 'person', inverse: '荐举',     hasRole: false, hasDate: false, multi: true,  icon: '📜' },
  '其他':     { targetType: 'person', inverse: '其他',     hasRole: false, hasDate: false, multi: true,  icon: '🔗' },
};

// 运行时关系注册表（合并默认 + 用户自定义）
let RelationRegistry = { ...DEFAULT_RELATION_REGISTRY };

// 缺省反向关系前缀：当关系词未配置 inverse 时，自动生成 ←关系名 作为反向键
const DEFAULT_INVERSE_PREFIX = '←';
const isDefaultInverse = (key) => key && key.startsWith(DEFAULT_INVERSE_PREFIX);
const defaultInverseKey = (relKey) => DEFAULT_INVERSE_PREFIX + relKey;

// 关系注册表管理
const RelationManager = {
  _storageKey: 'hm_relation_registry',

  load() {
    try {
      const saved = localStorage.getItem(this._storageKey);
      if (saved) {
        const custom = JSON.parse(saved);
        RelationRegistry = { ...DEFAULT_RELATION_REGISTRY, ...custom };
      }
    } catch (e) { /* ignore */ }
  },

  save() {
    // 只保存用户自定义的（不在默认值中或与默认值不同的）
    const custom = {};
    for (const [key, def] of Object.entries(RelationRegistry)) {
      if (!DEFAULT_RELATION_REGISTRY[key] || JSON.stringify(def) !== JSON.stringify(DEFAULT_RELATION_REGISTRY[key])) {
        custom[key] = def;
      }
    }
    localStorage.setItem(this._storageKey, JSON.stringify(custom));
  },

  addRelation(key, def) {
    if (RelationRegistry[key]) return false;
    RelationRegistry[key] = def;
    this.save();
    return true;
  },

  updateRelation(key, def) {
    if (!RelationRegistry[key]) return false;
    RelationRegistry[key] = def;
    this.save();
    return true;
  },

  deleteRelation(key) {
    if (DEFAULT_RELATION_REGISTRY[key]) return false; // 不允许删除默认关系
    if (!RelationRegistry[key]) return false;
    delete RelationRegistry[key];
    this.save();
    return true;
  },

  getAll() {
    return { ...RelationRegistry };
  },

  getTargetTypes() {
    return [
      { value: 'person', label: '人物' },
      { value: 'organization', label: '组织' },
      { value: 'event', label: '事件' }
    ];
  }
};

// ==================== 数据存储层 ====================
const DataStore = {
  persons: {},
  organizations: {},
  events: {},
  loaded: false,
  personList: [],
  orgList: [],
  eventList: [],

  async init() {
    if (this.loaded) return;
    try {
      const [pRes, oRes, eRes] = await Promise.all([
        fetch('data/persons/index.json').then(r => r.json()).catch(() => []),
        fetch('data/organizations/index.json').then(r => r.json()).catch(() => []),
        fetch('data/events/index.json').then(r => r.json()).catch(() => [])
      ]);

      const localP = this._loadLocal('hm_persons');
      const localO = this._loadLocal('hm_organizations');
      const localE = this._loadLocal('hm_events');

      pRes.forEach(p => { this.persons[p.id] = p; });
      oRes.forEach(o => { this.organizations[o.id] = o; });
      eRes.forEach(e => { this.events[e.id] = e; });

      if (isLocalMode) {
        Object.values(localP).forEach(p => { this.persons[p.id] = p; });
        Object.values(localO).forEach(o => { this.organizations[o.id] = o; });
        Object.values(localE).forEach(e => { this.events[e.id] = e; });
      }

      this.personList = Object.values(this.persons);
      this.orgList = Object.values(this.organizations);
      this.eventList = Object.values(this.events);
      this.loaded = true;

      // 首次加载后执行一次全量反向关系同步（仅本地模式）
      if (isLocalMode && !localStorage.getItem('hm_inverse_synced')) {
        this.syncAllInverseRelations();
        localStorage.setItem('hm_inverse_synced', '1');
      }
    } catch (e) {
      console.error('数据加载失败:', e);
    }
  },

  // 通用获取
  getEntity(id) {
    return this.persons[id] || this.organizations[id] || this.events[id] || null;
  },
  getType(id) {
    if (this.persons[id]) return 'person';
    if (this.organizations[id]) return 'organization';
    if (this.events[id]) return 'event';
    return 'unknown';
  },
  resolveName(id) {
    const e = this.getEntity(id);
    return e ? e.name : id;
  },
  resolveType(id) {
    return this.getType(id);
  },

  // 获取实体属性值
  getProp(entity, key) {
    if (!entity || !entity.props) return '';
    return entity.props[key] || '';
  },

  // 解析引用（【id】或【id|type】格式）
  resolveRef(value) {
    if (!value) return null;
    const m = value.match(/^【(.+?)】$/);
    if (m) {
      const inner = m[1];
      // 解析显式类型标注：【id|type】
      const pipeIdx = inner.lastIndexOf('|');
      let id, explicitType;
      if (pipeIdx !== -1) {
        id = inner.substring(0, pipeIdx);
        const typePart = inner.substring(pipeIdx + 1);
        const typeMap = {
          'person': 'person', '人物': 'person', '人': 'person',
          'organization': 'organization', '组织': 'organization', '政权': 'organization', 'org': 'organization',
          'event': 'event', '事件': 'event', '事': 'event'
        };
        explicitType = typeMap[typePart] || null;
      } else {
        id = inner;
        explicitType = null;
      }
      const entity = this.getEntity(id);
      const type = entity ? this.getType(id) : (explicitType || 'unknown');
      return { id, name: entity ? entity.name : id, type, explicitType };
    }
    return null;
  },

  // 本地存储
  _loadLocal(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
  },
  _saveLocal(key, data) {
    localStorage.setItem(key, JSON.stringify(data));
  },

  saveEntity(entity) {
    if (!isLocalMode) return false;
    const map = { person: 'persons', organization: 'organizations', event: 'events' };
    const key = { person: 'hm_persons', organization: 'hm_organizations', event: 'hm_events' };
    const col = map[entity.type];
    const sk = key[entity.type];
    if (!col) return false;
    this[col][entity.id] = entity;
    this._refreshLists();
    const local = this._loadLocal(sk);
    local[entity.id] = entity;
    this._saveLocal(sk, local);
    return true;
  },

  deleteEntity(id) {
    if (!isLocalMode) return false;
    const type = this.getType(id);
    const map = { person: 'persons', organization: 'organizations', event: 'events' };
    const key = { person: 'hm_persons', organization: 'hm_organizations', event: 'hm_events' };
    const col = map[type];
    const sk = key[type];
    if (!col) return false;
    delete this[col][id];
    this._refreshLists();
    const local = this._loadLocal(sk);
    delete local[id];
    this._saveLocal(sk, local);
    return true;
  },

  // 保存实体后同步反向关系
  // oldEntity: 编辑前的旧实体（新建时为 null），用于比对增删
  syncInverseRelations(entity, oldEntity) {
    if (!isLocalMode || !entity.relations) return;

    const entityId = entity.id;

    // 构建旧关系集合（key: "relKey::targetId"），包括已配置反向和缺省反向
    const oldSet = new Set();
    if (oldEntity && oldEntity.relations) {
      for (const [relKey, relValues] of Object.entries(oldEntity.relations)) {
        if (!relValues) continue;
        const inverseKey = this._getInverseKey(relKey);
        if (!inverseKey) continue;
        for (const r of relValues) {
          const tid = typeof r === 'string' ? r : r.target;
          if (tid) oldSet.add(relKey + '::' + tid);
        }
      }
    }

    // 构建新关系集合，并处理新增
    const newSet = new Set();
    for (const [relKey, relValues] of Object.entries(entity.relations)) {
      if (!relValues) continue;
      const inverseKey = this._getInverseKey(relKey);
      if (!inverseKey) continue;
      for (const r of relValues) {
        const tid = typeof r === 'string' ? r : r.target;
        if (!tid) continue;
        const key = relKey + '::' + tid;
        newSet.add(key);
        if (!oldSet.has(key)) {
          // 新增关系 → 在目标节点添加反向关系
          this._addInverse(tid, inverseKey, entityId, r, RelationRegistry[relKey]);
        }
      }
    }

    // 处理被删除的关系
    if (oldEntity) {
      for (const key of oldSet) {
        if (newSet.has(key)) continue;
        const [relKey, tid] = key.split('::');
        const inverseKey = this._getInverseKey(relKey);
        if (inverseKey) {
          this._removeInverse(tid, inverseKey, entityId);
        }
      }
    }
  },

  // 获取关系词的反向键：已配置 → 用配置值；未配置 → 用缺省键 ←关系名
  _getInverseKey(relKey) {
    const relDef = RelationRegistry[relKey];
    if (relDef?.inverse) return relDef.inverse;
    // 如果本身就是缺省反向键，不再递归生成反向
    if (isDefaultInverse(relKey)) return null;
    // 用户自定义关系，生成缺省反向键
    if (relDef) return defaultInverseKey(relKey);
    return null;
  },

  // 在 targetId 实体上添加指向 sourceId 的反向关系
  _addInverse(targetId, inverseKey, sourceId, sourceRelData, sourceRelDef) {
    const target = this.getEntity(targetId);
    if (!target) return;
    if (!target.relations) target.relations = {};
    if (!target.relations[inverseKey]) target.relations[inverseKey] = [];

    const inverseDef = RelationRegistry[inverseKey];
    const isComplex = inverseDef && (inverseDef.hasRole || inverseDef.hasDate);

    // 检查是否已存在
    const exists = target.relations[inverseKey].some(r => {
      const id = typeof r === 'string' ? r : r.target;
      return id === sourceId;
    });
    if (exists) return;

    if (isComplex && typeof sourceRelData === 'object') {
      const inv = { target: sourceId };
      if (sourceRelData.role) inv.role = sourceRelData.role;
      if (sourceRelData.start) inv.start = sourceRelData.start;
      if (sourceRelData.end) inv.end = sourceRelData.end;
      target.relations[inverseKey].push(inv);
    } else {
      target.relations[inverseKey].push(sourceId);
    }
    this.saveEntity(target);
  },

  // 从 targetId 实体上移除指向 sourceId 的反向关系
  _removeInverse(targetId, inverseKey, sourceId) {
    const target = this.getEntity(targetId);
    if (!target || !target.relations || !target.relations[inverseKey]) return;

    target.relations[inverseKey] = target.relations[inverseKey].filter(r => {
      const id = typeof r === 'string' ? r : r.target;
      return id !== sourceId;
    });

    if (target.relations[inverseKey].length === 0) {
      delete target.relations[inverseKey];
    }
    this.saveEntity(target);
  },

  // 删除实体前清理所有其他实体中对它的引用
  cleanupReferences(deletedId) {
    if (!isLocalMode) return;
    const allMaps = [this.persons, this.organizations, this.events];
    for (const map of allMaps) {
      for (const entity of Object.values(map)) {
        if (!entity.relations) continue;
        let changed = false;
        for (const [relKey, relValues] of Object.entries(entity.relations)) {
          if (!relValues) continue;
          const filtered = relValues.filter(r => {
            const id = typeof r === 'string' ? r : r.target;
            return id !== deletedId;
          });
          if (filtered.length !== relValues.length) {
            changed = true;
            if (filtered.length === 0) {
              delete entity.relations[relKey];
            } else {
              entity.relations[relKey] = filtered;
            }
          }
        }
        if (changed) this.saveEntity(entity);
      }
    }
  },

  // 全量同步所有实体的反向关系（用于初始数据导入后的修复）
  syncAllInverseRelations() {
    if (!isLocalMode) return;
    const allMaps = [this.persons, this.organizations, this.events];
    for (const map of allMaps) {
      for (const entity of Object.values(map)) {
        if (!entity.relations) continue;
        for (const [relKey, relValues] of Object.entries(entity.relations)) {
          if (!relValues) continue;
          const inverseKey = this._getInverseKey(relKey);
          if (!inverseKey) continue;
          for (const r of relValues) {
            const tid = typeof r === 'string' ? r : r.target;
            if (!tid) continue;
            this._addInverse(tid, inverseKey, entity.id, r, RelationRegistry[relKey]);
          }
        }
      }
    }
  },

  // 当用户配置了正式反向词后，将所有实体中的缺省反向键 ←relKey 替换为 newInverseKey
  replaceDefaultInverse(relKey, newInverseKey) {
    if (!isLocalMode || !newInverseKey) return;
    const oldKey = defaultInverseKey(relKey);
    const allMaps = [this.persons, this.organizations, this.events];
    let replaced = 0;
    for (const map of allMaps) {
      for (const entity of Object.values(map)) {
        if (!entity.relations || !entity.relations[oldKey]) continue;
        // 将旧键的数据合并到新键（去重）
        if (!entity.relations[newInverseKey]) entity.relations[newInverseKey] = [];
        const existingIds = new Set(entity.relations[newInverseKey].map(r => typeof r === 'string' ? r : r.target));
        for (const r of entity.relations[oldKey]) {
          const id = typeof r === 'string' ? r : r.target;
          if (!existingIds.has(id)) {
            entity.relations[newInverseKey].push(r);
            existingIds.add(id);
          }
        }
        delete entity.relations[oldKey];
        replaced++;
        this.saveEntity(entity);
      }
    }
    if (replaced > 0) {
      console.log(`缺省反向键替换: ←${relKey} → ${newInverseKey}，影响 ${replaced} 个实体`);
    }
  },

  _refreshLists() {
    this.personList = Object.values(this.persons);
    this.orgList = Object.values(this.organizations);
    this.eventList = Object.values(this.events);
  },

  // 获取所有实体列表（用于搜索和浏览）
  getAllEntities() {
    return [
      ...this.personList.map(p => ({ id: p.id, name: p.name, type: 'person', entity: p })),
      ...this.orgList.map(o => ({ id: o.id, name: o.name, type: 'organization', entity: o })),
      ...this.eventList.map(e => ({ id: e.id, name: e.name, type: 'event', entity: e }))
    ];
  },

  exportAll() {
    return JSON.stringify({
      persons: this.personList,
      organizations: this.orgList,
      events: this.eventList
    }, null, 2);
  }
};

// ==================== 搜索引擎 ====================
const SearchEngine = {
  fuse: null,

  init() {
    const items = [];
    for (const p of DataStore.personList) {
      const propText = p.props ? Object.values(p.props).join(' ') : '';
      items.push({
        id: p.id, name: p.name, type: 'person',
        aliases: (p.aliases || []).join(' '),
        desc: (p.props?.简介 || p.props?.描述 || '').slice(0, 80),
        searchText: [p.name, ...(p.aliases || []), propText].join(' ')
      });
    }
    for (const o of DataStore.orgList) {
      const propText = o.props ? Object.values(o.props).join(' ') : '';
      items.push({
        id: o.id, name: o.name, type: 'organization',
        aliases: (o.aliases || []).join(' '),
        desc: (o.props?.简介 || o.props?.描述 || '').slice(0, 80),
        searchText: [o.name, ...(o.aliases || []), propText].join(' ')
      });
    }
    for (const e of DataStore.eventList) {
      const propText = e.props ? Object.values(e.props).join(' ') : '';
      items.push({
        id: e.id, name: e.name, type: 'event',
        aliases: (e.aliases || []).join(' '),
        desc: (e.props?.简介 || e.props?.描述 || '').slice(0, 80),
        searchText: [e.name, ...(e.aliases || []), propText].join(' ')
      });
    }
    this.fuse = new Fuse(items, {
      keys: ['name', 'aliases', 'searchText'],
      threshold: 0.4,
      distance: 100,
      minMatchCharLength: 1
    });
  },

  search(query, limit = 10) {
    if (!query || !this.fuse) return [];
    return this.fuse.search(query, { limit }).map(r => r.item);
  },

  resolveEntities(ids) {
    return ids.map(id => {
      const e = DataStore.getEntity(id);
      if (e) return { id, name: e.name, type: DataStore.getType(id) };
      return null;
    }).filter(Boolean);
  }
};

// ==================== 源码解析器 ====================
const SourceParser = {
  // 解析【id1】，【id2】格式的关系值
  _parseBracketValues(value) {
    if (!value) return [];
    const result = [];
    // 按逗号或顿号分割，但尊重【】边界
    const parts = value.split(/[，,](?=\s*【)/);
    for (const part of parts) {
      const trimmed = part.trim();
      const m = trimmed.match(/^【(.+?)】(.*)$/);
      if (m) {
        let id = m[1];
        // 剥离显式类型标注：【id|type】→ id（关系类型由RelationRegistry决定）
        const pipeIdx = id.lastIndexOf('|');
        if (pipeIdx !== -1) {
          const typePart = id.substring(pipeIdx + 1);
          const knownTypes = { 'person':1, '人物':1, '人':1, 'organization':1, '组织':1, '政权':1, 'org':1, 'event':1, '事件':1, '事':1 };
          if (knownTypes[typePart]) {
            id = id.substring(0, pipeIdx);
          }
        }
        const rest = m[2].trim();
        if (rest.startsWith('|')) {
          const roleParts = rest.split('|').map(s => s.trim());
          result.push({
            target: id,
            role: roleParts[1] || '',
            start: roleParts[2] || '',
            end: roleParts[3] || ''
          });
        } else {
          result.push(id);
        }
      }
    }
    return result;
  },

  parse(source, type, existingId) {
    const entity = {
      id: existingId || '',
      type: type,
      name: '',
      props: {},
      aliases: [],
      tags: [],
      wikiUrl: '',
      relations: {},
      sources: []
    };

    const lines = source.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 别名
      if (trimmed.startsWith('别名：') || trimmed.startsWith('别名:')) {
        entity.aliases = trimmed.replace(/^别名[：:]/, '').trim().split(/[,，、]/).map(s => s.trim()).filter(Boolean);
        continue;
      }
      // 标签
      if (trimmed.startsWith('标签：') || trimmed.startsWith('标签:')) {
        entity.tags = trimmed.replace(/^标签[：:]/, '').trim().split(/[,，、]/).map(s => s.trim()).filter(Boolean);
        continue;
      }
      // Wiki
      if (trimmed.startsWith('wiki：') || trimmed.startsWith('wiki:')) {
        entity.wikiUrl = trimmed.replace(/^wiki[：:]\s*/, '').trim();
        continue;
      }
      // 名称/姓名
      if (trimmed.startsWith('名称：') || trimmed.startsWith('名称:') || trimmed.startsWith('姓名：') || trimmed.startsWith('姓名:')) {
        entity.name = trimmed.replace(/^(名称|姓名)[：:]\s*/, '').trim();
        continue;
      }
      // 数据源
      if (trimmed.startsWith('源：') || trimmed.startsWith('源:')) {
        const val = trimmed.replace(/^源[：:]\s*/, '').trim();
        const parts = val.split('|').map(s => s.trim());
        const src = {
          id: 'src-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          name: parts[0] || '',
          date: parts[1] || '',
          transcriber: (parts[2] || '').startsWith('【') ? parts[2] : (parts[2] || '').startsWith('@') ? '【' + parts[2].slice(1) + '】' : parts[2],
          previousSource: parts[3] || '',
          note: parts[4] || ''
        };
        // 解析 key=value 扩展字段
        for (let pi = 5; pi < parts.length; pi++) {
          const eqIdx = parts[pi].indexOf('=');
          if (eqIdx === -1) continue;
          const k = parts[pi].substring(0, eqIdx).trim();
          const v = parts[pi].substring(eqIdx + 1).trim();
          if (k === 'type') src.type = v;
          else if (k === 'publisher') src.publisher = v;
          else if (k === 'isbn') src.isbn = v;
          else if (k === 'url') src.url = v;
          else if (k === 'pubDate') src.publicationDate = v;
          else if (k === 'author') src.author = v;
        }
        entity.sources.push(src);
        continue;
      }

      // 通用 key：value
      const kvMatch = trimmed.match(/^(.+?)[：:]\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1].trim();
        const value = kvMatch[2].trim();
        if (!key || key === '别名' || key === '标签' || key === 'wiki' || key === '名称' || key === '姓名') continue;

        // 检查是否注册的关系词 → 解析为关系
        const relDef = RelationRegistry[key];
        if (relDef) {
          entity.relations[key] = this._parseBracketValues(value);
        } else {
          // 普通属性
          entity.props[key] = value;
        }
      }
    }

    // 使用名称作为ID（新建时）
    if (!existingId && entity.name) {
      entity.id = entity.name;
    }

    return entity;
  },

  // 将实体对象序列化为源码文本
  stringify(entity) {
    const lines = [];
    lines.push('名称：' + (entity.name || ''));

    if (entity.aliases?.length) {
      lines.push('别名：' + entity.aliases.join('，'));
    }

    // 属性
    if (entity.props) {
      for (const [key, value] of Object.entries(entity.props)) {
        if (value) lines.push(key + '：' + value);
      }
    }

    // 关系（【】格式）
    if (entity.relations) {
      for (const [relKey, relValues] of Object.entries(entity.relations)) {
        if (!relValues || relValues.length === 0) continue;
        const relDef = RelationRegistry[relKey];
        if (relDef?.hasRole) {
          const parts = relValues.map(r => {
            const roleStr = [r.role || '', r.start || '', r.end || ''].filter(Boolean).join(' | ');
            return '【' + (r.target || '') + '】' + (roleStr ? ' | ' + roleStr : '');
          });
          lines.push(relKey + '：' + parts.join('，'));
        } else {
          const ids = relValues.map(r => '【' + (typeof r === 'string' ? r : r.target) + '】');
          lines.push(relKey + '：' + ids.join('，'));
        }
      }
    }

    if (entity.tags?.length) {
      lines.push('标签：' + entity.tags.join('，'));
    }
    if (entity.wikiUrl) {
      lines.push('wiki：' + entity.wikiUrl);
    }

    // 数据源
    if (entity.sources?.length) {
      for (const src of entity.sources) {
        const parts = [src.name || '', src.date || '', src.transcriber || '', src.previousSource || '', src.note || ''];
        if (src.type) parts.push('type=' + src.type);
        if (src.publisher) parts.push('publisher=' + src.publisher);
        if (src.isbn) parts.push('isbn=' + src.isbn);
        if (src.url) parts.push('url=' + src.url);
        if (src.publicationDate) parts.push('pubDate=' + src.publicationDate);
        if (src.author) parts.push('author=' + src.author);
        lines.push('源：' + parts.join(' | '));
      }
    }

    return lines.join('\n');
  }
};

// ==================== 图谱渲染 ====================

// 关系方向定义：'to-focus'=箭头指向当前节点, 'from-focus'=箭头从当前节点指出, 'mutual'=双向
// 注：方向定义基于当前节点视角。例如"父亲"→从父亲指向当前节点(to-focus)，"子女"→从当前节点指向子女(from-focus)
const RelationDirection = {
  // === 注册关系词 ===
  '父母': 'to-focus',      // 父母→当前节点
  '子女': 'from-focus',    // 当前节点→子女
  '配偶': 'mutual',
  '兄弟姐妹': 'mutual',
  '亲属': 'mutual',
  '所属组织': 'from-focus', // 当前节点→组织
  '成员': 'to-focus',      // 组织→成员
  '上级组织': 'from-focus',
  '下级组织': 'to-focus',
  '参战方': 'mutual',
  '参战事件': 'mutual',
  '参与人物': 'mutual',
  '参与事件': 'mutual',
  '前置事件': 'from-focus',
  '后续事件': 'to-focus',
  '关键地点': 'mutual',
  '关键事件': 'mutual',

  // === 属性中的人物关系术语（人物↔人物） ===
  // 长辈 → 当前节点（to-focus）
  '父亲': 'to-focus', '母亲': 'to-focus', '爸爸': 'to-focus', '妈妈': 'to-focus',
  '父': 'to-focus', '母': 'to-focus', '祖父': 'to-focus', '祖母': 'to-focus',
  '爷爷': 'to-focus', '奶奶': 'to-focus', '外公': 'to-focus', '外婆': 'to-focus',
  '曾祖父': 'to-focus', '曾祖母': 'to-focus', '祖先': 'to-focus',
  '岳父': 'to-focus', '岳母': 'to-focus', '公公': 'to-focus', '婆婆': 'to-focus',
  '养父': 'to-focus', '养母': 'to-focus', '继父': 'to-focus', '继母': 'to-focus',
  '伯父': 'to-focus', '伯母': 'to-focus', '叔父': 'to-focus', '婶母': 'to-focus',
  '姑父': 'to-focus', '姑母': 'to-focus', '舅父': 'to-focus', '舅母': 'to-focus',
  '姨父': 'to-focus', '姨母': 'to-focus',
  // 当前节点 → 晚辈（from-focus）
  '儿子': 'from-focus', '女儿': 'from-focus', '孩子': 'from-focus', '子女': 'from-focus',
  '子': 'from-focus', '女': 'from-focus', '长子': 'from-focus', '次子': 'from-focus',
  '幼子': 'from-focus', '长女': 'from-focus', '幼女': 'from-focus',
  '孙子': 'from-focus', '孙女': 'from-focus', '外孙': 'from-focus', '外孙女': 'from-focus',
  '曾孙': 'from-focus', '曾孙女': 'from-focus', '后代': 'from-focus',
  '养子': 'from-focus', '养女': 'from-focus', '继子': 'from-focus', '继女': 'from-focus',
  '女婿': 'from-focus', '儿媳': 'from-focus',
  '侄子': 'from-focus', '侄女': 'from-focus', '外甥': 'from-focus', '外甥女': 'from-focus',
  // 同辈/平辈（mutual）
  '兄弟': 'mutual', '哥哥': 'mutual', '弟弟': 'mutual', '兄': 'mutual', '弟': 'mutual',
  '姐妹': 'mutual', '姐姐': 'mutual', '妹妹': 'mutual', '姊': 'mutual', '妹': 'mutual',
  '堂兄': 'mutual', '堂弟': 'mutual', '堂姐': 'mutual', '堂妹': 'mutual',
  '表兄': 'mutual', '表弟': 'mutual', '表姐': 'mutual', '表妹': 'mutual',
  '叔叔': 'mutual', '伯伯': 'mutual', '姑姑': 'mutual', '舅舅': 'mutual', '阿姨': 'mutual',
  '婶婶': 'mutual', '叔': 'mutual', '伯': 'mutual', '姑': 'mutual', '舅': 'mutual', '姨': 'mutual',
  // 社会关系
  '朋友': 'mutual', '好友': 'mutual', '知己': 'mutual', '同学': 'mutual', '同窗': 'mutual',
  '同事': 'mutual', '同僚': 'mutual', '邻居': 'mutual', '同乡': 'mutual',
  '战友': 'mutual', '盟友': 'mutual', '搭档': 'mutual', '合伙人': 'mutual',
  '恋人': 'mutual', '情侣': 'mutual', '未婚夫': 'mutual', '未婚妻': 'mutual', '情人': 'mutual',
  // 师生/师徒
  '老师': 'to-focus', '师父': 'to-focus', '师傅': 'to-focus', '恩师': 'to-focus',
  '导师': 'to-focus', '教官': 'to-focus', '教练': 'to-focus',
  '学生': 'from-focus', '徒弟': 'from-focus', '弟子': 'from-focus', '门生': 'from-focus',
  // 上下级
  '上司': 'to-focus', '领导': 'to-focus', '上级': 'to-focus', '长官': 'to-focus',
  '主公': 'to-focus', '君主': 'to-focus', '皇帝': 'to-focus', '帝王': 'to-focus',
  '下属': 'from-focus', '部下': 'from-focus', '下级': 'from-focus', '部将': 'from-focus',
  '臣子': 'from-focus', '家臣': 'from-focus',
  // 其他
  '恩人': 'to-focus', '仇人': 'mutual', '对手': 'mutual', '敌人': 'mutual',
  '宿主': 'to-focus', '寄主': 'from-focus', '主人': 'to-focus', '仆人': 'from-focus',

  // CBDB 社会关系方向
  '师生': 'mutual', '同僚': 'mutual', '门客': 'mutual', '政敌': 'mutual',
  '学术': 'mutual', '文学': 'mutual', '荐举': 'mutual', '其他': 'mutual'
};

function renderGraph(container, focusId, focusType, onNodeClick) {
  const svg = d3.select(container).html('').append('svg');
  const width = container.clientWidth;
  const height = 500;
  svg.attr('viewBox', [0, 0, width, height]);

  // 箭头标记（硬编码颜色，避免 CSS 变量在 marker 中无法解析）
  // markerUnits="userSpaceOnUse" 确保箭头尺寸不受 stroke-width 缩放影响
  svg.append('defs').html(`
    <marker id="arrow-end" viewBox="0 -6 12 12" refX="10" refY="0"
            markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto">
      <polygon points="0 -5, 10 0, 0 5" fill="#64748b"/>
    </marker>
    <marker id="arrow-start" viewBox="0 -6 12 12" refX="2" refY="0"
            markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto">
      <polygon points="12 -5, 2 0, 12 5" fill="#64748b"/>
    </marker>
  `);

  const g = svg.append('g');
  const rn = DataStore.resolveName.bind(DataStore);

  const nodes = [];
  const links = [];
  const nodeIds = new Set();

  function addNode(id, type, label, group) {
    if (nodeIds.has(id) || !id) return;
    nodeIds.add(id);
    nodes.push({ id, type, label, group });
  }

  addNode(focusId, focusType, rn(focusId), 'focus');

  const entity = DataStore.getEntity(focusId);
  if (!entity) return;

  // 组颜色映射
  const groupMap = {
    '父母': 'parent', '子女': 'child', '配偶': 'spouse', '兄弟姐妹': 'sibling', '亲属': 'relative',
    '所属组织': 'org', '成员': 'member', '上级组织': 'parent', '下级组织': 'sub',
    '参战方': 'participant', '参战事件': 'event', '参与人物': 'person', '参与事件': 'event',
    '前置事件': 'prev', '后续事件': 'next', '关键地点': 'location', '关键事件': 'event',
    '师生': 'academic', '同僚': 'colleague', '朋友': 'friend', '门客': 'retainer',
    '政敌': 'rival', '学术': 'academic', '文学': 'literary', '同乡': 'hometown',
    '荐举': 'recommend', '其他': 'other'
  };

  // 1. 处理注册的关系
  const relations = entity.relations || {};
  for (const [relKey, relData] of Object.entries(relations)) {
    if (!relData || relData.length === 0) continue;
    const relDef = RelationRegistry[relKey];
    const group = relDef ? (groupMap[relKey] || relDef.targetType) : 'prop-rel';
    const targetType = relDef ? relDef.targetType : 'person';
    const direction = RelationDirection[relKey] || 'mutual';

    for (const r of relData) {
      const targetId = typeof r === 'string' ? r : r.target;
      if (!targetId) continue;
      addNode(targetId, targetType, rn(targetId), group);
      const roleLabel = (typeof r !== 'string' && r.role) ? ' (' + r.role + ')' : '';
      let source, target;
      if (direction === 'to-focus') {
        source = targetId; target = focusId;
      } else {
        source = focusId; target = targetId;
      }
      links.push({ source, target, label: relKey + roleLabel, direction, linkKey: relKey });
    }
  }

  // 2. 自动扫描 props 中【】指向人物的引用
  if (entity.props) {
    for (const [propKey, propValue] of Object.entries(entity.props)) {
      if (!propValue || typeof propValue !== 'string') continue;
      const ref = DataStore.resolveRef(propValue);
      if (!ref || ref.id === focusId) continue;
      // 人物引用人物 → 自动加入人物-人物关系图谱
      if (focusType === 'person' && ref.type === 'person') {
        const direction = RelationDirection[propKey] || 'mutual';
        addNode(ref.id, 'person', rn(ref.id), 'prop-rel');
        let source, target;
        if (direction === 'to-focus') {
          source = ref.id; target = focusId;
        } else {
          source = focusId; target = ref.id;
        }
        links.push({ source, target, label: propKey, direction, linkKey: 'prop:' + propKey });
      }
      // 非人物引用 → 仍加入图谱但用默认双向
      else if (focusType !== 'person' || ref.type !== 'person') {
        addNode(ref.id, ref.type, rn(ref.id), 'prop-rel');
        links.push({ source: focusId, target: ref.id, label: propKey, direction: 'mutual', linkKey: 'prop:' + propKey });
      }
    }
  }

  if (nodes.length === 1) {
    g.append('text')
      .attr('x', width / 2).attr('y', height / 2)
      .attr('text-anchor', 'middle')
      .attr('fill', 'var(--color-text-muted)')
      .text('暂无关系数据');
    return;
  }

  // 计算同节点对之间的多重边序号
  const pairCount = {};
  links.forEach(l => {
    const key = [l.source, l.target].sort().join('||');
    pairCount[key] = (pairCount[key] || 0) + 1;
  });
  const pairIndex = {};
  links.forEach(l => {
    const key = [l.source, l.target].sort().join('||');
    if (!pairIndex[key]) pairIndex[key] = 0;
    l._pairTotal = pairCount[key];
    l._pairIdx = pairIndex[key]++;
  });

  const colorMap = {
    focus: 'var(--color-primary)',
    parent: '#f59e0b', child: '#10b981', spouse: '#ec4899',
    sibling: '#06b6d4', relative: '#8b5cf6',
    member: 'var(--color-primary)', org: 'var(--color-accent)',
    sub: 'var(--color-accent)',
    participant: '#f59e0b', 'prop-rel': '#6b7280',
    prev: '#06b6d4', next: '#10b981', location: '#8b5cf6',
    academic: '#7c3aed', colleague: '#0891b2', friend: '#059669',
    retainer: '#d97706', rival: '#dc2626', literary: '#db2777',
    hometown: '#4f46e5', recommend: '#65a30d', other: '#9ca3af'
  };

  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(100))
    .force('charge', d3.forceManyBody().strength(-300))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide(40));

  // 用 path 替代 line 以支持弧形多重边
  const linkG = g.append('g').selectAll('g')
    .data(links).join('g');

  // 主连线路径：marker-end 始终指向 target，mutual 额外加 marker-start 指向 source
  const linkPath = linkG.append('path')
    .attr('fill', 'none')
    .attr('stroke', '#94a3b8')
    .attr('stroke-width', 1.8)
    .attr('opacity', 0.75)
    .attr('marker-end', 'url(#arrow-end)')
    .attr('marker-start', d => d.direction === 'mutual' ? 'url(#arrow-start)' : null);

  const linkLabel = linkG.append('text')
    .attr('font-size', '9px')
    .attr('fill', 'var(--color-text-muted)')
    .attr('text-anchor', 'middle')
    .attr('dy', -4)
    .text(d => d.label);

  const node = g.append('g').selectAll('g')
    .data(nodes).join('g')
    .style('cursor', 'pointer')
    .on('click', (event, d) => {
      if (d.id !== focusId) onNodeClick(d.id, d.type);
    });

  // 在节点数据上记录半径，供连线计算端点偏移
  node.each(function(d) { d._r = d.group === 'focus' ? 18 : 14; });

  node.append('circle')
    .attr('r', d => d._r)
    .attr('fill', d => colorMap[d.group] || 'var(--color-primary)')
    .attr('stroke', '#fff')
    .attr('stroke-width', 2);

  node.append('text')
    .attr('text-anchor', 'middle')
    .attr('dy', 28)
    .attr('font-size', '10px')
    .attr('fill', 'var(--color-text)')
    .attr('font-weight', d => d.group === 'focus' ? '700' : '400')
    .text(d => d.label.length > 5 ? d.label.slice(0, 5) + '…' : d.label);

  // 计算弧形路径（弧线偏移量）
  const ARC_GAP = 28;  // 多重边之间的弧线间距

  function arcPath(d) {
    const sx = d.source.x, sy = d.source.y;
    const tx = d.target.x, ty = d.target.y;
    const dx = tx - sx, dy = ty - sy;
    const dr = Math.sqrt(dx * dx + dy * dy);
    if (dr === 0) return '';
    // 在圆边缘处截断，避免箭头被圆点挡住
    const sr = d.source._r || 14;
    const tr = d.target._r || 14;
    const sx2 = sx + dx / dr * sr;
    const sy2 = sy + dy / dr * sr;
    const tx2 = tx - dx / dr * tr;
    const ty2 = ty - dy / dr * tr;
    if (d._pairTotal <= 1) return `M${sx2},${sy2}L${tx2},${ty2}`;
    // 多重边：弯曲弧度
    const offset = (d._pairIdx - (d._pairTotal - 1) / 2) * ARC_GAP;
    const mx = (sx + tx) / 2 - dy / dr * offset;
    const my = (sy + ty) / 2 + dx / dr * offset;
    return `M${sx2},${sy2}Q${mx},${my} ${tx2},${ty2}`;
  }

  simulation.on('tick', () => {
    linkPath.attr('d', arcPath);
    linkLabel.attr('x', d => {
      const sx = d.source.x, sy = d.source.y;
      const tx = d.target.x, ty = d.target.y;
      const dx = tx - sx, dy = ty - sy;
      const dr = Math.sqrt(dx * dx + dy * dy);
      if (d._pairTotal <= 1) return (sx + tx) / 2;
      const offset = (d._pairIdx - (d._pairTotal - 1) / 2) * ARC_GAP;
      return (sx + tx) / 2 - dy / dr * offset;
    })
    .attr('y', d => {
      const sx = d.source.x, sy = d.source.y;
      const tx = d.target.x, ty = d.target.y;
      const dx = tx - sx, dy = ty - sy;
      const dr = Math.sqrt(dx * dx + dy * dy);
      if (d._pairTotal <= 1) return (sy + ty) / 2 - 6;
      const offset = (d._pairIdx - (d._pairTotal - 1) / 2) * ARC_GAP;
      return (sy + ty) / 2 + dx / dr * offset - 6;
    });
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  const zoom = d3.zoom().scaleExtent([0.5, 4]).on('zoom', (event) => {
    g.attr('transform', event.transform);
  });
  svg.call(zoom);
}

// ==================== Vue 组件 ====================

// -- 搜索栏组件 --
const SearchBar = {
  props: ['value', 'isLocal'],
  emits: ['update:value', 'select'],
  template: `
    <div class="search-box">
      <div class="search-input-row">
        <input
          ref="searchInput"
          type="text"
          :value="value"
          @input="onInput"
          @focus="focused = true"
          @blur="onBlur"
          @keydown="onKeydown"
          placeholder="搜索人物、组织或事件…"
          autocomplete="off"
        />
        <span class="search-icon">🔍</span>
        <button class="btn btn-sm filter-toggle" :class="{ active: showAdvanced }" @click="showAdvanced = !showAdvanced" title="高级筛选">
          ⚙
        </button>
      </div>
      <!-- 高级筛选 -->
      <div v-if="showAdvanced" class="search-advanced">
        <div class="filter-row">
          <label>类型</label>
          <select v-model="filterType" @change="doSearch">
            <option value="all">全部</option>
            <option value="person">人物</option>
            <option value="organization">组织</option>
            <option value="event">事件</option>
          </select>
        </div>
        <div class="filter-row">
          <label>包含</label>
          <input type="text" v-model="includeKeyword" @input="doSearch" placeholder="关键词…" />
        </div>
        <div class="filter-row">
          <label>排除</label>
          <input type="text" v-model="excludeKeyword" @input="doSearch" placeholder="排除词…" />
        </div>
      </div>
      <div v-if="results.length && focused" class="search-results-dropdown">
        <div
          v-for="(r, i) in results"
          :key="r.id"
          class="search-result-item"
          :class="{ selected: i === selectedIndex }"
          @mousedown.prevent="select(r)"
          @mouseenter="selectedIndex = i"
        >
          <span class="type-badge" :class="r.type">{{ typeLabel(r.type) }}</span>
          <div>
            <div class="result-name">{{ r.name }}</div>
            <div class="result-sub" v-if="r.desc">{{ r.desc.slice(0, 40) }}</div>
          </div>
        </div>
      </div>
    </div>
  `,
  data() {
    return {
      focused: false,
      results: [],
      selectedIndex: -1,
      showAdvanced: false,
      filterType: 'all',
      includeKeyword: '',
      excludeKeyword: ''
    };
  },
  watch: {
    value(v) {
      this.doSearch();
    }
  },
  methods: {
    onInput(e) {
      this.$emit('update:value', e.target.value);
      this.selectedIndex = -1;
    },
    doSearch() {
      let results = this.value ? SearchEngine.search(this.value, 20) : [];
      // 类型筛选
      if (this.filterType !== 'all') {
        results = results.filter(r => r.type === this.filterType);
      }
      // 包含关键词（全文检索）
      if (this.includeKeyword) {
        const kw = this.includeKeyword.toLowerCase();
        results = results.filter(r => {
          const entity = DataStore.getEntity(r.id);
          if (!entity) return false;
          return JSON.stringify(entity).toLowerCase().includes(kw);
        });
      }
      // 排除关键词
      if (this.excludeKeyword) {
        const kw = this.excludeKeyword.toLowerCase();
        results = results.filter(r => {
          const entity = DataStore.getEntity(r.id);
          if (!entity) return true;
          return !JSON.stringify(entity).toLowerCase().includes(kw);
        });
      }
      this.results = results.slice(0, 8);
      this.selectedIndex = -1;
    },
    select(item) {
      this.$emit('select', item);
      this.focused = false;
      this.results = [];
      this.selectedIndex = -1;
    },
    onBlur() {
      setTimeout(() => {
        this.focused = false;
        this.selectedIndex = -1;
      }, 200);
    },
    onKeydown(e) {
      if (!this.results.length) return;
      if (e.key === 'Tab') {
        e.preventDefault();
        const idx = this.selectedIndex >= 0 ? this.selectedIndex : 0;
        this.select(this.results[idx]);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.selectedIndex = Math.min(this.selectedIndex + 1, this.results.length - 1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const idx = this.selectedIndex >= 0 ? this.selectedIndex : 0;
        this.select(this.results[idx]);
        return;
      }
    },
    typeLabel(t) {
      return { person: '人', organization: '组', event: '事' }[t] || t;
    }
  }
};

// -- 首页 --
const HomePage = {
  components: { SearchBar },
  props: ['isLocal'],
  template: `
    <div>
      <div class="search-section">
        <h1>人际关系 · 家族图谱</h1>
        <div class="home-stats" v-if="stats.loaded">
          <span class="home-stat-item">👤 人物 {{ stats.personCount }}</span>
          <span class="home-stat-item">🏛 组织 {{ stats.orgCount }}</span>
          <span class="home-stat-item">⚔ 事件 {{ stats.eventCount }}</span>
          <span class="home-stat-item" v-if="stats.lastUpdate">更新于 {{ stats.lastUpdate }}</span>
        </div>
        <SearchBar :value="query" :isLocal="isLocal" @update:value="query = $event" @select="goDetail" />
      </div>
      <div class="browse-section" v-if="persons.length">
        <h2>👤 人物</h2>
        <div class="browse-grid">
          <div v-for="p in persons" :key="p.id" class="browse-card" @click="$router.push('/person/' + p.id)">
            <div class="browse-name">{{ p.name }}</div>
            <div class="browse-sub">{{ p.props?.字 || p.props?.身份 || (p.aliases || []).slice(0,2).join(' / ') || '—' }}</div>
          </div>
        </div>
      </div>
      <div class="browse-section" v-if="orgs.length">
        <h2>🏛 组织</h2>
        <div class="browse-grid">
          <div v-for="o in orgs" :key="o.id" class="browse-card" @click="$router.push('/org/' + o.id)">
            <div class="browse-name">{{ o.name }}</div>
            <div class="browse-sub">{{ o.props?.类型 || o.props?.地区 || '—' }}</div>
          </div>
        </div>
      </div>
      <div class="browse-section" v-if="events.length">
        <h2>⚔ 事件</h2>
        <div class="browse-grid">
          <div v-for="e in events" :key="e.id" class="browse-card" @click="$router.push('/event/' + e.id)">
            <div class="browse-name">{{ e.name }}</div>
            <div class="browse-sub">{{ e.props?.时间 || '—' }}</div>
          </div>
        </div>
      </div>
      <div v-if="!persons.length && !orgs.length && !events.length" class="empty-state">
        <div class="empty-icon">📦</div>
        <p>数据加载中…</p>
      </div>
      <div v-if="isLocal" style="text-align:center;margin-top:32px;">
        <button class="btn btn-primary" @click="$emit('open-editor', 'person')">+ 新增人物</button>
        <button class="btn" style="margin-left:8px" @click="$emit('open-editor', 'organization')">+ 新增组织</button>
        <button class="btn" style="margin-left:8px" @click="$emit('open-editor', 'event')">+ 新增事件</button>
      </div>
    </div>
  `,
  data() { return { query: '', persons: [], orgs: [], events: [], stats: { loaded: false, personCount: 0, orgCount: 0, eventCount: 0, lastUpdate: '' } }; },
  async mounted() {
    await DataStore.init();
    this.persons = DataStore.personList.slice(0, 12);
    this.orgs = DataStore.orgList.slice(0, 8);
    this.events = DataStore.eventList.slice(0, 8);
    this.stats.personCount = DataStore.personList.length;
    this.stats.orgCount = DataStore.orgList.length;
    this.stats.eventCount = DataStore.eventList.length;
    this.stats.loaded = true;
    this.stats.lastUpdate = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  },
  methods: {
    goDetail(item) {
      const route = { person: '/person/', organization: '/org/', event: '/event/' }[item.type] || '/person/';
      this.$router.push(route + item.id);
    }
  }
};

// -- 通用实体详情组件工厂 --
function createEntityDetail(entityType) {
  const entitySchema = EntitySchema[entityType];
  const routeName = entitySchema.route;

  return {
    name: entityType + '-detail',
    props: ['isLocal'],
    data() {
      return {
        entity: null,
        showGraph: true,
        showTimeline: true,
        showSources: true,
        entityType: entityType,
        schema: EntitySchema[entityType] || {}
      };
    },
    computed: {
      resolvedProps() {
        if (!this.entity?.props) return {};
        const resolved = {};
        for (const [key, value] of Object.entries(this.entity.props)) {
          if (!value) continue;
          // 提取所有【】引用（支持单个和多个引用混排）
          const refs = [];
          const parts = [];
          let lastIdx = 0;
          const re = /【(.+?)】/g;
          let m;
          while ((m = re.exec(value)) !== null) {
            if (m.index > lastIdx) {
              parts.push({ text: value.slice(lastIdx, m.index) });
            }
            const ref = DataStore.resolveRef(m[0]);
            if (ref) {
              refs.push(ref);
              parts.push({ _ref: true, id: ref.id, name: ref.name, type: ref.type });
            } else {
              parts.push({ text: m[0] });
            }
            lastIdx = m.index + m[0].length;
          }
          if (lastIdx < value.length) {
            parts.push({ text: value.slice(lastIdx) });
          }
          // 没有引用 → 纯文本；有引用 → 返回 parts 数组供模板遍历
          if (refs.length === 0) {
            resolved[key] = value;
          } else {
            resolved[key] = { _multi: true, parts };
          }
        }
        return resolved;
      },
      resolvedRelations() {
        if (!this.entity?.relations) return {};
        const resolved = {};
        for (const [relKey, relData] of Object.entries(this.entity.relations)) {
          const relDef = RelationRegistry[relKey];
          // 缺省反向关系：显示但标记为 auto-generated
          const isAuto = !relDef && isDefaultInverse(relKey);
          if (!relDef && !isAuto) continue;
          const icon = relDef ? relDef.icon : '↩';
          const hasRole = relDef ? relDef.hasRole : false;
          if (hasRole) {
            resolved[relKey] = relData.map(r => ({
              ...r,
              name: DataStore.resolveName(r.target),
              type: DataStore.getType(r.target),
              icon, _auto: isAuto
            }));
          } else {
            resolved[relKey] = relData.map(id => {
              const tid = typeof id === 'string' ? id : id.target;
              return { id: tid, name: DataStore.resolveName(tid), type: DataStore.getType(tid), icon, _auto: isAuto };
            });
          }
        }
        return resolved;
      },
      // 事件时间线步骤
      timelineSteps() {
        if (this.entityType !== 'event') return [];
        const steps = [];
        const props = this.entity?.props || {};
        if (props['起因']) {
          steps.push({ type: 'cause', label: '起因', text: props['起因'] });
        }
        if (props['经过']) {
          const parts = props['经过'].split(/[→⟶]/).map(s => s.trim()).filter(Boolean);
          parts.forEach((part, i) => {
            steps.push({ type: 'progress', label: '经过 ' + (i + 1), text: part });
          });
        }
        if (props['影响']) {
          steps.push({ type: 'effect', label: '影响', text: props['影响'] });
        }
        return steps;
      },
      // 解析数据源链
      resolvedSources() {
        if (!this.entity?.sources) return [];
        return this.entity.sources.map((s, i) => {
          let tid = s.transcriber || '';
          // 提取【】中的ID
          const m = tid.match(/^【(.+?)】$/);
          const actualId = m ? m[1] : (tid.startsWith('@') ? tid.slice(1) : tid);
          return {
            ...s,
            transcriberName: actualId ? DataStore.resolveName(actualId) : null,
            transcriberType: actualId ? DataStore.getType(actualId) : null,
            transcriber: m ? m[1] : actualId,
            previousSourceName: i > 0 ? this.entity.sources[i - 1].name : null
          };
        });
      }
    },
    async mounted() {
      const id = this.$route.params.id;
      await DataStore.init();
      this.entity = this._ensureEntity(id);
      this.$nextTick(() => {
        if (this.showGraph && this.$refs.graph) {
          renderGraph(this.$refs.graph, id, entityType, (nid, type) => this.navigate(nid, type));
        }
      });
    },
    watch: {
      '$route.params.id': {
        async handler(id) {
          await DataStore.init();
          this.entity = this._ensureEntity(id);
          this.showGraph = true;
        }
      },
      showGraph(v) {
        if (v) {
          this.$nextTick(() => {
            if (this.$refs.graph) {
              renderGraph(this.$refs.graph, this.$route.params.id, entityType, (nid, type) => this.navigate(nid, type));
            }
          });
        }
      }
    },
    methods: {
      _ensureEntity(id) {
        let entity = DataStore.getEntity(id);
        if (!entity) {
          entity = {
            id: id, name: id, type: this.entityType,
            props: {}, aliases: [], tags: [], relations: {}, sources: []
          };
          DataStore.saveEntity(entity);
          SearchEngine.init();
        }
        return entity;
      },
      navigate(id, type) {
        const routeMap = { person: '/person/', organization: '/org/', event: '/event/' };
        this.$router.push((routeMap[type] || '/person/') + id);
      },
      editEntity() {
        this.$emit('open-editor', entityType, this.entity);
      },
      openWiki(url) { window.open(url, '_blank'); },
      resolveName(id) { return DataStore.resolveName(id); },
      typeLabel(t) {
        return { person: '人物', organization: '组织', event: '事件' }[t] || t;
      },
      getRoute(type) {
        return { person: '/person/', organization: '/org/', event: '/event/' }[type] || '/person/';
      },
      // 构建源链顺序（数组顺序为从最原始到最新）
      buildSourceChain() {
        if (!this.entity?.sources?.length) return [];
        return [...this.entity.sources];
      }
    },
    template: `
      <div v-if="entity">
        <div class="breadcrumb">
          <router-link to="/">首页</router-link>
          <span class="bc-sep">/</span>
          <span>{{ schema.label }}</span>
          <span class="bc-sep">/</span>
          <strong>{{ entity.name }}</strong>
        </div>
        <div class="toolbar">
          <button v-if="isLocal" class="btn" @click="editEntity">编辑</button>
          <span class="toolbar-spacer"></span>
          <span v-if="entity.wikiUrl" class="tag clickable" @click="openWiki(entity.wikiUrl)">Wikipedia</span>
        </div>

        <div class="detail-layout">
          <div class="detail-main">
            <!-- 基本信息卡片 -->
            <div class="card">
              <div class="card-header">
                <span class="card-title">{{ entity.name }}</span>
                <span class="tag" :class="entityType === 'person' ? 'primary' : entityType === 'organization' ? 'accent' : 'warning'">
                  {{ typeLabel(entityType) }}
                </span>
              </div>
              <div v-if="entity.aliases?.length" style="margin-bottom:12px">
                <span class="tag" v-for="a in entity.aliases" :key="a">{{ a }}</span>
              </div>
              <table class="info-table">
                <template v-for="(value, key) in resolvedProps" :key="key">
                  <tr v-if="value">
                    <td>{{ key }}</td>
                    <td>
                      <template v-if="value._multi">
                        <template v-for="(part, pi) in value.parts" :key="pi">
                          <span v-if="part._ref" class="tag clickable primary" @click="navigate(part.id, part.type)">{{ part.name }}</span>
                          <span v-else>{{ part.text }}</span>
                        </template>
                      </template>
                      <template v-else-if="value._ref">
                        <span class="tag clickable primary" @click="navigate(value.id, value.type)">
                          {{ value.name }}
                        </span>
                      </template>
                      <template v-else>{{ value }}</template>
                    </td>
                  </tr>
                </template>
              </table>
              <div v-if="entity.tags?.length" style="margin-top:12px">
                <span class="tag" v-for="t in entity.tags" :key="t">{{ t }}</span>
              </div>
            </div>

            <!-- 事件时间线（仅事件） -->
            <div v-if="entityType === 'event' && timelineSteps.length" class="card">
              <div class="card-header collapse-header" @click="showTimeline = !showTimeline">
                <span class="card-title">事件时间线</span>
                <span class="collapse-arrow">{{ showTimeline ? '▲' : '▼' }}</span>
              </div>
              <div v-if="showTimeline" class="timeline-container">
                <div class="timeline-item" v-for="(step, i) in timelineSteps" :key="i">
                  <div class="timeline-dot" :class="step.type"></div>
                  <div class="timeline-line" v-if="i < timelineSteps.length - 1"></div>
                  <div class="timeline-content">
                    <div class="timeline-label">{{ step.label }}</div>
                    <div class="timeline-text">{{ step.text }}</div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 关系图谱 -->
            <div class="card" style="padding:8px">
              <div class="graph-header collapse-header" @click="showGraph = !showGraph">
                <span class="card-title" style="font-size:1rem">关系图谱</span>
                <span class="card-subtitle" v-if="entity.relations" style="margin-left:12px">
                  <template v-for="(relList, relName) in entity.relations" :key="relName">
                    <span v-if="relList && relList.length" style="margin-right:10px;font-size:.8rem">{{ relName }} {{ relList.length }}</span>
                  </template>
                </span>
                <span class="collapse-arrow" style="margin-left:auto">{{ showGraph ? '▲' : '▼' }}</span>
              </div>
              <div v-if="showGraph" class="graph-container" ref="graph"></div>
            </div>

            <!-- 数据源溯源链 -->
            <div v-if="resolvedSources.length" class="card">
              <div class="card-header collapse-header" @click="showSources = !showSources">
                <span class="card-title">数据源溯源</span>
                <span class="card-subtitle">{{ resolvedSources.length }} 层</span>
                <span class="collapse-arrow" style="margin-left:auto">{{ showSources ? '▲' : '▼' }}</span>
              </div>
              <div v-if="showSources" class="source-chain-container">
                <div class="source-chain">
                  <div class="source-chain-item" v-for="(src, i) in resolvedSources" :key="src.id">
                    <div class="source-card">
                      <div class="source-card-header">
                        <div class="source-card-title-row">
                          <span class="source-card-name">{{ src.name }}</span>
                          <span class="source-type-badge" v-if="src.type" :class="src.type">{{ src.type }}</span>
                        </div>
                        <span class="source-card-date" v-if="src.publicationDate || src.date">{{ src.publicationDate || src.date }}</span>
                      </div>
                      <div class="source-card-body">
                        <div v-if="src.author && !src.transcriberName" class="source-card-field">
                          <span class="source-label">作者：</span>
                          <span>{{ src.author }}</span>
                        </div>
                        <div v-if="src.transcriberName" class="source-card-transcriber">
                          <span class="source-label">转述者：</span>
                          <span class="tag clickable primary" @click="navigate(src.transcriber, src.transcriberType)">{{ src.transcriberName }}</span>
                        </div>
                        <div v-if="src.publisher" class="source-card-field">
                          <span class="source-label">出版机构：</span>
                          <span>{{ src.publisher }}</span>
                        </div>
                        <div v-if="src.isbn" class="source-card-field">
                          <span class="source-label">ISBN：</span>
                          <span class="source-isbn">{{ src.isbn }}</span>
                        </div>
                        <div v-if="src.url" class="source-card-field">
                          <span class="source-label">链接：</span>
                          <a :href="src.url" target="_blank" rel="noopener" class="source-url">{{ src.url }}</a>
                        </div>
                        <div v-if="src.previousSourceName" class="source-card-prev">
                          <span class="source-label">上层来源：</span>
                          <span class="source-prev-name">{{ src.previousSourceName }}</span>
                        </div>
                        <div v-if="src.note" class="source-card-note">{{ src.note }}</div>
                      </div>
                    </div>
                    <div class="source-chain-arrow" v-if="i < resolvedSources.length - 1">
                      <span class="arrow-icon">↑</span>
                      <span class="arrow-label">引自</span>
                    </div>
                  </div>
                  <div class="source-chain-item source-chain-entity">
                    <div class="source-card source-card-entity">
                      <div class="source-card-header">
                        <div class="source-card-title-row">
                          <span class="source-card-name">{{ entity.name }}</span>
                          <span class="tag" :class="entityType === 'person' ? 'primary' : entityType === 'organization' ? 'accent' : 'warning'" style="font-size:.7rem">本条目</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 关系面板 -->
            <template v-for="(relData, relKey) in resolvedRelations" :key="relKey">
              <div class="card" v-if="relData.length">
                <div class="card-header">
                  <span class="card-title">{{ relKey }}</span>
                  <span v-if="relData[0]._auto" class="tag" style="font-size:.7rem;background:var(--color-bg-tertiary);color:var(--color-text-muted)" title="缺省反向关系，可在关系设置中配置正式反向词">自动生成</span>
                  <span class="card-subtitle">{{ relData.length }} 项</span>
                </div>
                <div class="relation-grid">
                  <div v-for="(r, i) in relData" :key="i" class="relation-item" @click="navigate(r.id || r.target, r.type)">
                    <div class="rel-avatar">{{ (r.name || '?')[0] }}</div>
                    <div class="rel-info">
                      <div class="rel-name">{{ r.name || r.target }}</div>
                      <div class="rel-desc" v-if="r.role">
                        {{ r.role }}
                        <span v-if="r.start || r.end">
                          ({{ r.start || '?' }}{{ r.end ? ' ~ ' + r.end : '' }})
                        </span>
                      </div>
                    </div>
                    <span class="rel-arrow">→</span>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
      <div v-else class="empty-state">
        <div class="empty-icon">🔍</div>
        <p>加载中…</p>
      </div>
    `
  };
}

// 人物、组织、事件详情页使用工厂函数
const PersonDetail = createEntityDetail('person');
const OrgDetail = createEntityDetail('organization');
const EventDetail = createEntityDetail('event');

// -- 源码编辑器面板 --
const EditorPanel = {
  props: ['isLocal'],
  emits: ['close', 'saved'],
  data() {
    return {
      isOpen: false,
      entityType: 'person',
      editId: null,
      sourceText: '',
      isEdit: false,
      showHelp: false,
      // 自动补全
      showAutocomplete: false,
      acResults: [],
      acSelected: 0,
      acTriggerPos: 0
    };
  },
  computed: {
    schema() {
      return EntitySchema[this.entityType] || {};
    },
    registryList() {
      const list = {};
      for (const [key, def] of Object.entries(RelationRegistry)) {
        list[key] = { ...def, label: EntitySchema[def.targetType]?.label || def.targetType };
      }
      return list;
    },
    placeholder() {
      const examples = {
        person: '名称：刘备\n字：玄德\n生卒：161年 ~ 223年\n出生地：涿郡涿县\n国籍：【蜀汉】\n简介：刘备，字玄德…\n别名：刘皇叔，刘玄德\n标签：三国，蜀汉，开国皇帝\nwiki：https://zh.wikipedia.org/wiki/刘备\n子女：【刘禅】，【刘永】，【刘理】\n配偶：【甘夫人】，【糜夫人】，【孙尚香】\n所属组织：【蜀汉】 | 皇帝 | 221年 | 223年',
        organization: '名称：蜀汉\n类型：政权\n地区：益州\n存续：221年 ~ 263年\n时期：【三国|政权】\n简介：蜀汉，三国时期…\n别名：季汉，蜀国\n标签：三国，政权\n成员：【刘备】 | 皇帝 | 221年 | 223年\n成员：【诸葛亮】 | 丞相 | 221年 | 234年',
        event: '名称：赤壁之战\n时间：208年\n地点：长江赤壁\n结果：孙刘联军胜利\n简介：赤壁之战是…\n标签：三国，战役\n参战方：【曹魏】 | 曹操军\n参战方：【东吴】 | 孙权军\n参与人物：【曹操】 | 主帅\n参与人物：【诸葛亮】 | 军师\n源：三国志·吴书·周瑜传 | 289年 | 【陈寿】 | | 陈寿编纂'
      };
      return examples[this.entityType] || '';
    }
  },
  methods: {
    open(type, existing) {
      this.entityType = type;
      this.isOpen = true;
      if (existing) {
        this.isEdit = true;
        this.editId = existing.id;
        this.sourceText = SourceParser.stringify(existing);
      } else {
        this.isEdit = false;
        this.editId = null;
        this.sourceText = '';
      }
      this.showAutocomplete = false;
    },
    close() {
      this.isOpen = false;
      this.showAutocomplete = false;
      this.$emit('close');
    },
    save() {
      try {
        const entity = SourceParser.parse(this.sourceText, this.entityType, this.editId);
        if (!entity.name) {
          alert('请至少输入名称');
          return;
        }
        // 检查重复ID
        if (!this.isEdit) {
          const existing = DataStore.getEntity(entity.id);
          if (existing) {
            if (!confirm('词条"' + entity.id + '"已存在，是否覆盖？')) return;
          }
        }
        // 保存编辑前旧实体，用于比对反向关系增删
        const oldEntity = this.isEdit ? DataStore.getEntity(this.editId) : null;
        // 自动创建关系中不存在的桩节点
        this._autoCreateStubs(entity);
        DataStore.saveEntity(entity);
        // 同步反向关系：新增关系 → 在目标添加反向关系，删除关系 → 清理目标反向关系
        DataStore.syncInverseRelations(entity, oldEntity);
        this.$emit('saved', entity);
        this.close();
      } catch (e) {
        alert('解析错误：' + e.message);
      }
    },
    _autoCreateStubs(entity) {
      // 处理关系中的引用
      if (entity.relations) {
        for (const [relKey, relValues] of Object.entries(entity.relations)) {
          const relDef = RelationRegistry[relKey];
          if (!relDef) continue;
          for (const r of relValues) {
            const targetId = typeof r === 'string' ? r : r.target;
            if (!targetId || DataStore.getEntity(targetId)) continue;
            const stub = {
              id: targetId, name: targetId, type: relDef.targetType,
              props: {}, aliases: [], tags: [], relations: {}, sources: []
            };
            DataStore.saveEntity(stub);
          }
        }
      }
      // 处理属性中的【】引用（支持显式类型标注）
      if (entity.props) {
        for (const value of Object.values(entity.props)) {
          if (!value || typeof value !== 'string') continue;
          const ref = DataStore.resolveRef(value);
          if (!ref || ref.type === 'unknown') continue;
          if (DataStore.getEntity(ref.id)) continue;
          const stub = {
            id: ref.id, name: ref.id, type: ref.type,
            props: {}, aliases: [], tags: [], relations: {}, sources: []
          };
          DataStore.saveEntity(stub);
        }
      }
    },
    deleteEntity() {
      if (!confirm('确定删除？此操作不可撤销。')) return;
      // 先清理所有其他实体中对该节点的引用
      DataStore.cleanupReferences(this.editId);
      DataStore.deleteEntity(this.editId);
      this.$emit('saved');
      this.close();
      this.$router.push('/');
    },
    // 自动补全
    onEditorInput(e) {
      const ta = e.target;
      const pos = ta.selectionStart;
      const text = ta.value;
      // 查找光标前最近的【
      const lastBracket = text.lastIndexOf('【', pos - 1);
      if (lastBracket !== -1 && lastBracket < pos) {
        const afterBracket = text.substring(lastBracket + 1, pos);
        // 如果【后面没有】且没有换行，触发补全
        if (!afterBracket.includes('】') && !afterBracket.includes('\n')) {
          this.acTriggerPos = lastBracket;
          this.acResults = SearchEngine.search(afterBracket, 8);
          this.acSelected = 0;
          this.showAutocomplete = this.acResults.length > 0;
          return;
        }
      }
      this.showAutocomplete = false;
    },
    onEditorKeydown(e) {
      if (!this.showAutocomplete) return;
      if (e.key === 'Tab') {
        e.preventDefault();
        this.completeAc(this.acResults[this.acSelected]);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.acSelected = Math.min(this.acSelected + 1, this.acResults.length - 1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.acSelected = Math.max(this.acSelected - 1, 0);
        return;
      }
      if (e.key === 'Enter' && this.acResults.length > 0) {
        e.preventDefault();
        this.completeAc(this.acResults[this.acSelected]);
        return;
      }
      if (e.key === 'Escape') {
        this.showAutocomplete = false;
        return;
      }
    },
    completeAc(item) {
      const before = this.sourceText.substring(0, this.acTriggerPos);
      const after = this.sourceText.substring(this.$refs.editorTextarea?.selectionStart || this.acTriggerPos + 1);
      // 找到after中第一个】或换行后的位置
      let cutAfter = after;
      const closeBracket = after.indexOf('】');
      const newline = after.indexOf('\n');
      if (closeBracket !== -1 && (newline === -1 || closeBracket < newline)) {
        cutAfter = after.substring(closeBracket + 1);
      }
      this.sourceText = before + '【' + item.id + '】' + cutAfter;
      this.showAutocomplete = false;
      this.$nextTick(() => {
        const ta = this.$refs.editorTextarea;
        if (ta) {
          const newPos = before.length + item.id.length + 3;
          ta.focus();
          ta.setSelectionRange(newPos, newPos);
        }
      });
    },
    acTypeLabel(t) {
      return { person: '人物', organization: '组织', event: '事件' }[t] || t;
    }
  },
  template: `
    <div>
      <div class="editor-overlay" :class="{ open: isOpen }" @click="close"></div>
      <div class="editor-panel" :class="{ open: isOpen }">
        <div class="editor-panel-header">
          <h3>{{ isEdit ? '编辑' : '新增' }}{{ schema.label || '实体' }}</h3>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm" @click="showHelp = !showHelp">{{ showHelp ? '收起帮助' : '语法帮助' }}</button>
            <button class="btn-icon" @click="close">✕</button>
          </div>
        </div>
        <div class="editor-panel-body">
          <!-- 语法帮助 -->
          <div v-if="showHelp" class="card" style="padding:12px;margin-bottom:16px;font-size:.82rem;background:var(--color-primary-light)">
            <div style="font-weight:600;margin-bottom:8px">语法说明</div>
            <div><b>名称：</b>必填，人物使用"姓名"亦可</div>
            <div><b>属性：</b><code>键：值</code> 每行一个属性，支持任意属性名</div>
            <div><b>关系：</b>用注册的关系词作为键，值用 <code>【词条名】</code> 逗号分隔</div>
            <div><b>含角色关系：</b><code>关系词：【词条名】 | 角色 | 开始 | 结束</code></div>
            <div><b>内链：</b>输入 <code>【</code> 触发自动补全；可用 <code>【词条|类型】</code> 指定类型（如【三国|政权】）</div>
            <div><b>别名/标签：</b>用逗号分隔</div>
            <div><b>数据源：</b><code>源：资料名 | 日期 | 【转述者】 | 上层源 | 备注</code></div>
            <div style="margin-top:8px"><b>注册的关系词：</b>
              <template v-for="(def, key) in registryList" :key="key">
                <span class="tag" style="font-size:.7rem">{{ key }}<span style="color:var(--color-text-muted)">→{{ def.label }}</span></span>
              </template>
            </div>
            <div style="margin-top:8px"><b>快捷键：</b>输入<code>【</code>触发补全，<code>Tab</code>补全首个，<code>↑↓</code>选择，<code>Enter</code>确认</div>
          </div>

          <!-- 源码编辑区 -->
          <div class="form-group" style="position:relative">
            <label>源码编辑</label>
            <textarea
              ref="editorTextarea"
              v-model="sourceText"
              :placeholder="placeholder"
              class="source-editor"
              style="min-height:400px;font-family:var(--font-mono);font-size:.85rem;line-height:1.7;tab-size:2"
              spellcheck="false"
              @input="onEditorInput"
              @keydown="onEditorKeydown"
            ></textarea>
            <!-- 自动补全弹窗 -->
            <div v-if="showAutocomplete" class="ac-dropdown">
              <div
                v-for="(r, i) in acResults"
                :key="r.id"
                class="ac-item"
                :class="{ selected: i === acSelected }"
                @mousedown.prevent="completeAc(r)"
                @mouseenter="acSelected = i"
              >
                <span class="type-badge" :class="r.type">{{ acTypeLabel(r.type) }}</span>
                <span class="ac-name">{{ r.name }}</span>
                <span class="ac-id">{{ r.id }}</span>
              </div>
            </div>
          </div>

          <div style="display:flex;gap:8px;margin-top:16px">
            <button class="btn btn-primary" @click="save" style="flex:1">保存</button>
            <button v-if="isEdit" class="btn btn-danger" @click="deleteEntity">删除</button>
          </div>
        </div>
      </div>
    </div>
  `
};

// -- 关系类型管理面板 --
const RelationPanel = {
  data() {
    return {
      isOpen: false,
      showForm: false,
      editingKey: null,
      form: { name: '', targetType: 'person', inverse: '', multi: true, icon: '🔗' },
      formError: ''
    };
  },
  computed: {
    relations() {
      const list = [];
      for (const [key, def] of Object.entries(RelationRegistry)) {
        list.push({
          key,
          ...def,
          isDefault: !!DEFAULT_RELATION_REGISTRY[key],
          targetLabel: EntitySchema[def.targetType]?.label || def.targetType
        });
      }
      list.sort((a, b) => {
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        return a.key.localeCompare(b.key, 'zh');
      });
      return list;
    },
    targetTypes() {
      return RelationManager.getTargetTypes();
    },
    defaultIcons() {
      return ['👤', '👥', '👴', '👵', '👶', '💑', '👫', '👪', '🏛', '⚔', '📍', '⏪', '⏩', '⬆', '⬇', '🔗', '📌', '⭐', '💼', '🎓'];
    },
    isEditingDefault() {
      return this.editingKey && !!DEFAULT_RELATION_REGISTRY[this.editingKey];
    }
  },
  methods: {
    open() {
      this.isOpen = true;
      this.showForm = false;
      this.editingKey = null;
    },
    close() {
      this.isOpen = false;
      this.showForm = false;
      this.editingKey = null;
      this.formError = '';
    },
    startAdd() {
      this.editingKey = null;
      this.form = { name: '', targetType: 'person', inverse: '', multi: true, icon: '🔗' };
      this.formError = '';
      this.showForm = true;
    },
    startEdit(key) {
      const def = RelationRegistry[key];
      if (!def) return;
      this.editingKey = key;
      this.form = {
        name: key,
        targetType: def.targetType,
        inverse: def.inverse || '',
        multi: def.multi !== false,
        icon: def.icon || '🔗'
      };
      this.formError = '';
      this.showForm = true;
    },
    cancelForm() {
      this.showForm = false;
      this.editingKey = null;
      this.formError = '';
    },
    save() {
      this.formError = '';
      const name = this.form.name.trim();
      if (!name) { this.formError = '请输入关系名称'; return; }

      const def = {
        targetType: this.form.targetType,
        inverse: this.form.inverse.trim() || null,
        multi: this.form.multi,
        icon: this.form.icon || '🔗'
      };

      if (this.editingKey) {
        // 编辑
        const isDefault = !!DEFAULT_RELATION_REGISTRY[this.editingKey];
        if (isDefault && this.editingKey !== name) {
          this.formError = '默认关系类型不可重命名';
          return;
        }
        if (this.editingKey !== name && RelationRegistry[name]) {
          this.formError = '关系名称 "' + name + '" 已存在';
          return;
        }

        // 检测反向词变更：从无到有，或从旧值到新值
        const oldDef = RelationRegistry[this.editingKey];
        const oldInverse = oldDef?.inverse || null;
        const newInverse = def.inverse;
        const inverseChanged = oldInverse !== newInverse;

        // 若重命名自定义关系，删除旧键
        if (this.editingKey !== name) {
          delete RelationRegistry[this.editingKey];
        }
        RelationRegistry[name] = def;
        RelationManager.save();

        // 如果反向词变更了，替换缺省反向键
        if (inverseChanged) {
          // 如果之前有旧反向词，且新反向词不同 → 扫描替换
          DataStore.replaceDefaultInverse(name, newInverse);
        }
      } else {
        // 新增
        if (RelationRegistry[name]) {
          this.formError = '关系名称 "' + name + '" 已存在';
          return;
        }
        RelationManager.addRelation(name, def);

        // 如果指定了反向词，替换所有已有实体的缺省反向键
        if (def.inverse) {
          DataStore.replaceDefaultInverse(name, def.inverse);
        }

        // 自动创建反向关系对（若指定了反向且该反向关系不存在）
        if (def.inverse && !RelationRegistry[def.inverse]) {
          const inverseDef = {
            targetType: 'person',
            inverse: name,
            multi: true,
            icon: '🔗'
          };
          RelationManager.addRelation(def.inverse, inverseDef);
        }
      }

      this.showForm = false;
      this.editingKey = null;
    },
    deleteRelation(key) {
      if (DEFAULT_RELATION_REGISTRY[key]) return;
      if (!confirm('确定删除关系类型 "' + key + '" 吗？此操作不会删除已有数据中的该关系。')) return;
      RelationManager.deleteRelation(key);
      if (this.editingKey === key) {
        this.showForm = false;
        this.editingKey = null;
      }
    },
    selectIcon(icon) {
      this.form.icon = icon;
    }
  },
  template: `
    <div>
      <div class="editor-overlay" :class="{ open: isOpen }" @click="close"></div>
      <div class="editor-panel" :class="{ open: isOpen }">
        <div class="editor-panel-header">
          <h3>管理关系类型</h3>
          <button class="btn-icon" @click="close">✕</button>
        </div>
        <div class="editor-panel-body">
          <div style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:.82rem;color:var(--color-text-muted)">共 {{ relations.length }} 个关系类型</span>
            <button class="btn btn-primary btn-sm" @click="startAdd" v-if="!showForm">+ 新增关系</button>
          </div>

          <!-- 新增/编辑表单 -->
          <div v-if="showForm" class="card" style="padding:16px;margin-bottom:16px;background:var(--color-primary-light);border:1px solid var(--color-primary)">
            <div style="font-weight:600;margin-bottom:12px">{{ editingKey ? '编辑关系：' + editingKey : '新增关系类型' }}</div>

            <div class="form-group">
              <label>关系名称 <span style="color:var(--color-danger)">*</span></label>
              <input v-model="form.name" placeholder="例如：叔叔、导师、盟友" @keydown.enter="save" :disabled="isEditingDefault" />
              <div v-if="isEditingDefault" style="font-size:.75rem;color:var(--color-text-muted);margin-top:2px">默认关系类型不可重命名</div>
            </div>

            <div class="form-group">
              <label>目标类型 <span style="color:var(--color-danger)">*</span></label>
              <select v-model="form.targetType">
                <option v-for="t in targetTypes" :key="t.value" :value="t.value">{{ t.label }}</option>
              </select>
            </div>

            <div class="form-group">
              <label>反向关系</label>
              <input v-model="form.inverse" placeholder="例如：侄子、学生、盟友（留空表示无反向）" />
              <div style="font-size:.75rem;color:var(--color-text-muted);margin-top:4px">
                当A指向B时，系统自动在B上添加此反向关系指向A。若双向关系，反向可填相同名称。
              </div>
            </div>

            <div class="form-group">
              <label>图标</label>
              <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">
                <span v-for="icon in defaultIcons" :key="icon"
                  @click="selectIcon(icon)"
                  style="font-size:1.2rem;cursor:pointer;padding:2px 4px;border-radius:4px"
                  :style="{ background: form.icon === icon ? 'var(--color-primary)' : 'transparent' }"
                >{{ icon }}</span>
              </div>
              <input v-model="form.icon" placeholder="或直接输入 emoji" style="width:80px" />
            </div>

            <div class="form-group">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input type="checkbox" v-model="form.multi" style="width:auto" />
                允许多个目标（如多个子女、多个成员）
              </label>
            </div>

            <div v-if="formError" style="color:var(--color-danger);font-size:.82rem;margin-bottom:8px">{{ formError }}</div>

            <div style="display:flex;gap:8px">
              <button class="btn btn-primary btn-sm" @click="save">{{ editingKey ? '保存修改' : '添加关系' }}</button>
              <button class="btn btn-sm" @click="cancelForm">取消</button>
            </div>
          </div>

          <!-- 关系列表 -->
          <div class="relation-list">
            <div v-for="r in relations" :key="r.key" class="relation-item card" :class="{ default: r.isDefault }" style="padding:10px 14px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
              <div style="flex:1;min-width:0">
                <div style="display:flex;align-items:center;gap:8px">
                  <span style="font-size:1.1rem">{{ r.icon }}</span>
                  <span style="font-weight:600">{{ r.key }}</span>
                  <span class="type-badge" :class="r.targetType" style="font-size:.7rem">{{ r.targetLabel }}</span>
                  <span v-if="r.isDefault" class="tag" style="font-size:.65rem;background:var(--color-bg)">默认</span>
                </div>
                <div style="font-size:.78rem;color:var(--color-text-muted);margin-top:2px;margin-left:26px">
                  <span v-if="r.inverse">反向：{{ r.inverse }}</span>
                  <span v-else style="font-style:italic">无反向关系</span>
                  <span style="margin:0 6px">·</span>
                  <span>{{ r.multi !== false ? '多目标' : '单目标' }}</span>
                </div>
              </div>
              <div style="display:flex;gap:4px;flex-shrink:0;margin-left:12px">
                <button class="btn btn-sm" @click="startEdit(r.key)" style="padding:2px 8px">编辑</button>
                <button v-if="!r.isDefault" class="btn btn-sm btn-danger" @click="deleteRelation(r.key)" style="padding:2px 8px">删除</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
};

// -- 全部对象浏览页 --
const AllObjects = {
  data() {
    return {
      filterType: 'all',
      sortBy: 'name',
      sortAsc: true,
      searchQuery: ''
    };
  },
  computed: {
    allItems() {
      const items = [];
      for (const p of DataStore.personList) {
        const props = p.props || {};
        const subtitle = props['字'] || props['身份'] || props['生卒'] || (p.aliases || []).join(' / ') || '';
        items.push({ id: p.id, name: p.name, type: 'person', subtitle, entity: p });
      }
      for (const o of DataStore.orgList) {
        const props = o.props || {};
        const subtitle = props['类型'] || props['地区'] || props['存续'] || '';
        items.push({ id: o.id, name: o.name, type: 'organization', subtitle, entity: o });
      }
      for (const e of DataStore.eventList) {
        const props = e.props || {};
        const subtitle = props['时间'] || props['地点'] || props['结果'] || '';
        items.push({ id: e.id, name: e.name, type: 'event', subtitle, entity: e });
      }
      return items;
    },
    filteredItems() {
      let items = this.allItems;
      if (this.filterType !== 'all') {
        items = items.filter(i => i.type === this.filterType);
      }
      if (this.searchQuery) {
        const q = this.searchQuery.toLowerCase();
        items = items.filter(i => i.name.toLowerCase().includes(q) || i.subtitle.toLowerCase().includes(q));
      }
      items = [...items].sort((a, b) => {
        let cmp = 0;
        if (this.sortBy === 'name') {
          cmp = a.name.localeCompare(b.name, 'zh');
        } else if (this.sortBy === 'type') {
          cmp = a.type.localeCompare(b.type);
        }
        return this.sortAsc ? cmp : -cmp;
      });
      return items;
    },
    typeCounts() {
      const counts = { all: this.allItems.length, person: 0, organization: 0, event: 0 };
      for (const item of this.allItems) {
        counts[item.type] = (counts[item.type] || 0) + 1;
      }
      return counts;
    }
  },
  async mounted() {
    await DataStore.init();
  },
  methods: {
    typeLabel(t) {
      return { person: '人物', organization: '组织', event: '事件' }[t] || t;
    },
    navigate(item) {
      const route = { person: '/person/', organization: '/org/', event: '/event/' }[item.type] || '/person/';
      this.$router.push(route + item.id);
    },
    toggleSort(field) {
      if (this.sortBy === field) {
        this.sortAsc = !this.sortAsc;
      } else {
        this.sortBy = field;
        this.sortAsc = true;
      }
    }
  },
  template: `
    <div>
      <div class="breadcrumb">
        <router-link to="/">首页</router-link>
        <span class="bc-sep">/</span>
        <strong>全部对象</strong>
      </div>

      <div class="all-objects-header">
        <h1>全部对象</h1>
        <div class="all-objects-stats">
          <span>共 {{ typeCounts.all }} 个条目</span>
        </div>
      </div>

      <div class="all-objects-toolbar">
        <div class="all-objects-tabs">
          <button class="btn btn-sm" :class="{ 'btn-primary': filterType === 'all' }" @click="filterType = 'all'">
            全部 ({{ typeCounts.all }})
          </button>
          <button class="btn btn-sm" :class="{ 'btn-primary': filterType === 'person' }" @click="filterType = 'person'">
            👤 人物 ({{ typeCounts.person }})
          </button>
          <button class="btn btn-sm" :class="{ 'btn-primary': filterType === 'organization' }" @click="filterType = 'organization'">
            🏛 组织 ({{ typeCounts.organization }})
          </button>
          <button class="btn btn-sm" :class="{ 'btn-primary': filterType === 'event' }" @click="filterType = 'event'">
            ⚔ 事件 ({{ typeCounts.event }})
          </button>
        </div>
        <div class="all-objects-search">
          <input type="text" v-model="searchQuery" placeholder="搜索名称或描述…" />
        </div>
      </div>

      <div class="card" style="padding:0;overflow:hidden">
        <table class="all-objects-table">
          <thead>
            <tr>
              <th style="width:80px" class="sortable" @click="toggleSort('type')">
                类型
                <span v-if="sortBy === 'type'" class="sort-icon">{{ sortAsc ? '▲' : '▼' }}</span>
              </th>
              <th class="sortable" @click="toggleSort('name')">
                名称
                <span v-if="sortBy === 'name'" class="sort-icon">{{ sortAsc ? '▲' : '▼' }}</span>
              </th>
              <th>描述</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in filteredItems" :key="item.id" class="all-objects-row" @click="navigate(item)">
              <td>
                <span class="type-badge" :class="item.type">{{ typeLabel(item.type) }}</span>
              </td>
              <td class="all-objects-name">{{ item.name }}</td>
              <td class="all-objects-sub">{{ item.subtitle || '—' }}</td>
            </tr>
            <tr v-if="!filteredItems.length">
              <td colspan="3" style="text-align:center;padding:32px;color:var(--color-text-muted)">无匹配结果</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `};

// -- 搜索结果页 --
const SearchResults = {
  data() {
    return {
      results: [],
      query: ''
    };
  },
  mounted() {
    this.query = this.$route.query.q || '';
    this.doSearch();
  },
  watch: {
    '$route.query.q': {
      handler(q) { this.query = q || ''; this.doSearch(); }
    }
  },
  methods: {
    doSearch() {
      this.results = this.query ? SearchEngine.search(this.query, 50) : [];
    },
    navigate(item) {
      const route = { person: '/person/', organization: '/org/', event: '/event/' }[item.type] || '/person/';
      this.$router.push(route + item.id);
    },
    typeLabel(t) {
      return { person: '人物', organization: '组织', event: '事件' }[t] || t;
    }
  },
  template: `
    <div>
      <div class="breadcrumb">
        <router-link to="/">首页</router-link>
        <span class="bc-sep">/</span>
        <span>搜索: "{{ query }}"</span>
      </div>
      <p style="color:var(--color-text-secondary);margin-bottom:16px">找到 {{ results.length }} 个结果</p>
      <div v-if="results.length">
        <div v-for="r in results" :key="r.id" class="relation-item" style="margin-bottom:8px" @click="navigate(r)">
          <span class="type-badge" :class="r.type" style="font-size:.7rem;padding:2px 8px;border-radius:10px;font-weight:500">
            {{ typeLabel(r.type) }}
          </span>
          <div style="flex:1">
            <div style="font-weight:600">{{ r.name }}</div>
            <div style="font-size:.8rem;color:var(--color-text-secondary)">{{ r.desc?.slice(0, 60) }}</div>
          </div>
          <span class="rel-arrow">→</span>
        </div>
      </div>
      <div v-else class="empty-state">
        <div class="empty-icon">🔍</div>
        <p>未找到匹配结果</p>
      </div>
    </div>
  `
};

// ==================== 路由 ====================
const routes = [
  { path: '/', name: 'home', component: HomePage },
  { path: '/person/:id', name: 'person', component: PersonDetail },
  { path: '/org/:id', name: 'org', component: OrgDetail },
  { path: '/event/:id', name: 'event', component: EventDetail },
  { path: '/search', name: 'search', component: SearchResults },
  { path: '/all', name: 'all', component: AllObjects }
];

const router = VueRouter.createRouter({
  history: VueRouter.createWebHashHistory(),
  routes
});

// ==================== 应用初始化 ====================
const app = Vue.createApp({
  data() {
    return {
      theme: 'light',
      isLocalMode: isLocalMode,
      dataVersion: 0,
      dataStats: {
        loaded: false,
        personCount: 0,
        orgCount: 0,
        eventCount: 0,
        lastUpdate: ''
      }
    };
  },
  mounted() {
    const saved = localStorage.getItem('hm_theme');
    if (saved) this.theme = saved;
    this.applyTheme();
    RelationManager.load();
    DataStore.init().then(() => {
      this.dataStats.personCount = DataStore.personList.length;
      this.dataStats.orgCount = DataStore.orgList.length;
      this.dataStats.eventCount = DataStore.eventList.length;
      this.dataStats.loaded = true;
      this.dataStats.lastUpdate = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
      SearchEngine.init();
    });
  },
  methods: {
    toggleTheme() {
      this.theme = this.theme === 'light' ? 'dark' : 'light';
      localStorage.setItem('hm_theme', this.theme);
      this.applyTheme();
    },
    applyTheme() {
      document.body.classList.toggle('dark', this.theme === 'dark');
    },
    openEditor(mode, existing) {
      if (this.$refs.editor) {
        this.$refs.editor.open(mode, existing);
      }
    },
    openRelationPanel() {
      if (this.$refs.relationPanel) {
        this.$refs.relationPanel.open();
      }
    },
    onEditorClose() {},
    onEditorSaved(entity) {
      SearchEngine.init();
      if (entity) {
        const route = { person: '/person/', organization: '/org/', event: '/event/' }[entity.type] || '/person/';
        const targetPath = route + entity.id;
        if (this.$route.path === targetPath) {
          // 同页面：用 replace+timestamp 强制刷新
          this.$router.replace({ path: targetPath, query: { _: Date.now() } });
        } else {
          this.$router.push(targetPath);
        }
      }
    }
  }
});

app.config.globalProperties.$ds = DataStore;
app.config.globalProperties.$se = SearchEngine;

app.use(router);
app.component('EditorPanel', EditorPanel);
app.component('RelationPanel', RelationPanel);
app.mount('#app');