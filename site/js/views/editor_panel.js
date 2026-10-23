/* ============================================
   HumanMap — EditorPanel
   实体编辑器抽屉：属性、关系、源码双向编辑

   依赖 js/services.js 暴露的服务（DataStore/SearchEngine/relations/…），
   由 index.html 在本文件之前加载。
   ============================================ */

const EditorPanel = {
  props: ['isLocal'],
  emits: ['close', 'saved'],
  data() {
    return {
      isOpen: false,
      entityType: 'person',
      editId: null,
      sourceText: '',
      isEdit: false,
      showHelp: false,
      // 自动补全
      showAutocomplete: false,
      acResults: [],
      acSelected: 0,
      acTriggerPos: 0
    };
  },
  computed: {
    schema() {
      return EntitySchema[this.entityType] || {};
    },
    registryList() {
      const list = {};
      for (const [key, def] of Object.entries(RelationRegistry)) {
        list[key] = { ...def, label: EntitySchema[def.targetType]?.label || def.targetType };
      }
      return list;
    },
    placeholder() {
      const examples = {
        person: '名称：刘备\n字：玄德\n生卒：161年 ~ 223年\n出生地：涿郡涿县\n国籍：【蜀汉】\n简介：刘备，字玄德…\n别名：刘皇叔，刘玄德\n标签：三国，蜀汉，开国皇帝\nwiki：https://zh.wikipedia.org/wiki/刘备\n子女：【刘禅】，【刘永】，【刘理】\n配偶：【甘夫人】，【糜夫人】，【孙尚香】\n所属组织：【蜀汉】 | 皇帝 | 221年 | 223年',
        organization: '名称：蜀汉\n类型：政权\n地区：益州\n存续：221年 ~ 263年\n时期：【三国|政权】\n简介：蜀汉，三国时期…\n别名：季汉，蜀国\n标签：三国，政权\n成员：【刘备】 | 皇帝 | 221年 | 223年\n成员：【诸葛亮】 | 丞相 | 221年 | 234年',
        event: '名称：赤壁之战\n时间：208年\n地点：长江赤壁\n结果：孙刘联军胜利\n简介：赤壁之战是…\n标签：三国，战役\n参战方：【曹魏】 | 曹操军\n参战方：【东吴】 | 孙权军\n参与人物：【曹操】 | 主帅\n参与人物：【诸葛亮】 | 军师\n源：三国志·吴书·周瑜传 | 289年 | 【陈寿】 | | 陈寿编纂'
      };
      return examples[this.entityType] || '';
    }
  },
  methods: {
    open(type, existing) {
      this.entityType = type;
      this.isOpen = true;
      if (existing) {
        this.isEdit = true;
        this.editId = existing.id;
        this.sourceText = SourceParser.stringify(existing);
      } else {
        this.isEdit = false;
        this.editId = null;
        this.sourceText = '';
      }
      this.showAutocomplete = false;
    },
    close() {
      this.isOpen = false;
      this.showAutocomplete = false;
      this.$emit('close');
    },
    save() {
      try {
        const entity = SourceParser.parse(this.sourceText, this.entityType, this.editId);
        if (!entity.name) {
          alert('请至少输入名称');
          return;
        }
        // 检查重复ID
        if (!this.isEdit) {
          const existing = DataStore.getEntity(entity.id);
          if (existing) {
            if (!confirm('词条"' + entity.id + '"已存在，是否覆盖？')) return;
          }
        }
        // 保存编辑前旧实体，用于比对反向关系增删
        const oldEntity = this.isEdit ? DataStore.getEntity(this.editId) : null;
        // 自动创建关系中不存在的桩节点
        this._autoCreateStubs(entity);
        DataStore.saveEntity(entity);
        // 同步反向关系：新增关系 → 在目标添加反向关系，删除关系 → 清理目标反向关系
        DataStore.syncInverseRelations(entity, oldEntity);
        this.$emit('saved', entity);
        this.close();
      } catch (e) {
        alert('解析错误：' + e.message);
      }
    },
    _autoCreateStubs(entity) {
      // 处理关系中的引用
      if (entity.relations) {
        for (const [relKey, relValues] of Object.entries(entity.relations)) {
          const relDef = RelationRegistry[relKey];
          if (!relDef) continue;
          for (const r of relValues) {
            const targetId = typeof r === 'string' ? r : r.target;
            if (!targetId || DataStore.getEntity(targetId)) continue;
            const stub = {
              id: targetId, name: targetId, type: relDef.targetType,
              props: {}, aliases: [], relations: {}, sources: []
            };
            DataStore.saveEntity(stub);
          }
        }
      }
      // 处理属性中的【】引用（支持显式类型标注）
      if (entity.props) {
        for (const value of Object.values(entity.props)) {
          if (!value || typeof value !== 'string') continue;
          const ref = DataStore.resolveRef(value);
          if (!ref || ref.type === 'unknown') continue;
          if (DataStore.getEntity(ref.id)) continue;
          const stub = {
            id: ref.id, name: ref.id, type: ref.type,
            props: {}, aliases: [], relations: {}, sources: []
          };
          DataStore.saveEntity(stub);
        }
      }
    },
    deleteEntity() {
      if (!confirm('确定删除？此操作不可撤销。')) return;
      // 先清理所有其他实体中对该节点的引用
      DataStore.cleanupReferences(this.editId);
      DataStore.deleteEntity(this.editId);
      this.$emit('saved');
      this.close();
      this.$router.push('/');
    },
    // 自动补全
    onEditorInput(e) {
      const ta = e.target;
      const pos = ta.selectionStart;
      const text = ta.value;
      // 查找光标前最近的【
      const lastBracket = text.lastIndexOf('【', pos - 1);
      if (lastBracket !== -1 && lastBracket < pos) {
        const afterBracket = text.substring(lastBracket + 1, pos);
        // 如果【后面没有】且没有换行，触发补全
        if (!afterBracket.includes('】') && !afterBracket.includes('\n')) {
          this.acTriggerPos = lastBracket;
          // Newest keystroke wins: search now waits on a bucket fetch, so a
          // slow response must not overwrite suggestions for a newer query.
          const seq = (this.acSeq = (this.acSeq || 0) + 1);
          SearchEngine.search(afterBracket, 8).then((rows) => {
            if (seq !== this.acSeq) return;
            this.acResults = rows;
            this.acSelected = 0;
            this.showAutocomplete = rows.length > 0;
          });
          return;
        }
      }
      this.showAutocomplete = false;
    },
    onEditorKeydown(e) {
      if (!this.showAutocomplete) return;
      if (e.key === 'Tab') {
        e.preventDefault();
        this.completeAc(this.acResults[this.acSelected]);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.acSelected = Math.min(this.acSelected + 1, this.acResults.length - 1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.acSelected = Math.max(this.acSelected - 1, 0);
        return;
      }
      if (e.key === 'Enter' && this.acResults.length > 0) {
        e.preventDefault();
        this.completeAc(this.acResults[this.acSelected]);
        return;
      }
      if (e.key === 'Escape') {
        this.showAutocomplete = false;
        return;
      }
    },
    completeAc(item) {
      const before = this.sourceText.substring(0, this.acTriggerPos);
      const after = this.sourceText.substring(this.$refs.editorTextarea?.selectionStart || this.acTriggerPos + 1);
      // 找到after中第一个】或换行后的位置
      let cutAfter = after;
      const closeBracket = after.indexOf('】');
      const newline = after.indexOf('\n');
      if (closeBracket !== -1 && (newline === -1 || closeBracket < newline)) {
        cutAfter = after.substring(closeBracket + 1);
      }
      this.sourceText = before + '【' + item.id + '】' + cutAfter;
      this.showAutocomplete = false;
      this.$nextTick(() => {
        const ta = this.$refs.editorTextarea;
        if (ta) {
          const newPos = before.length + item.id.length + 3;
          ta.focus();
          ta.setSelectionRange(newPos, newPos);
        }
      });
    },
    acTypeLabel(t) {
      return typeLabel(t);
    }
  },
  template: `
    <div>
      <div class="editor-overlay" :class="{ open: isOpen }" @click="close"></div>
      <div class="editor-panel" :class="{ open: isOpen }">
        <div class="editor-panel-header">
          <h3>{{ isEdit ? '编辑' : '新增' }}{{ schema.label || '实体' }}</h3>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm" @click="showHelp = !showHelp">{{ showHelp ? '收起帮助' : '语法帮助' }}</button>
            <button class="btn-icon" @click="close">✕</button>
          </div>
        </div>
        <div class="editor-panel-body">
          <!-- 语法帮助 -->
          <div v-if="showHelp" class="card" style="padding:12px;margin-bottom:16px;font-size:.82rem;background:var(--color-primary-light)">
            <div style="font-weight:600;margin-bottom:8px">语法说明</div>
            <div><b>名称：</b>必填，人物使用"姓名"亦可</div>
            <div><b>属性：</b><code>键：值</code> 每行一个属性，支持任意属性名</div>
            <div><b>关系：</b>用注册的关系词作为键，值用 <code>【词条名】</code> 逗号分隔</div>
            <div><b>含角色关系：</b><code>关系词：【词条名】 | 角色 | 开始 | 结束</code></div>
            <div><b>内链：</b>输入 <code>【</code> 触发自动补全；可用 <code>【词条|类型】</code> 指定类型（如【三国|政权】）</div>
            <div><b>别名/标签：</b>用逗号分隔</div>
            <div><b>数据源：</b><code>源：资料名 | 日期 | 【转述者】 | 上层源 | 备注</code></div>
            <div style="margin-top:8px"><b>注册的关系词：</b>
              <template v-for="(def, key) in registryList" :key="key">
                <span class="tag" style="font-size:.7rem">{{ key }}<span style="color:var(--color-text-muted)">→{{ def.label }}</span></span>
              </template>
            </div>
            <div style="margin-top:8px"><b>快捷键：</b>输入<code>【</code>触发补全，<code>Tab</code>补全首个，<code>↑↓</code>选择，<code>Enter</code>确认</div>
          </div>

          <!-- 源码编辑区 -->
          <div class="form-group" style="position:relative">
            <label>源码编辑</label>
            <textarea
              ref="editorTextarea"
              v-model="sourceText"
              :placeholder="placeholder"
              class="source-editor"
              style="min-height:400px;font-family:var(--font-mono);font-size:.85rem;line-height:1.7;tab-size:2"
              spellcheck="false"
              @input="onEditorInput"
              @keydown="onEditorKeydown"
            ></textarea>
            <!-- 自动补全弹窗 -->
            <div v-if="showAutocomplete" class="ac-dropdown">
              <div
                v-for="(r, i) in acResults"
                :key="r.id"
                class="ac-item"
                :class="{ selected: i === acSelected }"
                @mousedown.prevent="completeAc(r)"
                @mouseenter="acSelected = i"
              >
                <span class="type-badge" :class="r.type">{{ acTypeLabel(r.type) }}</span>
                <span class="ac-name">{{ r.name }}</span>
                <span class="ac-id">{{ r.id }}</span>
              </div>
            </div>
          </div>

          <div style="display:flex;gap:8px;margin-top:16px">
            <button class="btn btn-primary" @click="save" style="flex:1">保存</button>
            <button v-if="isEdit" class="btn btn-danger" @click="deleteEntity">删除</button>
          </div>
        </div>
      </div>
    </div>
  `
};

// -- 关系类型管理面板 --
