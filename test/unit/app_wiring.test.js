'use strict';
/**
 * Wiring test for js/app.js (the Vue assembly layer).
 *
 * app.js has no exports and needs Vue/D3, so it is loaded under stubs. The test
 * catches the failure mode a module refactor produces: a reference to a global
 * that moved into js/core/, or a compatibility shim that stopped covering the
 * whole predicate table. Nothing here exercises rendering.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

const CORE = [
  'predicates.js', 'timeline.js', 'data_store.js', 'api.js', 'relations.js',
  'search.js', 'source_parser.js', 'direction.js', 'evidence.js', 'graph_render.js',
];

// Load order mirrors index.html: core → services → views → app.
const SERVICES = ['services.js'];
const VIEWS = [
  // entity/ 子组件先于 entity_detail.js——模板里引用它们。
  'search_bar.js', 'home.js', 'entity/info_card.js', 'entity/source_chain.js',
  'entity_detail.js', 'family_tree.js',
  'predicate_page.js', 'source_page.js', 'all_objects.js', 'search_results.js',
];

function boot() {
  const store = new Map();
  const sandbox = {
    console, JSON, Date, Math, Set, Map, Promise, Error,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    document: {
      body: { classList: { toggle() {}, add() {}, remove() {} } },
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
      addEventListener() {},
    },
    location: { hostname: 'localhost', protocol: 'http:', href: 'http://localhost/' },
    fetch: () => Promise.resolve({ json: () => Promise.resolve([]) }),
    addEventListener() {},
    alert() {},
    confirm: () => false,
    // Minimal Vue / VueRouter / D3 stand-ins: enough for module top-level code.
    Vue: {
      createApp: () => ({
        use() { return this; },
        component() { return this; },
        config: { globalProperties: {} },
        mount() { return this; },
      }),
      RouterLink: {},
      RouterView: {},
    },
    VueRouter: {
      createRouter: () => ({ push() {}, replace() {}, route: {} }),
      createWebHashHistory: () => ({}),
    },
    d3: {
      select: () => ({ html() { return this; }, append() { return this; }, attr() { return this; } }),
      forceSimulation: () => ({}),
      zoom: () => ({}),
    },
    Fuse: null,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const run = (rel) => vm.runInNewContext(
    fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel },
  );
  for (const file of CORE) run('js/core/' + file);
  for (const file of SERVICES) run('js/' + file);
  for (const file of VIEWS) run('js/views/' + file);
  run('js/app.js');
  return sandbox;
}

test('app.js: the wiring layer loads with every core module present', () => {
  assert.doesNotThrow(boot, 'js/app.js must load without throwing');
});

test('app.js: the globals the components rely on all exist', () => {
  const sandbox = boot();
  // const/let declarations are script-scoped, not properties of the global
  // object, so probe them by evaluating inside the same context.
  const names = [
    'DataStore', 'SearchEngine', 'SourceParser', 'RelationManager',
    'RelationRegistry', 'RelationDirection', 'renderGraph', 'EntitySchema',
    'isLocalMode', 'listRelationWords', 'typeLabel', 'typeRoute', 'HMEvidence',
  ];
  const probe = JSON.parse(vm.runInNewContext(
    'JSON.stringify([' + names.map(n => `typeof ${n}`).join(',') + '])',
    sandbox,
  ));
  names.forEach((name, i) => {
    assert.notEqual(probe[i], 'undefined', `${name} is not defined in app.js`);
  });
});

test('app.js: RelationRegistry shim covers every predicate', () => {
  const sandbox = boot();
  const missing = JSON.parse(vm.runInNewContext(
    `JSON.stringify(Object.keys(HMPredicates.PREDICATES).filter(k => {
       const d = RelationRegistry[k];
       return !d || !d.label || !d.targetType;
     }))`,
    sandbox,
  ));
  assert.deepEqual(missing, [], 'every predicate must be readable through RelationRegistry');
});

test('app.js: RelationRegistry derives hasRole/hasDate from predicates', () => {
  const sandbox = boot();
  const probe = JSON.parse(vm.runInNewContext(
    `JSON.stringify({
       memberOf: RelationRegistry['所属组织'],
       gender: RelationRegistry['性别'],
       spouse: RelationRegistry['配偶']
     })`,
    sandbox,
  ));
  assert.equal(probe.memberOf.hasRole, true);
  assert.equal(probe.memberOf.hasDate, true);
  assert.equal(probe.gender.hasRole, false);
  // A symmetric predicate collapses because inverse === key.
  assert.equal(probe.spouse.targetType, 'person');
});

test('app.js: 前端没有修改谓词的能力', () => {
  // 谓词是代码资产（src/predicates/registry.js），改动要走代码审查。
  // 曾经界面可以增删改自定义关系词并存 localStorage，那会立刻产生一批
  // 只有这个浏览器认识的谓词，且它们的边没有 domain/range 约束、没有出处校验。
  const sandbox = boot();
  const result = JSON.parse(vm.runInNewContext(
    `JSON.stringify({
       hasAdd: typeof RelationManager.addRelation,
       hasUpdate: typeof RelationManager.updateRelation,
       hasDelete: typeof RelationManager.deleteRelation,
       hasSave: typeof RelationManager.save,
       // 只读查询必须还在——谓词页和详情页靠它渲染。
       getAll: typeof RelationManager.getAll,
     })`,
    sandbox,
  ));
  assert.equal(result.hasAdd, 'undefined');
  assert.equal(result.hasUpdate, 'undefined');
  assert.equal(result.hasDelete, 'undefined');
  assert.equal(result.hasSave, 'undefined');
  assert.equal(result.getAll, 'function');
});

test('app.js: EntitySchema and the routing helpers cover all five types', () => {
  // The type table was three entries while the data model had five, and six
  // views each carried their own `{person,organization,event}` route map. A
  // thing or evidence entity therefore linked to /person/ and rendered its raw
  // type key instead of a Chinese label.
  const sandbox = boot();
  const out = JSON.parse(vm.runInNewContext(`JSON.stringify({
    types: Object.keys(EntitySchema),
    labels: Object.keys(EntitySchema).map(k => typeLabel(k)),
    routes: Object.keys(EntitySchema).map(k => typeRoute(k, 'x')),
    unknownLabel: typeLabel('nonsense'),
    unknownRoute: typeRoute('nonsense', 'x'),
  })`, sandbox));

  assert.deepEqual(out.types.sort(), ['event', 'evidence', 'organization', 'person', 'thing']);
  for (let i = 0; i < out.types.length; i++) {
    assert.notEqual(out.labels[i], out.types[i], `${out.types[i]} has no label`);
    assert.equal(out.routes[i], `/${out.routes[i].split('/')[1]}/x`);
  }
  // A bad type must not produce '/undefined/'.
  assert.equal(out.unknownLabel, 'nonsense');
  assert.equal(out.unknownRoute, '/person/x');
});

test('app.js: every declared type has a router entry', () => {
  // A type in the schema but not in the router makes its detail links dead
  // inside the SPA: no error, just a blank view at a path nothing matches.
  const sandbox = boot();
  const out = JSON.parse(vm.runInNewContext(`JSON.stringify({
    want: Object.keys(EntitySchema).map(k => '/' + EntitySchema[k].route + '/:id'),
    have: routes.map(r => r.path),
  })`, sandbox));
  for (const path of out.want) {
    assert.ok(out.have.includes(path), `no route for ${path}`);
  }
});
