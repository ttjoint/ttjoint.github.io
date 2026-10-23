/* ============================================
   HumanMap — 家谱视图（family tree）

   与详情页分离的理由：详情页回答「这个人是什么」，家谱回答「这个人和谁连着」。
   后者需要递归查询，只有后端在时才可用；混进详情页会让所有实体页都背上一次
   可能失败的网络请求。

   数据来源：GET /api/tree/:id?dir=up|down&depth=N&predicate=...
   后端不存在时整个视图显示为「需要后端」，而不是空图——空图会被读成「此人无亲属」，
   那是完全不同的一句话。
   ============================================ */

const FamilyTreePage = {
  template: `
  <div class="page family-tree-page">
    <div class="page-header">
      <button class="btn btn-ghost" @click="back">← 返回</button>
      <h1 class="page-title">{{ entity ? entity.name : id }}</h1>
      <span class="page-subtitle" v-if="entity && entity.valid_from">
        {{ formatYear(entity.valid_from) }}<template v-if="entity.valid_to">–{{ formatYear(entity.valid_to) }}</template>
      </span>
    </div>

    <div v-if="!apiAvailable" class="empty-state">
      <p>家谱图需要后端查询服务。</p>
      <p class="hint">启动方式：<code>node scripts/serve_api.js</code>，然后访问 127.0.0.1:8787。</p>
    </div>

    <template v-else>
      <div class="tree-controls">
        <div class="control-group">
          <label>方向</label>
          <button
            v-for="d in directions" :key="d.key"
            class="btn" :class="{ 'btn-primary': dir === d.key }"
            @click="setDir(d.key)">{{ d.label }}</button>
        </div>
        <div class="control-group">
          <label>代数</label>
          <input type="range" min="1" :max="maxDepth" v-model.number="depth" @change="load" />
          <span class="depth-value">{{ depth }}</span>
        </div>
        <div class="control-group">
          <label>只看</label>
          <select v-model="predicate" @change="load">
            <option value="">全部关系</option>
            <option v-for="p in predicates" :key="p.predicate" :value="p.predicate">
              {{ p.predicate }} ({{ p.n }})
            </option>
          </select>
        </div>
      </div>

      <div v-if="loading" class="loading">正在查询…</div>
      <div v-else-if="error" class="empty-state error">查询失败：{{ error }}</div>
      <div v-else-if="!rows.length" class="empty-state">
        <!-- Distinguish the two reasons a tree can be empty. Saying "no relatives"
             when the answer is "no relatives OF THIS KIND" would be wrong. -->
        <p v-if="predicate">此人没有「{{ predicate }}」类的{{ dir === 'up' ? '祖先' : '后代' }}。</p>
        <p v-else>此人没有任何{{ dir === 'up' ? '上溯' : '下溯' }}关系。</p>
      </div>

      <div v-else class="tree-body">
        <div class="tree-summary">
          {{ rows.length - 1 }} 位{{ dir === 'up' ? '祖先' : '后代' }}，最深 {{ maxReachedDepth }} 代
          <span v-if="duplicates.length" class="warn-inline">
            · {{ duplicates.length }} 人出现在多代（谱系交叉，不是重复）
          </span>
        </div>

        <!-- One row per generation. Rendering as a graph would need layout and
             would hide the depth information, which is the actual answer here. -->
        <div v-for="gen in generations" :key="gen.depth" class="tree-generation">
          <div class="generation-label">{{ gen.depth === 0 ? '本人' : gen.depth + ' 代' }}</div>
          <div class="generation-people">
            <a
              v-for="p in gen.people" :key="p.id"
              class="tree-person"
              :class="{ 'is-focus': gen.depth === 0 }"
              :href="'#/person/' + p.id"
              @click.prevent="go(p.id)">
              <span class="tree-person-name">{{ p.name || p.id }}</span>
              <span class="tree-person-years" v-if="p.valid_from || p.valid_to">
                {{ formatYear(p.valid_from) }}–{{ formatYear(p.valid_to) }}
              </span>
            </a>
          </div>
        </div>

        <p v-if="reachedLimit" class="hint">
          已达到 {{ maxDepth }} 代上限。再往上会走出可信范围，因此不再展开。
        </p>
      </div>
    </template>
  </div>`,

  data() {
    return {
      dir: 'up',
      depth: 5,
      predicate: '',
      rows: [],
      entity: null,
      loading: false,
      error: null,
      maxDepth: 8,
      directions: [
        { key: 'up', label: '上溯（祖先）' },
        { key: 'down', label: '下溯（后代）' },
      ],
    };
  },

  computed: {
    id() {
      return decodeURIComponent(this.$route.params.id || '');
    },
    apiAvailable() {
      return !!(this.$root && this.$root.apiAvailable);
    },
    predicates() {
      const h = window.HMApi && Api && Api.health;
      return (h && h.predicates) || [];
    },
    /** Group rows by depth, keeping the server's ordering. */
    generations() {
      const out = [];
      const byDepth = new Map();
      for (const r of this.rows) {
        if (!byDepth.has(r.depth)) {
          const gen = { depth: r.depth, people: [] };
          byDepth.set(r.depth, gen);
          out.push(gen);
        }
        byDepth.get(r.depth).people.push(r);
      }
      return out;
    },
    maxReachedDepth() {
      return this.rows.reduce((m, r) => Math.max(m, r.depth), 0);
    },
    /**
     * People reachable at more than one depth.
     *
     * Not an error: a pedigree collapse (cousins marrying) means the same ancestor
     * is reachable by several paths, and the depth is the shortest one only because
     * UNION keeps the first. Surfaced so the count is not read as a bug.
     */
    duplicates() {
      const depthById = new Map();
      for (const r of this.rows) {
        if (!depthById.has(r.id)) depthById.set(r.id, new Set());
        depthById.get(r.id).add(r.depth);
      }
      return [...depthById.entries()].filter(([, d]) => d.size > 1).map(([id]) => id);
    },
    reachedLimit() {
      return this.maxReachedDepth >= this.depth && this.rows.length > 1;
    },
  },

  mounted() {
    this.fetchEntity();
    if (this.apiAvailable) this.load();
  },

  watch: {
    // `apiAvailable` flips once, after the probe resolves. Without this watcher a
    // page opened before the probe finished would stay empty forever.
    apiAvailable(up) {
      if (up) this.load();
    },
    id() {
      this.fetchEntity();
      if (this.apiAvailable) this.load();
    },
  },

  methods: {
    async fetchEntity() {
      this.entity = await loadEntityDetail(this.id);
    },

    async load() {
      if (!this.apiAvailable) return;
      this.loading = true;
      this.error = null;
      try {
        const res = await apiTree(this.id, {
          dir: this.dir,
          depth: this.depth,
          predicate: this.predicate || undefined,
        });
        this.rows = (res && res.rows) || [];
        if (res && res.maxDepth) this.maxDepth = res.maxDepth;
      } catch (e) {
        this.error = e.message;
        this.rows = [];
      } finally {
        this.loading = false;
      }
    },

    setDir(dir) {
      this.dir = dir;
      this.load();
    },

    formatYear(jdn) {
      if (!jdn) return '';
      // HMTime.jdnToYear then formatYear: the browser module works in Julian day
      // numbers, the same unit the database stores, so no conversion table is
      // duplicated here.
      if (!window.HMTime) return String(jdn);
      return HMTime.formatYear(HMTime.jdnToYear(jdn));
    },

    go(id) {
      if (id === this.id) return;
      this.$router.push('/tree/' + encodeURIComponent(id));
    },

    back() {
      this.$router.back();
    },
  },
};
