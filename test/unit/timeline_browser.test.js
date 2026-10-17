'use strict';
/**
 * The browser timeline module re-implements two JDN formulas so it can run
 * without a build step. These tests pin parity with the Node core so the two
 * copies can never silently diverge.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const J = require('../../src/time/julian.js');

// Load the browser script into a fake window.
const sandbox = { window: {} };
const script = path.join(__dirname, '..', '..', 'js', 'core', 'timeline.js');
require('node:vm').runInNewContext(require('fs').readFileSync(script, 'utf8'), sandbox);
const HM = sandbox.window.HMTime;

test('timeline(js): JDN conversion matches the node core', () => {
  const cases = [[2000, 1, 1], [1970, 1, 1], [1858, 11, 17], [1956, 9, 15], [1644, 3, 19], [0, 1, 1], [-1200, 7, 1]];
  for (const [y, m, d] of cases) {
    assert.equal(HM.julianToJdn(y, m, d), J.julianToJdn(y, m, d), `${y}-${m}-${d}`);
  }
});

test('timeline(js): reverse conversion matches the node core', () => {
  for (const jdn of [2451545, 2440588, 2400001, 1700000]) {
    const a = HM.jdnToJulian(jdn);
    const b = J.jdnToJulian(jdn);
    assert.deepEqual([a.year, a.month, a.day], [b.year, b.month, b.day], `jdn ${jdn}`);
  }
});

test('timeline(js): confidence buckets match the node core', () => {
  const ranges = [
    J.pointRange({ year: 1956, month: 9, day: 15, precision: 'exact' }),
    J.pointRange({ year: 1956, month: 9, day: null }),
    J.fuzzyRange(-1200, 50),
    J.fuzzyRange(-1200, 400),
    null,
  ];
  for (const r of ranges) {
    assert.equal(HM.confidenceClass(r), J.confidenceClass(r), JSON.stringify(r && r.precision));
  }
});

test('timeline(js): inWindow honours the window and buckets', () => {
  const exact = { lifespan: J.pointRange({ year: 1956, month: 9, day: 15, precision: 'exact' }) };
  const vague = { lifespan: J.fuzzyRange(-1200, 400) };
  const window2 = [J.julianToJdn(1940, 1, 1), J.julianToJdn(1960, 1, 1)];

  assert.equal(HM.inWindow(exact, window2[0], window2[1], { exact: true }), true);
  assert.equal(HM.inWindow(exact, window2[0], window2[1], { fuzzy: true }), false, 'bucket filter must exclude');
  assert.equal(HM.inWindow(vague, window2[0], window2[1], { vague: true }), false, 'outside window');
  assert.equal(HM.inWindow({}, window2[0], window2[1], { exact: true }), false, 'undated excluded');
});

test('timeline(js): BCE years format as 公元前', () => {
  assert.equal(HM.formatYear(-1200), '公元前1200');
  assert.equal(HM.formatYear(1956), '1956');
});
