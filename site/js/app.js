/* ============================================
   HumanMap — 应用装配入口（app）

   本文件只做四件事：
     1. 定义路由
     2. 创建根实例（主题、数据统计、编辑器/关系面板的打开）
     3. 注册全局组件
     4. 挂载

   所有服务在 js/services.js，所有组件在 js/views/。
   本文件不含业务逻辑——要改行为请改对应的 view 或 core 模块。

   加载顺序（见 index.html）：
     js/core/*.js → js/services.js → js/views/*.js → js/app.js
   ============================================ */

const routes = [
  { path: '/', name: 'home', component: HomePage },
  { path: '/person/:id', name: 'person', component: PersonDetail },
  { path: '/org/:id', name: 'org', component: OrgDetail },
  { path: '/event/:id', name: 'event', component: EventDetail },
  // thing and evidence reuse the same detail factory: an entity page only needs
  // name/props/relations/sources, which all five types share.
  { path: '/thing/:id', name: 'thing', component: ThingDetail },
  { path: '/evidence/:id', name: 'evidence', component: EvidenceDetail },
  { path: '/search', name: 'search', component: SearchResults },
  // 谓词独立成页，不做弹窗：谓词是结构性定义，需要深链接和搜索。
  // 原先在 relation_panel 抽屉里，既不能分享链接，又带增删改——
  // 而谓词是代码资产，不该由界面改。
  { path: '/predicate', name: 'predicate', component: PredicateIndexPage },
  { path: '/detector', name: 'detector', component: DetectorPage },
  { path: '/predicate/:key', name: 'predicate-detail', component: PredicateDetailPage },
  // 反向视图：从证据文件看它支撑了哪些断言。
  // 管理界面（后续 S3）要用这个方向核对 bot 抽取质量。
  { path: '/sources', name: 'sources', component: SourceIndexPage },
  { path: '/sources/:title', name: 'source-detail', component: SourceDetailPage },
  { path: '/all', name: 'all', component: AllObjects },
  // The family tree is its own page rather than a panel inside the detail view:
  // it needs a recursive query the static shards cannot answer, and mixing that
  // into every entity page would make them all depend on the backend.
  { path: '/tree/:id', name: 'tree', component: FamilyTreePage }
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
      // Whether the SQLite-backed API answered. Starts false so the first render
      // does not promise a family tree it cannot draw; flips in mounted().
      apiAvailable: false,
      dataVersion: 0,
      dataStats: {
        loaded: false,
        personCount: 0,
        orgCount: 0,
        eventCount: 0,
        edgeCount: 0,
        lastUpdate: ''
      }
    };
  },
  mounted() {
    const saved = localStorage.getItem('hm_theme');
    if (saved) this.theme = saved;
    this.applyTheme();

    // Probe the SQLite API and load the shards in parallel. They answer different
    // questions and neither depends on the other; serialising them would make
    // startup wait for a network round trip that only some views need.
    //
    // A failed probe is not surfaced to the user: a static deploy has no backend
    // by design, and the views check `capabilities()` to decide what to offer.
    Api.probe().then((up) => {
      this.apiAvailable = up;
      if (up) {
        this.dataStats.edgeCount = Api.health.counts.edges;
      } else if (window.console) {
        console.info('无后端：家谱图、时间轴区间、全文检索不可用，其余照常。');
      }
    });

    DataStore.init().then(() => {
      this.dataStats.personCount = DataStore.personList.length;
      this.dataStats.orgCount = DataStore.orgList.length;
      this.dataStats.eventCount = DataStore.eventList.length;
      this.dataStats.loaded = true;
      this.dataStats.lastUpdate = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
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
    // 前端不提供编辑入口。
    //
    // 编辑必须走 commit 链路：改动落到 raw/（附文献依据）→ transformer 重跑
    // → 重新 build 第 2 层。前端直接改实体等于凭空产生没有 provenance、
    // 没有 commitId 的数据——而这正是清理 tags/era/kin 要消灭的东西。
    //
    // 管理界面的编辑（查看 bot 抽取了哪些证据、读原文划取、提交新抽取）
    // 属于后续 S3 后端阶段，见 docs/architecture/前端页面架构调整方案.md §2.3。
  }
});

app.config.globalProperties.$ds = DataStore;
app.config.globalProperties.$se = SearchEngine;

app.use(router);
// 详情页的子组件。拆出来是因为 entity_detail.js 原本 772 行，
// 把「这个实体是什么」「它和谁有关系」「这条记录从哪来」混在一起。
app.component('EntityInfoCard', EntityInfoCard);
app.component('EntitySourceChain', EntitySourceChain);
app.mount('#app');

// Remove the static fallback that `build_site.js` splices in for crawlers and
// no-JS visitors. It lives outside `#app` on purpose — the root component has no
// `template`, so Vue would otherwise compile that markup as part of the app.
// In the dev tree (repo root `index.html`) the element does not exist at all.
//
// Deferred to DOMContentLoaded on purpose: this script is loaded while the body is
// still being parsed, and the fallback sits further down (just before </body>), so
// it does not exist yet at this point. Looking it up synchronously returned null
// and the block stayed on the page forever.
//
// Guarded rather than assumed: `js/app.js` is loaded into a bare VM context by
// app_wiring.test.js, where `document` exists without getElementById. Throwing
// here would take down the whole wiring test for a cosmetic cleanup.
(function removeStaticFallback() {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
  const drop = () => {
    const el = document.getElementById('static-fallback');
    if (el) el.remove();
  };
  if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', drop, { once: true });
  } else {
    drop();
  }
})();
