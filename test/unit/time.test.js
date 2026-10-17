'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const J = require('../../src/time/julian.js');

test('julian: known JDN anchors', () => {
  assert.equal(J.julianToJdn(2000, 1, 1), 2451545);
  assert.equal(J.julianToJdn(1970, 1, 1), 2440588);
  assert.equal(J.julianToJdn(1858, 11, 17), 2400001); // MJD epoch
});

test('julian: round trip including BCE', () => {
  for (const [y, m, d] of [[2000, 1, 1], [1956, 9, 15], [1644, 3, 19], [0, 1, 1], [-1200, 7, 1]]) {
    const back = J.jdnToJulian(J.julianToJdn(y, m, d));
    assert.equal(back.year, y, `year ${y}`);
    assert.equal(back.month, m, `month ${m}`);
    assert.equal(back.day, d, `day ${d}`);
  }
});

test('julian: parseYearMonth handles common Chinese date forms', () => {
  const r = J.parseYearMonth('1956年9月');
  assert.equal(r.year, 1956);
  assert.equal(r.month, 9);
  // Precision lives on the derived TimeRange, not on the raw parse result.
  assert.equal(J.pointRange(r).precision, 'month');
  assert.equal(J.pointRange(J.parseYearMonth('1956年')).precision, 'year');
  // '公元前1200年' is 1200 BCE -> astronomical year -1199 (1 BCE = 0).
  assert.equal(J.parseYearMonth('公元前1200年').year, -1199);
  assert.equal(J.parseYearMonth('前1200年').year, -1199);
  const iso = J.parseYearMonth('1949-10-01');
  assert.equal(J.pointRange(iso).precision, 'exact');
  assert.equal(J.parseYearMonth(''), null);
  assert.equal(J.parseYearMonth('不是日期'), null);
});

test('julian: fuzzyRange encodes midpoint and uncertainty', () => {
  const r = J.fuzzyRange(-1200, 50);
  assert.equal(r.uncertainty, 50);
  assert.equal(r.precision, 'approx');
  const back = J.jdnToJulian(r.mid);
  assert.ok(Math.abs(back.year - (-1200)) <= 1, `mid year ${back.year}`);
  assert.ok(r.start < r.mid && r.mid < r.end);
});

test('julian: lifespanRange supports death-only', () => {
  const r = J.lifespanRange({ death: '1104年' });
  assert.equal(r.start, null);
  assert.ok(r.end > 0);
  // With only the death year, the representative instant must fall inside that
  // same calendar year (not shifted), and start stays unknown.
  const midYear = J.jdnToJulian(r.mid).year;
  const endYear = J.jdnToJulian(r.end).year;
  assert.equal(midYear, endYear);
  assert.ok(r.mid <= r.end);
});

test('julian: confidenceClass buckets', () => {
  assert.equal(J.confidenceClass(J.pointRange({ year: 1956, month: 9, day: 15, precision: 'exact' })), 'exact');
  assert.equal(J.confidenceClass(J.fuzzyRange(-1200, 50)), 'fuzzy');
  assert.equal(J.confidenceClass(J.fuzzyRange(-1200, 400)), 'vague');
});

test('julian: overlaps respects window edges', () => {
  const r = J.pointRange({ year: 1956, month: 9, day: 15, precision: 'exact' });
  assert.equal(J.overlaps(r, r.start, r.end), true);
  assert.equal(J.overlaps(r, r.end + 1, r.end + 100), false);
});

test('julian: formatRange renders readable Chinese', () => {
  const r = J.pointRange({ year: 1956, month: 9, day: 15, precision: 'exact' });
  const s = J.formatRange(r);
  assert.match(s, /1956/);
  assert.match(J.formatJdnYear(J.julianToJdn(-1200, 7, 1)), /公元前/);
});
