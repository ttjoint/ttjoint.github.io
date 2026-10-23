/* ============================================
   HumanMap — 数据源溯源链

   从 entity_detail.js 拆出。回答「这条记录是从哪来的」：
   evidence 节点 → 它的上层文献 → …… → 本条目。

   依赖 js/services.js 暴露的服务，由 index.html 在本文件之前加载。
   ============================================ */

const EntitySourceChain = {
  props: {
    sources: { type: Array, default: () => [] },
    entity: { type: Object, required: true },
    entityType: { type: String, default: 'person' },
    open: { type: Boolean, default: true },
  },
  emits: ['toggle', 'navigate'],
  methods: {
    typeTagClass(t) {
      return t === 'person' ? 'primary' : t === 'organization' ? 'accent' : 'warning';
    },
  },
  template: `
    <div v-if="sources.length" class="card">
      <div class="card-header collapse-header" @click="$emit('toggle')">
        <span class="card-title">数据源溯源</span>
        <span class="card-subtitle">{{ sources.length }} 层</span>
        <span class="collapse-arrow" style="margin-left:auto">{{ open ? '▲' : '▼' }}</span>
      </div>
      <div v-if="open" class="source-chain-container">
        <div class="source-chain">
          <div class="source-chain-item" v-for="(src, i) in sources" :key="src.id">
            <div class="source-card">
              <div class="source-card-header">
                <div class="source-card-title-row">
                  <span class="source-card-name">{{ src.name }}</span>
                  <span class="source-type-badge" v-if="src.type" :class="src.type">{{ src.type }}</span>
                </div>
                <span class="source-card-date" v-if="src.publicationDate || src.date">{{ src.publicationDate || src.date }}</span>
              </div>
              <div class="source-card-body">
                <!-- Evidence fields.
                     只显示 name/url 的话，一条引用说不了「谁载着它、
                     什么媒介、什么时候」。 -->
                <template v-if="src._evidenceRows && src._evidenceRows.length">
                  <div v-for="row in src._evidenceRows" :key="row.key" class="source-card-field">
                    <span class="source-label">{{ row.label }}：</span>
                    <a v-if="row.link" :href="row.value" target="_blank" rel="noopener" class="source-url">{{ row.value }}</a>
                    <span v-else>{{ row.value }}</span>
                  </div>
                </template>
                <div v-else>
                  <div v-if="src.author && !src.transcriberName" class="source-card-field">
                    <span class="source-label">作者：</span>
                    <span>{{ src.author }}</span>
                  </div>
                  <div v-if="src.transcriberName" class="source-card-transcriber">
                    <span class="source-label">转述者：</span>
                    <span class="tag clickable primary" @click="$emit('navigate', src.transcriber, src.transcriberType)">{{ src.transcriberName }}</span>
                  </div>
                  <div v-if="src.publisher" class="source-card-field">
                    <span class="source-label">出版机构：</span>
                    <span>{{ src.publisher }}</span>
                  </div>
                  <div v-if="src.isbn" class="source-card-field">
                    <span class="source-label">ISBN：</span>
                    <span class="source-isbn">{{ src.isbn }}</span>
                  </div>
                  <div v-if="src.url" class="source-card-field">
                    <span class="source-label">链接：</span>
                    <a :href="src.url" target="_blank" rel="noopener" class="source-url">{{ src.url }}</a>
                  </div>
                  <div v-if="src.previousSourceName" class="source-card-prev">
                    <span class="source-label">上层来源：</span>
                    <span class="source-prev-name">{{ src.previousSourceName }}</span>
                  </div>
                  <div v-if="src.accessedAt" class="source-card-field"><span class="source-label">抓取时间：</span>{{ src.accessedAt }}</div>
                  <div v-if="src.note" class="source-card-note">{{ src.note }}</div>
                </div>
              </div>
            </div>
            <div class="source-chain-arrow" v-if="i < sources.length - 1">
              <span class="arrow-icon">↑</span>
              <span class="arrow-label">引自</span>
            </div>
          </div>
          <div class="source-chain-item source-chain-entity">
            <div class="source-card source-card-entity">
              <div class="source-card-header">
                <div class="source-card-title-row">
                  <span class="source-card-name">{{ entity.name }}</span>
                  <span class="tag" :class="typeTagClass(entityType)" style="font-size:.7rem">本条目</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
};
