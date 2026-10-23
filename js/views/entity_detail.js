/* ============================================
   HumanMap — createEntityDetail / PersonDetail / ThingDetail / OrgDetail
                / EventDetail / EvidenceDetail
   实体详情（三类实体共用一个工厂，见下）

   依赖 js/services.js 暴露的服务（DataStore/SearchEngine/relations/…），
   由 index.html 在本文件之前加载。
   ============================================ */

function createEntityDetail(entityType) {
  const entitySchema = EntitySchema[entityType];
  const routeName = entitySchema.route;

  return {
    name: entityType + '-detail',
    props: ['isLocal'],
    data() {
      return {
        entity: null,
        showGraph: true,
        showTimeline: true,
        showSources: true,
        entityType: entityType,
        schema: EntitySchema[entityType] || {},
        // Evidence nodes referenced by this entity's `sources`, keyed by id.
        // Fetched in `mounted` because they live in their own shards.
        evidenceMap: {},
        // Which citation popover is open, keyed by the element that opened it.
        // A single key rather than one boolean per row: the popovers are
        // position-fixed and only one can be meaningfully read at a time, and a
        // per-row flag would let the user open twenty of them at once.
        citeOpen: null,
        citePos: { top: 0, left: 0 },
        // 边级出处：由关系项的 ⓘ 填进来。与实体级的 citeRows 分开，
        // 因为「这个人生于 1042」和「他的父亲是某某」是两条不同的原始记录。
        relCiteRows: null,
      };
    },
    computed: {
      resolvedProps() {
        if (!this.entity?.props) return {};
        const resolved = {};
        for (const [key, value] of Object.entries(this.entity.props)) {
          if (!value) continue;
          // 提取所有【】引用（支持单个和多个引用混排）
          const refs = [];
          const parts = [];
          let lastIdx = 0;
          const re = /【(.+?)】/g;
          let m;
          const pushText = (text) => {
            if (!text) return;
            // 【】之外也可能直接写着裸 id。两种写法都是实体引用，都要可点，
            // 否则同一页会出现「有的 id 能点、有的不能点」的不一致。
            const bareRe = /(?:person|organization|event|thing|evidence):[A-Za-z0-9._-]+/g;
            let bm;
            let li = 0;
            while ((bm = bareRe.exec(text)) !== null) {
              if (bm.index > li) parts.push({ text: text.slice(li, bm.index) });
              const ref = DataStore.resolveBareId(bm[0]);
              if (ref) {
                refs.push(ref);
                parts.push({ _ref: true, id: ref.id, name: ref.name, type: ref.type });
              } else {
                parts.push({ text: bm[0] });
              }
              li = bm.index + bm[0].length;
            }
            if (li < text.length) parts.push({ text: text.slice(li) });
          };
          while ((m = re.exec(value)) !== null) {
            if (m.index > lastIdx) {
              pushText(value.slice(lastIdx, m.index));
            }
            const ref = DataStore.resolveRef(m[0]);
            if (ref) {
              refs.push(ref);
              parts.push({ _ref: true, id: ref.id, name: ref.name, type: ref.type });
            } else {
              parts.push({ text: m[0] });
            }
            lastIdx = m.index + m[0].length;
          }
          if (lastIdx < value.length) {
            pushText(value.slice(lastIdx));
          }
          // 没有引用 → 纯文本；有引用 → 返回 parts 数组供模板遍历
          if (refs.length === 0) {
            resolved[key] = value;
          } else {
            resolved[key] = { _multi: true, parts };
          }
        }
        return resolved;
      },
      resolvedRelations() {
        if (!this.entity?.relations) return {};
        const resolved = {};
        for (const [relKey, relData] of Object.entries(this.entity.relations)) {
          const relDef = RelationRegistry[relKey];
          // 缺省反向关系：显示但标记为 auto-generated
          const isAuto = !relDef && isDefaultInverse(relKey);
          // 未注册的谓词过去直接 `continue` 跳过。那会让数据变得不可见：
          // 一条只有数据库认识、前端注册表还没跟上的谓词（例如刚加的 `era`）
          // 在页面上完全消失，而且不报错——看起来就像「这个人没有朝代」。
          // 宁可显示原始键名，也不要静默丢弃已有数据。
          // `relDef.label` 是基础谓词的标签：`father/反` 会显示成「父亲」，
          // 于是「他的父亲是甲」和「甲的父亲是他」在页面上长得一样。
          // `HMPredicates.label` 保留 `/反` 修饰符（显示为「父亲（反）」）。
          const label = relDef ? HM.HMPredicates.label(relKey) : relKey;
          const icon = relDef ? relDef.icon : '↩';
          const hasRole = relDef ? relDef.hasRole : false;
          // 字面量谓词（时代 / 性别 / 民族）的目标是值，不是实体 id。
          // 不区分的话模板会按 id 去 navigate，跳到一条并不存在的实体页。
          const isLiteral = !!relDef && relDef.targetType === 'literal';
          if (hasRole) {
            resolved[label] = relData.map(r => {
              const tid = r.target || r.id;
              // `resolveName` 对未加载的实体回退到裸 id。在发布切片里这意味着
              // 「目标被时间窗口过滤掉了」（例如 1900 年前的配偶），而不是「名字就叫这个」。
              // 直接渲染裸 id 会泄露内部标识符，并且把它做成可点链接——点进去是一片空白。
              // 名字优先用条目自带的 `name`（API 的 `other_name`）。
              // 只靠 `DataStore.getEntity` 判定会让全量库里的实体显示成
              // 「（未收录）」——它们不在发布切片里，但确实存在。
              const known = !!DataStore.getEntity(tid);
              const ownName = r.name || null;
              return {
                ...r,
                id: tid,
                // 原始谓词键：`父亲（反）` 的 label 是显示用的，
                // 要跳谓词页得知道它其实是 `father/反`。
                _predicate: relKey,
                name: ownName || (known ? DataStore.resolveName(tid) : tid),
                type: r.type || DataStore.getType(tid),
                _missing: !ownName && !known,
                icon, _auto: isAuto,
                _prov: Array.isArray(r.provenance) ? r.provenance : null,
              };
            });
          } else {
            resolved[label] = relData.map(entry => {
              // 分片里的条目有两种形状：裸 id 字符串，或 `{id, provenance}`。
              // 后者键名是 `id`，不是 `target`——写成 `entry.target` 会得到
              // undefined，整条关系在页面上变成空白。
              const tid = typeof entry === 'string' ? entry : (entry && (entry.id || entry.target));
              const prov = (entry && typeof entry === 'object' && Array.isArray(entry.provenance))
                ? entry.provenance : null;
              if (isLiteral) {
                return { target: tid, name: tid, _literal: true, icon, _auto: isAuto, _prov: prov };
              }
              const known = !!DataStore.getEntity(tid);
              const ownName = (entry && typeof entry === 'object' && entry.name) || null;
              return {
                id: tid,
                _predicate: relKey,
                name: ownName || (known ? DataStore.resolveName(tid) : tid),
                type: (entry && entry.type) || DataStore.getType(tid),
                _missing: !ownName && !known,
                icon, _auto: isAuto,
                // 边级出处：这条断言出自哪里。与实体级 provenance 分开，
                // 因为「这个人生于 1042」和「他的父亲是某某」是两条不同的原始记录。
                _prov: prov,
              };
            });
          }
        }
        return resolved;
      },
      // 事件时间线步骤
      timelineSteps() {
        if (this.entityType !== 'event') return [];
        const steps = [];
        const props = this.entity?.props || {};
        if (props['起因']) {
          steps.push({ type: 'cause', label: '起因', text: props['起因'] });
        }
        if (props['经过']) {
          const parts = props['经过'].split(/[→⟶]/).map(s => s.trim()).filter(Boolean);
          parts.forEach((part, i) => {
            steps.push({ type: 'progress', label: '经过 ' + (i + 1), text: part });
          });
        }
        if (props['影响']) {
          steps.push({ type: 'effect', label: '影响', text: props['影响'] });
        }
        return steps;
      },
      // 解析数据源链
      //
      // `sources` now holds evidence ids ("evidence:3e1d…"), not inline objects.
      // Reading `s.name` off a string yields undefined for every property, so the
      // source list rendered blank for the whole corpus after the migration.
      //
      // The evidence nodes themselves are fetched in `mounted` (they live in
      // their own shards, which the person page never preloads); until they
      // arrive this shows the id so the citation is never invisible.
      resolvedSources() {
        if (!this.entity?.sources) return [];
        const loaded = this.evidenceMap || {};
        return this.entity.sources.map((raw, i) => {
          const isRef = typeof raw === 'string';
          const ev = isRef ? loaded[raw] : null;
          if (isRef && !ev) {
            return { name: raw, url: '', date: '', note: '', _unresolved: true, _evidenceRows: [] };
          }
          const s = isRef ? {
            name: ev.name || '',
            url: ev.url || '',
            // The evidence name already carries the date ("… 1978-05-11 …"),
            // so there is no separate date column to format here.
            date: '',
            note: '',
            carrier: ev.carrier ? DataStore.resolveName(ev.carrier) : null,
            // Structured rows let the card show carrier/medium/date instead of
            // just a name and a link. Built by a pure module so it is testable
            // without a DOM.
            _evidenceRows: (typeof HMEvidence !== 'undefined')
              ? HMEvidence.describeEvidence(ev, (id) => DataStore.resolveName(id))
              : [],
          } : raw;
          let tid = s.transcriber || '';
          // 提取【】中的ID
          const m = tid.match(/^【(.+?)】$/);
          const actualId = m ? m[1] : (tid.startsWith('@') ? tid.slice(1) : tid);
          const prev = this.entity.sources[i - 1];
          return {
            ...s,
            transcriberName: actualId ? DataStore.resolveName(actualId) : null,
            transcriberType: actualId ? DataStore.getType(actualId) : null,
            transcriber: m ? m[1] : actualId,
            previousSourceName: i > 0
              ? (typeof prev === 'string'
                ? (loaded[prev]?.name || prev)
                : prev.name)
              : null,
          };
        });
      },
      /**
       * Provenance entries grouped by the field they support.
       *
       * `provenance[].reason` is a comma-separated list of the prop names the raw
       * record was used to fill (`"出生年月,逝世时间"`), so one record can back
       * several rows. Keying by field lets each row show its own button instead of
       * a single page-level one that leaves the reader guessing which field the
       * quote belongs to.
       */
      fieldCites() {
        const out = {};
        const prov = Array.isArray(this.entity?.provenance) ? this.entity.provenance : [];
        for (const p of prov) {
          if (!p || typeof p.quote !== 'string' || !p.quote.trim()) continue;
          const reasons = String(p.reason || '').split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean);
          for (const r of reasons) {
            (out[r] = out[r] || []).push(p);
          }
        }
        return out;
      },
      citeRows() {
        // 关系项的气泡：出处已由 toggleRelCite 放进 relCiteRows。
        // 直接返回，否则会把整页的实体级出处也列一遍——读起来像是
        // 「这条父子关系的出处包括这个人的生年和史料注记」，那是错的。
        if (this.citeOpen && String(this.citeOpen).startsWith('rel:')) {
          return this.relCiteRows || [];
        }
        const rows = [];

        // ① provenance — where each field came from. This is what an imported
        // entity has: CBDB persons carry no `sources` at all, only
        // `provenance: [{ rawRef, quote, reason }]`. Reading only `sources` made
        // the citation button empty for most of the corpus.
        const prov = Array.isArray(this.entity?.provenance) ? this.entity.provenance : [];
        // A popover opened from a field row shows only the records that field rests
        // on; one opened from the entity title shows everything.
        const fieldKey = this.citeOpen && this.citeOpen.indexOf('field:') === 0
          ? this.citeOpen.slice('field:'.length)
          : null;
        const fieldProv = fieldKey ? (this.fieldCites[fieldKey] || []) : null;
        const provSource = fieldProv || prov;
        provSource.forEach((p, i) => {
          if (!p || typeof p.quote !== 'string' || !p.quote.trim()) return;
          rows.push({
            key: 'prov' + i,
            name: p.reason || '原始记录',
            url: '',
            rows: [
              { key: 'quote', label: '引文', value: p.quote },
              { key: 'rawRef', label: '出处', value: p.rawRef || '' },
            ].filter((r) => r.value),
            unresolved: false,
          });
        });

        // ② sources — evidence nodes, each with its own carrier/medium/date.
        // Suppressed for a field popover: evidence describes the entity, not the
        // individual field, so including it there would repeat the same rows on
        // every field.
        if (fieldKey) {
          return rows;
        }
        (this.resolvedSources || []).forEach((s, i) => {
          rows.push({
            key: 'src' + i,
            name: s.name || '',
            url: s.url || '',
            // `_evidenceRows` is absent on an unresolved source (the shard has not
            // arrived yet) and on inline source objects that predate evidence ids.
            // Reading `.length` off undefined threw inside a computed, which took
            // the whole detail view down with it.
            rows: Array.isArray(s._evidenceRows) ? s._evidenceRows : [],
            unresolved: !!s._unresolved,
          });
        });

        return rows;
      },
    },
    async mounted() {
      const id = this.$route.params.id;
      await DataStore.init();
      // 优先走本地全量库（`npm run serve`），回落分片。
      //
      // 分片只有已发布集合（1900+ 阈值，3,641 人）；而 CBDB 的亲属数据集中在
      // 古代，于是「父亲」「妻子」这些肯定存在的对象全显示成「（未收录）」。
      // 不是数据缺失，是详情页没连全量库。
      const detail = await loadEntityDetail(id);
      if (detail) {
        this.entity = this._ensureEntity(id);
      } else {
        await DataStore.loadEntity(id);
        this.entity = this._ensureEntity(id);
      }
      await this.loadEvidence();
      this.$nextTick(() => {
        if (this.showGraph && this.$refs.graph) {
          renderGraph(this.$refs.graph, id, entityType, (nid, type) => this.navigate(nid, type));
        }
      });
    },
    watch: {
      '$route.params.id': {
        async handler(id) {
          await DataStore.init();
          const detail = await loadEntityDetail(id);
          if (!detail) {
            await DataStore.loadEntity(id);
          }
          this.entity = this._ensureEntity(id);
          this.evidenceMap = {};
          await this.loadEvidence();
          this.showGraph = true;
        }
      },
      showGraph(v) {
        if (v) {
          this.$nextTick(() => {
            if (this.$refs.graph) {
              renderGraph(this.$refs.graph, this.$route.params.id, entityType, (nid, type) => this.navigate(nid, type));
            }
          });
        }
      },
    },
    methods: {
      openTree() {
        this.$router.push('/tree/' + encodeURIComponent(this.entity.id));
      },

      _ensureEntity(id) {
        const entity = DataStore.getEntity(id);
        if (entity) return entity;
        // Do NOT fabricate and save a stub here.
        //
        // This used to create `{ id, name: id, … }` and call saveEntity, which
        // persisted an empty record under the real id: opening a link to any
        // entity outside the first index page replaced it with a nameless shell.
        // A read path must never write. Returning a transient placeholder keeps
        // the page renderable without touching storage.
        return {
          id, name: id, type: this.entityType,
          props: {}, aliases: [], relations: {}, sources: [],
          _missing: true,
        };
      },
      navigate(id, type) {
        // Route through the shared schema: a local map here would silently send
        // thing/evidence to /person/ the moment a type is added.
        this.$router.push(typeRoute(type, id));
      },
      /**
       * Load the evidence nodes this entity cites.
       *
       * Failure is per-entry and non-fatal: a citation whose shard is missing
       * must still show its id rather than disappear from the page.
       */
      async loadEvidence() {
        const ids = (this.entity?.sources || []).filter((s) => typeof s === 'string');
        if (!ids.length) return;
        const out = {};
        await Promise.all(ids.map(async (id) => {
          try {
            // 先试 API：`evidence:cbdb` 这类节点是 build_db 直接写进数据库的，
            // 不来自分片，所以 DataStore 永远查不到。本地全量模式下 API 有，
            // 静态部署时才回落到分片。
            let ev = null;
            if (Api.isAvailable()) {
              try { ev = await Api.entity(id); } catch (e) { ev = null; }
            }
            if (!ev) ev = await DataStore.loadEntity(id);
            if (ev) out[id] = ev;
          } catch (e) {
            if (window.console) console.warn('证据加载失败', id, e);
          }
        }));
        this.evidenceMap = out;
      },
      openWiki(url) { window.open(url, '_blank'); },
      /**
       * Open the citation popover for `key` next to the button that was clicked.
       *
       * Positioned from the button's own box rather than as a child of the row, so
       * a popover opened near the bottom of the viewport is not clipped by the card
       * that contains it. Clamped to the viewport for the same reason.
       */
      toggleRelCite(index, prov, ev) {
        // 边级出处直接存在关系项上（已由 resolvedRelations 从分片读入），
        // 不需要再去 fetch：出处是边的一部分，不是另一次查询。
        this.relCiteRows = (prov || []).map((p, n) => ({
          key: 'relprov' + index + '-' + n,
          name: p.reason || '原始记录',
          url: '',
          rows: [
            { key: 'quote', label: '引文', value: p.quote || '' },
            { key: 'rawRef', label: '出处', value: p.rawRef || '' },
          ].filter((r) => r.value),
          unresolved: false,
        }));
        this.toggleCite('rel:' + index, ev);
      },
      toggleCite(key, ev) {
        if (this.citeOpen === key) { this.citeOpen = null; return; }
        const rect = ev && ev.currentTarget ? ev.currentTarget.getBoundingClientRect() : null;
        const width = 320;
        let left = rect ? rect.left : 20;
        let top = rect ? rect.bottom + 6 : 20;
        if (typeof window !== 'undefined') {
          left = Math.min(left, window.innerWidth - width - 12);
          // Open upward when there is no room below.
          if (rect && rect.bottom + 220 > window.innerHeight) {
            top = Math.max(8, rect.top - 220);
          }
        }
        this.citePos = { top: Math.max(8, top), left: Math.max(8, left) };
        this.citeOpen = key;
      },
      closeCite() { this.citeOpen = null; },
      /**
       * Everything known about the citations behind this entity, for the popover.
       *
       * Built from `resolvedSources` so the popover and the full 来源 card cannot
       * disagree — they read the same resolution, including the case where an
       * evidence shard has not arrived yet and only the id is known.
       *
       * A computed rather than a method because the template reads it in the
       * `v-if`, the `v-for` and the empty state: as a method it would rebuild the
       * array several times per render.
       */
      resolveName(id) { return DataStore.resolveName(id); },
      typeLabel(t) { return typeLabel(t); },
      getRoute(type) { return typeRoute(type, ''); },
      // 构建源链顺序（数组顺序为从最原始到最新）
      // Same reference-vs-object duality as resolvedSources: a bare id has no
      // transcriber of its own, so it must be resolved before the chain is built.
      buildSourceChain() {
        if (!this.entity?.sources?.length) return [];
        return this.entity.sources.map((s) => (typeof s === 'string' ? (DataStore.getEntity(s) || { name: s }) : s));
      }
    },
    template: `
      <div v-if="entity">
        <div v-if="entity._missing" class="card" style="border-color:#c00">
          <div class="card-header">
            <span class="card-title">未找到该实体</span>
          </div>
          <p>id <code>{{ entity.id }}</code> 没有对应的数据分片。可能是链接已失效，或数据尚未导入。</p>
        </div>
        <div class="breadcrumb">
          <router-link to="/">首页</router-link>
          <span class="bc-sep">/</span>
          <span>{{ schema.label }}</span>
          <span class="bc-sep">/</span>
          <strong>{{ entity.name }}</strong>
        </div>
        <div class="toolbar">
          <span class="toolbar-spacer"></span>
          <span v-if="entity.external?.cpcUrl" class="tag clickable" @click="openWiki(entity.external.cpcUrl)">人民网来源</span>
          <span v-if="entity.wikiUrl" class="tag clickable" @click="openWiki(entity.wikiUrl)">Wikipedia</span>
        </div>

        <div class="detail-layout">
          <div class="detail-main">
            <!-- 基本信息卡（js/views/entity/info_card.js） -->
            <entity-info-card
              :entity="entity"
              :entity-type="entityType"
              :resolved-props="resolvedProps"
              :field-cites="fieldCites"
              :cite-open="citeOpen"
              :cite-count="citeRows.length"
              @toggle-cite="toggleCite"
              @navigate="navigate"
            ></entity-info-card>

            <!-- 事件时间线（仅事件） -->
            <div v-if="entityType === 'event' && timelineSteps.length" class="card">
              <div class="card-header collapse-header" @click="showTimeline = !showTimeline">
                <span class="card-title">事件时间线</span>
                <span class="collapse-arrow">{{ showTimeline ? '▲' : '▼' }}</span>
              </div>
              <div v-if="showTimeline" class="timeline-container">
                <div class="timeline-item" v-for="(step, i) in timelineSteps" :key="i">
                  <div class="timeline-dot" :class="step.type"></div>
                  <div class="timeline-line" v-if="i < timelineSteps.length - 1"></div>
                  <div class="timeline-content">
                    <div class="timeline-label">{{ step.label }}</div>
                    <div class="timeline-text">{{ step.text }}</div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 关系图谱 -->
            <div class="card" style="padding:8px">
              <div class="graph-header collapse-header" @click="showGraph = !showGraph">
                <span class="card-title" style="font-size:1rem">关系图谱</span>
                <span class="card-subtitle" v-if="entity.relations" style="margin-left:12px">
                  <template v-for="(relList, relName) in entity.relations" :key="relName">
                    <span v-if="relList && relList.length" style="margin-right:10px;font-size:.8rem">{{ relName }} {{ relList.length }}</span>
                  </template>
                </span>
                <!-- Entry point to the recursive family tree. Shown only when the
                     backend answered: a link that leads to "needs a backend" is
                     worse than no link. -->
                <a
                  v-if="$root.apiAvailable"
                  class="graph-tree-link"
                  :href="'#/tree/' + encodeURIComponent(entity.id)"
                  @click.stop.prevent="openTree"
                >家谱 ⟶</a>
                <span class="collapse-arrow" style="margin-left:auto">{{ showGraph ? '▲' : '▼' }}</span>
              </div>
              <div v-if="showGraph" class="graph-container" ref="graph"></div>
            </div>

            <!-- 数据源溯源链（js/views/entity/source_chain.js） -->
            <entity-source-chain
              :sources="resolvedSources"
              :entity="entity"
              :entity-type="entityType"
              :open="showSources"
              @toggle="showSources = !showSources"
              @navigate="navigate"
            ></entity-source-chain>

          </div>
          <!-- 关系面板。宽屏下它自成一栏；窄屏时跟在主内容后面，
               顺序不变——先看这个人是谁，再看他和谁有关系。 -->
          <div class="detail-side">
            <!-- 关系面板 -->
            <template v-for="(relData, relKey) in resolvedRelations" :key="relKey">
              <div class="card" v-if="relData.length">
                <div class="card-header">
                  <!-- 谓词名可点击跳转到谓词页：这是「有 id 的地方都可点击」
                       的一致做法——谓词也有定义，也该能查。 -->
                  <a v-if="relData[0]._predicate"
                     class="card-title predicate-link"
                     :href="'#/predicate/' + encodeURIComponent(relData[0]._predicate)"
                     :title="'查看谓词 ' + relData[0]._predicate + ' 的定义'">{{ relKey }}</a>
                  <span v-else class="card-title">{{ relKey }}</span>
                  <span v-if="relData[0]._auto" class="tag" style="font-size:.7rem;background:var(--color-bg-tertiary);color:var(--color-text-muted)" title="缺省反向关系，可在关系设置中配置正式反向词">自动生成</span>
                  <span class="card-subtitle">{{ relData.length }} 项</span>
                </div>
                <div class="relation-grid">
                  <div v-for="(r, i) in relData" :key="i" class="relation-item"
                       :class="{ 'relation-item--literal': r._literal, 'relation-item--missing': r._missing }"
                       :title="r._missing ? ('这条关系指向 ' + r.id + '，该记录不在已发布范围内（未收录），因此不可跳转') : null"
                       @click="!r._literal && !r._missing && navigate(r.id || r.target, r.type)">
                    <div class="rel-avatar">{{ r._missing ? '？' : (r.name || '?')[0] }}</div>
                    <div class="rel-info">
                      <div class="rel-name">
                        {{ r._missing ? '（未收录）' : (r.name || r.target) }}
                      </div>
                      <div class="rel-desc" v-if="r.role">
                        {{ r.role }}
                        <span v-if="r.start || r.end">
                          ({{ r.start || '?' }}{{ r.end ? ' ~ ' + r.end : '' }})
                        </span>
                      </div>
                    </div>
                    <!-- 边级出处：这条关系断言出自哪一行原始记录。
                         与实体级的「引用来源」分开：生年出自 BIOG_MAIN，
                         父子关系出自 KIN_DATA，是两条不同的原始记录。 -->
                    <button v-if="r._prov && r._prov.length" class="cite-btn cite-btn--inline"
                            type="button"
                            :class="{ 'cite-btn--active': citeOpen === 'rel:' + i }"
                            :title="'查看这条关系的引用来源（' + r._prov.length + ' 条）'"
                            @click.stop="toggleRelCite(i, r._prov, $event)">
                      <span aria-hidden="true">ⓘ</span>
                    </button>
                    <span class="rel-arrow" v-if="!r._literal && !r._missing">→</span>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- 引用来源气泡：点开实体名旁的 ⓘ 就在这里展开，
             不离开当前页面，也不跳转。 -->
        <div v-if="citeOpen" class="cite-backdrop" @click="closeCite"></div>
        <div v-if="citeOpen" class="cite-popover" :style="{ top: citePos.top + 'px', left: citePos.left + 'px' }">
          <div class="cite-head">
            <span class="cite-title">引用来源</span>
            <button class="cite-close" type="button" @click="closeCite" title="关闭">×</button>
          </div>
          <div class="cite-body">
            <p v-if="!citeRows.length" class="cite-empty">此记录没有登记引用来源。</p>
            <div v-for="c in citeRows" :key="c.key" class="cite-item">
              <div class="cite-name">
                <a v-if="c.url" :href="c.url" target="_blank" rel="noopener noreferrer">{{ c.name }}</a>
                <span v-else>{{ c.name }}</span>
                <span v-if="c.unresolved" class="cite-unresolved" title="证据分片尚未加载">（待加载）</span>
              </div>
              <dl v-if="c.rows.length" class="cite-rows">
                <template v-for="r in c.rows" :key="r.key">
                  <dt>{{ r.label }}</dt>
                  <dd :class="{ 'cite-unresolved': r.unresolved }">{{ r.value }}</dd>
                </template>
              </dl>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="empty-state">
        <div class="empty-icon">🔍</div>
        <p>加载中…</p>
      </div>
    `
  };
}

// 五类实体共用同一个详情工厂（人物、非人实体、组织、事件、证据）
const PersonDetail = createEntityDetail('person');
const ThingDetail = createEntityDetail('thing');
const OrgDetail = createEntityDetail('organization');
const EventDetail = createEntityDetail('event');
const EvidenceDetail = createEntityDetail('evidence');

// -- 源码编辑器面板 --
