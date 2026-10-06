#!/usr/bin/env node
/**
 * 来源链增强脚本
 * 为现有数据中的 sources 添加系统化引用信息
 * 包括：来源类型、出版机构、ISBN、URL、精确日期
 * 用法: node scripts/enhance_sources.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// ====================== 参考文献注册表 ======================
const REFS = {
  // === 史书 ===
  '史记·五帝本纪': { type: '古籍', author: '司马迁', publicationDate: '约前91年', url: 'https://ctext.org/shiji/wu-di-ben-ji' },
  '史记·夏本纪': { type: '古籍', author: '司马迁', publicationDate: '约前91年', url: 'https://ctext.org/shiji/xia-ben-ji' },
  '史记·殷本纪': { type: '古籍', author: '司马迁', publicationDate: '约前91年', url: 'https://ctext.org/shiji/yin-ben-ji' },
  '史记·周本纪': { type: '古籍', author: '司马迁', publicationDate: '约前91年', url: 'https://ctext.org/shiji/zhou-ben-ji' },
  '史记·太史公自序': { type: '古籍', author: '司马迁', publicationDate: '约前91年', url: 'https://ctext.org/shiji/tai-shi-gong-zi-xu' },
  '史记': { type: '古籍', author: '司马迁', publicationDate: '约前91年', url: 'https://ctext.org/shiji' },
  '汉书·司马迁传': { type: '古籍', author: '班固', publicationDate: '约92年', url: 'https://ctext.org/han-shu/zhang-shi-li-zhuan' },
  '汉书·淮南王传': { type: '古籍', author: '班固', publicationDate: '约92年' },
  '汉书·刘向传': { type: '古籍', author: '班固', publicationDate: '约92年' },
  '汉书': { type: '古籍', author: '班固', publicationDate: '约92年', url: 'https://ctext.org/han-shu' },
  '后汉书·应劭传': { type: '古籍', author: '范晔', publicationDate: '约445年' },
  '三国志·吴书': { type: '古籍', author: '陈寿', publicationDate: '约280年', url: 'https://ctext.org/san-guo-zhi' },
  '晋书·皇甫谧传': { type: '古籍', author: '房玄龄等', publicationDate: '648年' },
  '晋书·干宝传': { type: '古籍', author: '房玄龄等', publicationDate: '648年' },
  '晋书': { type: '古籍', author: '房玄龄等', publicationDate: '648年' },
  '旧唐书·欧阳询传': { type: '古籍', author: '刘昫等', publicationDate: '945年' },
  '宋史·李昉传': { type: '古籍', author: '脱脱等', publicationDate: '1345年' },

  // === 先秦典籍 ===
  '尚书': { type: '古籍', publicationDate: '先秦（约前10世纪~前5世纪）', url: 'https://ctext.org/shang-shu' },
  '尚书·牧誓': { type: '古籍', publicationDate: '西周初年（约前1046年）', url: 'https://ctext.org/shang-shu/mu-shi' },
  '尚书·禹贡': { type: '古籍', publicationDate: '战国（约前5世纪~前3世纪）', url: 'https://ctext.org/shang-shu/yu-gong' },
  '尚书·皋陶谟': { type: '古籍', publicationDate: '西周~春秋', url: 'https://ctext.org/shang-shu/gao-yao-mo' },
  '尚书·周书': { type: '古籍', publicationDate: '西周', url: 'https://ctext.org/shang-shu/zhou-shu' },
  '诗经': { type: '古籍', publicationDate: '西周~春秋（约前11世纪~前6世纪）', url: 'https://ctext.org/book-of-poetry' },
  '易·系辞下': { type: '古籍', publicationDate: '战国（约前5世纪~前3世纪）', url: 'https://ctext.org/book-of-changes/xi-ci-xia' },
  '国语·晋语': { type: '古籍', publicationDate: '战国（约前5世纪~前4世纪）', url: 'https://ctext.org/guo-yu/jin-yu' },
  '国语·楚语': { type: '古籍', publicationDate: '战国（约前5世纪~前4世纪）', url: 'https://ctext.org/guo-yu/chu-yu' },
  '国语': { type: '古籍', publicationDate: '战国（约前5世纪~前4世纪）', url: 'https://ctext.org/guo-yu' },
  '韩非子·五蠹': { type: '古籍', author: '韩非', publicationDate: '战国（约前3世纪）', url: 'https://ctext.org/hanfeizi/wu-du' },
  '竹书纪年': { type: '古籍', publicationDate: '战国（约前3世纪），西晋太康二年（281年）出土', url: 'https://ctext.org/zhu-shu-ji-nian' },

  // === 汉魏六朝典籍 ===
  '三五历纪': { type: '古籍', author: '徐整', publicationDate: '三国吴（约220~280年）' },
  '五运历年记': { type: '古籍', author: '徐整', publicationDate: '三国吴（约220~280年）' },
  '风俗通义': { type: '古籍', author: '应劭', publicationDate: '约195年', url: 'https://ctext.org/feng-su-tong-yi' },
  '淮南子·览冥训': { type: '古籍', author: '刘安', publicationDate: '约前139年', url: 'https://ctext.org/huainanzi/lan-ming-xun' },
  '淮南子·天文训': { type: '古籍', author: '刘安', publicationDate: '约前139年', url: 'https://ctext.org/huainanzi/tian-wen-xun' },
  '淮南子·本经训': { type: '古籍', author: '刘安', publicationDate: '约前139年', url: 'https://ctext.org/huainanzi/ben-jing-xun' },
  '淮南子·修务训': { type: '古籍', author: '刘安', publicationDate: '约前139年', url: 'https://ctext.org/huainanzi/xiu-wu-xun' },
  '淮南子': { type: '古籍', author: '刘安', publicationDate: '约前139年', url: 'https://ctext.org/huainanzi' },
  '搜神记': { type: '古籍', author: '干宝', publicationDate: '约350年', url: 'https://ctext.org/sou-shen-ji' },
  '帝王世纪': { type: '古籍', author: '皇甫谧', publicationDate: '约280年' },
  '山海经·大荒西经': { type: '古籍', publicationDate: '先秦至汉初', url: 'https://ctext.org/shan-hai-jing/da-huang-xi-jing' },
  '山海经·海外北经': { type: '古籍', publicationDate: '先秦至汉初', url: 'https://ctext.org/shan-hai-jing/hai-wai-bei-jing' },
  '山海经·海外西经': { type: '古籍', publicationDate: '先秦至汉初', url: 'https://ctext.org/shan-hai-jing/hai-wai-xi-jing' },
  '山海经·北山经': { type: '古籍', publicationDate: '先秦至汉初', url: 'https://ctext.org/shan-hai-jing/bei-shan-jing' },
  '山海经': { type: '古籍', author: '刘向整理', publicationDate: '先秦至汉初（刘向约前6年整理）', url: 'https://ctext.org/shan-hai-jing' },
  '神农本草经': { type: '古籍', publicationDate: '汉代（约前1世纪~公元1世纪）' },

  // === 唐宋类书 ===
  '艺文类聚': { type: '古籍', author: '欧阳询等', publicationDate: '624年（唐武德七年）', url: 'https://ctext.org/yi-wen-lei-ju' },
  '太平御览': { type: '古籍', author: '李昉等', publicationDate: '983年（北宋太平兴国八年）', url: 'https://ctext.org/taiping-yulan' },
  '太平广记': { type: '古籍', author: '李昉等', publicationDate: '978年（北宋太平兴国三年）' },

  // === 口传 ===
  '盘古开天辟地神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '女娲神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '伏羲神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '神农神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '燧人氏神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '远古部落口传': { type: '口传', publicationDate: '远古（无文字记载前）' },

  // === 现代出版物 ===
  '中国古代神话': { type: '出版', author: '袁珂', publisher: '华东师范大学出版社', isbn: '978-7-5675-4923-4', publicationDate: '2016-09（初版1950年商务印书馆）' },

  // === 网站/数字化资源 ===
  '中国哲学书电子化计划': { type: '网站', url: 'https://ctext.org', publicationDate: '2006年起持续更新' },

  // === 现代研究（泛指） ===
  '现代史学研究': { type: '出版', publicationDate: '现代' },
  '现代研究': { type: '出版', publicationDate: '现代' },
  '现代考古与研究': { type: '出版', publicationDate: '现代' },
  '现代学者生平记录': { type: '出版', publicationDate: '现代' },
  '甲骨文考古发现': { type: '出版', publicationDate: '1899年至今' },
  '甲骨文记载': { type: '出版', publicationDate: '商代（约前14世纪~前11世纪），1899年起被学者释读' },
  '殷墟考古发现': { type: '出版', publicationDate: '1928年至今' },
  '二里头遗址考古': { type: '出版', publicationDate: '1959年至今' },

  // === 史记篇目补充 ===
  '史记·楚世家': { type: '古籍', author: '司马迁', publicationDate: '约前91年', url: 'https://ctext.org/shiji/chu-shi-jia' },
  '史记·鲁周公世家': { type: '古籍', author: '司马迁', publicationDate: '约前91年', url: 'https://ctext.org/shiji/lu-zhou-gong-shi-jia' },
  '史记·齐太公世家': { type: '古籍', author: '司马迁', publicationDate: '约前91年', url: 'https://ctext.org/shiji/qi-tai-gong-shi-jia' },
  '史记·管蔡世家': { type: '古籍', author: '司马迁', publicationDate: '约前91年', url: 'https://ctext.org/shiji/guan-cai-shi-jia' },

  // === 尚书篇目补充 ===
  '尚书·尧典': { type: '古籍', publicationDate: '西周~春秋（约前10世纪~前6世纪）', url: 'https://ctext.org/shang-shu/yao-dian' },
  '尚书·舜典': { type: '古籍', publicationDate: '西周~春秋', url: 'https://ctext.org/shang-shu/shun-dian' },
  '尚书·甘誓': { type: '古籍', publicationDate: '夏代~西周（约前20世纪~前11世纪）', url: 'https://ctext.org/shang-shu/gan-shi' },
  '尚书·汤誓': { type: '古籍', publicationDate: '商代~西周（约前16世纪~前11世纪）', url: 'https://ctext.org/shang-shu/tang-shi' },
  '尚书·金縢': { type: '古籍', publicationDate: '西周', url: 'https://ctext.org/shang-shu/jin-teng' },

  // === 诗经篇目补充 ===
  '诗经·大雅': { type: '古籍', publicationDate: '西周（约前11世纪~前8世纪）', url: 'https://ctext.org/book-of-poetry/da-ya' },
  '诗经·小雅': { type: '古籍', publicationDate: '西周~春秋', url: 'https://ctext.org/book-of-poetry/xiao-ya' },

  // === 其他古籍 ===
  '大戴礼记·五帝德': { type: '古籍', publicationDate: '战国~西汉', url: 'https://ctext.org/da-dai-li-ji/wu-di-de' },
  '吕氏春秋': { type: '古籍', author: '吕不韦门客', publicationDate: '战国末年（约前239年）', url: 'https://ctext.org/lv-shi-chun-qiu' },
  '左传': { type: '古籍', author: '左丘明', publicationDate: '春秋战国（约前5世纪~前4世纪）', url: 'https://ctext.org/zuo-zhuan' },

  // === 口传补充（各人物/事件的口传变体） ===
  '有巢氏神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '共工神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '夸父神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '后羿神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '嫦娥神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '精卫神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '刑天神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '蚩尤神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '祝融神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '黄帝传说（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '颛顼传说（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '帝喾传说（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '尧传说（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '舜传说（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '丹朱传说（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '商均传说（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '大禹传说（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '启传说（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '桀传说（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '妹喜传说（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '妲己传说（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '褒姒传说（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '伯邑考传说（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '女娲造人神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '女娲补天神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '共工怒触不周山神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '涿鹿之战传说（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '阪泉之战传说（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '夸父逐日神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '后羿射日神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '嫦娥奔月神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
  '精卫填海神话（口传）': { type: '口传', publicationDate: '远古（无文字记载前）' },
};

// ====================== 模糊匹配函数 ======================
// 尝试精确匹配，然后尝试包含匹配
function findRef(sourceName) {
  if (!sourceName) return null;
  // 精确匹配
  if (REFS[sourceName]) return REFS[sourceName];
  // 去掉书名号后匹配
  const stripped = sourceName.replace(/《/g, '').replace(/》/g, '');
  if (REFS[stripped]) return REFS[stripped];
  // 包含匹配（长名包含短名）
  for (const [key, val] of Object.entries(REFS)) {
    if (sourceName.includes(key) || key.includes(sourceName)) {
      // 但要避免太短的 key 匹配到不相关的
      if (key.length >= 3) return val;
    }
  }
  return null;
}

// ====================== 推断来源类型 ======================
function inferType(name) {
  if (!name) return '古籍';
  if (name.includes('口传') || name.includes('神话（口传）')) return '口传';
  if (name.includes('网站') || name.includes('电子化') || name.includes('ctext') || name.includes('http')) return '网站';
  if (name.includes('考古') || name.includes('现代') || name.includes('研究') || name.includes('学者')) return '出版';
  if (name.includes(' ISBN') || name.includes('出版')) return '出版';
  // 默认按古籍处理
  return '古籍';
}

// ====================== 主函数 ======================
function main() {
  const files = [
    { path: path.join(DATA_DIR, 'persons', 'index.json'), label: '人物' },
    { path: path.join(DATA_DIR, 'organizations', 'index.json'), label: '组织' },
    { path: path.join(DATA_DIR, 'events', 'index.json'), label: '事件' },
  ];

  let totalEnhanced = 0;
  let totalUnmatched = 0;
  const unmatchedNames = new Set();

  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(f.path, 'utf-8'));
    let fileEnhanced = 0;

    for (const entity of data) {
      if (!entity.sources || !Array.isArray(entity.sources)) continue;

      for (const src of entity.sources) {
        const ref = findRef(src.name);

        if (ref) {
          // 合并 REFS 中的字段，不覆盖已有的非空字段
          if (!src.type && ref.type) src.type = ref.type;
          if (!src.publisher && ref.publisher) src.publisher = ref.publisher;
          if (!src.isbn && ref.isbn) src.isbn = ref.isbn;
          if (!src.url && ref.url) src.url = ref.url;
          if (!src.publicationDate && ref.publicationDate) src.publicationDate = ref.publicationDate;
          if (!src.author && ref.author) src.author = ref.author;
          fileEnhanced++;
        } else {
          // 未匹配，根据名称推断类型
          if (!src.type) {
            src.type = inferType(src.name);
          }
          totalUnmatched++;
          unmatchedNames.add(src.name);
        }
      }
    }

    // 写回文件（2 空格缩进，末尾保留换行）
    fs.writeFileSync(f.path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    console.log(`${f.label}：增强 ${fileEnhanced} 条来源记录`);
    totalEnhanced += fileEnhanced;
  }

  console.log(`\n总计增强：${totalEnhanced} 条`);
  console.log(`未匹配（仅推断类型）：${totalUnmatched} 条`);
  if (unmatchedNames.size > 0) {
    console.log('未匹配的来源名：');
    for (const name of unmatchedNames) {
      console.log(`  - ${name}`);
    }
  }
}

main();
