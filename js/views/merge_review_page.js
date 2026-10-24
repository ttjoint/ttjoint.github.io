/* ============================================
   HumanMap — 归并审查页

   跨来源实体归并是**判断**，不是事实。这个页面让人看清哪些判断
   已经做了、依据是什么、哪些该重新看。

   为什么必须可审查：
   - 归并错了就是把两个人的数据混在一起，而且看不出错
   - 「同名」不是充分条件（历史上同名人物极多）
   - 归并的置信度差别很大：生卒年完全一致 vs 差 45 年

   按置信度分档是页面的核心。用户不该从 29 条里一条条看，
   而应该先看 far 那 2 条——那里出错的代价最高。

   依赖 js/services.js 的 Api，由 index.html 在本文件之前加载。
   ============================================ */

const MergeReviewPage = {
  data() {
    return {
      merges: [],
      counts: { exact: 0, near: 0, far: 0, unknown: 0 },
      total: 0,
      loading: true,
      apiAvailable: false,
      error: null,
      // 默认只看 far（最可疑的）。exact 的 23 条没必要逐条看。
      tierFilter: 'far',
    };
  },
  computed: {
    visible() {
      if (this.tierFilter === 'all') return this.merges;
      return this.merges.filter((m) => m.tier === this.tierFilter);
    },
    tiers() {
      return [
        { key: 'far', label: '差异大', count: this.counts.far, hint: '需要人工确认' },
        { key: 'near', label: '差 1–2 年', count: this.counts.near, hint: '通常是农历跨年' },
        { key: 'exact', label: '完全一致', count: this.counts.exact, hint: '基本可确信' },
        { key: 'all', label: '全部', count: this.total, hint: '' },
      ];
    },
  },
  methods: {
    fmt(v) {
      return v == null ? '不详' : String(v);
    },
    span(p) {
      if (p.from == null && p.to == null) return '不详';
      return `${this.fmt(p.from)} – ${this.fmt(p.to)}`;
    },
    tierLabel(t) {
      return { exact: '完全一致', near: '差 1–2 年', far: '差异大', unknown: '无时间' }[t] || t;
    },
    tierClass(t) {
      return {
        exact: 'tier tier--ok',
        near: 'tier tier--warn',
        far: 'tier tier--bad',
        unknown: 'tier tier--muted',
      }[t] || 'tier';
    },
    // 差异说明。让读者一眼看出「差在哪」，不用自己心算。
    diffText(m) {
      const parts = [];
      if (m.birthDiff != null && m.birthDiff > 0) parts.push(`生年差 ${m.birthDiff} 年`);
      if (m.deathDiff != null && m.deathDiff > 0) parts.push(`卒年差 ${m.deathDiff} 年`);
      return parts.length ? parts.join('，') : '一致';
    },
    // 为什么 near 档通常是跨年而不是真分歧——这个解释必须写在页面上，
    // 否则用户会以为「差 1 年」也需要处理。
    nearHint(m) {
      if (m.tier !== 'near') return '';
      return '农历年末换算成公历已入次年。两个来源都对，只是纪年方式不同。';
    },
  },
  async mounted() {
    await Api.whenReady();
    this.apiAvailable = Api.isAvailable();
    if (!this.apiAvailable) {
      this.loading = false;
      return;
    }
    try {
      const data = await Api.get('/api/merges');
      this.merges = data.merges || [];
      this.counts = data.counts || this.counts;
      this.total = data.total || 0;
      // 没有 far 时自动切到 near，避免打开就是空页
      if (this.counts.far === 0) this.tierFilter = this.counts.near ? 'near' : 'all';
    } catch (e) {
      this.error = e.message;
    } finally {
      this.loading = false;
    }
  },
  template: `
    <div class="merge-page">
      <nav class="breadcrumb">
        <router-link to="/">首页</router-link>
        <span class="sep">/</span>
        <span>归并审查</span>
      </nav>

      <header class="page-header">
        <h1>跨来源实体归并</h1>
        <p class="page-sub">
          同一个人在不同来源有不同实体（苏轼 = CBDB + 维基百科）。归并是
          <b>判断，不是事实</b>——错了就是把两个人的数据混在一起。这里让人看清
          每条判断的依据，以及哪些值得重新看。
        </p>
      </header>

      <div v-if="!apiAvailable" class="empty-hint">
        <p>归并清单需要后端。</p>
        <p class="hint-sub">本地启动：<code>npm run serve</code></p>
      </div>
      <div v-else-if="loading" class="loading-hint">加载中…</div>
      <div v-else-if="error" class="empty-hint"><p>加载失败：{{ error }}</p></div>

      <template v-else>
        <section class="tier-row">
          <button v-for="t in tiers" :key="t.key"
                  class="tier-card"
                  :class="{ 'tier-card--active': tierFilter === t.key }"
                  @click="tierFilter = t.key">
            <div class="tier-num">{{ t.count }}</div>
            <div class="tier-label">{{ t.label }}</div>
            <div v-if="t.hint" class="tier-hint">{{ t.hint }}</div>
          </button>
        </section>

        <section v-if="!visible.length" class="empty-hint">
          <p>这个分档没有归并记录。</p>
        </section>

        <section class="merge-list">
          <article v-for="m in visible" :key="m.mergedId" class="merge-card">
            <header class="merge-head">
              <h2 class="merge-name">{{ m.name }}</h2>
              <span :class="tierClass(m.tier)">{{ tierLabel(m.tier) }}</span>
              <span class="merge-diff">{{ diffText(m) }}</span>
            </header>

            <div class="merge-compare">
              <div class="merge-side">
                <div class="merge-side-label">主实体（保留）</div>
                <router-link class="merge-id" :to="'/entity/' + encodeURIComponent(m.canonicalId)">
                  {{ m.canonicalId }}
                </router-link>
                <div class="merge-lifespan">{{ span(m.canonical) }}</div>
              </div>
              <div class="merge-arrow">←</div>
              <div class="merge-side">
                <div class="merge-side-label">归到主实体名下</div>
                <router-link class="merge-id" :to="'/entity/' + encodeURIComponent(m.mergedId)">
                  {{ m.mergedId }}
                </router-link>
                <div class="merge-lifespan">{{ span(m.merged) }}</div>
              </div>
            </div>

            <p v-if="nearHint(m)" class="merge-near-hint">{{ nearHint(m) }}</p>

            <div class="merge-reason">
              <span class="merge-reason-label">归并依据：</span>{{ m.reason }}
            </div>

            <div class="merge-actions">
              <span class="merge-cmd">撤销：<code>node scripts/merge_entities.js --unmerge {{ m.mergedId }}</code></span>
            </div>
          </article>
        </section>

        <section class="merge-note">
          <h3>归并规则与风险</h3>
          <p>
            自动归并条件（全部满足才归并）：同类型、同名、生卒年相差 &lt; 20 年。
            任一不满足就留两个实体，等人判断——<b>宁可留重复，不可错并</b>。
          </p>
          <p>
            归并是<b>建链接</b>不是物理合并：原始实体和它的边一条不动，查询时
            视为同一人。所以撤销只需删一条记录，所有数据自动恢复原状，
            两个来源的不同说法也不会丢。
          </p>
          <p class="merge-note-sub">
            重跑：<code>node scripts/merge_entities.js</code>　
            列表：<code>node scripts/merge_entities.js --list</code>
          </p>
        </section>
      </template>
    </div>
  `,
};
