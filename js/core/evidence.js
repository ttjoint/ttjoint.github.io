/**
 * Evidence presentation helpers (browser).
 *
 * The evidence nodes carry structured fields — carrier, medium, documentedAt,
 * url, reliability — but the detail view only rendered name and url, so a
 * citation told you almost nothing about where the claim came from.
 *
 * This module turns a node into display rows. It is pure logic (no Vue, no DOM)
 * so it can be unit-tested in Node, and its `MEDIUM_LABELS` table is asserted
 * against `src/store/evidence.js` by the test suite: two copies of an enum that
 * drift apart show the wrong label rather than failing loudly.
 */
(function (global) {
  'use strict';

  var MEDIUM_LABELS = {
    // 二手数据库：它不是文献本身，而是把文献整理成字段的库。
    // 标注出来比让人以为「引文」就是原文更诚实。
    database: '二手数据库',
    newspaper: '报刊',
    periodical: '期刊',
    book: '书籍',
    inscription: '碑刻',
    archive: '档案',
    gazette: '公报',
    oral: '口述',
    web: '网络',
  };

  /** Fall back to the raw key so an unlabelled medium is visible, not blank. */
  function mediumLabel(medium) {
    if (!medium) return '';
    return MEDIUM_LABELS[medium] || medium;
  }

  /**
   * Format a TimeRange as a readable year/date span.
   *
   * Deliberately conservative: it only claims what the data supports. A range
   * with `uncertainty > 0` is shown with ±, and a missing side is left out
   * rather than invented — the whole point of storing fuzzy medieval dates as
   * mid ± uncertainty is lost if the UI rounds them into a confident-looking
   * single date.
   *
   * Year conversion delegates to HMTime (js/core/timeline.js), which is already
   * cross-checked against src/time/julian.js. A second calendar implementation
   * here would be a second place for off-by-one bugs.
   */
  function formatRange(range) {
    if (!range) return '';
    if (!global.HMTime || typeof global.HMTime.jdnToYear !== 'function') return '';
    var start = range.start;
    var end = range.end;
    var mid = range.mid != null ? range.mid : start;
    if (mid == null && start == null && end == null) return '';

    var fmt = function (jdn) {
      if (jdn == null) return '';
      var y = global.HMTime.jdnToYear(jdn);
      return y < 0 ? ('前' + Math.abs(y) + '年') : (y + '年');
    };

    var text;
    if (start != null && end != null && start !== end) {
      text = fmt(start) + '–' + fmt(end);
    } else {
      text = fmt(mid != null ? mid : (start != null ? start : end));
    }
    if (range.uncertainty) text += ' ±' + range.uncertainty;
    return text;
  }

  /**
   * Turn an evidence node into ordered [label, value] display rows.
   *
   * Only non-empty fields become rows: a card full of "未知" is noise, and the
   * UI already has a dedicated state for an unresolved carrier.
   */
  function describeEvidence(node, resolveName) {
    if (!node) return [];
    var rows = [];
    var resolve = typeof resolveName === 'function' ? resolveName : function () { return null; };

    if (node.carrierName) {
      rows.push({ key: 'carrier', label: '载体', value: node.carrierName });
    } else if (node.carrier) {
      var name = resolve(node.carrier);
      rows.push({
        key: 'carrier',
        label: '载体',
        value: name || node.carrier,
        unresolved: !name,
      });
    }

    if (node.medium) {
      rows.push({ key: 'medium', label: '媒介', value: mediumLabel(node.medium) });
    }
    var when = formatRange(node.documentedAt);
    if (when) rows.push({ key: 'when', label: '记载时间', value: when });
    if (node.reliability != null) {
      rows.push({ key: 'reliability', label: '可信度', value: String(node.reliability) });
    }
    if (node.url) rows.push({ key: 'url', label: '链接', value: node.url, link: true });
    if (node.accessedAt) rows.push({ key: 'accessed', label: '抓取时间', value: node.accessedAt });
    return rows;
  }

  global.HMEvidence = {
    MEDIUM_LABELS: MEDIUM_LABELS,
    mediumLabel: mediumLabel,
    formatRange: formatRange,
    describeEvidence: describeEvidence,
  };
})(typeof window !== 'undefined' ? window : globalThis);
