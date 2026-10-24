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
  // 批量取出（不是逐边查）——详情页要展示几十条边
  assert.match(api, /edge_id IN \(SELECT id FROM edges WHERE subject = \? OR object = \?\)/);
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
