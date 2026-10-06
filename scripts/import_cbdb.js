/**
 * CBDB (China Biographical Database) 数据导入脚本
 * 将 CBDB SQLite 数据库转换为 HumanMap 格式并合并到现有数据中
 * 
 * 用法:
 *   1. npm install         (安装 sql.js 依赖)
 *   2. node scripts/import_cbdb.js
 * 
 * 数据来源: https://huggingface.co/datasets/cbdb/cbdb-sqlite
 */

const fs = require('fs');
const path = require('path');

// ====================== 配置 ======================
const DATA_DIR = path.join(__dirname, '..', 'data');
const CBDB_DIR = path.join(__dirname, '..', 'cbdb_20260801');
const DB_PATH = path.join(CBDB_DIR, 'cbdb_20260801.sqlite3');
const PERSONS_FILE = path.join(DATA_DIR, 'persons', 'index.json');
const ORGS_FILE = path.join(DATA_DIR, 'organizations', 'index.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events', 'index.json');

// 仅导入有明确生卒年的人物（避免大量数据）
const MIN_YEAR_KNOWN = true;
// 生卒年范围限制（仅导入先秦至南北朝，避免数据过多）
const YEAR_MIN = -1000;  // 公元前1000年
const YEAR_MAX = 600;    // 公元600年

// ====================== CBDB 亲属关系代码映射 ======================
// CBDB kin_code 到 HumanMap 关系类型的映射
const KIN_CODE_MAP = {
  // 父系长辈
  1: '父母', 2: '父母', 3: '父母', 4: '父母', 5: '父母', 6: '父母',
  10: '父母', 11: '父母', 12: '父母',
  20: '父母', 21: '父母', 22: '父母',
  // 子女
  75: '子女', 76: '子女', 77: '子女', 78: '子女',
  100: '子女', 101: '子女', 102: '子女', 103: '子女',
  110: '子女', 111: '子女',
  120: '子女', 121: '子女',
  130: '子女', 131: '子女',
  140: '子女',
  150: '子女', 151: '子女',
  160: '子女',
  // 兄弟姐妹
  30: '兄弟姐妹', 31: '兄弟姐妹', 32: '兄弟姐妹',
  40: '兄弟姐妹', 41: '兄弟姐妹',
  // 配偶
  200: '配偶', 201: '配偶', 202: '配偶', 203: '配偶',
  210: '配偶', 211: '配偶',
  // 亲属（泛化）
  50: '亲属', 51: '亲属', 52: '亲属', 53: '亲属',
  60: '亲属', 61: '亲属', 62: '亲属', 63: '亲属',
  70: '亲属', 71: '亲属', 72: '亲属',
  80: '亲属', 81: '亲属', 82: '亲属',
  90: '亲属', 91: '亲属',
};

// ====================== CBDB 社会关系代码映射 ======================
const ASSOC_CODE_MAP = {
  1: '师生', 2: '师生', 3: '师生',
  10: '同僚', 11: '同僚', 12: '同僚',
  20: '朋友', 21: '朋友',
  30: '门客', 31: '门客',
  40: '政敌', 41: '政敌',
  50: '学术', 51: '学术',
  60: '文学', 61: '文学',
  70: '同乡', 71: '同乡',
  80: '荐举', 81: '荐举',
  90: '其他', 91: '其他',
};

// ====================== 工具函数 ======================

/**
 * 获取表的列信息
 */
function getTableColumns(db, tableName) {
  try {
    const stmt = db.prepare(`PRAGMA table_info("${tableName}")`);
    const columns = [];
    while (stmt.step()) {
      columns.push({
        cid: stmt.getAsObject().cid,
        name: stmt.getAsObject().name,
        type: stmt.getAsObject().type
      });
    }
    stmt.free();
    return columns;
  } catch (e) {
    return [];
  }
}

/**
 * 安全获取表中的所有行
 */
function getTableRows(db, tableName, limit = null) {
  try {
    const sql = limit ? `SELECT * FROM "${tableName}" LIMIT ${limit}` : `SELECT * FROM "${tableName}"`;
    const stmt = db.prepare(sql);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  } catch (e) {
    console.error(`  读取表 ${tableName} 失败: ${e.message}`);
    return [];
  }
}

/**
 * 构建 CBDB 人物名到 HumanMap id 的映射
 */
function buildNameMap(persons) {
  const map = new Map();
  for (const p of persons) {
    map.set(p.name, p.id);
    if (p.aliases) {
      for (const alias of p.aliases) {
        if (!map.has(alias)) {
          map.set(alias, p.id);
        }
      }
    }
  }
  return map;
}

/**
 * 格式化生卒年
 */
function formatLifeSpan(indexYear, deathYear) {
  const birth = indexYear ? `${indexYear}年` : '不详';
  const death = deathYear ? `${deathYear}年` : '不详';
  return `${birth} ~ ${death}`;
}

/**
 * 构建简介
 */
function buildDescription(person) {
  const parts = [];
  if (person.name) parts.push(person.name);
  if (person.c_name_chn_alt) parts.push(`字${person.c_name_chn_alt}`);
  if (person.c_notes) parts.push(person.c_notes);
  return parts.join('，') || person.name;
}

// ====================== 主函数 ======================

async function main() {
  console.log('=== CBDB 数据导入工具 ===\n');

  // 检查数据库文件
  if (!fs.existsSync(DB_PATH)) {
    console.error(`错误: 找不到数据库文件 ${DB_PATH}`);
    process.exit(1);
  }

  // 加载 sql.js
  console.log('加载 sql.js...');
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  
  // 读取数据库
  console.log(`读取数据库: ${DB_PATH}`);
  const fileBuffer = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(fileBuffer);

  // 探索数据库结构
  console.log('\n--- 数据库结构 ---');
  const tables = getTableRows(db, 'sqlite_master', null)
    .filter(r => r.type === 'table' && !r.name.startsWith('sqlite_'));
  
  console.log(`共 ${tables.length} 个表:`);
  for (const t of tables) {
    const cols = getTableColumns(db, t.name);
    const rowCount = db.exec(`SELECT COUNT(*) as cnt FROM "${t.name}"`)[0]?.values[0][0] || 0;
    console.log(`  ${t.name} (${rowCount} 行) - 列: ${cols.map(c => c.name).join(', ')}`);
  }

  // ==================== 1. 处理人物数据 (BIOG_MAIN) ====================
  console.log('\n--- 处理人物数据 ---');
  
  let biogMain = [];
  try {
    const stmt = db.prepare('SELECT * FROM BIOG_MAIN');
    while (stmt.step()) {
      biogMain.push(stmt.getAsObject());
    }
    stmt.free();
  } catch (e) {
    console.error(`  读取 BIOG_MAIN 失败: ${e.message}`);
    // 尝试其他可能的表名
    const tableNames = tables.map(t => t.name.toLowerCase());
    const bioTable = tableNames.find(n => n.includes('biog') && n.includes('main'));
    if (bioTable) {
      const stmt = db.prepare(`SELECT * FROM "${bioTable}"`);
      while (stmt.step()) {
        biogMain.push(stmt.getAsObject());
      }
      stmt.free();
    }
  }
  console.log(`  BIOG_MAIN: ${biogMain.length} 条记录`);

  // 按年份筛选人物
  const filteredPersons = [];
  for (const p of biogMain) {
    const indexYear = p.C_INDEX_YEAR || p.c_index_year;
    const deathYear = p.C_DEATH_YEAR || p.c_death_year;
    
    if (MIN_YEAR_KNOWN) {
      if (indexYear == null && deathYear == null) continue;
      if (indexYear != null && (indexYear < YEAR_MIN || indexYear > YEAR_MAX)) continue;
      if (deathYear != null && (deathYear < YEAR_MIN || deathYear > YEAR_MAX)) continue;
    }
    filteredPersons.push(p);
  }
  console.log(`  筛选后（${YEAR_MIN}~${YEAR_MAX}年）: ${filteredPersons.length} 人`);

  // 限制数量，避免数据过多
  const MAX_PERSONS = 5000;
  const personsToImport = filteredPersons.slice(0, MAX_PERSONS);
  if (filteredPersons.length > MAX_PERSONS) {
    console.log(`  限制导入数量: ${MAX_PERSONS} 人`);
  }

  // 转换为 HumanMap 人物格式
  const cbdbPersons = [];
  const cbdbIdMap = new Map(); // c_personid -> HumanMap id (name)
  
  // 先去重同名人物
  const nameCount = new Map();
  for (const p of personsToImport) {
    const name = (p.C_NAME_CHN || p.c_name_chn || '').trim();
    if (!name) continue;
    nameCount.set(name, (nameCount.get(name) || 0) + 1);
  }
  
  const nameIndex = new Map();
  for (const p of personsToImport) {
    const name = (p.C_NAME_CHN || p.c_name_chn || '').trim();
    if (!name) continue;
    
    const pid = p.C_PERSONID || p.c_personid;
    const indexYear = p.C_INDEX_YEAR || p.c_index_year;
    const deathYear = p.C_DEATH_YEAR || p.c_death_year;
    const altName = (p.C_NAME_CHN_ALT || p.c_name_chn_alt || '').trim();
    const notes = (p.C_NOTES || p.c_notes || '').trim();
    
    // 处理同名（添加序号）
    let humanId = name;
    const cnt = nameCount.get(name) || 1;
    if (cnt > 1) {
      const idx = (nameIndex.get(name) || 0) + 1;
      nameIndex.set(name, idx);
      humanId = `${name}（${idx}）`;
    }
    
    cbdbIdMap.set(pid, humanId);
    
    const person = {
      id: humanId,
      name: name,
      type: 'person',
      props: {
        '生卒': formatLifeSpan(indexYear, deathYear),
        '简介': buildDescription(p),
      },
      aliases: [],
      tags: [],
      relations: {},
      wikiUrl: '',
    };
    
    // 字
    if (altName) {
      person.props['字'] = altName;
      person.aliases.push(`${name}${altName}`);
    }
    
    // 朝代标记
    if (indexYear != null) {
      if (indexYear <= -221) person.tags.push('先秦');
      else if (indexYear <= -206) person.tags.push('秦');
      else if (indexYear <= 220) person.tags.push('西汉');
      else if (indexYear <= 280) person.tags.push('东汉/三国');
      else if (indexYear <= 420) person.tags.push('晋');
      else if (indexYear <= 589) person.tags.push('南北朝');
      else person.tags.push('隋唐及以后');
    }
    
    cbdbPersons.push(person);
  }
  console.log(`  转换人物: ${cbdbPersons.length} 人`);

  // ==================== 2. 处理亲属关系 (KIN_DATA) ====================
  console.log('\n--- 处理亲属关系 ---');
  
  let kinData = [];
  try {
    const stmt = db.prepare('SELECT * FROM KIN_DATA');
    while (stmt.step()) {
      kinData.push(stmt.getAsObject());
    }
    stmt.free();
  } catch (e) {
    console.error(`  读取 KIN_DATA 失败: ${e.message}`);
  }
  console.log(`  KIN_DATA: ${kinData.length} 条记录`);

  let kinCount = 0;
  for (const k of kinData) {
    const pid = k.C_PERSONID || k.c_personid;
    const kinId = k.C_KIN_ID || k.c_kin_id;
    const kinCode = k.C_KIN_CODE || k.c_kin_code;
    
    const sourceId = cbdbIdMap.get(pid);
    const targetId = cbdbIdMap.get(kinId);
    if (!sourceId || !targetId) continue;
    
    const relationType = KIN_CODE_MAP[kinCode] || '亲属';
    
    const sourcePerson = cbdbPersons.find(p => p.id === sourceId);
    if (!sourcePerson) continue;
    
    if (!sourcePerson.relations[relationType]) {
      sourcePerson.relations[relationType] = [];
    }
    
    if (!sourcePerson.relations[relationType].includes(targetId)) {
      sourcePerson.relations[relationType].push(targetId);
      kinCount++;
    }
  }
  console.log(`  建立亲属关系: ${kinCount} 条`);

  // ==================== 3. 处理社会关系 (ASSOC_DATA) ====================
  console.log('\n--- 处理社会关系 ---');
  
  let assocData = [];
  try {
    const stmt = db.prepare('SELECT * FROM ASSOC_DATA');
    while (stmt.step()) {
      assocData.push(stmt.getAsObject());
    }
    stmt.free();
  } catch (e) {
    console.error(`  读取 ASSOC_DATA 失败: ${e.message}`);
  }
  console.log(`  ASSOC_DATA: ${assocData.length} 条记录`);

  let assocCount = 0;
  for (const a of assocData) {
    const pid = a.C_PERSONID || a.c_personid;
    const assocId = a.C_ASSOC_ID || a.c_assoc_id;
    const assocCode = a.C_ASSOC_CODE || a.c_assoc_code;
    
    const sourceId = cbdbIdMap.get(pid);
    const targetId = cbdbIdMap.get(assocId);
    if (!sourceId || !targetId) continue;
    
    const relationType = ASSOC_CODE_MAP[assocCode] || '其他';
    
    const sourcePerson = cbdbPersons.find(p => p.id === sourceId);
    if (!sourcePerson) continue;
    
    if (!sourcePerson.relations[relationType]) {
      sourcePerson.relations[relationType] = [];
    }
    
    if (!sourcePerson.relations[relationType].includes(targetId)) {
      sourcePerson.relations[relationType].push(targetId);
      assocCount++;
    }
  }
  console.log(`  建立社会关系: ${assocCount} 条`);

  // ==================== 4. 处理官职/身份 (STATUS_DATA) ====================
  console.log('\n--- 处理官职/身份 ---');
  
  let statusData = [];
  try {
    const stmt = db.prepare('SELECT * FROM STATUS_DATA');
    while (stmt.step()) {
      statusData.push(stmt.getAsObject());
    }
    stmt.free();
  } catch (e) {
    console.error(`  读取 STATUS_DATA 失败: ${e.message}`);
  }
  console.log(`  STATUS_DATA: ${statusData.length} 条记录`);

  for (const s of statusData) {
    const pid = s.C_PERSONID || s.c_personid;
    const statusDesc = (s.C_STATUS_DESC || s.c_status_desc || '').trim();
    
    const humanId = cbdbIdMap.get(pid);
    if (!humanId || !statusDesc) continue;
    
    const person = cbdbPersons.find(p => p.id === humanId);
    if (!person) continue;
    
    if (!person.props['身份']) {
      person.props['身份'] = statusDesc;
    } else if (!person.props['身份'].includes(statusDesc)) {
      person.props['身份'] += '、' + statusDesc;
    }
  }

  // ==================== 5. 处理组织 (SOCIAL_INSTITUTION) ====================
  console.log('\n--- 处理组织 ---');
  
  let instData = [];
  try {
    const stmt = db.prepare('SELECT * FROM SOCIAL_INSTITUTION');
    while (stmt.step()) {
      instData.push(stmt.getAsObject());
    }
    stmt.free();
  } catch (e) {
    console.error(`  读取 SOCIAL_INSTITUTION 失败: ${e.message}`);
  }
  console.log(`  SOCIAL_INSTITUTION: ${instData.length} 条记录`);

  const cbdbOrgs = [];
  const instIdMap = new Map(); // c_inst_code -> HumanMap org id
  
  for (const inst of instData) {
    const instCode = inst.C_INST_CODE || inst.c_inst_code;
    const instName = (inst.C_INST_NAME_CHN || inst.c_inst_name_chn || inst.C_INST_NAME || inst.c_inst_name || '').trim();
    const instDesc = (inst.C_INST_DESC || inst.c_inst_desc || '').trim();
    
    if (!instName || instName.length > 30) continue;
    
    instIdMap.set(instCode, instName);
    
    const org = {
      id: instName,
      name: instName,
      type: 'organization',
      props: {
        '类型': '机构',
        '简介': instDesc || instName,
      },
      aliases: [],
      tags: ['CBDB', '机构'],
      relations: {},
    };
    cbdbOrgs.push(org);
  }
  console.log(`  转换组织: ${cbdbOrgs.length} 个`);

  // ==================== 6. 处理人物-组织关系 (BIOG_INST_DATA) ====================
  console.log('\n--- 处理人物-组织关系 ---');
  
  let biogInstData = [];
  try {
    const stmt = db.prepare('SELECT * FROM BIOG_INST_DATA');
    while (stmt.step()) {
      biogInstData.push(stmt.getAsObject());
    }
    stmt.free();
  } catch (e) {
    console.error(`  读取 BIOG_INST_DATA 失败: ${e.message}`);
  }
  console.log(`  BIOG_INST_DATA: ${biogInstData.length} 条记录`);

  let orgRelCount = 0;
  for (const bi of biogInstData) {
    const pid = bi.C_PERSONID || bi.c_personid;
    const instCode = bi.C_INST_CODE || bi.c_inst_code;
    
    const humanId = cbdbIdMap.get(pid);
    const orgName = instIdMap.get(instCode);
    if (!humanId || !orgName) continue;
    
    const person = cbdbPersons.find(p => p.id === humanId);
    if (!person) continue;
    
    if (!person.relations['所属组织']) {
      person.relations['所属组织'] = [];
    }
    
    const alreadyAdded = person.relations['所属组织'].some(
      r => (typeof r === 'string' ? r : r.target) === orgName
    );
    if (!alreadyAdded) {
      person.relations['所属组织'].push({ target: orgName, role: '' });
      orgRelCount++;
    }
  }
  console.log(`  建立组织关系: ${orgRelCount} 条`);

  // ==================== 7. 处理事件 (EVENTS_ADDR) ====================
  console.log('\n--- 处理事件 ---');
  
  let eventsData = [];
  try {
    const stmt = db.prepare('SELECT * FROM EVENTS_ADDR');
    while (stmt.step()) {
      eventsData.push(stmt.getAsObject());
    }
    stmt.free();
  } catch (e) {
    console.error(`  读取 EVENTS_ADDR 失败: ${e.message}`);
  }
  console.log(`  EVENTS_ADDR: ${eventsData.length} 条记录`);

  const cbdbEvents = [];
  for (const evt of eventsData) {
    const evtId = evt.C_EVENT_ID || evt.c_event_id;
    const evtDesc = (evt.C_EVENT_DESC || evt.c_event_desc || '').trim();
    const evtYear = evt.C_EVENT_YEAR || evt.c_event_year;
    
    if (!evtDesc || evtDesc.length > 100) continue;
    
    const event = {
      id: evtDesc.substring(0, 30),
      name: evtDesc,
      type: 'event',
      props: {
        '时间': evtYear ? `${evtYear}年` : '不详',
        '简介': evtDesc,
      },
      aliases: [],
      tags: ['CBDB'],
      relations: {},
      wikiUrl: '',
    };
    cbdbEvents.push(event);
  }
  console.log(`  转换事件: ${cbdbEvents.length} 个`);

  // 关闭数据库
  db.close();

  // ==================== 8. 合并到现有数据 ====================
  console.log('\n--- 合并到现有数据 ---');

  // 读取现有数据
  const existingPersons = JSON.parse(fs.readFileSync(PERSONS_FILE, 'utf-8'));
  const existingOrgs = JSON.parse(fs.readFileSync(ORGS_FILE, 'utf-8'));
  const existingEvents = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf-8'));

  console.log(`  现有人物: ${existingPersons.length}`);
  console.log(`  现有组织: ${existingOrgs.length}`);
  console.log(`  现有事件: ${existingEvents.length}`);

  // 合并人物（以 name 去重，已有数据优先保留）
  const existingPersonNames = new Set(existingPersons.map(p => p.name));
  const newPersons = cbdbPersons.filter(p => !existingPersonNames.has(p.name));
  const mergedPersons = [...existingPersons, ...newPersons];
  console.log(`  新增人物: ${newPersons.length}，合并后: ${mergedPersons.length}`);

  // 合并组织
  const existingOrgNames = new Set(existingOrgs.map(o => o.name));
  const newOrgs = cbdbOrgs.filter(o => !existingOrgNames.has(o.name));
  const mergedOrgs = [...existingOrgs, ...newOrgs];
  console.log(`  新增组织: ${newOrgs.length}，合并后: ${mergedOrgs.length}`);

  // 合并事件
  const existingEventNames = new Set(existingEvents.map(e => e.name));
  const newEvents = cbdbEvents.filter(e => !existingEventNames.has(e.name));
  const mergedEvents = [...existingEvents, ...newEvents];
  console.log(`  新增事件: ${newEvents.length}，合并后: ${mergedEvents.length}`);

  // 写入文件
  fs.writeFileSync(PERSONS_FILE, JSON.stringify(mergedPersons, null, 2), 'utf-8');
  console.log(`\n人物数据已写入: ${PERSONS_FILE}`);

  fs.writeFileSync(ORGS_FILE, JSON.stringify(mergedOrgs, null, 2), 'utf-8');
  console.log(`组织数据已写入: ${ORGS_FILE}`);

  fs.writeFileSync(EVENTS_FILE, JSON.stringify(mergedEvents, null, 2), 'utf-8');
  console.log(`事件数据已写入: ${EVENTS_FILE}`);

  // ==================== 9. 统计 ====================
  console.log('\n=== 导入统计 ===');
  console.log(`总人物: ${mergedPersons.length} (原有 ${existingPersons.length} + CBDB新增 ${newPersons.length})`);
  console.log(`总组织: ${mergedOrgs.length} (原有 ${existingOrgs.length} + CBDB新增 ${newOrgs.length})`);
  console.log(`总事件: ${mergedEvents.length} (原有 ${existingEvents.length} + CBDB新增 ${newEvents.length})`);

  // 按朝代统计
  const tagCounts = {};
  for (const p of newPersons) {
    for (const tag of p.tags) {
      if (['先秦', '秦', '西汉', '东汉/三国', '晋', '南北朝', '隋唐及以后'].includes(tag)) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }
  }
  console.log(`\nCBDB新增人物按朝代分布:`);
  for (const [tag, count] of Object.entries(tagCounts)) {
    console.log(`  ${tag}: ${count} 人`);
  }

  console.log(`\n亲属关系: ${kinCount} 条`);
  console.log(`社会关系: ${assocCount} 条`);
  console.log(`组织关系: ${orgRelCount} 条`);

  console.log('\n=== 导入完成 ===');
  console.log('提示: 清除浏览器 localStorage 中的 hm_persons/hm_organizations/hm_events 后刷新页面即可看到新数据。');
}

main().catch(err => {
  console.error('导入失败:', err);
  process.exit(1);
});