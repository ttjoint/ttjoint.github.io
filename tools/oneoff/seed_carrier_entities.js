'use strict';
/**
 * Seed the carrier entities that evidence nodes point at.
 *
 * ## Why a script and not a data file
 *
 * Every entity created here is a *domain owner*: the body that actually
 * publishes the sources already cited in the corpus. The four hosts below cover
 * 100% of the URLs in the existing data:
 *
 *   cpc.people.com.cn   73  → 中国共产党新闻网, published by 人民日报社
 *   www.cppcc.gov.cn    23  → 中国人民政治协商会议全国委员会
 *   www.spp.gov.cn      10  → 最高人民检察院
 *   www.gov.cn           8  → 中国政府网, run by 国务院办公厅
 *
 * Nothing here is inferred about history or people; each row states who runs the
 * domain, which is printed on the site itself. That is why it can live in code
 * as a fixed table rather than being guessed per record.
 *
 * ## The thing / organisation split
 *
 * A publication and its publisher are different nodes:
 *
 *   人民日报社   organization   the body
 *   人民日报     thing          the paper it publishes
 *   人民网       thing          the website it publishes
 *
 * This is the distinction that makes "who says so" answerable: a citation in
 * 人民日报 resolves to the paper, and the paper's `publishedBy` edge names the
 * party organ that stands behind it.
 *
 * Usage: node tools/oneoff/seed_carrier_entities.js [--dry-run]
 */
const { readAll, upsertAll } = require('../../src/store/entity_writer');
const { thingId, organizationId } = require('../../src/store/entity_id');

const DRY = process.argv.includes('--dry-run');

/** Organisations: the bodies that own domains or publish things. */
const ORGANIZATIONS = [
  {
    name: '最高人民检察院',
    tags: ['国家机关', '司法机关'],
    props: {
      类型: '国家机关',
      职能: '国家法律监督机关',
      简介: '中华人民共和国最高检察机关，领导地方各级人民检察院和专门人民检察院的工作。',
    },
    sources: ['http://www.spp.gov.cn/'],
  },
  {
    name: '中国人民政治协商会议全国委员会',
    tags: ['国家机关', '统一战线组织'],
    aliases: ['全国政协', '政协全国委员会'],
    props: {
      类型: '统一战线组织',
      简介: '中国人民政治协商会议全国委员会，简称全国政协。',
    },
    sources: ['http://www.cppcc.gov.cn/'],
  },
  {
    name: '国务院办公厅',
    tags: ['国家机关'],
    props: {
      类型: '国家机关',
      职能: '协助国务院领导处理国务院日常工作',
      简介: '国务院办公厅是协助国务院领导同志处理国务院日常工作的机构。',
    },
    sources: ['http://www.gov.cn/'],
  },
  {
    name: '人民日报社',
    tags: ['新闻机构', '事业单位'],
    props: {
      类型: '新闻机构',
      简介: '人民日报社是中国共产党中央委员会机关报社，出版《人民日报》并主办人民网。',
    },
    sources: ['http://www.people.com.cn/'],
  },
];

/**
 * Things: publications and websites.
 *
 * Each carries `publishedBy` in `relations` (not props) so graph_source turns it
 * into a real edge to the organisation node.
 */
const THINGS = [
  {
    name: '人民日报',
    tags: ['报纸', '机关报'],
    props: {
      类型: '报纸',
      创刊: '1948年6月15日',
      简介: '中国共产党中央委员会机关报，由人民日报社出版。',
    },
    relations: { publishedBy: '人民日报社' },
    sources: ['http://paper.people.com.cn/'],
  },
  {
    name: '人民网',
    tags: ['新闻网站'],
    props: {
      类型: '新闻网站',
      简介: '人民网是人民日报社主办的中央重点新闻网站。',
    },
    relations: { publishedBy: '人民日报社' },
    sources: ['http://www.people.com.cn/'],
  },
  {
    name: '中国共产党新闻网',
    tags: ['新闻网站'],
    props: {
      类型: '新闻网站',
      简介: '中国共产党新闻网由人民日报社主办，是cpc.people.com.cn站点。',
    },
    relations: { publishedBy: '人民日报社' },
    sources: ['http://cpc.people.com.cn/'],
  },
  {
    name: '中国政府网',
    tags: ['政府网站'],
    props: {
      类型: '政府网站',
      简介: '中国政府网由国务院办公厅主办，是国务院和国务院各部门发布政务信息的官方网站。',
    },
    relations: { publishedBy: '国务院办公厅' },
    sources: ['http://www.gov.cn/'],
  },
  {
    name: '中国人民政治协商会议全国委员会网站',
    tags: ['政府网站'],
    props: {
      类型: '机构网站',
      简介: '全国政协官方网站。',
    },
    relations: { publishedBy: '中国人民政治协商会议全国委员会' },
    sources: ['http://www.cppcc.gov.cn/'],
  },
  {
    name: '最高人民检察院网站',
    tags: ['政府网站'],
    props: {
      类型: '机构网站',
      简介: '最高人民检察院官方网站。',
    },
    relations: { publishedBy: '最高人民检察院' },
    sources: ['http://www.spp.gov.cn/'],
  },
];

function build(list, type, idFn) {
  return list.map((spec) => ({
    id: idFn(spec.name),
    type,
    name: spec.name,
    aliases: spec.aliases || [],
    tags: spec.tags || [],
    props: spec.props || {},
    relations: spec.relations || {},
    // Inline source objects at seed time; the evidence migration turns these
    // into references later, which is why the compat layer has to exist.
    sources: (spec.sources || []).map((url) => ({
      id: 'seed-' + Buffer.from(url).toString('base64url').slice(0, 24),
      name: spec.name,
      url,
      accessedAt: new Date().toISOString(),
    })),
    external: {},
  }));
}

function main() {
  const existing = new Map();
  for (const type of ['person', 'thing', 'organization', 'event']) {
    for (const e of readAll(type)) existing.set(e.id, e);
  }

  const orgs = build(ORGANIZATIONS, 'organization', organizationId);
  const things = build(THINGS, 'thing', thingId);

  const fresh = [...orgs, ...things].filter((e) => !existing.has(e.id));
  console.log(`组织 ${orgs.length} 个、非人实体 ${things.length} 个；其中新增 ${fresh.length} 个`);
  for (const e of fresh) console.log(`  + ${e.type.padEnd(13)} ${e.name}`);

  if (DRY) {
    console.log('\n--dry-run：未写入');
    return;
  }
  if (!fresh.length) {
    console.log('无需写入');
    return;
  }
  // upsertAll is content-aware, so re-running this is a no-op rather than a
  // rewrite of every shard. It takes (type, records), one call per type.
  const written = upsertAll('organization', orgs).written + upsertAll('thing', things).written;
  console.log(`\n写入 ${written} 个文件`);
}

main();
