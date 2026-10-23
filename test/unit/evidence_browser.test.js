'use strict';
/**
 * The browser evidence presenter must agree with the Node core.
 *
 * There are two copies of the medium enum and its Chinese labels: one in
 * `src/store/evidence.js` for importers, one in `js/core/evidence.js` for the
 * UI. A drifted copy does not crash — it silently renders the wrong label (or a
 * raw key), which is exactly the class of bug that survives a green test run.
 * These tests compare the copies and check the formatting rules.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const core = require('../../src/store/evidence.js');
const julian = require('../../src/time/julian.js');

const ROOT = path.join(__dirname, '..', '..');

/** Load timeline.js then evidence.js in one context, as index.html does. */
function boot() {
  const sandbox = { window: {}, console };
  vm.runInNewContext(
    fs.readFileSync(path.join(ROOT, 'js', 'core', 'timeline.js'), 'utf8'),
    sandbox,
  );
  sandbox.HMTime = sandbox.window.HMTime;
  vm.runInNewContext(
    fs.readFileSync(path.join(ROOT, 'js', 'core', 'evidence.js'), 'utf8'),
    sandbox,
  );
  return sandbox.window.HMEvidence;
}

test('evidence(js): medium labels match the core exactly', () => {
  const HM = boot();
  const coreKeys = Object.keys(core.MEDIUM_LABELS).sort();
  const browserKeys = Object.keys(HM.MEDIUM_LABELS).sort();
  assert.deepEqual(browserKeys, coreKeys, 'medium enum drifted between core and browser');
  for (const key of coreKeys) {
    assert.equal(HM.MEDIUM_LABELS[key], core.MEDIUM_LABELS[key], `label for ${key} differs`);
  }
});

test('evidence(js): every MEDIUM value has a label', () => {
  const HM = boot();
  for (const medium of Object.values(core.MEDIUM)) {
    assert.ok(HM.MEDIUM_LABELS[medium], `medium "${medium}" has no browser label`);
    assert.notEqual(HM.mediumLabel(medium), medium, `medium "${medium}" rendered as raw key`);
  }
});

test('evidence(js): an unknown medium is shown, not swallowed', () => {
  const HM = boot();
  // Better a visible wrong-looking key than an empty cell: it surfaces the
  // upstream bug instead of hiding it.
  assert.equal(HM.mediumLabel('microfilm'), 'microfilm');
  assert.equal(HM.mediumLabel(''), '');
  assert.equal(HM.mediumLabel(null), '');
});

test('evidence(js): years agree with the core calendar', () => {
  const HM = boot();
  // Anchor dates from src/time/julian.js, plus a BCE case.
  for (const [year, month, day] of [[2000, 1, 1], [1970, 1, 1], [1978, 5, 11], [1893, 12, 26]]) {
    const jdn = julian.julianToJdn(year, month, day);
    const text = HM.formatRange({ start: jdn, end: jdn, mid: jdn, uncertainty: 0 });
    assert.equal(text, `${year}年`, `JDN ${jdn} rendered as ${text}`);
  }
});

test('evidence(js): a fuzzy range keeps its uncertainty', () => {
  const HM = boot();
  const jdn = julian.julianToJdn(-1200, 1, 1);
  const text = HM.formatRange({ start: jdn, end: jdn, mid: jdn, uncertainty: 50 });
  // "-1200 ± 50年" must not be flattened into a confident single year.
  assert.ok(text.includes('前'), `negative year lost its era: ${text}`);
  assert.ok(text.includes('±50'), `uncertainty dropped: ${text}`);
});

test('evidence(js): a span renders both ends', () => {
  const HM = boot();
  const a = julian.julianToJdn(1900, 1, 1);
  const b = julian.julianToJdn(1950, 1, 1);
  const text = HM.formatRange({ start: a, end: b, mid: a, uncertainty: 0 });
  assert.equal(text, '1900年–1950年');
});

test('evidence(js): an empty range renders nothing rather than a placeholder', () => {
  const HM = boot();
  assert.equal(HM.formatRange(null), '');
  assert.equal(HM.formatRange({}), '');
  assert.equal(HM.formatRange({ start: null, end: null, mid: null }), '');
});

test('evidence(js): describeEvidence lists only fields the node has', () => {
  const HM = boot();
  const node = {
    id: 'evidence:x',
    name: '人民日报 1978-05-11 某篇报道',
    carrier: 'thing:abc',
    carrierName: '人民日报',
    medium: 'newspaper',
    url: 'http://paper.people.com.cn/',
    reliability: 0.9,
  };
  const rows = HM.describeEvidence(node, () => '人民日报');
  // JSON comparison: values cross a vm boundary, so their Array prototype is
  // not this realm's and deepEqual rejects them as 'not reference-equal'.
  const keys = rows.map((r) => r.key);
  assert.equal(JSON.stringify(keys), JSON.stringify(['carrier', 'medium', 'reliability', 'url']));

  const byKey = {};
  for (const r of rows) byKey[r.key] = r;
  assert.equal(byKey.carrier.value, '人民日报');
  assert.equal(byKey.medium.value, '报刊');
  assert.equal(byKey.reliability.value, '0.9', 'reliability 0.9 lost precision');
  assert.equal(byKey.url.link, true, 'url must render as a link');
});

test('evidence(js): reliability 0 is shown, not treated as unset', () => {
  const HM = boot();
  const rows = HM.describeEvidence({ carrierName: 'x', reliability: 0 }, () => 'x');
  const rel = rows.find((r) => r.key === 'reliability');
  assert.ok(rel, 'reliability 0 was dropped as falsy');
  assert.equal(rel.value, '0');
});

test('evidence(js): an unresolvable carrier id is marked, not hidden', () => {
  const HM = boot();
  const rows = HM.describeEvidence({ carrier: 'thing:gone', medium: 'web' }, () => null);
  const carrier = rows.find((r) => r.key === 'carrier');
  assert.ok(carrier, 'carrier row vanished when it could not be resolved');
  assert.equal(carrier.value, 'thing:gone');
  assert.equal(carrier.unresolved, true);
});

test('evidence(js): describeEvidence handles a node with no fields', () => {
  const HM = boot();
  assert.equal(JSON.stringify(HM.describeEvidence(null)), '[]');
  assert.equal(JSON.stringify(HM.describeEvidence({ id: 'evidence:y' })), '[]');
});
