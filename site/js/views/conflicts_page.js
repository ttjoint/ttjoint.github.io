/* ============================================
   HumanMap — 数据分歧总览页

   冲突在实体页只能一个一个看。这个页面把全部冲突集中，
   按「性质」分类——性质决定读法：

     跨年换算   两个都对，纪年方式不同。农历年末的生日换算成
                公历已入次年，「绍兴十一年十二月廿九」就是
                1142-01-27。读法：两个说法是同一事实的两种写法。
     学界争议   不同考证各有所本。系统并列，不选边——选边就是
                替史学界下结论。

   分类是启发式，可能错分。但错分不致命：所有说法都并列保留，
   出处都可溯源。分类只是引导阅读顺序，不是判定。

   依赖 js/services.js 的 Api，由 index.html 在本文件之前加载。
   ============================================ */

const ConflictsPage = {
  data() {
    return {
      conflicts: [],
      counts: { 'calendar-crossing': 0, 'scholarly-dispute': 0 },
      total: 0,
      loading: true,
      apiAvailable: false,
      error: null,
      // 默认先看学界争议——跨年那类读一遍就懂，争议才值得停留
      filter: 'scholarly-dispute',
    };
  },
  computed: {
    visible() {
      if (this.filter === 'all') return this.conflicts;
      return this.conflicts.filter((c) => c.category === this.filter);
    },
    cats() {
      return [
        {
          key: 'scholarly-dispute',
          label: '学界争议',
          count: this.counts['scholarly-dispute'] || 0,
          hint: '不同考证各有所本，系统不选边',
        },
        {
          key: 'calendar-crossing',
          label: '跨年换算',
          count: this.counts['calendar-crossing'] || 0,
          hint: '农历年末已入公历次年，两个都对',
        },
        { key: 'all', label: '全部', count: this.total, hint: '' },
      ];
    },
  },
  methods: {
    predLabel(p) {
      return { birthDate: '生', deathDate: '卒' }[p] || p;
    },
    catLabel(c) {
      return { 'calendar-crossing': '跨年', 'scholarly-dispute': '争议' }[c] || c;
    },
    catClass(c) {
      return {
        'calendar-crossing': 'cat cat--cal',
        'scholarly-dispute': 'cat cat--dispute',
      }[c] || 'cat';
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
      const data = await Api.get('/api/conflicts');
      this.conflicts = data.conflicts || [];
      this.counts = data.counts || this.counts;
      this.total = data.total || 0;
      // 没有争议类时切到跨年，避免打开空页
      if (!(this.counts['scholarly-dispute'] > 0)) this.filter = 'all';
    } catch (e) {
      this.error = e.message;
    } finally {
      this.loading = false;
    }
  },
  template: `
    <div class="conflict-page">
      <nav class="breadcrumb">
        <router-link to="/">首页</router-link>
        <span class="sep">/</span>
        <span>数据分歧</span>
      </nav>

      <header class="page-header">
        <h1>数据分歧</h1>
        <p class="page-sub">
          多个来源对同一事实给出不同说法。系统<b>并列保留全部说法</b>、
          标明各自出处，不替任何人选边。按性质分类只是为了引导读法——
          分错了不致命，出处永远可查。
        </p>
      </header>

      <div v-if="!apiAvailable" class="empty-hint">
        <p>分歧清单需要后端。</p>
        <p class="hint-sub">本地启动：<code>npm run serve</code></p>
      </div>
      <div v-else-if="loading" class="loading-hint">加载中…</div>
      <div v-else-if="error" class="empty-hint"><p>加载失败：{{ error }}</p></div>
      <div v-else-if="!total" class="empty-hint">
        <p>当前没有检测到数据分歧。</p>
        <p class="hint-sub">
          冲突要有两个以上独立来源才会出现。先跑
          <code>node scripts/run_detectors.js</code>。
        </p>
      </div>

      <template v-else>
        <section class="cat-row">
          <button v-for="c in cats" :key="c.key"
                  class="cat-card"
                  :class="{ 'cat-card--active': filter === c.key }"
                  @click="filter = c.key">
            <div class="cat-num">{{ c.count }}</div>
            <div class="cat-label">{{ c.label }}</div>
            <div v-if="c.hint" class="cat-hint">{{ c.hint }}</div>
          </button>
        </section>

        <section class="conflict-list">
          <article v-for="c in visible" :key="c.subjectId + c.predicate" class="conflict-card">
            <header class="conflict-head">
              <router-link class="conflict-name" :to="'/entity/' + encodeURIComponent(c.subjectId)">
                {{ c.name }}
              </router-link>
              <span class="conflict-pred">{{ predLabel(c.predicate) }}</span>
              <span :class="catClass(c.category)">{{ catLabel(c.category) }}</span>
            </header>

            <!-- 各说法并列，等权重。任何暗示「第一个对」的样式都是错的。 -->
            <div class="conflict-values">
              <div v-for="v in c.values" :key="v.edgeId" class="conflict-value">
                <span class="conflict-value-text">{{ v.value }}</span>
              </div>
            </div>

            <p v-if="c.category === 'calendar-crossing'" class="conflict-explain">
              农历纪年的年末在公历里已是次年。两个说法是同一日期的两种纪年写法。
            </p>
            <p v-else class="conflict-explain">
              不同来源的考证各有所本。要看依据，点开人物页查每条说法的出处。
            </p>
          </article>
        </section>

        <section class="conflict-note">
          <h3>分类是怎么来的</h3>
          <p>
            启发式：年份差 1 且一方带月日 → 判「跨年」；其余 → 判「争议」。
            这个判据会错——整年对整年差 1 年时无法区分「跨年」和「争议」
            （王莽前45/前44 很可能也是跨年），统一归入「争议」让人看。
            <b>宁可让人看，不可暗示都对。</b>
          </p>
        </section>
      </template>
    </div>
  `,
};
