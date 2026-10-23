/* ============================================
   HumanMap — HomePage
   首页：统计概览与入口

   依赖 js/services.js 暴露的服务（DataStore/SearchEngine/relations/…），
   由 index.html 在本文件之前加载。
   ============================================ */

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
      this.$router.push(typeRoute(item.type, item.id));
    }
  }
};

// -- 通用实体详情组件工厂 --
