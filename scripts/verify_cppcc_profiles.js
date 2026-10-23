#!/usr/bin/env node
/**
 * Refine CPPCC directory candidates.
 *
 * Stage 2 of the CPPCC pipeline. The discovery step cannot tell a resume page
 * from a section index — both are links under /zxld/. This step fetches each
 * candidate and decides:
 *
 *   candidate          a real resume page (URL pattern + 简历 in title + enough text)
 *   section-or-index   a listing page, not a person
 *
 * It also slices out the resume body itself, because the LLM step downstream
 * should see the person's text and not the whole site chrome.
 *
 * Design note: a failed fetch is recorded per-URL rather than aborting the run.
 * Government hostnames go up and down, and one 502 should not discard the
 * other 40 profiles.
 */
const path = require('path');
const { fetchText, cleanHtml } = require('../src/net/http');
const { readLatestBatch, writeBatch } = require('../src/store/batches');
const { entityId } = require('../src/store/entity_id');
const { personKeyFromUrl } = require('../src/store/source_key');

/** Resume URLs: dated article pages (`/202303/t20230313_1234.html`) or a name folder. */
const RESUME_URL_RE = /\/\d{6}\/t\d+_\d+\.html$/i;

/** Site title that means we fetched the homepage, not a person. */
const SITE_NAME = '中国政协网';

/** Markers that end the resume body; everything after is related-links noise. */
const BODY_END_RE = /图片报道|视频报道|活动报道集|相关新闻/;

/** Leading punctuation/suffixes that appear in <title> but not in a name. */
function personNameFromTitle(title, fallback) {
  const cleaned = cleanHtml(title)
    .replace(/[|｜].*$/, '')
    .replace(/[-_—].*$/, '')
    .replace(/简历|个人简历|同志简历/g, '')
    .replace(/\s+/g, '')
    .trim();
  return /^[\u4e00-\u9fff·]{2,12}$/.test(cleaned) ? cleaned : fallback;
}

/**
 * Slice the resume body out of the cleaned page text.
 *
 * Resumes open with `<name>，<gender>，…`. Prefer that anchor; fall back to the
 * last `<name>简历` heading, then to the first mention of the name.
 */
function extractResumeText(text, name) {
  let start = -1;

  for (const gender of ['男', '女']) {
    for (const sep of ['，', ',']) {
      const i = text.indexOf(name + sep + gender);
      if (i >= 0) start = i;
    }
  }

  if (start < 0) {
    // "XXX简历" heading, taking the last occurrence (page nav often repeats it).
    const tag = name + '简历';
    let last = -1;
    let i = 0;
    while ((i = text.indexOf(tag, i)) >= 0) {
      last = i;
      i += tag.length;
    }
    if (last >= 0) start = last + tag.length;
  }

  if (start < 0) start = Math.max(0, text.indexOf(name));

  let body = text.slice(start);
  const cut = body.search(BODY_END_RE);
  if (cut > 60) body = body.slice(0, cut);
  return body.trim();
}

async function main() {
  const { data: batch } = readLatestBatch('cppcc-leaders-', 'npm run import:cppcc-leaders');

  const records = [];
  const errors = [];

  for (const candidate of batch.records) {
    const url = candidate.external?.officialUrl || '';
    try {
      const res = await fetchText(url);
      const html = res.body;
      const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
      const title = titleMatch ? titleMatch[1] : '';
      const name = personNameFromTitle(title, candidate.name);
      const text = cleanHtml(html);

      const urlOk = RESUME_URL_RE.test(url) || /\/zxld\/fzx\/[^/]+\/$/i.test(url);
      const looksLikeResume = urlOk && /简历/.test(title) && text.length > 500 && name !== SITE_NAME;

      records.push({
        ...candidate,
        id: entityId('person', personKeyFromUrl(url)),
        name,
        verification: {
          status: looksLikeResume ? 'candidate' : 'section-or-index',
          httpStatus: res.status,
          finalUrl: res.finalUrl,
          contentLength: res.body.length,
          checkedAt: new Date().toISOString(),
          textSample: extractResumeText(text, name).slice(0, 4000),
        },
      });
    } catch (e) {
      errors.push({ url, error: e.message });
    }
  }

  const candidates = records.filter((r) => r.verification.status === 'candidate').length;
  const file = writeBatch('cppcc-verified-', {
    source: batch.source,
    checkedAt: new Date().toISOString(),
    count: records.length,
    candidates,
    errors,
    records,
  });

  console.log(
    `verified ${records.length}; candidate profiles ${candidates}; `
    + `errors ${errors.length} -> ${path.basename(file)}`,
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
