/* ============================================
   HumanMap — 文献（证据来源）总表

   反向视图：从证据文件看它支撑了哪些断言。

   现有查询方向都是「实体 → 它的出处」，这个页面反过来：
   《宋史》被引用了多少次、支撑了哪些关系、quote 的多样性如何。

   最后一项是关键——如果某文献的 distinctQuotes 远小于总条数，
   说明大量断言共用同一条引文，那通常意味着自动生成，
   而不是逐条读过原书。

   依赖 js/services.js 暴露的服务，由 index.html 在本文件之前加载。
   ============================================ */

const SourceIndexPage = {
  data() {
    return {
      filter: '',
      sources: [],
      untitled: 0,
      total: 0,
      loading: true,
      apiAvailable: false,
      sortBy: 'count',
    };
  },
  computed: {
    filtered() {
      const q = this.filter.trim().toLowerCase();
      let rows = this.sources;
      if (q) rows = rows.filter((s) => String(s.title).toLowerCase().includes(q));
      if (this.sortBy === 'title') {
        rows = rows.slice().sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh'));
      }
      // 默认按条数降序（后端已排好）。
      return rows;
    },
    totalEdges() {
      return this.sources.reduce((a, s) => a + (s.edges || 0), 0);
    },
  },
  async mounted() {
    // 等 probe 有结果再判断，否则可能先于 app.mounted() 的探测跑，
    // 于是明明后端在、页面却走「静态模式」分支。
    const up = await Api.whenReady();
    if (!up) { this.loading = false; return; }
    this.apiAvailable = true;
    try {
      const res = await Api.get('/api/sources');
      this.sources = res.sources || [];
      this.untitled = res.untitled || 0;
      this.total = res.total || 0;
    } catch (e) {
      if (window.console) console.warn('文献总表加载失败', e.message);
    } finally {
      this.loading = false;
    }
  },
  methods: {
    fmt(n) {
      return n == null ? '—' : n.toLocaleString();
    },
    open(title) {
      this.$router.push('/sources/' + encodeURIComponent(title));
    },
    barWidth(n) {
      // 相对最大值画条。绝对数值看不出相对规模——
      // 35801 和 94 都是「有引用」，但差 380 倍。
      const max = this.sources.length ? this.sources[0].n : 1;
      return Math.max(2, Math.round((n / max) * 100)) + '%';
    },
  },
  template: `
    <div>
      <div class="breadcrumb">
        <a href="#/">首页</a>
        <span class="bc-sep">/</span>
        <span>文献</span>
      </div>

      <div class="predicate-header">
        <h1>文献</h1>
        <div class="predicate-stats">
          <span>{{ sources.length }} 种</span>
          <span v-if="apiAvailable">· {{ fmt(total) }} 条出处</span>
        </div>
      </div>

      <p class="predicate-intro">
        CBDB 是<strong>二手数据库</strong>：它把文献整理成字段，自己不是文献。
        这里列出它声称的依据——每个名字都是 CBDB 的 <code>TEXT_CODES</code>
        表里的一条记录，不是我们读过的书。
        <template v-if="untitled">
          另有 {{ fmt(untitled) }} 条出处 CBDB 未记文献名（<code>c_source=0</code>）。
        </template>
      </p>

      <div v-if="!apiAvailable" class="empty-state">
        <div class="empty-icon">⚠</div>
        <p>此页需要本地服务（<code>npm run serve</code>）。</p>
        <p style="font-size:.82rem">文献反查要按 <code>source_title</code> 分组统计，静态快照里没有这个索引。</p>
      </div>

      <template v-else>
        <div class="predicate-toolbar">
          <input v-model="filter" class="predicate-search" placeholder="搜索文献名（如「宋史」「墓誌」）" />
          <select v-model="sortBy" class="predicate-select">
            <option value="count">按引用数</option>
            <option value="title">按名称</option>
          </select>
        </div>

        <div class="card" style="padding:0;overflow:hidden">
          <table class="predicate-table source-table">
            <thead>
              <tr>
                <th>文献</th>
                <th class="num">边断言</th>
                <th class="num">实体断言</th>
                <th class="num">合计</th>
                <th style="width:22%"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in filtered" :key="s.title" class="predicate-row" @click="open(s.title)">
                <td>{{ s.title }}</td>
                <td class="num">{{ fmt(s.edges) }}</td>
                <td class="num">{{ fmt(s.entities) }}</td>
                <td class="num"><strong>{{ fmt(s.n) }}</strong></td>
                <td>
                  <div class="source-bar"><div class="source-bar-fill" :style="{ width: barWidth(s.n) }"></div></div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="!filtered.length && !loading" class="empty-state">
          <div class="empty-icon">🔍</div>
          <p>没有匹配的文献</p>
        </div>
      </template>
    </div>
  `,
};

/* ============================================
   HumanMap — 单个文献的详情

   看它支撑了哪些断言。除了列举，还给出「quote 多样性」——
   这是判断出处质量的唯一可靠指标。
   ============================================ */

const SourceDetailPage = {
  data() {
    return {
      title: '',
      total: 0,
      byScope: {},
      distinctQuotes: 0,
      edges: [],
      entities: [],
      loading: true,
      apiAvailable: false,
      showAll: false,
    };
  },
  computed: {
    /**
     * quote 多样性。
     *
     * 每条断言都该有自己的一条引文。若 2,348 条边只有 785 种 quote，
     * 说明有 1,563 条复用了别人的引文——它们仍然「有出处」，
     * 但那个出处不是为它单独核对的。
     */
    quoteRatio() {
      if (!this.total || !this.distinctQuotes) return null;
      return this.distinctQuotes / this.total;
    },
    ratioVerdict() {
      const r = this.quoteRatio;
      if (r === null) return null;
      if (r >= 0.9) return { level: 'good', text: '每条断言几乎都有独立引文' };
      if (r >= 0.5) return { level: 'ok', text: '部分断言共用引文，尚可' };
      return { level: 'warn', text: '大量断言共用同一条引文——可能不是逐条核对' };
    },
    visibleEdges() {
      return this.showAll ? this.edges : this.edges.slice(0, 15);
    },
  },
  async mounted() {
    this.title = decodeURIComponent(this.$route.params.title || '');
    const up = await Api.whenReady();
    if (!up) { this.loading = false; return; }
    this.apiAvailable = true;
    try {
      const res = await Api.get('/api/sources/' + encodeURIComponent(this.title) + '?limit=100');
      this.total = res.total || 0;
      this.byScope = res.byScope || {};
      this.distinctQuotes = res.distinctQuotes || 0;
      this.edges = res.edges || [];
      this.entities = res.entities || [];
    } catch (e) {
      if (window.console) console.warn('文献详情加载失败', e.message);
    } finally {
      this.loading = false;
    }
  },
  methods: {
    fmt(n) { return n == null ? '—' : n.toLocaleString(); },
    pct(n) {
      // 没有这一 scope 的断言时显示「—」，不是「NaN%」。
      if (!n) return '—';
      return this.total ? (n / this.total * 100).toFixed(1) + '%' : '—';
    },
    goEntity(id, type) {
      const route = { person: 'person', organization: 'org', event: 'event', thing: 'thing', evidence: 'evidence' }[type || 'person'];
      this.$router.push('/' + route + '/' + encodeURIComponent(id));
    },
    goPredicate(key) {
      this.$router.push('/predicate/' + encodeURIComponent(key));
    },
    locatorText(loc) {
      if (!loc) return '';
      const parts = [];
      if (loc.pages) parts.push('页/条目：' + loc.pages);
      if (loc.sourceId) parts.push('CBDB TEXT_ID ' + loc.sourceId);
      return parts.join(' · ');
    },
  },
  template: `
    <div>
      <div class="breadcrumb">
        <a href="#/">首页</a>
        <span class="bc-sep">/</span>
        <a href="#/sources">文献</a>
        <span class="bc-sep">/</span>
        <span>{{ title }}</span>
      </div>

      <div v-if="!apiAvailable" class="empty-state">
        <div class="empty-icon">⚠</div>
        <p>此页需要本地服务（<code>npm run serve</code>）。</p>
      </div>

      <template v-else>
        <div class="card">
          <div class="card-header">
            <span class="card-title">{{ title }}</span>
            <span class="card-subtitle">{{ fmt(total) }} 条断言</span>
          </div>
          <dl class="info-table">
            <dt>边断言</dt>
            <dd v-if="byScope.edge">{{ fmt(byScope.edge) }} 条（{{ pct(byScope.edge) }}）</dd>
            <dd v-else class="predicate-none">无</dd>
            <dt>实体断言</dt>
            <dd v-if="byScope.entity">{{ fmt(byScope.entity) }} 条（{{ pct(byScope.entity) }}）</dd>
            <dd v-else class="predicate-none">无</dd>
            <dt>不同引文</dt>
            <dd>
              {{ fmt(distinctQuotes) }} 种
              <span v-if="ratioVerdict" class="tag" :class="ratioVerdict.level">{{ ratioVerdict.text }}</span>
            </dd>
          </dl>
        </div>

        <div v-if="edges.length" class="card">
          <div class="card-header">
            <span class="card-title">支撑的边断言</span>
            <span class="card-subtitle">取前 {{ visibleEdges.length }} / {{ fmt(byScope.edge) }}</span>
          </div>
          <div class="relation-grid">
            <div v-for="(e, i) in visibleEdges" :key="i" class="relation-item source-claim">
              <div class="rel-info">
                <div class="rel-name">
                  <a @click.stop="goEntity(e.subject)">{{ e.subjectName || e.subject }}</a>
                  <a class="predicate-link" @click.stop="goPredicate(e.predicate)">—{{ e.predicate }}→</a>
                  <a @click.stop="goEntity(e.object)">{{ e.objectName || e.object }}</a>
                </div>
                <div class="rel-meta" v-if="locatorText(e.locator)">{{ locatorText(e.locator) }}</div>
                <div class="source-quote" v-if="e.quote">{{ e.quote }}</div>
              </div>
            </div>
          </div>
          <button v-if="edges.length < byScope.edge" class="btn btn-sm" style="margin-top:12px" @click="showAll = true">
            显示全部已加载
          </button>
        </div>

        <div v-if="entities.length" class="card">
          <div class="card-header">
            <span class="card-title">支撑的实体断言</span>
            <span class="card-subtitle">{{ entities.length }} 条</span>
          </div>
          <div class="relation-grid">
            <div v-for="(e, i) in entities" :key="i" class="relation-item source-claim" @click="goEntity(e.targetId, e.entityType)">
              <div class="rel-info">
                <div class="rel-name">{{ e.entityName || e.targetId }}</div>
                <div class="rel-meta">{{ e.reason }}</div>
                <div class="source-quote" v-if="e.quote">{{ e.quote }}</div>
              </div>
              <span class="rel-arrow">→</span>
            </div>
          </div>
        </div>

        <div v-if="!edges.length && !entities.length && !loading" class="empty-state">
          <p>这个文献没有可显示的断言。</p>
        </div>
      </template>
    </div>
  `,
};
