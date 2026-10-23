'use strict';
/**
 * 提交表——边与节点溯源的最后一段。
 *
 * ## 为什么需要它
 *
 * 边上的 `provenance[].rawRef` 指向第 0 层的原始记录，但那只回答
 * 「这条断言出自哪一行」。它回答不了：
 *
 *   - 这一行是哪次任务读进来的？
 *   - 同一次任务还改了哪些边？
 *   - 这条边被改过几次？
 *
 * 版本号字符串（`cbdb-biog@1.0.0`）只能回答「哪个转换器版本」，
 * 一旦同一版本跑了两次、或中间手工修过一条，就无法区分。
 *
 * ## 为什么不直接做 git
 *
 * 800 万边 × 300 字节 = 2.4 GB/次快照。存 diff 则需要 diff 引擎、合并、
 * 分支——那是重新实现 git，与本项目目标无关。
 *
 * 边长只存 8 字节 `commitId`（800 万边 = 64 MB），提交表本身只增不改，
 * 溯源链变成：
 *
 *     边 → commitId → 本次提交的 raw 链头 → 247 万行原始记录
 *
 * ## 只增不改
 *
 * `commits.jsonl` 追加写入，永不重写。任何「修正历史」的诱惑都应改成
 * 追加一条新 commit 说明修正了什么——历史被改写就失去溯源价值。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const COMMIT_DIR = path.join(ROOT, 'data', 'commits');
const COMMIT_FILE = path.join(COMMIT_DIR, 'commits.jsonl');

/**
 * 读全部提交，按写入顺序。
 * 损坏行跳过并 WARN，不抛错——一次坏写不该让整个溯源链失效。
 */
function readCommits(file = COMMIT_FILE) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  const text = fs.readFileSync(file, 'utf8');
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    n++;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      console.warn(`WARN commits.jsonl 第 ${n} 行损坏，已跳过：${e.message}`);
    }
  }
  return out;
}

/** 下一个 commitId。格式 c-000001，保证按字典序 = 按时间序。 */
function nextCommitId(commits) {
  let max = 0;
  for (const c of commits) {
    const m = /^c-(\d+)$/.exec(c.commitId || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `c-${String(max + 1).padStart(6, '0')}`;
}

/**
 * 追加一条提交。
 *
 * @param {object} o
 * @param {string} o.author   脚本版本（cbdb-biog@1.0.0）或 human:xxx
 * @param {string} o.message  人读的说明
 * @param {object} [o.stats]  { edgesAdded, nodesAdded, ... }
 * @param {string} [o.anchor] raw 层链头 sha256
 * @param {string} [file]     测试用，默认写真实 commits.jsonl
 * @returns {object} 写入的提交记录
 */
function appendCommit({ author, message, stats = {}, anchor = null } = {}, file = COMMIT_FILE) {
  if (!author) throw new Error('commit 必须有 author');
  if (!message) throw new Error('commit 必须有 message');
  const commits = readCommits(file);
  const rec = {
    commitId: nextCommitId(commits),
    at: new Date().toISOString(),
    author,
    message,
    parentId: commits.length ? commits[commits.length - 1].commitId : null,
    stats,
    anchor,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  return rec;
}

/** 按 id 查一条提交，找不到返回 null。 */
function getCommit(id, file = COMMIT_FILE) {
  return readCommits(file).find((c) => c.commitId === id) || null;
}

/**
 * 提交表的自校验：id 连续、parentId 串成一条链、at 单调不减。
 * 返回问题列表，空数组表示健康。
 */
function verifyCommits(file = COMMIT_FILE) {
  const commits = readCommits(file);
  const problems = [];
  let prev = null;
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const want = `c-${String(i + 1).padStart(6, '0')}`;
    if (c.commitId !== want) problems.push(`第 ${i + 1} 条 id 应为 ${want}，实际 ${c.commitId}`);
    const wantParent = prev ? prev.commitId : null;
    if ((c.parentId || null) !== wantParent) {
      problems.push(`${c.commitId} parentId 应为 ${wantParent}，实际 ${c.parentId}`);
    }
    if (prev && String(c.at) < String(prev.at)) {
      problems.push(`${c.commitId} 时间倒退：${c.at} < ${prev.at}`);
    }
    prev = c;
  }
  return problems;
}

module.exports = { readCommits, appendCommit, getCommit, nextCommitId, verifyCommits, COMMIT_FILE };
