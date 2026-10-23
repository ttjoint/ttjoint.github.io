'use strict';
/**
 * Layer 0 (raw) invariants.
 *
 * These guard the properties the whole four-layer design rests on:
 *  - contentHash ignores field order and capture time, so re-ingest is stable
 *  - the chain detects an edited payload, not just a missing one
 *  - append is idempotent, so re-running an ingester cannot fork the corpus
 *  - a document citation can name a paragraph, not just a file
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const schema = require('../../src/store/raw_schema');
const store = require('../../src/store/raw_store');

function withTempRoot(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-test-'));
  const prev = process.env.HUMANMAP_RAW_ROOT;
  process.env.HUMANMAP_RAW_ROOT = dir;
  store.clearCache();
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.HUMANMAP_RAW_ROOT;
    else process.env.HUMANMAP_RAW_ROOT = prev;
    store.clearCache();
  }
}

test('canonical JSON ignores key order', () => {
  const a = schema.canonical({ b: 1, a: [2, { d: 3, c: 4 }] });
  const b = schema.canonical({ a: [2, { c: 4, d: 3 }], b: 1 });
  assert.strictEqual(a, b);
});

test('contentHash is stable across re-ingest (same payload, later clock)', () => {
  const payload = { c_personid: 100001, c_name_chn: '許雪英', c_female: 1, c_dy: 20 };
  const first = schema.makeRecord({
    source: 'cbdb', sourceTable: 'BIOG_MAIN', sourceKey: 100001,
    capturedAt: '2026-10-20T10:00:00Z', payload,
  });
  const again = schema.makeRecord({
    source: 'cbdb', sourceTable: 'BIOG_MAIN', sourceKey: 100001,
    capturedAt: '2026-11-01T09:00:00Z', payload,
  });
  assert.strictEqual(first.contentHash, again.contentHash,
    'capturedAt must not feed the content hash, or every re-ingest looks like tampering');
  assert.strictEqual(first.rawId, again.rawId);
});

test('contentHash changes when the payload changes', () => {
  const mk = (p) => schema.makeRecord({
    source: 'cbdb', sourceTable: 'BIOG_MAIN', sourceKey: 1,
    capturedAt: '2026-10-20T10:00:00Z', payload: p,
  }).contentHash;
  assert.notStrictEqual(mk({ c_dy: 20 }), mk({ c_dy: 19 }));
});

test('rawId embeds source, group and key so it can be located without a global index', () => {
  const rec = schema.makeRecord({
    source: 'cbdb', sourceTable: 'KIN_DATA', sourceKey: 555,
    capturedAt: '2026-10-20T10:00:00Z', payload: {},
  });
  assert.strictEqual(rec.rawId, 'raw:cbdb/KIN_DATA/555');
  assert.deepStrictEqual(schema.parseRawId(rec.rawId), {
    source: 'cbdb', group: 'KIN_DATA', key: '555',
  });
});

test('segmentText splits on blank lines and keeps offsets', () => {
  const text = '第一段内容。\n\n第二段内容。\n\n第三段。';
  const segs = schema.segmentText(text);
  assert.strictEqual(segs.length, 3);
  assert.deepStrictEqual(segs.map((s) => s.segId), ['p1', 'p2', 'p3']);
  assert.strictEqual(text.slice(segs[1].offset, segs[1].offset + segs[1].length), '第二段内容。');
});

test('segmentText of a one-paragraph document yields one segment, not zero', () => {
  const segs = schema.segmentText('只有一段');
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].text, '只有一段');
});

test('segmentRef round-trips', () => {
  const ref = schema.segmentRef('raw:web/x/1', 'p3');
  assert.deepStrictEqual(schema.parseSegmentRef(ref), { rawId: 'raw:web/x/1', segId: 'p3' });
  assert.deepStrictEqual(schema.parseSegmentRef('raw:web/x/1'), { rawId: 'raw:web/x/1', segId: null });
});

test('rawId parts survive a group name that contains dashes', () => {
  // Regression: the first rawId format was `<source>-<group>-<key>`, which
  // could not be split back. `raw:web-gov-5746205` read as source `web`,
  // group `gov`, so every page id in a dashed group resolved to null while the
  // record sat on disk — a silent "not found", the worst failure mode.
  const id = schema.makeRawId('web', 'gov-5746205', 'p1');
  assert.deepStrictEqual(schema.parseRawId(id), {
    source: 'web', group: 'gov-5746205', key: 'p1',
  });
});

test('rawId containing dashes in every part still parses', () => {
  const id = schema.makeRawId('my-src', 'a-b-c', 'x-y-z');
  assert.deepStrictEqual(schema.parseRawId(id), {
    source: 'my-src', group: 'a-b-c', key: 'x-y-z',
  });
});

test('parseRawId refuses malformed ids instead of guessing', () => {
  assert.strictEqual(schema.parseRawId('raw:onlyonepart'), null);
  assert.strictEqual(schema.parseRawId('not-a-raw-id'), null);
  assert.strictEqual(schema.parseRawId('raw:a/b'), null);
});

test('a dashed group name resolves to its stored document', () => {
  // End-to-end guard for the same bug: correct parse alone is not enough, the
  // store must actually find the record it wrote.
  withTempRoot(() => {
    const rawId = schema.makeRawId('web', 'gov-5746205', 'doc');
    const text = '第一段。\n\n第二段。';
    store.append('web', 'gov-5746205', [schema.makeDocument({
      source: 'web', rawId, capturedAt: '2026-10-20T10:00:00Z',
      text, segments: schema.segmentText(text),
    })]);

    assert.ok(store.get(rawId), 'document in a dashed group must be findable');
    assert.strictEqual(store.get(rawId + '#p2').text, '第二段。');
  });
});

test('append is idempotent: re-running writes nothing and keeps one chain', () => {
  withTempRoot(() => {
    const rows = [1, 2, 3].map((i) =>
      schema.makeRecord({
        source: 'cbdb', sourceTable: 'T', sourceKey: i,
        capturedAt: '2026-10-20T10:00:00Z', payload: { v: i },
      }));
    const a = store.append('cbdb', 'T', rows);
    assert.strictEqual(a.written, 3);

    const b = store.append('cbdb', 'T', rows);
    assert.strictEqual(b.written, 0, 'second run must write nothing');
    assert.strictEqual(b.skipped, 3);

    assert.strictEqual(store.verifyGroup('cbdb', 'T').ok, true);
  });
});

test('the chain continues across separate append calls', () => {
  withTempRoot(() => {
    const mk = (i) => schema.makeRecord({
      source: 's', sourceTable: 'T', sourceKey: i,
      capturedAt: '2026-10-20T10:00:00Z', payload: { v: i },
    });
    store.append('s', 'T', [mk(1), mk(2)]);
    store.append('s', 'T', [mk(3)]);
    const recs = [...store.readGroup('s', 'T')];
    assert.strictEqual(recs.length, 3);
    assert.strictEqual(recs[0].prevHash, null);
    assert.strictEqual(recs[1].prevHash, recs[0].chainHash);
    assert.strictEqual(recs[2].prevHash, recs[1].chainHash);
    assert.strictEqual(store.verifyGroup('s', 'T').ok, true);
  });
});

test('verify detects an edited payload and names the record', () => {
  withTempRoot((dir) => {
    const rec = schema.makeRecord({
      source: 's', sourceTable: 'T', sourceKey: 7,
      capturedAt: '2026-10-20T10:00:00Z', payload: { v: '原值' },
    });
    store.append('s', 'T', [rec]);

    const file = path.join(dir, 's', 'T', 'batch-000.jsonl.gz');
    const raw = JSON.parse(
      require('zlib').gunzipSync(fs.readFileSync(file)).toString('utf8').split('\n')[0]);
    raw.payload.v = '改过的值';
    fs.writeFileSync(file,
      require('zlib').gzipSync(Buffer.from(JSON.stringify(raw) + '\n', 'utf8')));

    store.clearCache();
    const v = store.verifyGroup('s', 'T');
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.brokenAt, 'raw:s/T/7');
    assert.match(v.reason, /contentHash/);
  });
});

test('verify detects deletion of a middle record', () => {
  withTempRoot((dir) => {
    const rows = [1, 2, 3].map((i) => schema.makeRecord({
      source: 's', sourceTable: 'T', sourceKey: i,
      capturedAt: '2026-10-20T10:00:00Z', payload: { v: i },
    }));
    store.append('s', 'T', rows);

    const file = path.join(dir, 's', 'T', 'batch-000.jsonl.gz');
    const lines = require('zlib').gunzipSync(fs.readFileSync(file)).toString('utf8')
      .split('\n').filter(Boolean);
    // Drop the middle record: every per-record hash is still self-consistent,
    // which is exactly the case a bare contentHash cannot catch.
    fs.writeFileSync(file,
      require('zlib').gzipSync(Buffer.from(lines[0] + '\n' + lines[2] + '\n', 'utf8')));

    store.clearCache();
    const v = store.verifyGroup('s', 'T');
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.brokenAt, 'raw:s/T/3');
    assert.match(v.reason, /chainHash/);
  });
});

test('get resolves a document segment, not just the whole document', () => {
  withTempRoot(() => {
    const text = '第一段。\n\n第二段。';
    const doc = schema.makeDocument({
      source: 'web', rawId: schema.makeRawId('web','gov','1'), capturedAt: '2026-10-20T10:00:00Z',
      text, segments: schema.segmentText(text),
    });
    store.append('web', 'gov', [doc]);

    const whole = store.get(schema.makeRawId('web','gov','1'));
    assert.strictEqual(whole.kind, 'document');

    const p2 = store.get(schema.makeRawId('web','gov','1') + '#p2');
    assert.strictEqual(p2.segId, 'p2');
    assert.strictEqual(p2.text, '第二段。');

    assert.strictEqual(store.segments(schema.makeRawId('web','gov','1')).length, 2);
  });
});

test('asking for a segment of a record is an error, not a silent null', () => {
  withTempRoot(() => {
    store.append('s', 'T', [schema.makeRecord({
      source: 's', sourceTable: 'T', sourceKey: 1,
      capturedAt: '2026-10-20T10:00:00Z', payload: {},
    })]);
    assert.throws(() => store.get('raw:s/T/1#p1'), /has no segments/);
  });
});

test('a missing ref returns null rather than throwing', () => {
  withTempRoot(() => {
    store.append('s', 'T', [schema.makeRecord({
      source: 's', sourceTable: 'T', sourceKey: 1,
      capturedAt: '2026-10-20T10:00:00Z', payload: {},
    })]);
    assert.strictEqual(store.get('raw:s/T/999'), null);
    assert.strictEqual(store.get('raw:web/gov/1#p1'), null);
  });
});

test('exists() answers membership without returning the record', () => {
  // 上层注释一直写着「只要判断存在的调用方应该用 exists()」，但这个函数
  // 从来没被写过——照着注释写代码的人会拿到 TypeError。这是补上的那个函数。
  withTempRoot(() => {
    store.append('s', 'T', [schema.makeRecord({
      source: 's', sourceTable: 'T', sourceKey: 42,
      capturedAt: '2026-10-20T10:00:00Z', payload: { a: 1 },
    })]);
    assert.equal(store.exists('raw:s/T/42'), true);
    assert.equal(store.exists('raw:s/T/43'), false);
    // 格式不对一律 false，不抛错——校验器要能安全地调用它。
    assert.equal(store.exists('not-a-raw-id'), false);
    assert.equal(store.exists('raw:s/Nope/42'), false);
  });
});

test('headsOnly reads one file per group and reports the true chain head', () => {
  withTempRoot(() => {
    const mk = (i) => schema.makeRecord({
      source: 's', sourceTable: 'T', sourceKey: i,
      capturedAt: '2026-10-20T10:00:00Z', payload: { v: i },
    });
    store.append('s', 'T', [mk(1), mk(2)]);
    store.append('u', 'U', [mk(3)]);

    const heads = store.headsOnly();
    assert.strictEqual(heads.length, 2);

    const t = heads.find((h) => h.group === 'T');
    const lastT = [...store.readGroup('s', 'T')].pop();
    assert.strictEqual(t.head, lastT.chainHash);
    assert.strictEqual(t.rawId, lastT.rawId);

    const full = store.verifyGroup('s', 'T');
    assert.strictEqual(full.head, t.head, 'head-only mode must agree with full verification');
  });
});
