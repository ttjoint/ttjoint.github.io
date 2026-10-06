/**
 * 三国人物数据导入脚本
 * 将 Characters_of_the_Three_Kingdoms 的数据转换为 HumanMap 格式
 * 用法: node scripts/import_three_kingdoms.js
 */

const fs = require('fs');
const path = require('path');

// ====================== 配置 ======================
const SOURCE_DIR = path.join(__dirname, '..', '_import_source', 'characters');
const DATA_DIR = path.join(__dirname, '..', 'data');
const PERSONS_FILE = path.join(DATA_DIR, 'persons', 'index.json');
const ORGS_FILE = path.join(DATA_DIR, 'organizations', 'index.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events', 'index.json');

// 阵营名称规范化映射
const FACTION_MAP = {
  '蜀汉': '蜀汉', '蜀': '蜀汉', '蜀国': '蜀汉',
  '魏国': '曹魏', '魏': '曹魏',
  '东吴': '东吴', '吴': '东吴', '吴国': '东吴',
  '东汉': '东汉',
  '西晋': '西晋',
  '起义军': '黄巾军',
  '刘璋割据军阀': '刘璋势力',
  '袁术': '袁术势力',
};

// 需要创建的组织
const FACTION_ORGS = {
  '蜀汉': { '类型': '政权', '存续': '221年 ~ 263年', '简介': '三国时期割据政权之一，由刘备建立，又称季汉。' },
  '曹魏': { '类型': '政权', '存续': '220年 ~ 265年', '简介': '三国时期割据政权之一，由曹丕建立，占据北方广大地区。' },
  '东吴': { '类型': '政权', '存续': '229年 ~ 280年', '简介': '三国时期割据政权之一，由孙权建立，占据江东地区。' },
  '东汉': { '类型': '政权', '存续': '25年 ~ 220年', '简介': '汉朝后期，刘秀建立，定都洛阳。' },
  '西晋': { '类型': '政权', '存续': '265年 ~ 316年', '简介': '司马炎取代曹魏建立的统一王朝。' },
  '黄巾军': { '类型': '势力', '存续': '184年 ~ 192年', '简介': '东汉末年张角领导的农民起义军。' },
  '刘璋势力': { '类型': '势力', '存续': '194年 ~ 214年', '简介': '刘璋割据益州的地方势力。' },
  '袁术势力': { '类型': '势力', '存续': '? ~ 199年', '简介': '袁术割据淮南的地方势力。' },
};

// 性别映射
const GENDER_MAP = { 1: '男', 0: '女' };

// ====================== 工具函数 ======================

function normalizeFaction(raw) {
  if (!raw) return null;
  // 处理数组
  if (Array.isArray(raw)) raw = raw[0];
  // 处理逗号分隔
  if (raw.includes(',')) raw = raw.split(',')[0].trim();
  // 处理分号分隔
  if (raw.includes(';')) raw = raw.split(';')[0].trim();
  return FACTION_MAP[raw.trim()] || raw.trim();
}

function extractNames(characterList) {
  if (!characterList || !Array.isArray(characterList)) return [];
  return characterList
    .map(c => c.name)
    .filter(n => n && n !== '名不详' && !n.startsWith('名不详'));
}

function buildRelations(family, faction) {
  const relations = {};

  // 父母
  const parents = [];
  if (family.father && family.father.character) {
    parents.push(...extractNames(family.father.character));
  }
  if (family.mother && family.mother.character) {
    parents.push(...extractNames(family.mother.character));
  }
  if (parents.length > 0) relations['父母'] = parents;

  // 配偶
  if (family.spouse && family.spouse.character) {
    const spouses = extractNames(family.spouse.character);
    if (spouses.length > 0) relations['配偶'] = spouses;
  }

  // 兄弟姐妹
  const siblings = [];
  if (family.brothers && family.brothers.character) {
    siblings.push(...extractNames(family.brothers.character));
  }
  if (family.sisters && family.sisters.character) {
    siblings.push(...extractNames(family.sisters.character));
  }
  if (siblings.length > 0) relations['兄弟姐妹'] = siblings;

  // 子女
  const children = [];
  if (family.sons && family.sons.character) {
    children.push(...extractNames(family.sons.character));
  }
  if (family.daughters && family.daughters.character) {
    children.push(...extractNames(family.daughters.character));
  }
  if (children.length > 0) relations['子女'] = children;

  // 所属组织
  const normFaction = normalizeFaction(faction);
  if (normFaction) {
    relations['所属组织'] = [{ target: normFaction }];
  }

  return relations;
}

function buildProps(data) {
  const props = {};

  // 字
  if (data.courtesyName) props['字'] = data.courtesyName;

  // 号
  if (data.pseudonym) props['号'] = data.pseudonym;

  // 生卒
  const birth = data.birthdate || '';
  const death = data.deathdate || '';
  if (birth || death) {
    props['生卒'] = birth && death ? `${birth} ~ ${death}`
      : birth ? `${birth} ~ 不详`
      : `不详 ~ ${death}`;
  }

  // 出生地
  if (data.birthplace) {
    props['出生地'] = data.birthplacePresentDay
      ? `${data.birthplace}（今${data.birthplacePresentDay}）`
      : data.birthplace;
  }

  // 性别
  if (data.gender !== undefined) {
    props['性别'] = GENDER_MAP[data.gender] || '不详';
  }

  // 身份
  if (data.position && data.position.length > 0) {
    props['身份'] = data.position.join('、');
  }

  // 谥号
  if (data.posthumousName && data.posthumousName.length > 0) {
    props['谥号'] = data.posthumousName.join('、');
  }

  // 庙号
  if (data.templeName && data.templeName.length > 0) {
    props['庙号'] = data.templeName.join('、');
  }

  // 爵位
  if (data.peerage && data.peerage.length > 0) {
    props['爵位'] = data.peerage.join('、');
  }

  // 国籍
  const normFaction = normalizeFaction(data.faction);
  if (normFaction) {
    props['国籍'] = `【${normFaction}】`;
  }

  // 简介（优先使用历史简介）
  if (data.historicalBriefIIntroduction) {
    props['简介'] = data.historicalBriefIIntroduction;
  } else if (data.novelisticBriefIIntroduction) {
    props['简介'] = data.novelisticBriefIIntroduction;
  }

  return props;
}

function buildAliases(data) {
  const aliases = [];

  // 从 aliase 提取
  if (data.aliase && Array.isArray(data.aliase)) {
    for (const a of data.aliase) {
      if (a.name) aliases.push(a.name);
    }
  }

  // 从小名/乳名提取
  if (data.infantName && Array.isArray(data.infantName)) {
    for (const a of data.infantName) {
      if (a.name) aliases.push(a.name);
    }
  }

  return aliases;
}

function buildTags(data) {
  const tags = [];
  const normFaction = normalizeFaction(data.faction);
  if (normFaction) tags.push(normFaction);

  if (data.position && data.position.length > 0) {
    for (const p of data.position) {
      if (p && !tags.includes(p)) tags.push(p);
    }
  }

  return tags;
}

// ====================== 主逻辑 ======================

function main() {
  console.log('=== 三国人物数据导入 ===\n');

  // 1. 读取所有源数据
  const files = fs.readdirSync(SOURCE_DIR).filter(f => f.endsWith('.json'));
  console.log(`找到 ${files.length} 个源数据文件`);

  const persons = [];
  const factions = new Set();
  const skipped = [];

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, file), 'utf-8'));

    if (!raw.name) {
      skipped.push(file);
      continue;
    }

    const person = {
      id: raw.name,
      name: raw.name,
      type: 'person',
      props: buildProps(raw),
      aliases: buildAliases(raw),
      tags: buildTags(raw),
      relations: buildRelations(raw.family || {}, raw.faction),
    };

    // 添加 wiki 链接
    person.wikiUrl = `https://zh.wikipedia.org/wiki/${encodeURIComponent(raw.name)}`;

    persons.push(person);

    const normFaction = normalizeFaction(raw.faction);
    if (normFaction) factions.add(normFaction);
  }

  console.log(`成功转换 ${persons.length} 个人物`);
  if (skipped.length > 0) console.log(`跳过 ${skipped.length} 个文件: ${skipped.join(', ')}`);

  // 2. 读取现有数据，合并
  let existingPersons = [];
  let existingOrgs = [];
  let existingEvents = [];

  if (fs.existsSync(PERSONS_FILE)) {
    existingPersons = JSON.parse(fs.readFileSync(PERSONS_FILE, 'utf-8'));
  }
  if (fs.existsSync(ORGS_FILE)) {
    existingOrgs = JSON.parse(fs.readFileSync(ORGS_FILE, 'utf-8'));
  }
  if (fs.existsSync(EVENTS_FILE)) {
    existingEvents = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf-8'));
  }

  // 3. 合并人物（以 id 去重，新数据覆盖旧数据）
  const existingPersonIds = new Set(existingPersons.map(p => p.id));
  const newPersons = persons.filter(p => !existingPersonIds.has(p.id));
  const mergedPersons = [...existingPersons, ...newPersons];
  console.log(`\n人物: 原有 ${existingPersons.length} + 新增 ${newPersons.length} = 合并 ${mergedPersons.length}`);

  // 4. 创建/合并组织
  const existingOrgIds = new Set(existingOrgs.map(o => o.id));
  const newOrgs = [];
  for (const f of factions) {
    if (!existingOrgIds.has(f) && FACTION_ORGS[f]) {
      newOrgs.push({
        id: f,
        type: 'organization',
        name: f,
        props: FACTION_ORGS[f],
        aliases: [],
        tags: [f, '三国'],
        relations: {},
      });
    }
  }
  const mergedOrgs = [...existingOrgs, ...newOrgs];
  console.log(`组织: 原有 ${existingOrgs.length} + 新增 ${newOrgs.length} = 合并 ${mergedOrgs.length}`);

  // 5. 输出
  fs.writeFileSync(PERSONS_FILE, JSON.stringify(mergedPersons, null, 2), 'utf-8');
  console.log(`\n人物数据已写入: ${PERSONS_FILE}`);

  fs.writeFileSync(ORGS_FILE, JSON.stringify(mergedOrgs, null, 2), 'utf-8');
  console.log(`组织数据已写入: ${ORGS_FILE}`);

  // 事件保持原样
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(existingEvents, null, 2), 'utf-8');
  console.log(`事件数据已写入: ${EVENTS_FILE}`);

  console.log('\n=== 导入完成 ===');
}

main();