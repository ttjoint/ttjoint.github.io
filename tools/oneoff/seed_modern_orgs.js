'use strict';
/**
 * Seed the modern organisations that career claims refer to by name.
 *
 * ## Why this is data and not inference
 *
 * Every entry below is a body whose name appears verbatim in the corpus (in
 * `claims.currentPositions` / `claims.career`), sourced from the cited CPC and
 * government pages. This script does not invent memberships: it creates the
 * organisation *node* so that an existing claim can resolve to it instead of
 * dangling as a literal string.
 *
 * ## Aliases, not duplicate nodes
 *
 * The extractor produced several spellings for the same body:
 *
 *   中共二十届中央委员会 / 中共二十届中央 / 中共二十届
 *   中央纪委国家监委   / 中共二十届中纪委
 *   中央组织部        / 中共中央组织部
 *
 * These become one node with aliases. Creating separate nodes for each spelling
 * would fragment every membership edge, which is precisely the duplicate-entity
 * problem the canonical id scheme exists to prevent.
 *
 * ## What is deliberately NOT created
 *
 * Four labels are extraction artefacts, not organisations:
 *
 *   （未具体说明）
 *   （未具体说明，但可推断为工作单位）
 *   未具体说明（参加工作）
 *   （未具体说明，指参加工作的时间点）
 *
 * They are recorded in docs/实体类型重构.md as a data-quality note. Turning them
 * into nodes would put a placeholder on the graph and make the unresolved count
 * look better than it is.
 *
 * Usage: node tools/oneoff/seed_modern_orgs.js [--dry-run]
 */
const { readAll, upsertAll } = require('../../src/store/entity_writer');
const { organizationId } = require('../../src/store/entity_id');

const DRY = process.argv.includes('--dry-run');

/**
 * [name, aliases, tags, props]
 *
 * `types` and `简介` are kept short on purpose: this file asserts only what the
 * citing sources state (that the body exists and what kind it is), not a
 * hand-written history.
 */
const ORGANIZATIONS = [
  // ---- party central bodies (20th Central Committee) ----
  {
    name: '中国共产党',
    aliases: ['中共'],
    tags: ['政党', '执政党'],
    props: { 类型: '政党', 简介: '中华人民共和国的执政党。' },
  },
  {
    name: '中共二十届中央委员会',
    aliases: ['中共二十届', '中共二十届中央'],
    tags: ['政党机构', '中央委员会'],
    props: { 类型: '中央委员会', 简介: '中国共产党第二十届中央委员会。' },
  },
  {
    name: '中共二十届中央政治局',
    aliases: [],
    tags: ['政党机构', '中央政治局'],
    props: { 类型: '中央政治局', 简介: '中国共产党第二十届中央政治局。' },
  },
  {
    name: '中共二十届中央书记处',
    aliases: ['中央书记处'],
    tags: ['政党机构', '中央书记处'],
    props: { 类型: '中央书记处', 简介: '中国共产党第二十届中央书记处。' },
  },
  {
    name: '中央纪律检查委员会国家监察委员会',
    aliases: ['中央纪委国家监委', '中共二十届中纪委', '中央纪委'],
    tags: ['政党机构', '监察机关'],
    props: { 类型: '纪律检查与监察机关', 简介: '中央纪律检查委员会与国家监察委员会合署办公。' },
  },
  {
    name: '中共中央组织部',
    aliases: ['中央组织部'],
    tags: ['政党机构', '工作部门'],
    props: { 类型: '中央工作部门', 简介: '中共中央主管组织工作和干部工作的职能部门。' },
  },
  {
    name: '中央政法委员会',
    aliases: ['中央政法委'],
    tags: ['政党机构', '工作部门'],
    props: { 类型: '中央工作部门', 简介: '中共中央领导政法工作的职能部门。' },
  },
  {
    name: '中央全面深化改革委员会办公室',
    aliases: [],
    tags: ['政党机构', '办事机构'],
    props: { 类型: '办事机构', 简介: '中央全面深化改革委员会的办事机构。' },
  },
  {
    name: '中央财经委员会办公室',
    aliases: [],
    tags: ['政党机构', '办事机构'],
    props: { 类型: '办事机构', 简介: '中央财经委员会的办事机构。' },
  },

  // ---- state organs ----
  {
    name: '国务院',
    aliases: ['中华人民共和国国务院', '中央人民政府'],
    tags: ['国家机关'],
    props: { 类型: '国家行政机关', 简介: '中华人民共和国中央人民政府，最高国家行政机关。' },
  },
  {
    name: '公安部',
    aliases: [],
    tags: ['国家机关'],
    props: { 类型: '国务院组成部门', 简介: '国务院主管全国公安工作的组成部门。' },
  },
  {
    name: '审计署',
    aliases: [],
    tags: ['国家机关'],
    props: { 类型: '国务院组成部门', 简介: '国务院主管审计工作的组成部门。' },
  },
  {
    name: '最高人民法院',
    aliases: [],
    tags: ['国家机关', '司法机关'],
    props: { 类型: '国家审判机关', 简介: '中华人民共和国最高审判机关。' },
  },

  // ---- consultative conferences ----
  {
    name: '中国人民政治协商会议第十四届全国委员会',
    aliases: ['十四届全国政协', '全国政协'],
    tags: ['统一战线组织'],
    props: { 类型: '统一战线组织', 简介: '中国人民政治协商会议第十四届全国委员会。' },
  },
  {
    name: '中国人民政治协商会议西藏自治区委员会',
    aliases: ['西藏自治区政协'],
    tags: ['统一战线组织'],
    props: { 类型: '地方政协', 简介: '中国人民政治协商会议西藏自治区委员会。' },
  },

  // ---- democratic parties (中央) ----
  {
    name: '中国国民党革命委员会中央委员会',
    aliases: ['民革中央'],
    tags: ['民主党派'],
    props: { 类型: '民主党派中央', 简介: '中国国民党革命委员会中央委员会。' },
  },
  {
    name: '中国民主同盟中央委员会',
    aliases: ['民盟中央'],
    tags: ['民主党派'],
    props: { 类型: '民主党派中央', 简介: '中国民主同盟中央委员会。' },
  },
  {
    name: '中国民主建国会中央委员会',
    aliases: ['民建中央'],
    tags: ['民主党派'],
    props: { 类型: '民主党派中央', 简介: '中国民主建国会中央委员会。' },
  },
  {
    name: '中国民主促进会中央委员会',
    aliases: ['民进中央'],
    tags: ['民主党派'],
    props: { 类型: '民主党派中央', 简介: '中国民主促进会中央委员会。' },
  },
  {
    name: '中国农工民主党中央委员会',
    aliases: ['农工党中央'],
    tags: ['民主党派'],
    props: { 类型: '民主党派中央', 简介: '中国农工民主党中央委员会。' },
  },
  {
    name: '中国致公党中央委员会',
    aliases: ['致公党中央'],
    tags: ['民主党派'],
    props: { 类型: '民主党派中央', 简介: '中国致公党中央委员会。' },
  },
  {
    name: '九三学社中央委员会',
    aliases: ['九三学社中央'],
    tags: ['民主党派'],
    props: { 类型: '民主党派中央', 简介: '九三学社中央委员会。' },
  },
  {
    name: '台湾民主自治同盟中央委员会',
    aliases: ['台盟中央'],
    tags: ['民主党派'],
    props: { 类型: '民主党派中央', 简介: '台湾民主自治同盟中央委员会。' },
  },

  // ---- people's organisations ----
  {
    name: '中华全国妇女联合会',
    aliases: ['全国妇联'],
    tags: ['人民团体'],
    props: { 类型: '人民团体', 简介: '中国共产党领导下的全国各族各界妇女的群众组织。' },
  },
  {
    name: '中华全国工商业联合会',
    aliases: ['全国工商联'],
    tags: ['人民团体'],
    props: { 类型: '人民团体', 简介: '中国共产党领导的以民营企业和民营经济人士为主体的社会团体。' },
  },
  {
    name: '中国民间商会',
    aliases: [],
    tags: ['社会团体'],
    props: { 类型: '社会团体', 简介: '与中华全国工商业联合会合署办公。' },
  },
  {
    name: '中国佛教协会',
    aliases: [],
    tags: ['宗教团体'],
    props: { 类型: '宗教团体', 简介: '全国性佛教组织。' },
  },
  {
    name: '中国文学艺术界联合会',
    aliases: ['中国文联'],
    tags: ['人民团体'],
    props: { 类型: '人民团体', 简介: '中国共产党领导的全国性文艺界人民团体。' },
  },

  // ---- universities ----
  {
    name: '约克大学',
    aliases: ['加拿大约克大学', 'York University'],
    tags: ['大学'],
    props: { 类型: '大学', 简介: '位于加拿大安大略省多伦多的公立大学。' },
  },
];

function main() {
  const existing = new Set(readAll('organization').map((e) => e.name));

  // Aliases can also collide with an existing node's name; fold those in rather
  // than creating a second node for the same body.
  const byName = new Map(readAll('organization').map((e) => [e.name, e]));

  const records = [];
  for (const spec of ORGANIZATIONS) {
    const aliasHit = [spec.name, ...(spec.aliases || [])].map((n) => byName.get(n)).find(Boolean);
    const id = aliasHit ? aliasHit.id : organizationId(spec.name);
    records.push({
      id,
      type: 'organization',
      name: aliasHit ? aliasHit.name : spec.name,
      aliases: [...new Set([...(aliasHit ? aliasHit.aliases || [] : []), ...(spec.aliases || [])])]
        .filter((a) => a !== (aliasHit ? aliasHit.name : spec.name)),
      tags: spec.tags || [],
      props: spec.props || {},
      relations: {},
      sources: [],
      external: {},
    });
  }

  const fresh = records.filter((r) => !existing.has(r.name));
  console.log(`组织 ${records.length} 个；其中新增 ${fresh.length} 个`);
  for (const r of fresh) console.log(`  + ${r.name}${r.aliases.length ? '  (亦作 ' + r.aliases.join('、') + ')' : ''}`);

  // Report alias collisions explicitly: a silent merge is the failure mode here.
  for (const r of records) {
    for (const a of r.aliases) {
      const other = byName.get(a);
      if (other && other.id !== r.id) {
        console.log(`  ! 别名 "${a}" 与已有实体 "${other.name}" 重名，已保留两者`);
      }
    }
  }

  if (DRY) {
    console.log('\n--dry-run：未写入');
    return;
  }
  const res = upsertAll('organization', records);
  console.log(`\n新增 ${res.added}，更新 ${res.updated}，写入 ${res.written} 个分片`);
}

main();
