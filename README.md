# HumanMap

> 历史至今的人物家谱、组织与企业关系的可视化知识图谱。
> 支持 60 万+ 量级实体、任意时间跨度（公元前至今）、可检索的关系谓词与时间轴筛选。

```
人物 ─┬─ 亲属（父/母/子女/配偶/兄弟）
      ├─ 任职（组织 + 官职 + 起止时间）
      ├─ 社会（师生/同僚/朋友/荐举）
      └─ 属性（性别/民族/学历/籍贯/生卒）
组织 ─┬─ 上级组织 / 下级组织 / 控股 / 前身后继
      └─ 成员 / 相关事件
事件 ─┬─ 参与人物 / 发生地 / 前因后果
```

---

## 核心特性

| 特性 | 说明 |
| --- | --- |
| **谓词原语** | 关系词是注册表原语而非自由文本；同义词自动归一 |
| **反向 / 否定** | `father/inverse`（子女）、`father/negate`（明确不是父亲） |
| **性别感知检索** | 搜「儿子」只返回男性子女（`maleChild` 带 `subjectGender` 约束） |
| **儒略日时间** | 所有时刻统一为 JDN，支持公元前与模糊区间（`-1200±50年`） |
| **三档时间筛选** | 精确日期 / 单端点模糊 / 完全模糊，可拖动时间条 |
| **证据可审计** | 每条边带 `sourceUrl`、`createdAt`（录入时刻） |
| **静态可部署** | `data/` 为唯一真相，前端纯静态读取 |
| **分页索引** | 索引按页切分 + 首字搜索桶，启动只取 manifest 与首页，不随 66 万实体线性膨胀 |

---

## 快速开始

```bash
npm install
npm run admin      # 本地审核后台 → http://127.0.0.1:8787/admin.html
npm run publish    # 审核结果发布为静态数据
npm run build:site # 构建发布树 site/（数据 + SPA 外壳 + 静态页 + sitemap）
npm run build:static # 只重生静态页（假定 site/data/ 已就位）
npm run check      # 全量校验 + 测试（必须全绿）
```

查看图数据：

```bash
npm run graph:stats        # 节点 / 边统计
npm run graph:predicates   # 谓词清单
npm run graph:query -- 李强
npm run timeline           # 生卒年代直方图
```

---

## 架构一览

```
                      ┌──────────────────────────────┐
  CBDB (66 万人物) ───┤                              │
  官方网站抓取      ───┤  src/importers/  导入适配器   │
  人工录入          ───┤                              │
                      └───────────────┬──────────────┘
                                      ▼
                        data/imports/  候选批次（待审核）
                                      ▼
                        admin_server.js  +  SQLite（审核工作区）
                                      ▼
              export_static.js →  data/*/entities/*.json（权威）
                                      ▼
              build_index.js   →  manifest.json   （计数 / 分页表 / 搜索桶表）
                                  index/page-NNN.json（列表页，每页 2000）
                                  index/chrono.json  （有日期的实体，按 JDN 排序）
                                  search/bucket-NNN.json（首字搜索桶）
                                      ▼
        ┌─────────────────────────────┴────────────────────────────┐
        ▼                                                          ▼
  src/store/graph_source.js                              js/core/timeline.js
  src/core/graph.js   GraphStore                         （浏览器时间轴）
  src/core/query.js   QueryEngine                                  │
        ▼                                                          ▼
  src/cli/hm.js（命令行）          js/core/*.js → js/services.js → js/views/*.js → js/app.js
```

> **前端分层**：`js/core/` 是无 Vue/DOM 的纯逻辑；`js/services.js` 把它们装配成
> 服务对象；`js/views/` 每个文件一个 Vue 组件；`js/app.js` 只剩路由与挂载（约 100 行）。

> **为什么索引要分页**：早年 `index.json` 是全量数组。5,287 条已占 1.5 MB，
> 若按目标规模 66 万条计算约 190 MB，浏览器无法打开。现在启动只取
> `manifest.json`（约 14 KB）+ 第一页，搜索只取命中首字所在的桶，
> 时间轴只取 `chrono.json`。三者体积都与"当前操作"相关，而非与语料总量相关。
>
> `data/*/index.json` 已退化为**生成文件**（只含首页的兼容包装，带 `_truncated`
> 标记）。校验脚本、导入脚本、后台与测试一律读 `data/*/entities/` 分片或
> `manifest.json`，**不得写入 `index.json`**——否则会静默丢掉首页之外的实体。

**关键模块**

| 模块 | 职责 |
| --- | --- |
| `src/time/julian.js` | JDN 换算、模糊区间、精度分档、格式化 |
| `src/predicates/registry.js` | 谓词原语、同义词、反向/否定、性别约束 |
| `src/core/graph.js` | Node / Edge / GraphStore（三层索引） |
| `src/core/query.js` | 时间窗筛选、谓词检索、直方图 |
| `src/store/graph_source.js` | `data/` → GraphStore |
| `src/store/data_reader.js` | 唯一读入口（manifest + entities，回退 `index.json`） |
| `src/store/entity_writer.js` | 唯一写入口；内容未变不写盘；`setDataRoot()` 供测试隔离 |
| `src/store/entity_id.js` | 不透明 ID `type:origin-key`（`person:cbdb-467817`），禁止从姓名派生 |
| `src/store/id_allocator.js` | 无外部来源实体的持久序号分配（`data/.id_seq.json`，永不复用） |
| `src/store/source_key.js` | 从官方页面 URL 提取稳定 key
| `src/store/batches.js` | 导入批次文件的路径计算与读写 |
| `src/net/http.js` | `fetchText` / `cleanHtml` / `extractLinks`（超时、重定向、大小上限） |
| `src/importers/cbdb.js` | CBDB 适配器（分片、流式） |
| `src/importers/cbdb_kinship.js` | 亲属代码 → 谓词（从 `KINSHIP_CODES` 推导，不手写映射） |
| `src/importers/structured.js` | 官方简历规范化、规则回退、死亡信息富化（纯函数，可单测） |
| `src/cli/hm.js` | 统一命令行入口 |

**前端模块**（`js/core/*.js` 为无 Vue、无 DOM 的纯逻辑，可在 Node 中单测）

| 模块 | 职责 |
| --- | --- |
| `js/core/predicates.js` | 谓词表（由 Node 注册表生成，一致性由测试钉住）、修饰前缀、性别约束 |
| `js/core/timeline.js` | 浏览器侧 JDN 换算与三档置信度（与 `src/time/julian.js` 对齐） |
| `js/core/data_store.js` | manifest / 分页 / 搜索桶加载、详情按需拉取、localStorage 覆盖层 |
| `js/core/relations.js` | 关系分组、反向写入、性别检索、引用清理 |
| `js/core/search.js` | 首字桶收窄 + 模糊匹配（Fuse 缺失时退化为子串） |
| `js/core/source_parser.js` | 源码 ⇄ 实体（关系词由谓词表判定） |
| `js/core/direction.js` | 图谱箭头方向（由谓词对称性推导，非硬编码词表） |
| `js/core/graph_render.js` | D3 力导向渲染 |
| `js/app.js` | 仅做装配 + Vue 组件，不含业务逻辑 |

---

## 数据模型要点

**五类节点**：`person`（人物）、`thing`（非人实体：器物/地点/出版物/网站）、
`organization`（组织与国家：机关/政党/朝代/报社）、`event`（事件：发生过的事）、
`evidence`（证据：某处记载了某事）。

- **组织与国家是同一类**，用 `props['类型']` 区分朝代/诸侯国/王朝/报纸/政党。
- **事件不是证据**。事件是「发生过的事」，证据是「某处记载了某事」，
  用 `documents` / `documentedBy` 连接。
- **证据的主语必须是已注册实体**：「人民日报」是 `thing`，「人民日报社」是
  `organization`、「张澜」是 `person`；证据不能指向未注册的字符串。

**实体**（`data/<type>/entities/*.json`）
```jsonc
{ "id": "person:1a21…", "type": "person", "name": "石泰峰",
  "props": { "性别": "男", "出生年月": "1956年9月", "籍贯": "山西榆社" },
  "claims": { "currentPositions": [ … ] },
  "sources": ["evidence:3e1d39471ff68f8fa512"] }
```

**边**（内存图，由实体派生）
```jsonc
{ "key": "memberOf", "subject": "person:aaa", "object": "organization:bbb",
  "role": "总理", "range": { "start": …, "end": … }, "sourceUrl": "…", "createdAt": "…" }
```

**时间区间**
```jsonc
{ "start": 2435731, "end": null, "mid": 2435746,
  "uncertainty": 0, "precision": "month" }   // JDN，支持模糊与单端点
```

---

## 目录结构

```
src/           核心库（时间/谓词/图/查询/导入器/CLI）
scripts/       CLI 封装：常规管线（导入 / 校验 / 检查 / 发布）
                —— 一次性修复脚本不放这里，放 tools/oneoff/
data/          权威存储（**不进版本库**）：data/<类型>/entities/*.json 是唯一真实来源；
              index.json / index/ 由 build_index.js 从分片生成，不可反推
site/          发布产物（**进版本库**）：由 build_site.js 生成，仅含 1900 年后的现代人物；
                这是 GitHub Pages 实际部署的东西。除 SPA 外壳与数据外，还包含每实体的
                静态页 site/p/<路由>/<slug>/index.html、浏览索引 site/browse/、
                sitemap.xml 与 robots.txt —— 全部无 JavaScript，供搜索引擎收录
local_data/    审核工作区 SQLite（不进版本库）
tools/oneoff/  一次性与临时脚本（均幂等、支持 --dry-run）
test/unit/     单元测试（含浏览器模块，用 vm 沙箱运行）
test/integration/ 集成测试（加载真实数据）
js/core/       前端纯逻辑模块（无 Vue，可单测）
js/app.js      前端装配层与 Vue 组件
docs/          架构与使用文档
```

### 为什么是两棵树

权威语料是全量 CBDB 导入（486,786 人、约 610 MB）。本地后台、CLI 与所有导入器
都对着它工作，它必须完整。**仓库是另一个东西**：它是一个公开、静态托管的现代人物
展览。把半个百万的古代传记提交进 git，会让仓库暴涨、超出 GitHub Pages 限制，
并且首次加载慢到不可用——而这些并不是网站要做的事。

所以分流靠**输出目录**，绝不靠删数据：

| 命令 | 输出 | 内容 | 是否进 git |
| --- | --- | --- | --- |
| `npm run build:index` | `data/<类型>/` | 全量 486,786 人 | 否 |
| `npm run build:site` | `site/data/<类型>/` | 1900 年起的人物 + 全部组织/事件/证据 | 是 |

`data/` 里的任何东西都不会被删除，过滤器只决定哪些行被复制进发布树。

### 静态页：让发布树能被搜索引擎读到

前端是 hash 路由的 SPA（URL 形如 `/#/person/person:cbdb-122316`）。**hash 从不发给
服务器**，所以对爬虫而言整个语料只有一个 URL——只内联外壳不足以让任何实体页可索引。

`scripts/build_static_pages.js` 因此为每个已发布实体生成真实路径的纯 HTML：

| 产物 | 内容 |
| --- | --- |
| `site/p/<路由>/<slug>/index.html` | 每实体一页：标题、meta description、正文（属性、关系、provenance 原文引用）、`rel=canonical` |
| `site/browse/` | 类型入口 + `browse/<类型>/page-N.html` 分页清单，是爬虫走到叶子页的路径 |
| `site/sitemap.xml` | 列出全部静态页；超过 50,000 条或 50 MB 时自动分片并生成 sitemap-index.xml |
| `site/robots.txt` | 声明 sitemap 绝对地址 |

三条约束由 `test/unit/static_pages.test.js` 守住：每实体恰有一页且 URL 由 id（不是名字）
派生；每个站内链接都能落到实际文件；sitemap 与文件一一对应且在协议上限内。

实体页靠 `<a href="../../../../#/person/...">` 提供「在交互式图谱中查看」入口，不重复
实现 SPA；关系目标若落在发布切片之外（全量里 48 万余人不会发布）渲染为「（未收录）」
纯文本，不留死链。首页 `site/index.html` 的 `</body>` 前另注入一段类型导航降级块，
`js/app.js` 在 DOMContentLoaded 后移除它。

---

## 文档

**当前架构（已实现）**

- [`docs/架构设计.md`](docs/架构设计.md) —— 整体架构、数据模型、扩展方式
- [`docs/使用说明.md`](docs/使用说明.md) —— 命令、时间轴、谓词用法、新增数据源流程
- [`docs/实体类型重构.md`](docs/实体类型重构.md) —— 五类节点类型的设计记录

**目标架构（四层重构，第 0 层已落地）**

- [`docs/architecture/分层架构重构方案.md`](docs/architecture/分层架构重构方案.md) —— **总纲**：为什么分层、四层定义、不变量、性能实测
- [`docs/architecture/节点类型与谓词.md`](docs/architecture/节点类型与谓词.md) —— 8 类节点、时段语义、谓词扩充
- [`docs/architecture/技术选型与前端重建.md`](docs/architecture/技术选型与前端重建.md) —— SQLite 选型、CSS 拆分
- [`docs/architecture/实施任务清单.md`](docs/architecture/实施任务清单.md) —— P0–P7 可执行拆解

### raw 层（已实现）

`raw/` 是原始语料层：**上面一切可以从它重建，它无法从上面重建**。
因此它是唯一必须备份的层。CBDB 六表 2,472,329 行已原样入库，290 MB（gzip），
带哈希链防篡改。

```bash
npm run raw:ingest:cbdb   # 从 cbdb_20260801/*.sqlite3 搬运六表（幂等）
npm run raw:verify        # 校验链头（0.2 s，已含在 npm run check 里）
npm run raw:verify:full   # 完整校验 247 万条链（62 s，发布前跑）
```

代码：`src/store/raw_schema.js`（schema 与哈希）、`src/store/raw_store.js`（读写与验证）、
`tools/raw/*.js`（CLI）。不变量由 `test/unit/raw_layer.test.js` 守住。

> **`raw/` 不进 git**，`data/` 也不进 git；被跟踪的是发布树 `site/`。
> 备份目标已从 `data/` 改为 **`raw/`** — 见 `D:\Docs\HumanMapBK\README.md`。

**资料来源**

- [`docs/中国官方政府人员资料源调查.md`](docs/中国官方政府人员资料源调查.md) —— 来源调研
- [`docs/人民网人物专题接入方案.md`](docs/人民网人物专题接入方案.md) —— 人民网接入

**每次结构性改动后必须同步更新 `docs/架构设计.md` 与 `docs/使用说明.md`。**
重构期间改动若涉及分层边界，还必须更新 `docs/architecture/` 下对应文档。

---

## 数据规模

| 类型 | 全量（`data/`，本地） | 发布（`site/`，进 git） | 说明 |
| --- | --- | --- | --- |
| 人物 | 486,786 | 3,604 | 全量中 234,470 人有可定位日期；发布仅取卒年或生年 ≥1900 者 |
| 非人实体 | 6 | 6 | 报纸、网站等证据载体 |
| 组织与国家 | 67 | 67 | 机关、政党、民主党派、人民团体、报社；古代政权与人物同属此型 |
| 事件 | 22 | 22 | |
| 证据 | 111 | 111 | 载体全部解析成功；外链全为 `evidence:` 引用 |
| 谓词 | 55 | 55 | 内置注册表；`relations` 的键必须是其中之一 |

发布树 3,810 个实体，含 3,817 个静态页；`site/` 合计 7,684 文件 / 约 17.4 MB，
可直接由 GitHub Pages 提供。

### 时间数据

- **234,470 / 486,786** 人物的 `lifespan` 可解析（`出生年月`、`逝世时间` 或活动年 `生卒`）。
- CBDB 有 25 万人**完全没有任何年份**——这是源头缺失，不是导入丢数据。
  他们保留在库中（`關羽`、`劉備`、`張遼` 都属于此列），只是无法排在时间轴上。
- 只有卒年的人**不会**被补一个虚构的出生年。
- 年份 `0` 是 CBDB 的“未知”哨兵，一律按无日期处理。

---

## 开发约定

- 层级不可跨越：`data/` 是唯一真相，SQLite 仅作审核工作区。
- **分片是权威存储，索引是派生物，方向不能反**：`data/<类型>/entities/*.json`
  只能由实体写入路径（`upsertAll`）和一次性迁移脚本写；`index.json` / `index/`
  只由 `build_index.js` 从分片生成。任何“从索引重建分片”的脚本都是错的，
  无论它看起来多合理——这倒是个真事，5269 个实体曾因此被倒灌成空壳
  （见 `docs/架构设计.md` §6.7）。分片丢了从备份恢复，不要从索引重建。
- **校验要能区分“损坏”与“本来就薄”**：空 `props` + 带 `detail` 字段 = 从索引导灌
  （致命）；空 `props` 但无指纹 = 待补数据（警告，不堵构建）。
- **审核库的旧数据不能污染分片**：`npm run publish` 走 `sourcesAudit` 合并，
  按 URL 识别来源，否则会把已迁移的证据引用与内联副本重复叠加。
- **一个节点必须说得清自己凭什么存在**：有出处、有内容、或被其它实体引用。
  三者皆无的节点不是「数据稀疏」，是「空壳」（张辽/廉颇曾在没有一条事实、
  也没有一条入边的状态下存在）；名字整体是「某」的记录不算身份，不建节点
  （见 `docs/架构设计.md` §6.8）。
- **关系键必须是 `src/predicates/registry.js` 里的谓词 key**，不能是中文标签
  或 `其他` 之类的 catch-all：未注册的键在浏览器端无法反查方向、无法渲染标签。
  映射不到就不建边，并报告跳过了多少条。
- 不入库原始网页文本；必须经「证据 → 规则抽取 → 候选 → 审核 → 实体」。
- 每个非空字段须有原文证据（`evidence`）。
- 实体主键是 **不透明来源键**（`person:cbdb-467817`、`person:local-000042`），
  绝不从姓名派生。理由：姓名会重复、会改、会带错别字；把它当主键，这三种情况
  就分别变成「同名人塔成一个」「改一次名断所有边」「错名永久留存」——三个都真的
  发生过（详见 `docs/架构设计.md` §6.9）。
- **名字是普通字段，不是主键**。它必须**原子**：不带 `（1）` 序号，也不带
  `(許亨妻)` 这类关系注记。前者是 ID 该管的事，后者是 `spouse` 边说的事。
- **同名多实体是合法的**，区分靠约束边（生卒、阵营、配偶、父子），不靠名字后缀。
  因此“按名字找唯一实体”是不安全的——`NameIndex.get()` 遇到同名返回 `null` 而不是
  选第一个。
- 不能用“进程名”批量结束浏览器（见 `AGENTS.md`）。
- 测试失败或校验未通过时，不得声称完成。

---

## 许可证

数据来源各异（CBDB、中国政府网、人民网等），使用时请遵守各来源条款。
