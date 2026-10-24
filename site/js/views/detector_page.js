/* ============================================
   HumanMap — 检测器管理页

   冲突检测器是「判断」，不是「事实」。这个页面让它可见、可审查。

   为什么需要独立页面而不是散在代码里：
   - 「冲突」的判定标准本身有争议（11 岁生子在古代是实情，
     按今天的常识是异常）
   - 判定固化成写死的规则，等于替使用者做了这个判断
   - 每条规则的依据、当前命中量、可能出错的方式，都该看得见

   为什么开关不走 HTTP：
   开关检测器会重算全表标注，是写操作。本系统的写操作一律走
   有审计、可回滚的路径（commit 链路），不是一个 POST 随手改的
   配置项。页面只负责「看清」，改由人决定、CLI 执行。

   依赖 js/services.js 暴露的服务，由 index.html 在本文件之前加载。
   ============================================ */

const DetectorPage = {
  data() {
    return {
      detectors: [],
      totalFlagged: 0,
      multiFlagged: 0,
      loading: true,
      apiAvailable: false,
      error: null,
    };
  },
  computed: {
    // 有命中量的排在前面：这些是真正在影响数据的规则。
    sorted() {
      return this.detectors.slice().sort((a, b) => b.flagged - a.flagged);
    },
    activeCount() {
      return this.detectors.filter((d) => d.flagged > 0).length;
    },
  },
  methods: {
    fmt(n) {
      return Number(n || 0).toLocaleString('en-US');
    },
    severityLabel(s) {
      return s === 'conflict' ? '史料分歧' : '逻辑可疑';
    },
    severityClass(s) {
      return s === 'conflict' ? 'badge badge--info' : 'badge badge--warn';
    },
    cmd(d) {
      return 'node scripts/run_detectors.js --off ' + d.id;
    },
  },
  async mounted() {
    // 等 probe 完成再判断可用性——isAvailable() 是同步检查，
    // 而 probe 在 app.mounted() 里异步跑，子组件可能先于它。
    await Api.whenReady();
    this.apiAvailable = Api.isAvailable();
    if (!this.apiAvailable) {
      this.loading = false;
      return;
    }
    try {
      const data = await Api.get('/api/detectors');
      this.detectors = data.detectors || [];
      this.totalFlagged = data.totalFlagged || 0;
      this.multiFlagged = data.multiFlagged || 0;
    } catch (e) {
      this.error = e.message;
    } finally {
      this.loading = false;
    }
  },
  template: `
    <div class="detector-page">
      <nav class="breadcrumb">
        <router-link to="/">首页</router-link>
        <span class="sep">/</span>
        <span>检测器</span>
      </nav>

      <header class="page-header">
        <h1>冲突检测器</h1>
        <p class="page-sub">
          这些规则<b>只标注，不改数据</b>。一条边被标为「可疑」不等于它是错的——
          更可能是录入错误，也可能是生年本身是推的，系统没有能力判断是哪一种。
        </p>
      </header>

      <div v-if="!apiAvailable" class="empty-hint">
        <p>检测器清单需要后端。</p>
        <p class="hint-sub">本地启动：<code>npm run serve</code></p>
      </div>

      <div v-else-if="loading" class="loading-hint">加载中…</div>

      <div v-else-if="error" class="empty-hint">
        <p>加载失败：{{ error }}</p>
      </div>

      <template v-else>
        <section class="stat-row">
          <div class="stat-card">
            <div class="stat-num">{{ detectors.length }}</div>
            <div class="stat-label">检测器总数</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">{{ activeCount }}</div>
            <div class="stat-label">有命中的</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">{{ fmt(totalFlagged) }}</div>
            <div class="stat-label">被标注的边</div>
          </div>
          <div class="stat-card">
            <div class="stat-num">{{ fmt(multiFlagged) }}</div>
            <div class="stat-label">被多条规则命中</div>
          </div>
        </section>

        <section class="detector-list">
          <article v-for="d in sorted" :key="d.id" class="detector-card">
            <header class="detector-head">
              <div class="detector-title-row">
                <h2 class="detector-title">{{ d.title }}</h2>
                <span :class="severityClass(d.severity)">{{ severityLabel(d.severity) }}</span>
                <span v-if="d.flagged === 0" class="badge badge--muted">无命中</span>
              </div>
              <div class="detector-id"><code>{{ d.id }}</code></div>
            </header>

            <div class="detector-count">
              <span class="detector-num">{{ fmt(d.flagged) }}</span>
              <span class="detector-unit">条边被标注</span>
            </div>

            <p class="detector-rationale">{{ d.rationale }}</p>

            <div class="detector-off">
              <span class="detector-off-label">关闭此检测器：</span>
              <code class="detector-cmd">{{ cmd(d) }}</code>
            </div>
          </article>
        </section>

        <section class="detector-note">
          <h3>为什么开关不走界面</h3>
          <p>
            开关检测器会重算全表标注，是<b>写操作</b>。本系统的写操作一律走
            有审计、可回滚的路径（commit 链路），不是一个 POST 随手改的配置项。
            所以这里只展示，改由人决定、CLI 执行。
          </p>
          <p>
            关闭某条规则时会同时清掉它的历史标注——否则「关掉」是假的：
            报告里旧标注还在，看起来仍在生效。
          </p>
          <p class="detector-note-sub">
            重算全部：<code>node scripts/run_detectors.js</code>　
            查看统计：<code>node scripts/run_detectors.js --report</code>　
            列出规则：<code>node scripts/run_detectors.js --list</code>
          </p>
        </section>
      </template>
    </div>
  `,
};
