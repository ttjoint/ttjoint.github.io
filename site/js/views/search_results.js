/* ============================================
   HumanMap — SearchResults
   搜索结果列表

   依赖 js/services.js 暴露的服务（DataStore/SearchEngine/relations/…），
   由 index.html 在本文件之前加载。
   ============================================ */

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
    async doSearch() {
      this.results = this.query ? await SearchEngine.search(this.query, 50) : [];
    },
    navigate(item) {
      this.$router.push(typeRoute(item.type, item.id));
    },
    typeLabel(t) { return typeLabel(t); }
  },
  template: `
    <div>
      <div class="breadcrumb">
        <router-link to="/">首页</router-link>
        <span class="bc-sep">/</span>
        <span>搜索: "{{ query }}"</span>
      </div>
      <p style="color:var(--color-text-secondary);margin-bottom:16px">找到 {{ results.length }} 个结果</p>
      <!-- 结果网格：宽屏多列。单列时 2560px 屏幕上每行只放一条，
           下面留一大片空白，翻页要滚很久。 -->
      <div v-if="results.length" class="result-grid">
        <div v-for="r in results" :key="r.id" class="relation-item" @click="navigate(r)">
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
