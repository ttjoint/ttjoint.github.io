/* ============================================
   HumanMap — RelationPanel
   关系词管理面板：内置词只读、自定义词增删改

   依赖 js/services.js 暴露的服务（DataStore/SearchEngine/relations/…），
   由 index.html 在本文件之前加载。
   ============================================ */

const RelationPanel = {
  data() {
    return {
      isOpen: false,
      showForm: false,
      editingKey: null,
      form: { name: '', targetType: 'person', inverse: '', multi: true, icon: '🔗' },
      formError: ''
    };
  },
  computed: {
    relations() {
      const list = [];
      for (const [key, def] of Object.entries(RelationRegistry)) {
        list.push({
          key,
          ...def,
          isDefault: BUILTIN_RELATION_KEYS.has(key),
          targetLabel: EntitySchema[def.targetType]?.label || def.targetType
        });
      }
      list.sort((a, b) => {
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        return a.key.localeCompare(b.key, 'zh');
      });
      return list;
    },
    targetTypes() {
      return RelationManager.getTargetTypes();
    },
    defaultIcons() {
      return ['👤', '👥', '👴', '👵', '👶', '💑', '👫', '👪', '🏛', '⚔', '📍', '⏪', '⏩', '⬆', '⬇', '🔗', '📌', '⭐', '💼', '🎓'];
    },
    isEditingDefault() {
      return !!this.editingKey && BUILTIN_RELATION_KEYS.has(this.editingKey);
    }
  },
  methods: {
    open() {
      this.isOpen = true;
      this.showForm = false;
      this.editingKey = null;
    },
    close() {
      this.isOpen = false;
      this.showForm = false;
      this.editingKey = null;
      this.formError = '';
    },
    startAdd() {
      this.editingKey = null;
      this.form = { name: '', targetType: 'person', inverse: '', multi: true, icon: '🔗' };
      this.formError = '';
      this.showForm = true;
    },
    startEdit(key) {
      const def = RelationRegistry[key];
      if (!def) return;
      this.editingKey = key;
      this.form = {
        name: key,
        targetType: def.targetType,
        inverse: def.inverse || '',
        multi: def.multi !== false,
        icon: def.icon || '🔗'
      };
      this.formError = '';
      this.showForm = true;
    },
    cancelForm() {
      this.showForm = false;
      this.editingKey = null;
      this.formError = '';
    },
    save() {
      this.formError = '';
      const name = this.form.name.trim();
      if (!name) { this.formError = '请输入关系名称'; return; }

      const def = {
        targetType: this.form.targetType,
        inverse: this.form.inverse.trim() || null,
        multi: this.form.multi,
        icon: this.form.icon || '🔗'
      };

      if (this.editingKey) {
        // 编辑
        const isDefault = BUILTIN_RELATION_KEYS.has(this.editingKey);
        if (isDefault && this.editingKey !== name) {
          this.formError = '内置关系词不可重命名';
          return;
        }
        if (this.editingKey !== name && HM.HMPredicates.PREDICATES[name]) {
          this.formError = '关系名称 "' + name + '" 已存在';
          return;
        }
        // Renaming a custom word moves it; editing a built-in only touches its
        // stored extra fields, which RelationManager rejects for built-ins.
        const payload = {
          label: name,
          domain: this.form.targetType,
          range: this.form.targetType,
          inverse: def.inverse,
          icon: def.icon,
        };
        if (this.editingKey !== name) {
          RelationManager.deleteRelation(this.editingKey);
        }
        if (!RelationManager.updateRelation(name, payload)) {
          RelationManager.addRelation(name, payload);
        }
      } else {
        // 新增
        if (HM.HMPredicates.PREDICATES[name]) {
          this.formError = '关系名称 "' + name + '" 已存在';
          return;
        }
        RelationManager.addRelation(name, {
          label: name,
          domain: this.form.targetType,
          range: this.form.targetType,
          inverse: def.inverse,
          icon: def.icon,
        });

        // 自动创建反向关系对（若指定了反向且该反向关系不存在）
        if (def.inverse && !HM.HMPredicates.PREDICATES[def.inverse]) {
          RelationManager.addRelation(def.inverse, {
            label: def.inverse,
            domain: this.form.targetType,
            range: this.form.targetType,
            inverse: name,
            icon: '🔗',
          });
        }
      }

      this.showForm = false;
      this.editingKey = null;
    },
    deleteRelation(key) {
      if (BUILTIN_RELATION_KEYS.has(key)) return;
      if (!confirm('确定删除关系类型 "' + key + '" 吗？此操作不会删除已有数据中的该关系。')) return;
      RelationManager.deleteRelation(key);
      if (this.editingKey === key) {
        this.showForm = false;
        this.editingKey = null;
      }
    },
    selectIcon(icon) {
      this.form.icon = icon;
    }
  },
  template: `
    <div>
      <div class="editor-overlay" :class="{ open: isOpen }" @click="close"></div>
      <div class="editor-panel" :class="{ open: isOpen }">
        <div class="editor-panel-header">
          <h3>管理关系类型</h3>
          <button class="btn-icon" @click="close">✕</button>
        </div>
        <div class="editor-panel-body">
          <div style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:.82rem;color:var(--color-text-muted)">共 {{ relations.length }} 个关系类型</span>
            <button class="btn btn-primary btn-sm" @click="startAdd" v-if="!showForm">+ 新增关系</button>
          </div>

          <!-- 新增/编辑表单 -->
          <div v-if="showForm" class="card" style="padding:16px;margin-bottom:16px;background:var(--color-primary-light);border:1px solid var(--color-primary)">
            <div style="font-weight:600;margin-bottom:12px">{{ editingKey ? '编辑关系：' + editingKey : '新增关系类型' }}</div>

            <div class="form-group">
              <label>关系名称 <span style="color:var(--color-danger)">*</span></label>
              <input v-model="form.name" placeholder="例如：叔叔、导师、盟友" @keydown.enter="save" :disabled="isEditingDefault" />
              <div v-if="isEditingDefault" style="font-size:.75rem;color:var(--color-text-muted);margin-top:2px">默认关系类型不可重命名</div>
            </div>

            <div class="form-group">
              <label>目标类型 <span style="color:var(--color-danger)">*</span></label>
              <select v-model="form.targetType">
                <option v-for="t in targetTypes" :key="t.value" :value="t.value">{{ t.label }}</option>
              </select>
            </div>

            <div class="form-group">
              <label>反向关系</label>
              <input v-model="form.inverse" placeholder="例如：侄子、学生、盟友（留空表示无反向）" />
              <div style="font-size:.75rem;color:var(--color-text-muted);margin-top:4px">
                当A指向B时，系统自动在B上添加此反向关系指向A。若双向关系，反向可填相同名称。
              </div>
            </div>

            <div class="form-group">
              <label>图标</label>
              <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">
                <span v-for="icon in defaultIcons" :key="icon"
                  @click="selectIcon(icon)"
                  style="font-size:1.2rem;cursor:pointer;padding:2px 4px;border-radius:4px"
                  :style="{ background: form.icon === icon ? 'var(--color-primary)' : 'transparent' }"
                >{{ icon }}</span>
              </div>
              <input v-model="form.icon" placeholder="或直接输入 emoji" style="width:80px" />
            </div>

            <div class="form-group">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                <input type="checkbox" v-model="form.multi" style="width:auto" />
                允许多个目标（如多个子女、多个成员）
              </label>
            </div>

            <div v-if="formError" style="color:var(--color-danger);font-size:.82rem;margin-bottom:8px">{{ formError }}</div>

            <div style="display:flex;gap:8px">
              <button class="btn btn-primary btn-sm" @click="save">{{ editingKey ? '保存修改' : '添加关系' }}</button>
              <button class="btn btn-sm" @click="cancelForm">取消</button>
            </div>
          </div>

          <!-- 关系列表 -->
          <div class="relation-list">
            <div v-for="r in relations" :key="r.key" class="relation-item card" :class="{ default: r.isDefault }" style="padding:10px 14px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
              <div style="flex:1;min-width:0">
                <div style="display:flex;align-items:center;gap:8px">
                  <span style="font-size:1.1rem">{{ r.icon }}</span>
                  <span style="font-weight:600">{{ r.key }}</span>
                  <span class="type-badge" :class="r.targetType" style="font-size:.7rem">{{ r.targetLabel }}</span>
                  <span v-if="r.isDefault" class="tag" style="font-size:.65rem;background:var(--color-bg)">默认</span>
                </div>
                <div style="font-size:.78rem;color:var(--color-text-muted);margin-top:2px;margin-left:26px">
                  <span v-if="r.inverse">反向：{{ r.inverse }}</span>
                  <span v-else style="font-style:italic">无反向关系</span>
                  <span style="margin:0 6px">·</span>
                  <span>{{ r.multi !== false ? '多目标' : '单目标' }}</span>
                </div>
              </div>
              <div style="display:flex;gap:4px;flex-shrink:0;margin-left:12px">
                <button class="btn btn-sm" @click="startEdit(r.key)" style="padding:2px 8px">编辑</button>
                <button v-if="!r.isDefault" class="btn btn-sm btn-danger" @click="deleteRelation(r.key)" style="padding:2px 8px">删除</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
};

// -- 全部对象浏览页 --
