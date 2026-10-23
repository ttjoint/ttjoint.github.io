/* ============================================
   HumanMap — AllObjects
   全量浏览 + 时间轴筛选

   依赖 js/services.js 暴露的服务（DataStore/SearchEngine/relations/…），
   由 index.html 在本文件之前加载。
   ============================================ */

const AllObjects = {
  components: { TimelineFilter: window.HMTime ? window.HMTime.TimelineFilter : null },
  data() {
    return {
      filterType: 'all',
      sortBy: 'name',
      sortAsc: true,
      searchQuery: '',
      sourceFilter: 'all',
      timeEnabled: false,
      timeFilter: null
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
      if (this.sourceFilter === 'cpc') {
        // Keyed on `external.cpcUrl` only. This used to also accept
        // `tags.includes('人民网专题')`, but `tags` is gone and carried no information
        // the URL does not: the importer set both from the same CPC topic page.
        items = items.filter(i => i.entity.external?.cpcUrl);
      }
      if (this.searchQuery) {
        const q = this.searchQuery.toLowerCase();
        items = items.filter(i => i.name.toLowerCase().includes(q) || i.subtitle.toLowerCase().includes(q));
      }
      // Timeline: keep only entities inside the dragged window whose date
      // confidence bucket is enabled. Undated items drop out while active.
      if (this.timeEnabled && this.timeFilter) {
        const tf = this.timeFilter;
        items = items.filter(i => window.HMTime.inWindow(i.entity, tf.loJdn, tf.hiJdn, tf.confidence));
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
    typeLabel(t) { return typeLabel(t); },
    navigate(item) {
      this.$router.push(typeRoute(item.type, item.id));
    },
    toggleSort(field) {
      if (this.sortBy === field) {
        this.sortAsc = !this.sortAsc;
      } else {
        this.sortBy = field;
        this.sortAsc = true;
      }
    },
    onTimeChange(filter) {
      this.timeFilter = filter;
      this.timeEnabled = true;
    },
    onTimeToggle() {
      if (!this.timeEnabled) this.timeEnabled = false;
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
          <button class="btn btn-sm" :class="{ 'btn-primary': sourceFilter === 'cpc' }" @click="sourceFilter = sourceFilter === 'cpc' ? 'all' : 'cpc'">
            人民网专题
          </button>
          <button class="btn btn-sm" :class="{ 'btn-primary': timeEnabled }" @click="timeEnabled = !timeEnabled">
            ⏱ 时间轴
          </button>
        </div>
      </div>

      <timeline-filter v-if="timeEnabled" @change="onTimeChange"></timeline-filter>

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
