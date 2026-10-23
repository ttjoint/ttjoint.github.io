/* ============================================
   HumanMap — 实体信息卡

   名字、别名、字段表。从 entity_detail.js 拆出：
   那个文件原本 772 行，把「这个实体是什么」和「它和谁有关系」
   混在一起，改任何一处都要在 700 行里找位置。

   依赖 js/services.js 暴露的服务，由 index.html 在本文件之前加载。
   ============================================ */

const EntityInfoCard = {
  props: {
    entity: { type: Object, required: true },
    entityType: { type: String, default: 'person' },
    resolvedProps: { type: Object, default: () => ({}) },
    fieldCites: { type: Object, default: () => ({}) },
    citeOpen: { type: String, default: null },
    citeCount: { type: Number, default: 0 },
  },
  emits: ['toggle-cite', 'navigate'],
  methods: {
    typeLabel(t) {
      return { person: '人物', organization: '组织', event: '事件', thing: '物', evidence: '证据' }[t] || t;
    },
    typeTagClass(t) {
      return t === 'person' ? 'primary' : t === 'organization' ? 'accent' : 'warning';
    },
  },
  template: `
    <div class="card">
      <div class="card-header">
        <span class="card-title">{{ entity.name }}</span>
        <button class="cite-btn" type="button"
                :class="{ 'cite-btn--active': citeOpen === 'entity' }"
                :aria-expanded="citeOpen === 'entity' ? 'true' : 'false'"
                :title="citeCount ? ('查看引用来源（' + citeCount + ' 条）') : '此记录暂无引用来源'"
                @click.stop="$emit('toggle-cite', 'entity', $event)">
          <span aria-hidden="true">ⓘ</span><span class="cite-btn-count" v-if="citeCount">{{ citeCount }}</span>
        </button>
        <span class="tag" :class="typeTagClass(entityType)">
          {{ typeLabel(entityType) }}
        </span>
      </div>

      <div v-if="entity.aliases?.length" style="margin-bottom:12px">
        <span class="tag" v-for="a in entity.aliases" :key="a">{{ a }}</span>
      </div>

      <table class="info-table">
        <template v-for="(value, key) in resolvedProps" :key="key">
          <tr v-if="value">
            <td>{{ key }}</td>
            <td>
              <template v-if="value._multi">
                <template v-for="(part, pi) in value.parts" :key="pi">
                  <span v-if="part._ref && part.missing" class="static-unpublished"
                        :title="part.id + ' 不在已发布范围内'">（未收录）</span>
                  <span v-else-if="part._ref" class="tag clickable primary" @click="$emit('navigate', part.id, part.type)">{{ part.name }}</span>
                  <span v-else>{{ part.text }}</span>
                </template>
              </template>
              <template v-else-if="value._ref">
                <span v-if="value.missing" class="static-unpublished"
                      :title="value.id + ' 不在已发布范围内'">（未收录）</span>
                <span v-else class="tag clickable primary" @click="$emit('navigate', value.id, value.type)">
                  {{ value.name }}
                </span>
              </template>
              <template v-else>{{ value }}</template>
              <!-- 字段级来源：provenance.reason 列出了这个字段是根据哪条原始记录填的 -->
              <button v-if="fieldCites[key]" class="cite-btn cite-btn--inline" type="button"
                      :class="{ 'cite-btn--active': citeOpen === 'field:' + key }"
                      :title="'查看「' + key + '」的引用来源'"
                      @click.stop="$emit('toggle-cite', 'field:' + key, $event)">
                <span aria-hidden="true">ⓘ</span>
              </button>
            </td>
          </tr>
        </template>
      </table>
    </div>
  `,
};
