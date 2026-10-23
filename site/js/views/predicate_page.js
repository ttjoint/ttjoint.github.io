/* ============================================
   HumanMap — 谓词总表页

   谓词是结构性定义（domain/range/inverse/qualifiers），与实体详情
   不是同一层级。原先塞在弹窗抽屉里：不能深链接、不能搜索、
   而且那个抽屉还带增删改——谓词是代码资产，不该由界面改。

   依赖 js/services.js 暴露的服务（RelationManager/Api/…），
   由 index.html 在本文件之前加载。
   ============================================ */

const PredicateIndexPage = {
  data() {
    return {
      filter: '',
      domainFilter: '',
      // 边数：来自 /api/predicates。静态部署没有后端，此时为空——
      // 页面仍然可读，只是不显示「用了多少次」。
      counts: null,
      totalEdges: 0,
      apiAvailable: false,
    };
  },
  computed: {
    all() {
      const out = [];
      for (const [key, def] of Object.entries(RelationManager.getAll())) {
        out.push({ ...def, key, count: this.counts ? (this.counts[key] || 0) : null });
      }
      return out;
    },
    domains() {
      const set = new Set();
      for (const p of this.all) if (p.domain) set.add(p.domain);
      return [...set].sort();
    },
    filtered() {
      const q = this.filter.trim().toLowerCase();
      return this.all.filter((p) => {
        if (this.domainFilter && p.domain !== this.domainFilter) return false;
        if (!q) return true;
        return String(p.key).toLowerCase().includes(q)
          || String(p.label || '').toLowerCase().includes(q)
          || (p.aliases || []).some((a) => String(a).toLowerCase().includes(q));
      });
    },
    /**
     * 按 domain→range 分组。
     *
     * 平铺 56 条看不出结构，而结构正是这里最有信息量的部分：
     * person→person 有 18 个（亲属、社交），organization→organization
     * 只有 6 个（隶属、合并）。分组让人一眼看出模型的重心在哪。
     */
    grouped() {
      const map = new Map();
      for (const p of this.filtered) {
        const g = (p.domain || '?') + '→' + (p.targetType || '?');
        if (!map.has(g)) map.set(g, []);
        map.get(g).push(p);
      }
      const rows = [...map.entries()].map(([group, items]) => ({
        group,
        items: items.sort((a, b) => (b.count || 0) - (a.count || 0)),
        edges: items.reduce((a, p) => a + (p.count || 0), 0),
      }));
      // 边数多的组排前面：它才是这个模型实际在用的部分。
      return rows.sort((a, b) => b.edges - a.edges || b.items.length - a.items.length);
    },
  },
  async mounted() {
    if (!Api.isAvailable()) return;
    this.apiAvailable = true;
    try {
      const res = await Api.get('/api/predicates');
      this.counts = res.counts || {};
      this.totalEdges = res.total || 0;
    } catch (e) {
      if (window.console) console.warn('谓词统计加载失败', e.message);
    }
  },
  methods: {
    typeLabel(t) {
      return { person: '人物', organization: '组织', event: '事件', thing: '物', evidence: '证据', literal: '字面值' }[t] || t || '?';
    },
    qualifierLabel(q) {
      return {
        role: '角色', dates: '时间', place: '地点', note: '注记',
        source: '出处', certainty: '确定性', rank: '排行',
      }[q] || q;
    },
    fmt(n) {
      return n == null ? '—' : n.toLocaleString();
    },
    open(key) {
      this.$router.push('/predicate/' + encodeURIComponent(key));
    },
  },
  template: `
    <div>
      <div class="breadcrumb">
        <a href="#/">首页</a>
        <span class="bc-sep">/</span>
        <span>谓词</span>
      </div>

      <div class="predicate-header">
        <h1>谓词表</h1>
        <div class="predicate-stats">
          <span>{{ all.length }} 个谓词</span>
          <span v-if="apiAvailable && counts">· {{ fmt(totalEdges) }} 条边</span>
          <span v-else-if="!apiAvailable" class="predicate-note">（静态模式，无统计）</span>
        </div>
      </div>

      <p class="predicate-intro">
        谓词是边的类型。<strong>每个谓词都是代码资产</strong>（
        <code>src/predicates/registry.js</code>），不在界面上增删改——
        否则会立刻产生一批只有某个浏览器认识的谓词，
        而它们产生的边没有 domain/range 约束，也没有出处校验。
      </p>

      <div class="predicate-toolbar">
        <input v-model="filter" class="predicate-search" placeholder="搜索谓词名、标签或别名（如「父」「father」「子女」）" />
        <select v-model="domainFilter" class="predicate-select">
          <option value="">全部主体类型</option>
          <option v-for="d in domains" :key="d" :value="d">{{ typeLabel(d) }}</option>
        </select>
      </div>

      <div v-for="g in grouped" :key="g.group" class="card predicate-group">
        <div class="card-header">
          <span class="card-title">{{ g.group }}</span>
          <span class="card-subtitle">{{ g.items.length }} 个谓词<template v-if="apiAvailable && counts"> · {{ fmt(g.edges) }} 条边</template></span>
        </div>
        <table class="predicate-table">
          <thead>
            <tr>
              <th>谓词</th>
              <th>标签</th>
              <th>反向</th>
              <th>限定符</th>
              <th class="num" v-if="apiAvailable && counts">边数</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in g.items" :key="p.key" class="predicate-row" @click="open(p.key)">
              <td><code>{{ p.key }}</code></td>
              <td>{{ p.label }}</td>
              <td>
                <span v-if="p.inverse" class="predicate-inverse">{{ p.inverse }}</span>
                <span v-else class="predicate-none">无</span>
              </td>
              <td>
                <span v-for="q in p.qualifiers" :key="q" class="tag">{{ qualifierLabel(q) }}</span>
              </td>
              <td class="num" v-if="apiAvailable && counts">{{ fmt(p.count) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="!grouped.length" class="empty-state">
        <div class="empty-icon">🔍</div>
        <p>没有匹配的谓词</p>
      </div>
    </div>
  `,
};

/* ============================================
   HumanMap — 单个谓词详情页

   回答三个问题：这个谓词是什么意思、谁在用它、它长什么样。
   ============================================ */

const PredicateDetailPage = {
  data() {
    return {
      key: '',
      count: null,
      samples: [],
      apiAvailable: false,
    };
  },
  computed: {
    def() {
      const all = RelationManager.getAll();
      return all[this.key] || null;
    },
    /** 谁把当前谓词当作反向。反向不是独立谓词，而是同一关系的另一个视角。 */
    inverseOf() {
      const all = RelationManager.getAll();
      return Object.values(all).filter((p) => p.inverse === this.key && p.key !== this.key);
    },
    aliases() {
      return (this.def && this.def.aliases) || [];
    },
  },
  async mounted() {
    this.key = decodeURIComponent(this.$route.params.key || '');
    if (!Api.isAvailable()) return;
    this.apiAvailable = true;
    try {
      const res = await Api.get('/api/predicates/' + encodeURIComponent(this.key));
      this.count = res.count;
      this.samples = res.samples || [];
    } catch (e) {
      if (window.console) console.warn('谓词详情加载失败', e.message);
    }
  },
  methods: {
    typeLabel(t) {
      return { person: '人物', organization: '组织', event: '事件', thing: '物', evidence: '证据', literal: '字面值' }[t] || t || '?';
    },
    qualifierLabel(q) {
      return {
        role: '角色', dates: '时间', place: '地点', note: '注记',
        source: '出处', certainty: '确定性', rank: '排行',
      }[q] || q;
    },
    fmt(n) {
      return n == null ? '—' : n.toLocaleString();
    },
    go(id, type) {
      const route = { person: 'person', organization: 'org', event: 'event', thing: 'thing', evidence: 'evidence' }[type || 'person'];
      this.$router.push('/' + route + '/' + encodeURIComponent(id));
    },
  },
  template: `
    <div>
      <div class="breadcrumb">
        <a href="#/">首页</a>
        <span class="bc-sep">/</span>
        <a href="#/predicate">谓词</a>
        <span class="bc-sep">/</span>
        <span>{{ key }}</span>
      </div>

      <div v-if="!def" class="empty-state">
        <div class="empty-icon">❓</div>
        <p>谓词 <code>{{ key }}</code> 不在注册表中</p>
        <p style="font-size:.82rem">它可能来自旧数据，或是拼写错误。</p>
      </div>

      <template v-else>
        <div class="card">
          <div class="card-header">
            <span class="card-title">{{ def.label }}</span>
            <span class="tag primary">{{ def.key }}</span>
          </div>
          <dl class="info-table">
            <dt>主体类型</dt><dd>{{ typeLabel(def.domain) }}</dd>
            <dt>宾语类型</dt><dd>{{ typeLabel(def.targetType) }}</dd>
            <dt>反向谓词</dt>
            <dd>
              <a v-if="def.inverse" :href="'#/predicate/' + encodeURIComponent(def.inverse)">{{ def.inverse }}</a>
              <span v-else>无（单向）</span>
            </dd>
            <dt>对称</dt><dd>{{ def.symmetric ? '是（A↔B 同一关系）' : '否' }}</dd>
            <dt>可否定</dt><dd>{{ def.negatable ? '是' : '否' }}</dd>
            <dt v-if="aliases.length">别名</dt>
            <dd v-if="aliases.length"><span v-for="a in aliases" :key="a" class="tag">{{ a }}</span></dd>
            <dt v-if="def.qualifiers && def.qualifiers.length">限定符</dt>
            <dd v-if="def.qualifiers && def.qualifiers.length">
              <span v-for="q in def.qualifiers" :key="q" class="tag">{{ qualifierLabel(q) }}</span>
            </dd>
            <dt v-if="apiAvailable">使用次数</dt>
            <dd v-if="apiAvailable">{{ fmt(count) }} 条边</dd>
          </dl>
        </div>

        <div v-if="inverseOf.length" class="card">
          <div class="card-header">
            <span class="card-title">作为反向谓词</span>
            <span class="card-subtitle">{{ inverseOf.length }} 个谓词</span>
          </div>
          <p class="predicate-intro" style="margin:0 0 8px">
            这些谓词把 <code>{{ key }}</code> 当作反向。反向不是独立关系，
            是同一段关系的另一个视角——「A 是 B 的父亲」与「B 是 A 的儿子」说的是同一件事。
          </p>
          <div class="relation-grid">
            <div v-for="p in inverseOf" :key="p.key" class="relation-item" @click="$router.push('/predicate/' + encodeURIComponent(p.key))">
              <div class="rel-avatar">{{ (p.label || '?')[0] }}</div>
              <div class="rel-info">
                <div class="rel-name">{{ p.label }}</div>
                <div class="rel-meta"><code>{{ p.key }}</code></div>
              </div>
              <span class="rel-arrow">→</span>
            </div>
          </div>
        </div>

        <div v-if="samples.length" class="card">
          <div class="card-header">
            <span class="card-title">实例</span>
            <span class="card-subtitle">取前 {{ samples.length }} 条（按 id 排序，稳定）</span>
          </div>
          <div class="relation-grid">
            <div v-for="(s, i) in samples" :key="i" class="relation-item" @click="go(s.subject, 'person')">
              <div class="rel-info">
                <div class="rel-name">
                  <a @click.stop="go(s.subject, 'person')">{{ s.subjectName || s.subject }}</a>
                  <span class="predicate-arrow"> —{{ def.label }}→ </span>
                  <a @click.stop="go(s.object, 'person')">{{ s.objectName || s.object }}</a>
                </div>
                <div class="rel-meta">
                  <code>{{ s.subject }}</code> → <code>{{ s.object }}</code>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-else-if="apiAvailable" class="card">
          <div class="empty-state" style="padding:24px">
            <p>这个谓词当前没有任何边。</p>
          </div>
        </div>
      </template>
    </div>
  `,
};
