/**
 * Timeline range filter — browser half of the time system.
 *
 * Implements the requirement:
 *   "搜索结果筛选增加可拖动时间范围条，只查询高亮条内实体；提供三档：
 *    只看精确日期 / 纳入单端点模糊 / 连完全模糊也纳入"
 *
 * Kept in sync with src/time/julian.js by porting the two JDN formulas.
 * If the core changes, update BOTH (tests pin the expected values).
 */
(function (global) {
  'use strict';

  var CONF = { EXACT: 'exact', FUZZY: 'fuzzy', VAGUE: 'vague' };

  // ---- Julian Day Number (proleptic Gregorian, matches src/time/julian.js) ----
  function julianToJdn(year, month, day) {
    var a = Math.floor((14 - (month || 1)) / 12);
    var y = year + 4800 - a;
    var m = (month || 1) + 12 * a - 3;
    var jdn = (day || 1)
      + Math.floor((153 * m + 2) / 5)
      + 365 * y
      + Math.floor(y / 4)
      - Math.floor(y / 100)
      + Math.floor(y / 400)
      - 32045;
    return jdn;
  }

  function jdnToJulian(jdn) {
    var a = jdn + 32044;
    var b = Math.floor((4 * a + 3) / 146097);
    var c = a - Math.floor(146097 * b / 4);
    var d = Math.floor((4 * c + 3) / 1461);
    var e = c - Math.floor(1461 * d / 4);
    var m = Math.floor((5 * e + 2) / 153);
    var day = e - Math.floor((153 * m + 2) / 5) + 1;
    var month = m + 3 - 12 * Math.floor(m / 10);
    var year = 100 * b + d - 4800 + Math.floor(m / 10);
    return { year: year, month: month, day: day };
  }

  function yearToJdn(y) { return julianToJdn(Math.round(y), 7, 1); }
  function jdnToYear(jdn) { return jdnToJulian(jdn).year; }

  function formatYear(y) {
    return y < 0 ? '公元前' + Math.abs(y) : String(y);
  }

  /**
   * Classify a stored lifespan into the three UI buckets.
   * Mirrors confidenceClass() in src/time/julian.js.
   */
  function confidenceClass(range) {
    if (!range) return CONF.VAGUE;
    var hasStart = range.start != null;
    var hasEnd = range.end != null;
    if (range.precision === 'exact' && range.uncertainty === 0 && hasStart && hasEnd) return CONF.EXACT;
    if ((hasStart || hasEnd) && (range.uncertainty === 0 || range.uncertainty < 100)) return CONF.FUZZY;
    return CONF.VAGUE;
  }

  /**
   * Does an entity fall inside [loJdn, hiJdn] for the given enabled buckets?
   * Returns false when the entity has no dates and a window is active.
   */
  function inWindow(entity, loJdn, hiJdn, confSet) {
    var range = entity && entity.lifespan;
    if (!range) return false;
    if (confSet && !confSet[confidenceClass(range)]) return false;
    var s = range.start != null ? range.start : range.mid;
    var e = range.end != null ? range.end : range.mid;
    if (s == null || e == null) return false;
    return s <= hiJdn && e >= loJdn;
  }

  var TimelineFilter = {
    CONF: CONF,

    data: function () {
      return {
        loYear: 1950,
        hiYear: 2026,
        minYear: -1500,
        maxYear: 2030,
        exact: true,
        fuzzy: true,
        vague: false,
        dragging: false,
        dragEdge: null,
        startPixel: 0,
        startLo: 0,
        startHi: 0
      };
    },

    computed: {
      confSet: function () {
        var s = {};
        if (this.exact) s[CONF.EXACT] = true;
        if (this.fuzzy) s[CONF.FUZZY] = true;
        if (this.vague) s[CONF.VAGUE] = true;
        return s;
      },
      rangeText: function () {
        return formatYear(this.loYear) + ' – ' + formatYear(this.hiYear);
      },
      /** Percentage offsets of the two handles across the track. */
      leftPct: function () {
        return this.toPct(this.loYear);
      },
      rightPct: function () {
        return this.toPct(this.hiYear);
      },
      loJdn: function () { return yearToJdn(this.loYear); },
      hiJdn: function () { return yearToJdn(this.hiYear); }
    },

    methods: {
      toPct: function (y) {
        var span = this.maxYear - this.minYear;
        if (span <= 0) return 0;
        return Math.max(0, Math.min(100, ((y - this.minYear) / span) * 100));
      },
      fromPct: function (pct, trackWidth) {
        var span = this.maxYear - this.minYear;
        return Math.round(this.minYear + (pct / trackWidth) * span);
      },
      startDrag: function (edge, ev) {
        this.dragging = true;
        this.dragEdge = edge;
        this.startPixel = ev.clientX;
        this.startLo = this.loYear;
        this.startHi = this.hiYear;
        ev.preventDefault();
      },
      onMove: function (ev) {
        if (!this.dragging) return;
        var track = this.$refs.track;
        if (!track) return;
        var width = track.getBoundingClientRect().width || 1;
        var deltaYears = Math.round(((ev.clientX - this.startPixel) / width) * (this.maxYear - this.minYear));
        if (this.dragEdge === 'lo') {
          this.loYear = Math.min(this.startLo + deltaYears, this.hiYear - 1);
        } else if (this.dragEdge === 'hi') {
          this.hiYear = Math.max(this.startHi + deltaYears, this.loYear + 1);
        } else if (this.dragEdge === 'span') {
          var span = this.startHi - this.startLo;
          var lo = this.startLo + deltaYears;
          lo = Math.max(this.minYear, Math.min(lo, this.maxYear - span));
          this.loYear = lo;
          this.hiYear = lo + span;
        }
      },
      endDrag: function () {
        if (!this.dragging) return;
        this.dragging = false;
        this.dragEdge = null;
        this.$emit('change', this.filter());
      },
      reset: function () {
        this.loYear = this.minYear;
        this.hiYear = this.maxYear;
        this.exact = true;
        this.fuzzy = true;
        this.vague = true;
        this.$emit('change', this.filter());
      },
      /** The filter object consumed by the list views. */
      filter: function () {
        return {
          loJdn: this.loJdn,
          hiJdn: this.hiJdn,
          loYear: this.loYear,
          hiYear: this.hiYear,
          confidence: this.confSet,
          inWindow: function (entity) {
            return inWindow(entity, this.loJdn, this.hiJdn, this.confSet);
          }.bind(this)
        };
      },
      emitChange: function () {
        this.$emit('change', this.filter());
      }
    },

    template: [
      '<div class="timeline-filter">',
      '  <div class="tl-head">',
      '    <span class="tl-label">时间范围</span>',
      '    <span class="tl-range">{{ rangeText }}</span>',
      '  </div>',
      '  <div class="tl-track" ref="track" @mousemove="onMove" @mouseup="endDrag" @mouseleave="endDrag">',
      '    <div class="tl-highlight" :style="{ left: leftPct + \'%\', width: (rightPct - leftPct) + \'%\' }"',
      '         @mousedown="startDrag(\'span\', $event)"></div>',
      '    <div class="tl-handle" :style="{ left: leftPct + \'%\' }" @mousedown="startDrag(\'lo\', $event)"></div>',
      '    <div class="tl-handle" :style="{ left: rightPct + \'%\' }" @mousedown="startDrag(\'hi\', $event)"></div>',
      '  </div>',
      '  <div class="tl-ticks">',
      '    <span v-for="t in [minYear, Math.round((minYear+maxYear)/2), maxYear]" :key="t">{{ t < 0 ? "前" + (-t) : t }}</span>',
      '  </div>',
      '  <div class="tl-conf">',
      '    <label><input type="checkbox" v-model="exact" @change="emitChange"> 精确日期</label>',
      '    <label><input type="checkbox" v-model="fuzzy" @change="emitChange"> 单端点模糊</label>',
      '    <label><input type="checkbox" v-model="vague" @change="emitChange"> 完全模糊</label>',
      '    <button class="btn btn-sm" @click="reset">重置</button>',
      '  </div>',
      '</div>'
    ].join('\n')
  };

  global.HMTime = {
    CONF: CONF,
    julianToJdn: julianToJdn,
    jdnToJulian: jdnToJulian,
    yearToJdn: yearToJdn,
    jdnToYear: jdnToYear,
    formatYear: formatYear,
    confidenceClass: confidenceClass,
    inWindow: inWindow,
    TimelineFilter: TimelineFilter
  };
})(window);
