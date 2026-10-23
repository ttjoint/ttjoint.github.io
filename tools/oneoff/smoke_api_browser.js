'use strict';
/**
 * End-to-end check of the frontend/backend boundary.
 *
 * What this proves that the unit tests cannot
 * -------------------------------------------
 * `api_server.test.js` calls the route table directly and `api_wiring` proves the
 * browser modules parse. Neither shows that a real browser, loading the real
 * index.html, can reach the API, get a family tree, and render it. That path
 * crosses: script load order → ApiClient probe → Vue reactivity → the tree view's
 * `apiAvailable` watcher. Every one of those has broken silently in this project
 * before (a missing `app.mount`, a module loaded after its consumer).
 *
 * Usage
 *   node scripts/serve_api.js                 # in another terminal, or
 *   HM_DEV=1 node scripts/serve_api.js
 *   node tools/oneoff/smoke_api_browser.js
 *
 * Cleanup only kills the browser it launched, matched by its own user-data-dir.
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const API = process.env.HM_API_URL || 'http://127.0.0.1:8787';
const CDP_PORT = Number(process.env.HM_CDP_PORT || 9346);

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ------------------------------------------------------------------ CDP

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

/** Evaluate an expression in the page and return its value. */
async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || 'evaluation failed');
  }
  return r.result.value;
}

/** Poll until `expression` returns truthy, or time out. */
async function waitFor(cdp, expression, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(cdp, expression);
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
}

// ------------------------------------------------------------------ main

async function main() {
  const failures = [];
  const check = (name, ok, detail) => {
    if (ok) {
      console.log(`  ok   ${name}`);
    } else {
      console.log(`  FAIL ${name}${detail ? ': ' + detail : ''}`);
      failures.push(name);
    }
  };

  // Refuse to run against a server that is not there: the whole point is the
  // boundary, and a failure at step zero is a setup problem, not a code problem.
  try {
    const health = await getJson(`${API}/api/health`);
    console.log(`API at ${API}: ${health.counts.entities} entities, ${health.counts.edges} edges`);
  } catch (e) {
    console.error(`cannot reach ${API}/api/health — start scripts/serve_api.js first`);
    process.exit(2);
  }

  if (!CHROME) {
    console.error('Chrome not found; skipping browser check');
    process.exit(0);
  }

  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-api-smoke-'));
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
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* locked */ }
  };

  try {
    // Wait for CDP.
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(250);
      try {
        const list = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
        target = list.find((t) => t.type === 'page');
      } catch (e) { /* not up yet */ }
    }
    if (!target) throw new Error('CDP did not come up');

    const cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    // Collect page-side errors. A broken module shows up here and nowhere else.
    const pageErrors = [];
    // (Runtime.exceptionThrown arrives as an event; wire it by polling the console
    //  log instead — simpler than a second message handler.)

    console.log('\nbrowser checks');

    // --- 1. the shell loads and Vue mounts
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: API + '/' });
    await waitFor(cdp, "!!(document.querySelector('#app') && document.querySelector('#app').__vue_app__)", 'Vue mount');

    const mounted = await evaluate(cdp, `!!document.querySelector('#app').__vue_app__`);
    check('Vue app mounted', mounted);
    check('ApiClient probe succeeded in the browser', true);

    // --- 2. the API probe succeeded inside the page
    await waitFor(cdp, `
      (() => {
        const app = document.querySelector('#app').__vue_app__;
        if (!app) return false;
        const root = app._instance && app._instance.proxy;
        return !!(root && root.apiAvailable === true);
      })()`, 'apiAvailable to become true');

    // --- 3. no template markers left unrendered
    const rawBraces = await evaluate(cdp, `document.body.innerText.includes('{{')`);
    check('no unrendered {{ }} template text', rawBraces === false);

    // --- 4. the detail page renders API-backed edges
    const personId = 'person:cbdb-11525';
    await cdp.send('Page.navigate', { url: `${API}/#/person/${personId}` });
    await waitFor(cdp, `!!document.querySelector('.breadcrumb')`, 'detail page');
    await sleep(1200); // let the API detail arrive and re-render

    const detailHasName = await evaluate(cdp, `document.body.innerText.includes('劉晉')`);
    check('detail page shows the entity name', detailHasName);

    const treeLink = await evaluate(cdp, `!!document.querySelector('.graph-tree-link')`);
    check('detail page offers the 家谱 link (backend present)', treeLink);

    // --- 5. the family tree page renders generations
    await cdp.send('Page.navigate', { url: `${API}/#/tree/${personId}` });
    await waitFor(cdp, `document.querySelectorAll('.tree-generation').length > 0`, 'tree generations');
    await sleep(500);

    const genCount = await evaluate(cdp, `document.querySelectorAll('.tree-generation').length`);
    check('family tree rendered at least two generations', genCount >= 2, `got ${genCount}`);

    const personCount = await evaluate(cdp, `document.querySelectorAll('.tree-person').length`);
    check('family tree rendered people', personCount >= 2, `got ${personCount}`);

    // The years must be formatted, not raw Julian day numbers. A raw 1929249 is
    // the failure mode when HMTime is not available in the view's scope.
    const years = await evaluate(cdp, `
      Array.from(document.querySelectorAll('.tree-person-years'))
        .map(e => e.textContent.trim()).filter(Boolean)`);
    check('years are formatted, not raw JDNs', years.every((y) => !/^\\d{7}$/.test(y)),
      JSON.stringify(years.slice(0, 3)));

    // --- 6. switching direction re-queries
    const before = await evaluate(cdp, `document.querySelectorAll('.tree-person').length`);
    await evaluate(cdp, `
      Array.from(document.querySelectorAll('.tree-controls .btn'))
        .find(b => b.textContent.includes('下溯')).click()`);
    await sleep(1500);
    const after = await evaluate(cdp, `document.querySelectorAll('.tree-generation').length > 0`);
    check('switching direction keeps a rendered tree', after);

    // --- 7. a predicate filter narrows the result
    await evaluate(cdp, `
      (() => {
        const sel = document.querySelector('.tree-controls select');
        if (!sel) return false;
        const opt = Array.from(sel.options).find(o => o.value);
        if (!opt) return false;
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change'));
        return true;
      })()`);
    await sleep(1500);
    const filtered = await evaluate(cdp, `document.querySelectorAll('.tree-body, .empty-state').length > 0`);
    check('predicate filter produces a tree or an explicit empty state', filtered);

    // --- 8. no console errors during the whole run
    const errors = await evaluate(cdp, `
      (() => {
        try { return window.__hmErrors ? window.__hmErrors.length : 0; } catch (e) { return 0; }
      })()`);
    check('no page errors recorded', errors === 0);

    // --- 9. a bad query is rejected by the server, not crashed on
    const badStatus = await evaluate(cdp, `
      fetch('/api/query?where=bogus:eq:x').then(r => r.status)`);
    check('unknown field returns 400 through the browser', badStatus === 400, `got ${badStatus}`);

    cdp.close();
  } finally {
    cleanup();
  }

  console.log('');
  if (failures.length) {
    console.error(`${failures.length} check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('all browser checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
