'use strict';
/**
 * Headless browser smoke test for the static site.
 *
 * Serves the repo over HTTP, drives Chrome through CDP, and asserts that Vue
 * actually mounted and rendered entities. This exists because a previous
 * refactor dropped the final `app.mount('#app')` line, which left the site
 * serving raw `{{ }}` template text with no console errors — invisible to every
 * unit test but instantly obvious to a user.
 *
 * Usage: node tools/oneoff/smoke_browser.js
 * Requires: Chrome installed, plus `--remote-debugging-port` free.
 *
 * Note on cleanup: only kills the browser instance it launched, matched by its
 * own user-data-dir, never by process name.
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8899;
const CDP_PORT = 9345;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error('Chrome not found; skipping browser smoke test');
  process.exit(0);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** Minimal static file server for the repo root. */
function serve() {
  const server = http.createServer((req, res) => {
    // Do NOT decode the URL. Shard filenames are already percent-encoded on disk
    // (`person%3A05b9….json`), so decoding `%3A` back to ":" makes every entity
    // detail request 404 — which is exactly how this smoke test first "proved"
    // the detail page was broken when it was in fact the server.
    const urlPath = req.url.split('?')[0];
    const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal CDP client over Node's built-in WebSocket (Node 22+).
 *
 * Deliberately not the `ws` package: this is a throwaway diagnostic, and adding
 * a dependency for it would make `npm ci` heavier for everyone.
 */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;

    ws.addEventListener('open', () => {
      resolve({
        send(method, params) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { try { ws.close(); } catch (e) { /* gone */ } },
      });
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (!msg.id || !pending.has(msg.id)) return;
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message));
      else res(msg.result);
    });
  });
}

async function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-smoke-'));
  const server = await serve();

  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { chrome.kill(); } catch (e) { /* already gone */ }
    try { server.close(); } catch (e) { /* already closed */ }
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* locked */ }
  };

  try {
    // Wait for CDP to come up.
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      try {
        const list = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
        target = list.find((t) => t.type === 'page');
      } catch (e) { /* not up yet */ }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('Chrome CDP did not start');

    const cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    async function evaluate(expr) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
      }
      return r.result.value;
    }

    // ---- index page ----
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
    await sleep(6000);

    const report = await evaluate(`(() => {
      const app = document.querySelector('#app');
      const text = app ? app.innerText : '';
      return {
        vueLoaded: typeof Vue !== 'undefined',
        vueVersion: typeof Vue !== 'undefined' ? Vue.version : null,
        hasMustache: /\\{\\{.*\\}\\}/.test(text),
        textLength: text.length,
        sample: text.slice(0, 220),
        cards: document.querySelectorAll('a[href*="/entity/"], .entity-card, .card').length,
      };
    })()`);

    console.log(JSON.stringify(report, null, 2));

    // ---- entity detail page ----
    //
    // Visit a real person who has evidence sources and check the source list
    // renders text. After the sources -> evidence migration the view read
    // `.name` off a string and showed a blank list for the entire corpus. No
    // unit test and no index-page assertion could see that: the home page never
    // renders sources at all.
    // Pick the id from disk instead of hardcoding: the corpus changes.
    const detailId = process.env.HM_DETAIL_ID || findEntityWithSources();
    let detail = { skipped: true };
    if (detailId) {
      await cdp.send('Page.navigate', {
        url: `http://127.0.0.1:${PORT}/index.html#/person/${detailId}`,
      });
      await sleep(3000);
      detail = await evaluate(`(() => {
        const app = document.querySelector('#app');
        const text = app ? app.innerText : '';
        const cards = [...document.querySelectorAll('.source-card')];
        const sourceRows = cards.map((n) => n.innerText.trim()).filter(Boolean);
        const fieldLabels = [...document.querySelectorAll('.source-card-field .source-label')]
          .map((n) => n.innerText.trim());
        return {
          textLength: text.length,
          hasMustache: /\\{\\{.*\\}\\}/.test(text),
          sourceRows: sourceRows.length,
          emptySourceRows: sourceRows.filter((t) => t.length <= 2).length,
          fieldLabels,
          fieldCount: document.querySelectorAll('.source-card-field').length,
          cardHTML: cards[0] ? cards[0].innerHTML.slice(0, 700) : null,
          hmEvidenceKeys: typeof window.HMEvidence !== 'undefined' ? Object.keys(window.HMEvidence) : null,
          firstSourceCard: sourceRows[0] ? sourceRows[0].slice(0, 200) : null,
          sample: text.slice(0, 160),
        };
      })()`);
      console.log(JSON.stringify(detail, null, 2));
    }

    const problems = [];
    if (!report.vueLoaded) problems.push('Vue did not load');
    if (report.hasMustache) problems.push('raw {{ }} template text is visible (mount failed)');
    if (report.textLength < 100) problems.push('page rendered almost nothing');
    if (!detail.skipped) {
      if (detail.hasMustache) problems.push('detail page shows raw {{ }} template text');
      if (detail.emptySourceRows > 0) problems.push('detail page renders empty source rows');
    }

    if (problems.length) {
      console.error('\nFAILED:\n- ' + problems.join('\n- '));
      process.exitCode = 1;
    } else {
      console.log('\nOK: Vue mounted and rendered content.');
    }

    cdp.close();
  } finally {
    cleanup();
  }
}

/**
 * Find a person whose `sources` are evidence references, reading the shards the
 * same way the browser does. Returns null when the corpus has none, so the
 * detail-page assertions turn into a skip rather than a false failure.
 */
function findEntityWithSources() {
  const dir = path.join(ROOT, 'data', 'persons', 'entities');
  if (!fs.existsSync(dir)) return null;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (Array.isArray(e.sources) && e.sources.some((s) => typeof s === 'string')) {
        return e.id;
      }
    } catch (err) { /* skip malformed */ }
  }
  return null;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
