'use strict';
/**
 * 提交表是溯源链的最后一环：边 → commitId → 提交 → raw 链头。
 * 它只增不改，所以「历史被改写」是比「数据错」更严重的故障。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readCommits, appendCommit, getCommit, nextCommitId, verifyCommits } = require('../../src/store/commits.js');

/** 每个测试用独立文件，避免污染真实 commits.jsonl。 */
function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hm-commits-')), 'commits.jsonl');
}

test('commits: ids are sequential and parentId chains them', () => {
  const file = tmpFile();
  const a = appendCommit({ author: 'test@1', message: 'first' }, file);
  const b = appendCommit({ author: 'test@1', message: 'second' }, file);
  assert.equal(a.commitId, 'c-000001');
  assert.equal(b.commitId, 'c-000002');
  assert.equal(a.parentId, null);
  assert.equal(b.parentId, a.commitId);
  assert.deepEqual(verifyCommits(file), []);
});

test('commits: appending never rewrites earlier lines', () => {
  const file = tmpFile();
  appendCommit({ author: 'a', message: 'one' }, file);
  const firstBytes = fs.readFileSync(file, 'utf8');
  appendCommit({ author: 'b', message: 'two' }, file);
  const after = fs.readFileSync(file, 'utf8');
  // 只增不改：新内容必须以旧内容原样开头。
  assert.ok(after.startsWith(firstBytes), 'existing history must be byte-identical');
});

test('commits: a corrupt line is skipped, not fatal', () => {
  const file = tmpFile();
  appendCommit({ author: 'a', message: 'good' }, file);
  fs.appendFileSync(file, '{ not json\n', 'utf8');
  appendCommit({ author: 'b', message: 'after corruption' }, file);
  // 坏行被跳过，好行仍可读——一次坏写不该让整条链失效。
  const commits = readCommits(file);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].message, 'good');
});

test('commits: verifyCommits catches a broken chain', () => {
  const file = tmpFile();
  appendCommit({ author: 'a', message: 'one' }, file);
  appendCommit({ author: 'b', message: 'two' }, file);
  // 手工篡改 parentId，模拟历史被改写。
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const second = JSON.parse(lines[1]);
  second.parentId = null;
  lines[1] = JSON.stringify(second);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const problems = verifyCommits(file);
  assert.ok(problems.length > 0, 'a detached parentId must be reported');
});

test('commits: author and message are mandatory', () => {
  const file = tmpFile();
  assert.throws(() => appendCommit({ message: 'no author' }, file), /author/);
  assert.throws(() => appendCommit({ author: 'a' }, file), /message/);
});

test('commits: getCommit finds by id and returns null otherwise', () => {
  const file = tmpFile();
  const a = appendCommit({ author: 'a', message: 'one' }, file);
  assert.equal(getCommit(a.commitId, file).message, 'one');
  assert.equal(getCommit('c-999999', file), null);
});

test('commits: nextCommitId starts at 1 and pads for sortability', () => {
  assert.equal(nextCommitId([]), 'c-000001');
  assert.equal(nextCommitId([{ commitId: 'c-000041' }]), 'c-000042');
  // 字典序必须等于时间序，否则按 id 排序会错乱。
  const ids = ['c-000009', 'c-000010', 'c-000100'];
  assert.deepEqual([...ids].sort(), ids);
});
