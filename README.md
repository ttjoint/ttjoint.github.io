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

---

## 快速开始

```bash
npm install
npm run admin      # 本地审核后台 → http://127.0.0.1:8787/admin.html
npm run publish    # 审核结果发布为静态数据
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
              build_index.js   →  index.json（轻量索引，含 lifespan）
                                      ▼
        ┌─────────────────────────────┴────────────────────────────┐
        ▼                                                          ▼
  src/store/graph_source.js                              js/core/timeline.js
  src/core/graph.js   GraphStore                         （浏览器时间轴）
  src/core/query.js   QueryEngine                                  │
        ▼                                                          ▼
  src/cli/hm.js（命令行）                              js/app.js（静态站点）
```

**关键模块**

| 模块 | 职责 |
| --- | --- |
| `src/time/julian.js` | JDN 换算、模糊区间、精度分档、格式化 |
| `src/predicates/registry.js` | 谓词原语、同义词、反向/否定、性别约束 |
| `src/core/graph.js` | Node / Edge / GraphStore（三层索引） |
| `src/core/query.js` | 时间窗筛选、谓词检索、直方图 |
| `src/store/graph_source.js` | `data/` → GraphStore |
| `src/importers/cbdb.js` | CBDB 适配器（分片、流式） |
| `src/cli/hm.js` | 统一命令行入口 |

---

## 数据模型要点

**实体**（`data/<type>/entities/*.json`）
```jsonc
{ "id": "person:1a21…", "type": "person", "name": "石泰峰",
  "props": { "性别": "男", "出生年月": "1956年9月", "籍贯": "山西榆社" },
  "claims": { "currentPositions": [ … ] },
  "sources": [{ "name": "全国政协官网", "url": "…" }] }
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
scripts/       CLI 封装（导入、校验、发布）
tools/oneoff/  一次性与临时脚本
test/unit/     单元测试（无需数据）
test/integration/ 集成测试（加载真实数据）
data/          规范数据（索引入库，详情分片可重建）
js/            前端（app.js + core/timeline.js）
docs/          架构与使用文档
```

---

## 文档

- [`docs/架构设计.md`](docs/架构设计.md) —— 整体架构、数据模型、扩展方式
- [`docs/使用说明.md`](docs/使用说明.md) —— 命令、时间轴、谓词用法、新增数据源流程
- [`docs/中国官方政府人员资料源调查.md`](docs/中国官方政府人员资料源调查.md) —— 来源调研
- [`docs/人民网人物专题接入方案.md`](docs/人民网人物专题接入方案.md) —— 人民网接入

**每次结构性改动后必须同步更新 `docs/架构设计.md` 与 `docs/使用说明.md`。**

---

## 数据规模

| 类型 | 数量 | 说明 |
| --- | --- | --- |
| 人物 | 5,287 | 含官方来源 41 人、人民网专题 73 人、CBDB 骨架 |
| 组织 | 34 | |
| 事件 | 30 | |
| 谓词 | 45 | 内置注册表 |
| CBDB 待接入 | 660,311 人物 / 559,940 亲属 / 589,825 任职 | 按朝代分片导入 |

---

## 开发约定

- 层级不可跨越：`data/` 是唯一真相，SQLite 仅作审核工作区。
- 不入库原始网页文本；必须经「证据 → 规则抽取 → 候选 → 审核 → 实体」。
- 每个非空字段须有原文证据（`evidence`）。
- 实体主键 `type:sha256(type\0name)[:20]`，绝不使用姓名作主键。
- 不能用“进程名”批量结束浏览器（见 `AGENTS.md`）。
- 测试失败或校验未通过时，不得声称完成。

---

## 许可证

数据来源各异（CBDB、中国政府网、人民网等），使用时请遵守各来源条款。
