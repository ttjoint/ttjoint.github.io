/* ============================================
   HumanMap — SearchBar
   顶部搜索栏：输入、模糊检索、类型筛选、高级筛选

   依赖 js/services.js 暴露的服务（DataStore/SearchEngine/relations/…），
   由 index.html 在本文件之前加载。
   ============================================ */

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
      <div v-if="focused && (results.length || searched)" class="search-results-dropdown">
        <div v-if="!results.length" class="search-empty">没有找到匹配的条目</div>
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
      // True once a query has finished running. Without it an empty result set is
      // indistinguishable from "nothing has been typed yet", so the dropdown stayed
      // closed and a user whose query simply matched nothing saw no feedback at all —
      // the same symptom as a completely broken search box.
      searched: false,
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
    async doSearch() {
      let results = this.value ? await SearchEngine.search(this.value, 20) : [];
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
      this.searched = !!this.value;
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
      // A single character: this badge sits inline in a narrow result row.
      // Kept local because it is a compact variant, not the full label (which
      // would clip); both still derive from the shared schema so a new type
      // cannot render as a raw key.
      const short = { person: '人', thing: '物', organization: '组', event: '事', evidence: '证' };
      return short[t] || (EntitySchema[t] ? EntitySchema[t].label : t);
    }
  }
};

// -- 首页 --
