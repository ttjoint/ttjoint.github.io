'use strict';
/**
 * HTTP and HTML helpers shared by the source-scraping scripts.
 *
 * Five scripts had each pasted their own `get()` (http vs https, UA header,
 * redirect handling) and four had their own `clean()` (tag stripping, entity
 * decoding). The copies had already drifted: some returned a string, one
 * returned `{status, body, final}`, and the entity table differed between
 * them — so two importers could extract different text from the same page.
 *
 * This module is the single implementation. It is deliberately dependency-free
 * (no cheerio): the pages we read are simple enough that regex stripping is
 * fine, and adding a parser would not make the output more correct.
 */

const http = require('http');
const https = require('https');

/** Default UA. Identifies the project without pretending to be a browser. */
const DEFAULT_UA = 'HumanMap/1.0 (+https://github.com/ttjoint/ttjoint.github.io)';

/**
 * Named HTML entities worth decoding. Numeric entities are handled separately.
 *
 * Kept small on purpose: decoding every possible entity invites mojibake, and
 * government pages overwhelmingly use these.
 */
const ENTITIES = {
  '&nbsp;': ' ',
  '&#160;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&middot;': '·',
};

/**
 * Strip tags and decode entities.
 *
 * `script`/`style` bodies are removed entirely first, otherwise their contents
 * leak into the text and pollute extracted names.
 *
 * @param {string} html
 * @param {{collapse?: boolean}} [opts] collapse=false keeps newlines (useful
 *   when the caller wants paragraph structure)
 */
function cleanHtml(html, opts = {}) {
  const { collapse = true } = opts;
  let s = String(html || '');
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // Block-level tags become newlines so paragraphs stay separable.
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|br)\s*>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');

  for (const [entity, char] of Object.entries(ENTITIES)) {
    s = s.split(entity).join(char);
  }
  // Numeric entities: decimal and hex.
  s = s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));

  if (collapse) {
    s = s.replace(/[\s\u00a0]+/g, ' ');
  } else {
    // Keep newlines (callers rely on them to split blocks) but tidy the
    // whitespace *within* each line, so a tag boundary does not leave a
    // leading space on every paragraph.
    s = s.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  }
  return s.trim();
}

/**
 * Fetch a URL.
 *
 * Follows redirects (government sites use them heavily), enforces a timeout,
 * and caps the response size so a misconfigured URL cannot exhaust memory.
 *
 * @param {string} url
 * @param {{headers?: object, timeout?: number, maxBytes?: number, followRedirects?: number}} [opts]
 * @returns {Promise<{status: number, body: string, finalUrl: string, headers: object}>}
 */
function fetchText(url, opts = {}) {
  const {
    headers = {},
    timeout = 30000,
    maxBytes = 8 * 1024 * 1024,
    followRedirects = 5,
  } = opts;

/**
 * 按正确的字符集解码响应体。
 *
 * 顺序：HTTP 头里的 charset → HTML meta 声明 → UTF-8 试解 → GBK 兜底。
 *
 * 为什么最后用「试解 + 判断」而不是直接 GBK：GBK 也能「成功」解出
 * UTF-8 字节（得到乱码但不抛错），所以不能只看有没有报错。
 * 判据用替换字符（U+FFFD）的数量——UTF-8 硬解 GBK 文本会产生大量
 * U+FFFD，反之 GBK 解 UTF-8 文本也会。
 */
function decodeBody(buf, contentType) {
  const fromHeader = /charset=([\w-]+)/i.exec(contentType || '');
  if (fromHeader) {
    const enc = normalizeEncoding(fromHeader[1]);
    try {
      return new TextDecoder(enc).decode(buf);
    } catch {
      /* 未知编码，继续尝试 */
    }
  }

  // HTML 里的 meta charset（只扫前 2KB，声明总在头部）
  const head = buf.subarray(0, 2048).toString('latin1');
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  if (fromMeta) {
    const enc = normalizeEncoding(fromMeta[1]);
    try {
      return new TextDecoder(enc).decode(buf);
    } catch {
      /* 继续 */
    }
  }

  // 无声明：比较两种解码的乱码比例，取干净的那个。
  const asUtf8 = new TextDecoder('utf-8').decode(buf);
  const badUtf8 = (asUtf8.match(/�/g) || []).length;
  if (badUtf8 === 0) return asUtf8;

  try {
    const asGbk = new TextDecoder('gbk').decode(buf);
    const badGbk = (asGbk.match(/�/g) || []).length;
    if (badGbk < badUtf8) return asGbk;
  } catch {
    /* 环境不支持 GBK，返回 UTF-8 结果 */
  }
  return asUtf8;
}

/** 常见别名归一。 */
function normalizeEncoding(enc) {
  const e = String(enc).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (e === 'gb2312' || e === 'gbk' || e === 'gb18030' || e === 'cp936') return 'gbk';
  if (e === 'utf8') return 'utf-8';
  return e;
}

  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`invalid URL: ${url}`));
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;

    const req = lib.request(parsed, {
      method: 'GET',
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        ...headers,
      },
    }, (res) => {
      const status = res.statusCode || 0;

      // Redirect: resolve against the *current* URL, then recurse.
      if (status >= 300 && status < 400 && res.headers.location && followRedirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, parsed).href;
        resolve(fetchText(next, { ...opts, followRedirects: followRedirects - 1 }));
        return;
      }

      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy(new Error(`response exceeded ${maxBytes} bytes: ${url}`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status,
          // 不能一律按 UTF-8 解。
          //
          // 中文站点大量仍用 GBK（人民网、很多政府网站）。按 UTF-8 硬解
          // 得到的是「ϰ��ƽͬ־����」这种乱码——不报错，但内容不可用，
          // 而且会静默流进 raw 层，之后所有抽取都基于乱码。
          // 实测：73 个人民网页面全部踩中。
          body: decodeBody(buf, res.headers['content-type']),
          finalUrl: parsed.href,
          headers: res.headers,
        });
      });
      res.on('error', reject);
    });

    req.setTimeout(timeout, () => {
      req.destroy(new Error(`timeout after ${timeout}ms: ${url}`));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Fetch and verify the response is usable.
 *
 * Throws on non-2xx so callers do not have to remember to check.
 */
async function fetchOk(url, opts = {}) {
  const res = await fetchText(url, opts);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res;
}

/**
 * Extract `<a href>` links with their cleaned text.
 *
 * Shared by the discoverers; each then filters by its own URL/name rules.
 *
 * @param {string} html
 * @param {string} baseUrl  used to resolve relative hrefs
 * @returns {Array<{text: string, url: string}>}
 */
function extractLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const text = cleanHtml(m[2]);
    if (!text) continue;
    let url;
    try {
      url = new URL(m[1], baseUrl).href;
    } catch {
      continue;
    }
    if (!/^https?:\/\//.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ text, url });
  }
  return out;
}

/** Extract the `<title>`, cleaned. Returns '' when absent. */
function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return m ? cleanHtml(m[1]) : '';
}

module.exports = {
  DEFAULT_UA,
  ENTITIES,
  cleanHtml,
  fetchText,
  fetchOk,
  extractLinks,
  extractTitle,
};
