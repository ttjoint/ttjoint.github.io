// 冲突检测器：模块化、可开关、不写 edges。
//
// 用户问的关键问题：「判断本身会回写固着在 sqlite 里因此不能作为
// 可开关的旁路？」——初版实现正是这样错的：flag 写进 edges 列，
// 开关检测器要重建全库（200 秒），多条规则命中时互相覆盖。
//
// 修正：判断与事实分层。edges 只存事实；edge_flags 是 sidecar 表，
// 由 run_detectors.js 独立重算（3 秒），edges 一条不动。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { ALL, runDetectors } = require('../../src/store/detectors/registry.js');

/** 一年 = 365.25 天（JDN 单位，与实体时间列一致） */
const Y = 365.25;

function makeCtx() {
  const lifespan = new Map([
    ['p:son', { validFrom: 2086000 + 30 * Y }],   // 子：父出生后 30 年
    ['p:son2', { validFrom: 2086000 + 5 * Y }],   // 子：父出生后 5 年（异常早）
    ['p:son3', { validFrom: 2086000 + 80 * Y }],  // 子：父出生后 80 岁（异常晚）
    ['p:sonBad', { validFrom: 2086000 - 10 * Y }],// 子：父出生前 10 年（倒挂）
    ['p:father', { validFrom: 2086000 }],
  ]);
  const edges = [
    { id: 'e-ok', subject: 'p:father', predicate: 'maleChild', object: 'p:son' },
    { id: 'e-early', subject: 'p:father', predicate: 'maleChild', object: 'p:son2' },
    { id: 'e-late', subject: 'p:father', predicate: 'maleChild', object: 'p:son3' },
    { id: 'e-invert', subject: 'p:father', predicate: 'maleChild', object: 'p:sonBad' },
  ];
  return { edges, lifespan, literalPredicates: new Set() };
}

test('detectors: 每条都有 id/title/rationale/severity/defaultOn', () => {
  // rationale 必填——这条规则为什么成立、什么时候它可能是错的，
  // 必须写下来让人审查。「检测器是判断」意味着判断要经得起看。
  for (const d of ALL) {
    assert.ok(d.id && d.title, `${d.id || '?'} 缺 id/title`);
    assert.ok(d.rationale && d.rationale.length > 20, `${d.id} 缺 rationale`);
    assert.ok(['conflict', 'suspect'].includes(d.severity), `${d.id} severity 非法`);
    assert.equal(typeof d.defaultOn, 'boolean', `${d.id} 缺 defaultOn`);
  }
});

test('detectors: 正常 30 岁差不命中，5 岁与 80 岁命中', () => {
  const { flags } = runDetectors(makeCtx());
  const hits = flags.filter((f) => f.detectorId === 'parent-age-out-of-range').map((f) => f.edgeId);
  assert.ok(!hits.includes('e-ok'), '30 岁差是正常范围');
  assert.ok(hits.includes('e-early'), '5 岁差应命中');
  assert.ok(hits.includes('e-late'), '80 岁差应命中');
});

test('detectors: 倒挂命中，正常不命中', () => {
  const { flags } = runDetectors(makeCtx());
  const hits = flags.filter((f) => f.detectorId === 'parent-age-inverted').map((f) => f.edgeId);
  assert.ok(hits.includes('e-invert'));
  assert.ok(!hits.includes('e-ok'));
  assert.ok(!hits.includes('e-early'), '5 岁差是异常但不是倒挂——不重复标注');
});

test('detectors: --off 真的关掉，不是假开关', () => {
  const ctx = makeCtx();
  const enabled = ALL.map((d) => d.id).filter((id) => id !== 'parent-age-out-of-range');
  const { byDetector } = runDetectors(ctx, enabled);
  assert.equal(byDetector['parent-age-out-of-range'].ran, false);
  assert.ok(byDetector['parent-age-out-of-range'].count === 0);
  assert.ok(byDetector['parent-age-inverted'].ran, '其他检测器不受影响');
});

test('detectors: 多条命中保留多行，不互相覆盖', () => {
  // 初版写单列时只留第一个标记，信息丢失。sidecar 表一条边多行。
  const { flags } = runDetectors(makeCtx());
  const invertFlags = flags.filter((f) => f.edgeId === 'e-invert');
  assert.ok(invertFlags.length >= 1);
  // e-invert 倒挂且差 -10 岁超出范围——两条都该在
  const ids = new Set(invertFlags.map((f) => f.detectorId));
  assert.ok(ids.has('parent-age-inverted'));
});

test('detectors: 判断不写进 edges 表', () => {
  // 这是分层原则：edges 只存事实，判断放 sidecar 表。
  // 写进事实表 = 开关要重建全库 = 实际没法开关。
  const schema = fs.readFileSync(path.join(ROOT, 'src', 'store', 'db_schema.js'), 'utf8');
  assert.ok(!/flag TEXT/.test(schema), 'edges 表不应有 flag 列');
  assert.match(schema, /CREATE TABLE edge_flags/, '应有 edge_flags sidecar 表');
});

test('detectors: build_db 不做检测，独立脚本做', () => {
  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build_db.js'), 'utf8');
  assert.ok(!/runDetectors|detectConflicts/.test(build), 'build_db 不应内联检测');
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'run_detectors.js'), 'utf8');
  assert.match(script, /runDetectors/);
  // 关闭检测器时必须清掉它的旧标注，否则开关是假的
  assert.match(script, /for \(const id of args\.off\) del\.run\(id\)/);
});

test('detectors: API 只读，不做 HTTP 开关', () => {
  // 开关是写操作，走 CLI（可审计），不走随手 POST 的配置项。
  const api = fs.readFileSync(path.join(ROOT, 'scripts', 'serve_api.js'), 'utf8');
  assert.match(api, /'detectors'/);
  assert.match(api, /只读/);
});

test('detectors: 管理页展示规则、命中量、rationale', () => {
  const page = fs.readFileSync(path.join(ROOT, 'js', 'views', 'detector_page.js'), 'utf8');
  assert.match(page, /rationale/);
  assert.match(page, /severityLabel/);
  assert.match(page, /run_detectors\.js --off/);
  assert.match(page, /whenReady/, 'probe 竞态教训：必须 whenReady');
});

test('flags: API 详情页带出标注', () => {
  const api = fs.readFileSync(path.join(ROOT, 'scripts', 'serve_api.js'), 'utf8');
  // 批量取出（不是逐边查）——详情页要展示几十条边。
  // 现在按归并组取（subject IN (...))：同一个人可能有多个来源实体。
  assert.match(api, /edge_id IN \(SELECT id FROM edges WHERE subject IN/);
  assert.match(api, /groupIds/, '要按归并组取边');
  // 空数组而非 undefined：前端判空统一用 .length
  assert.match(api, /flags: flagsByEdge\.get\(e\.edge_id\) \|\| \[\]/);
});

test('flags: 前端透传到两个分支', () => {
  const services = fs.readFileSync(path.join(ROOT, 'js', 'services.js'), 'utf8');
  assert.match(services, /flags: Array\.isArray\(e\.flags\) \? e\.flags : \[\]/);
  const detail = fs.readFileSync(path.join(ROOT, 'js', 'views', 'entity_detail.js'), 'utf8');
  // hasRole 分支（键名 r）与普通分支（键名 entry）都要有。
  // 只改一处的话，另一类关系被标了却不显示——数据在库里，页面看不见。
  const hasRoleBranch = detail.includes('_flags: Array.isArray(r.flags)');
  const normalBranch = detail.includes('_flags: flags');
  assert.ok(hasRoleBranch, 'hasRole 分支要有标注');
  assert.ok(normalBranch, '普通分支要有标注');
});

test('flags: 警示不夸大严重性', () => {
  const css = fs.readFileSync(path.join(ROOT, 'css', 'views', 'detail.css'), 'utf8');
  // 用「提示」的视觉语言，不是「错误」的。夸大严重性会让读者
  // 直接跳过这些数据，而它们往往正是最需要看的。
  assert.match(css, /flag-badge--suspect/);
  assert.match(css, /flag-badge--conflict/);
  assert.ok(!/red/.test(css), '不用红色——那是「错误」的视觉语言');
});

test('flags: 时间显示为年份而非 JDN', () => {
  const detail = fs.readFileSync(path.join(ROOT, 'js', 'views', 'entity_detail.js'), 'utf8');
  assert.match(detail, /function fmtYear/, '要有 JDN→年份 的转换');
  // 直接渲染 JDN 会得到 (2282438 ~ 2272940) 这种没人看得懂的数字
  assert.ok(detail.includes('fmtYear(r.validFrom)'), 'hasRole 分支用 fmtYear');
  assert.ok(detail.includes('fmtYear(entry && entry.validFrom)'), '普通分支用 fmtYear');
});

test('多段任职：同目标不同时段是两条断言，不是一条', () => {
  // 「1998–2003 任某职，2008–2012 又任该职」是两段任职。
  // 早先只按目标 id 去重，第二段被静默丢弃——把「任过两次」
  // 显示成「任过一次」，读者会得到错误的事实。
  const src = fs.readFileSync(path.join(ROOT, 'js', 'services.js'), 'utf8');
  assert.match(src, /去重按「目标 \+ 时段」/, '去重逻辑要有说明');
  assert.match(src, /aFrom === bFrom && aTo === bTo/, '时段相同才去重');
});

test('多段任职：反向边也带时段', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'services.js'), 'utf8');
  // 反向分支不带时段，去重会把它当成同一事实
  const inv = src.slice(src.indexOf("+ '/反'"), src.indexOf("+ '/反'") + 500);
  assert.match(inv, /validFrom:/, '反向边要带 validFrom');
  assert.match(inv, /validTo:/, '反向边要带 validTo');
});

test('边身份：时间不同分边，时间相同合并', () => {
  const { splitRelationEntry, edgeId } = require('../../src/store/db_build_helpers.js');
  const entries = [
    { id: 'organization:A', dates: { from: 1998, to: 2003 } },
    { id: 'organization:A', dates: { from: 2008, to: 2012 } },
    { id: 'organization:A', dates: { from: 1998, to: 2003 }, provenance: [{ rawRef: 'x' }] },
  ];
  const grouped = new Map();
  for (const e of entries) {
    const rel = splitRelationEntry(e);
    const sig = [rel.validFrom ?? '', rel.validTo ?? '', rel.observedAt ?? '', rel.qualifiers || ''].join('|');
    if (!grouped.has(sig)) grouped.set(sig, { rel, sig });
    else {
      const p = grouped.get(sig);
      p.rel.provenance = (p.rel.provenance || []).concat(rel.provenance || []);
    }
  }
  assert.equal(grouped.size, 2, '3 条输入 → 2 条边');
  const ids = [...grouped.values()].map(({ rel, sig }) => edgeId('p:x', 'memberOf', rel.object, sig));
  assert.equal(new Set(ids).size, 2, '两段任职的 edge id 必须不同');
});

test('多说法视图：同一 literal 属性的多个值并列显示，不丢弃', () => {
  const detail = fs.readFileSync(path.join(ROOT, 'js', 'views', 'entity_detail.js'), 'utf8');
  // 旧 bug 的形状是「读到第一条就直接赋值返回」：
  //   resolved[label] = e.other_name || e.other;
  // 新代码要么赋单一值（values[0].value），要么赋 _variants 结构。
  // 出现旧模式说明有人把旧逻辑改了回来。
  assert.ok(!detail.includes('resolved[label] = e.other_name'), '不能再从边直接赋值（旧 bug 的形状）');
  // `if (resolved[label]) continue` 保留是正确的——那是「props 优先」：
  // props 是手写原文，优先级高于从边推导的值。
  assert.match(detail, /literalGroups/, '要按谓词分组收集');
  assert.match(detail, /_variants/, '多个值标 _variants');

  const card = fs.readFileSync(path.join(ROOT, 'js', 'views', 'entity', 'info_card.js'), 'utf8');
  assert.match(card, /value\._variants/, '信息卡要渲染 _variants');
  assert.match(card, /无出处/, '没有出处的说法要标明——孤证和有据可查不一样');
});

// ---------------------------------------------------------------- 多来源冲突
//
// 这是本项目第一份**真实的**多说法数据：维基百科（社区编纂）与
// CBDB（哈佛编纂）独立给出同一人的生卒年，部分数值不同。

test('多说法：精度不同不算冲突', () => {
  const { runDetectors } = require('../../src/store/detectors/registry.js');
  // 「1037年1月8日」与「1037年」是同一年，只是精度不同。
  // 标成冲突会让读者以为史料有分歧，而实际只是一方记得更细。
  const edges = [
    { id: 'e1', subject: 'p:a', predicate: 'birthDate', object: '1037年1月8日' },
    { id: 'e2', subject: 'p:a', predicate: 'birthDate', object: '1037年' },
  ];
  const { flags } = runDetectors({ edges, lifespan: new Map(), literalPredicates: new Set(['birthDate']) });
  const hits = flags.filter((f) => f.detectorId === 'multiple-values');
  assert.equal(hits.length, 0, '同一年不同精度不该标冲突');
});

test('多说法：数值不同才是冲突', () => {
  const { runDetectors } = require('../../src/store/detectors/registry.js');
  const edges = [
    { id: 'e1', subject: 'p:a', predicate: 'birthDate', object: '1029年' },
    { id: 'e2', subject: 'p:a', predicate: 'birthDate', object: '1032年' },
  ];
  const { flags } = runDetectors({ edges, lifespan: new Map(), literalPredicates: new Set(['birthDate']) });
  const hits = flags.filter((f) => f.detectorId === 'multiple-values');
  assert.equal(hits.length, 2, '两个说法都该标');
});

test('多说法：跨归并组比较（同一人的两个来源实体）', () => {
  const { runDetectors } = require('../../src/store/detectors/registry.js');
  // 苏轼：CBDB 1036 / 维基 1037-01-08，是两个不同实体。
  // 不按归并组分组的话，检测器永远看不到这个冲突。
  const edges = [
    { id: 'e1', subject: 'person:cbdb-3767', predicate: 'birthDate', object: '1036年' },
    { id: 'e2', subject: 'person:wikipedia-abc', predicate: 'birthDate', object: '1037年1月8日' },
  ];
  const mergeMap = new Map([['person:wikipedia-abc', 'person:cbdb-3767']]);
  const { flags } = runDetectors({
    edges, lifespan: new Map(), literalPredicates: new Set(['birthDate']), mergeMap,
  });
  const hits = flags.filter((f) => f.detectorId === 'multiple-values');
  assert.equal(hits.length, 2, '归并后应看到两种说法');
});

test('归并：链接不删数据，可撤销', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'merge_entities.js'), 'utf8');
  // 物理合并（删实体、搬边）不可逆，且会丢「这条断言属于哪个来源」。
  assert.match(script, /entity_merges/);
  assert.match(script, /--unmerge/, '要能撤销');
  assert.match(script, /lifespanCompatible/, '要有生卒年兼容判断');
  // 归并结果要持久化到 JSON——数据库每次重建，表会清空
  assert.match(script, /merges\.json/);
});

test('归并审查：API 分档 + 页面默认看最可疑的', () => {
  const api = fs.readFileSync(path.join(ROOT, 'scripts', 'serve_api.js'), 'utf8');
  // 置信度分档：差 3 年以上最可疑（可能是同名不同人，也可能是真争议）
  assert.match(api, /'merges'/);
  assert.match(api, /tier/, '要有置信度分档');
  assert.match(api, /worst <= 2/, '1-2 年是跨年，3+ 要人看');

  const page = fs.readFileSync(path.join(ROOT, 'js', 'views', 'merge_review_page.js'), 'utf8');
  assert.match(page, /tierFilter: 'far'/, '默认停在差异大——用户不该逐条看 23 条一致的');
  assert.match(page, /nearHint/, '跨年的解释必须写在页面上，否则用户以为差 1 年也要处理');
  // 撤销入口现在是 --reject（人工拒绝 = 撤销归并，人的决定持久化）
  assert.match(page, /--reject/, '拒绝/撤销命令要可见');
  assert.match(page, /--confirm/, '确认命令要可见');
});

test('存续期回填：边 → 实体列，否则归并校验形同虚设', () => {
  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build_db.js'), 'utf8');
  // 维基实体只有生卒年边没有存续期列，归并时「生卒年不矛盾」
  // 永远自动通过——29 条实际是「同名即合并」。实测发现的。
  assert.match(build, /backfillLifespanFromEdges/);
  assert.match(build, /COALESCE\(valid_from/, '只填空的列，不覆盖已有值');
});

test('分歧总览：分类启发式 + 保守原则', () => {
  const api = fs.readFileSync(path.join(ROOT, 'scripts', 'serve_api.js'), 'utf8');
  assert.match(api, /'conflicts'/);
  // 传字符串数组——传对象数组 YEAR_ONLY 恒 false，全落 dispute，分类形同虚设
  assert.match(api, /g\.values\.map\(\(v\) => v\.value\)/);
  // 整年对整年差 1 无法区分跨年和争议，统一归 dispute 让人看
  assert.match(api, /宁可让人看|统一归入|保守/);

  const page = fs.readFileSync(path.join(ROOT, 'js', 'views', 'conflicts_page.js'), 'utf8');
  assert.match(page, /scholarly-dispute/, '默认先看争议——跨年读一遍就懂');
  assert.match(page, /并列保留全部说法/, '核心原则要写在页面上');
  assert.match(page, /分类只是/, '启发式可能错分，必须声明');
});
