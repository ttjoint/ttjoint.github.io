'use strict';
/**
 * Time model for HumanMap.
 *
 * All instants are stored as Julian Day Numbers (JDN) so that dates across the
 * full historical range — including BCE years, and later other calendars or
 * era-name systems — compare and sort with plain numbers.
 *
 * A record never stores a bare instant. It stores a `TimeRange`:
 *
 *   { start, end, mid, uncertainty, precision, source }
 *
 *   start / end   JDN bounds; `null` when that bound is unknown.
 *   mid           Best-guess JDN when the true value is fuzzy (e.g. 尧 = -1200±50).
 *   uncertainty   Radius in years around `mid` for fuzzy values; 0 for exact.
 *   precision     See PRECISION.
 *
 * The three query buckets the UI needs are derived from this shape:
 *   exact    both bounds known to the day (precision >= DAY and start/end exact)
 *   fuzzy    at least one endpoint exact, or a mid with bounded uncertainty
 *   vague    a mid with wide uncertainty (mythical figures such as 女娲)
 */

const PRECISION = Object.freeze({
  EXACT: 'exact',       // known to the day
  MONTH: 'month',       // known to the month
  YEAR: 'year',         // known to the year
  DECADE: 'decade',     // known to the decade
  CENTURY: 'century',   // known to the century
  APPROX: 'approx',     // explicit ± radius
  UNKNOWN: 'unknown',   // existence known, date not recoverable
});

/** Days in the Gregorian month (proleptic, incl. BCE). */
function isLeap(y) {
  // Astronomical year numbering: 1 BCE is year 0, which is a leap year.
  if (((y % 4) + 4) % 4 !== 0) return false;
  if (((y % 100) + 100) % 100 === 0 && ((y % 400) + 400) % 400 !== 0) return false;
  return true;
}

function monthLength(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/**
 * Convert a proleptic Gregorian date to a Julian Day Number.
 * Verified against the canonical epoch (2000-01-01 -> 2451545, 1970-01-01 -> 2440588)
 * and round-trips for BCE astronomical years.
 */
function julianToJdn(y, m, d) {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4)
    - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

/** Inverse of julianToJdn. */
function jdnToJulian(jdn) {
  const a = jdn + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d0 = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d0) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  return {
    year: 100 * b + d0 - 4800 + Math.floor(m / 10),
    month: m + 3 - 12 * Math.floor(m / 10),
    day: e - Math.floor((153 * m + 2) / 5) + 1,
  };
}

/** JDN for "mid-year" of a given (possibly BCE) year — used for coarse dates. */
const YEAR_JDN = 365.25;

function yearToJdn(year) {
  // Mid-year anchor so that a ± radius is symmetric around the year.
  return julianToJdn(year, 7, 1);
}

function jdnToYear(jdn) {
  return jdnToJulian(Math.round(jdn)).year;
}

/** Parse "1956年9月", "1956", "-1200", "公元前1200年", "1956-09". */
function parseYearMonth(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null;

  // 「之前 / 之后」不是年份，是一个开口区间。不能静默取前缀数字：
  // `1104年之前` 若返回 1104，就把一个半无穷区间压成了一个精确年，
  // 时间线会把它当成「活到 1104」而不是「不晚于 1104」。
  // 调用方（lifespanFromProps）负责把它变成单端区间。
  if (/[之之以]?[前后]$/.test(s)) return null;

  // 公元前 / 前 / negative
  let bce = false;
  let body = s;
  if (/^公元前/.test(body)) { bce = true; body = body.replace(/^公元前/, ''); }
  else if (/^前/.test(body)) { bce = true; body = body.replace(/^前/, ''); }

  const ym = body.match(/^(-?\d{1,5})年(?:\s*(\d{1,2})月)?(?:\s*(\d{1,2})日)?/);
  if (ym) {
    let year = parseInt(ym[1], 10);
    if (bce && year > 0) year = -year + 1; // 1 BCE == astronomical year 0
    const month = ym[2] ? parseInt(ym[2], 10) : null;
    const day = ym[3] ? parseInt(ym[3], 10) : null;
    return { year, month, day };
  }

  const iso = body.match(/^(-?\d{1,5})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (iso) {
    let year = parseInt(iso[1], 10);
    if (bce && year > 0) year = -year + 1;
    return { year, month: parseInt(iso[2], 10), day: iso[3] ? parseInt(iso[3], 10) : null };
  }

  const yOnly = body.match(/^(-?\d{1,5})$/);
  if (yOnly) {
    let year = parseInt(yOnly[1], 10);
    if (bce && year > 0) year = -year + 1;
    return { year, month: null, day: null };
  }

  return null;
}

/** Build a TimeRange from a single possibly-partial date (a point, or a year span). */
function pointRange(parsed, opts = {}) {
  if (!parsed) return null;
  const { year, month, day } = parsed;
  if (month && day) {
    const jdn = julianToJdn(year, month, day);
    return { start: jdn, end: jdn, mid: jdn, uncertainty: 0, precision: PRECISION.EXACT, source: opts.source || 'parsed' };
  }  if (month) {
    const start = julianToJdn(year, month, 1);
    const end = julianToJdn(year, month, monthLength(year, month));
    return { start, end, mid: Math.round((start + end) / 2), uncertainty: 0, precision: PRECISION.MONTH, source: opts.source || 'parsed' };
  }
  // Year only: the whole year is the range.
  const start = julianToJdn(year, 1, 1);
  const end = julianToJdn(year, 12, 31);
  return { start, end, mid: Math.round((start + end) / 2), uncertainty: 0, precision: PRECISION.YEAR, source: opts.source || 'parsed' };
}

/**
 * 解析「1104年之前」/ 「1104年之后」这种开口区间。
 *
 * CBDB 的 c_by_range / c_dy_range 用 before（-1）/ after（1）表示「只知道在此年之前/后」。
 * 按设计 §2.6「不虚构起止日」，因此只给已知那一端，另一端留 null。
 * 不能退化成精确年：那会把「不晚于 1104」读成「活到 1104」。
 *
 * Returns { start, end, mid, uncertainty, precision, source } or null.
 */
function parseOpenRange(text) {
  if (text == null) return null;
  const s = String(text).trim();
  const m = s.match(/^(公元前|前)?\s*(-?\d{1,5})\s*年?\s*(之前|之后|前|后)$/);
  if (!m) return null;
  let year = parseInt(m[2], 10);
  if (m[1] && year > 0) year = -year + 1;
  const parsed = { year, month: null, day: null };
  const r = pointRange(parsed);
  if (!r) return null;
  const isBefore = m[3] === '之前' || m[3] === '前';
  if (isBefore) {
    // 不晚于该年年底：上界已知，下界未知。
    return { start: null, end: r.end, mid: r.mid, uncertainty: 0, precision: PRECISION.UNKNOWN, source: 'open' };
  }
  // 不早于该年年初：下界已知，上界未知。
  return { start: r.start, end: null, mid: r.mid, uncertainty: 0, precision: PRECISION.UNKNOWN, source: 'open' };
}

/** Build a fuzzy range: a mid point plus a ± radius in years. */
function fuzzyRange(year, radiusYears, opts = {}) {
  const mid = yearToJdn(year);
  const half = Math.abs(radiusYears || 0) * YEAR_JDN;
  return {
    start: Math.round(mid - half),
    end: Math.round(mid + half),
    mid: Math.round(mid),
    uncertainty: Math.abs(radiusYears || 0),
    precision: radiusYears >= 100 ? PRECISION.UNKNOWN : PRECISION.APPROX,
    source: opts.source || 'estimate',
  };
}

/**
 * Parse the fuzzy textual form used by the data files, e.g.
 *
 *   "-1200±50年"   "约公元前1200年±50年"   "约 前300年 ± 30"   "1200+/-50"
 *
 * Returns { year, radius } in astronomical years (1 BCE == 0) or null.
 * The explicit ± is the *only* signal that the date is a guess; without it a
 * year is treated as a known calendar year, not as a ±0 estimate.
 */
function parseFuzzy(text) {
  if (text == null) return null;
  const s = String(text);
  // 「公元前」与「前」都要认。数据里的 `formatYear()` 写出的是「前300年」，
  // 而这里原先只匹配「公元前」——于是 `约 前300年 ± 30` 被读成公元 300 年，
  // 一个战国人的生年就变成了西晋。负号已经覆盖 ISO 写法（-300±30），
  // 但中文前缀必须单独处理。
  const m = s.match(/(?:约)?\s*(公元前|前)?\s*(-?\d{1,5})\s*年?\s*(?:±|\+\/-|\+-)\s*(\d{1,4})\s*年?/);
  if (!m) return null;
  let year = parseInt(m[2], 10);
  if (m[1] && year > 0) year = -year + 1; // 公元前N年 / 前N年 -> astronomical
  return { year, radius: parseInt(m[3], 10) };
}

/**
 * Build a lifespan range from optional birth/death inputs.
 * Handles the "only death year known" case by recording just that bound.
 */
function lifespanRange({ birth, death, birthFuzzy, deathFuzzy } = {}) {
  const b = birth ? parseYearMonth(birth) : null;
  const d = death ? parseYearMonth(death) : null;
  const bR = birthFuzzy ? fuzzyRange(birthFuzzy.year ?? birthFuzzy, birthFuzzy.radius ?? 0) : (b ? pointRange(b) : null);
  const dR = deathFuzzy ? fuzzyRange(deathFuzzy.year ?? deathFuzzy, deathFuzzy.radius ?? 0) : (d ? pointRange(d) : null);

  if (!bR && !dR) return null;
  const start = bR ? bR.start : null;
  const end = dR ? dR.end : null;
  // Representative instant: the midpoint between birth and death when both are
  // known. With only one endpoint we use that endpoint's own mid (e.g. death year
  // = mid of that calendar year), never an arbitrary offset from it.
  const mid = bR && dR ? Math.round((bR.mid + dR.mid) / 2) : (bR || dR).mid;
  const uncertainty = Math.max(bR ? bR.uncertainty : 0, dR ? dR.uncertainty : 0);
  // Precision describes how well the *known* endpoints are pinned down. With a
  // single endpoint we inherit its own precision instead of degrading to
  // 'unknown', otherwise every "born 1955-02" person would look vague.
  const precision = bR && dR
    ? (bR.precision === PRECISION.EXACT && dR.precision === PRECISION.EXACT ? PRECISION.EXACT : PRECISION.APPROX)
    : ((bR || dR).precision || PRECISION.UNKNOWN);
  return { start, end, mid, uncertainty, precision, source: 'lifespan' };
}

/** Overlap test used by the timeline range filter. */
function overlaps(range, loJdn, hiJdn) {
  if (!range) return false;
  const s = range.start != null ? range.start : range.mid;
  const e = range.end != null ? range.end : range.mid;
  if (s == null || e == null) return false;
  return s <= hiJdn && e >= loJdn;
}

/**
 * Classify a range into the three UI confidence buckets.
 *   exact — precise to the day on both ends
 *   fuzzy — at least one endpoint known, but not to the day
 *   vague — only a guessed mid with wide uncertainty
 */
function confidenceClass(range) {
  if (!range) return 'vague';
  const hasStart = range.start != null;
  const hasEnd = range.end != null;
  const exact = range.precision === PRECISION.EXACT && range.uncertainty === 0 && hasStart && hasEnd;
  if (exact) return 'exact';
  if ((hasStart || hasEnd) && (range.uncertainty === 0 || range.uncertainty < 100)) return 'fuzzy';
  return 'vague';
}

/** Human-readable formatting, BCE aware. */
function formatJdnYear(jdn) {
  const { year } = jdnToJulian(Math.round(jdn));
  if (year <= 0) return `公元前${1 - year}年`;
  return `${year}年`;
}

function formatRange(range) {
  if (!range) return '';
  // `uncertainty` 描述的是**单个估计点**的±半径。当一个区间同时有起止两端时，
  // 起止本身就是信息（「947 – 约1004」），压成中点会丢掉生卒年——
  // 时间线上看到「约 975年」而不是「947–1004」，等于把生卒抹了。
  if (range.uncertainty > 0 && range.mid != null
      && (range.start == null || range.end == null)) {
    return `约 ${formatJdnYear(range.mid)} ±${range.uncertainty}年`;
  }
  if (range.start != null && range.end != null && range.start === range.end) {
    const { year, month, day } = jdnToJulian(range.start);
    const y = year <= 0 ? `公元前${1 - year}` : `${year}`;
    return `${y}年${month}月${day}日`;
  }
  // A single year, or a single month, should read as that period rather than a span.
  if (range.precision === PRECISION.YEAR || range.precision === PRECISION.MONTH) {
    const { year, month } = jdnToJulian(range.mid);
    const y = year <= 0 ? `公元前${1 - year}年` : `${year}年`;
    return range.precision === PRECISION.MONTH ? `${y}${month}月` : y;
  }
  // Lifespans carry only one endpoint when the other is unknown (e.g. birth known,
  // death missing). Render just what we actually know instead of "1955 – ?".
  const onlyStart = range.start != null && range.end == null;
  const onlyEnd = range.start == null && range.end != null;
  // `source === 'open'` marks a date that is *intrinsically* open-ended
  // (CBDB's before/after), not a lifespan missing one end. Rendering「今」there
  // would claim a 1104 年之前 person is still alive.
  if (range.source === 'open') {
    if (onlyEnd) return `${formatJdnYear(range.end)} 之前`;
    if (onlyStart) return `${formatJdnYear(range.start)} 之后`;
    // Both ends open (e.g. a birth recorded as "1104年之前" gives only an upper
    // bound, which cannot serve as a lifespan start). Show the known anchor with
    // its direction rather than "? – ?".
    if (range.mid != null) {
      const anchor = formatJdnYear(range.mid);
      if (range.openDir === 'before') return `${anchor} 之前`;
      if (range.openDir === 'after') return `${anchor} 之后`;
      return `${anchor} 前后`;
    }
  }
  if (onlyStart) return `${formatJdnYear(range.start)} – 今`;
  if (onlyEnd) return `? – ${formatJdnYear(range.end)}`;
  const a = range.start != null ? formatJdnYear(range.start) : '?';
  const b = range.end != null ? formatJdnYear(range.end) : '?';
  return `${a} – ${b}`;
}

module.exports = {
  PRECISION,
  julianToJdn,
  jdnToJulian,
  yearToJdn,
  jdnToYear,
  parseYearMonth,
  parseFuzzy,
  parseOpenRange,
  pointRange,
  fuzzyRange,
  lifespanRange,
  overlaps,
  confidenceClass,
  formatRange,
  formatJdnYear,
  monthLength,
  isLeap,
};
