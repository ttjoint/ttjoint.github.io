#!/usr/bin/env node
/**
 * Extract structured, evidence-linked candidates from verified profile pages.
 *
 * Stage 3 of the official-profile pipeline. Uses an optional LM Studio
 * OpenAI-compatible endpoint; when the model is unavailable the run still
 * produces rule-based candidates, and the failure is recorded per record so the
 * batch stays reviewable.
 *
 * Environment:
 *   LMSTUDIO_URL        endpoint (default http://127.0.0.1:1234/v1/chat/completions)
 *   LMSTUDIO_MODEL      model id
 *   LMSTUDIO_TIMEOUT    request timeout ms (default 600000)
 *   LMSTUDIO_MAX_TOKENS max tokens (default 16384)
 *   LMSTUDIO_LOG=1      log finish reason and raw content
 *   NO_LLM=1            skip the model entirely
 *   ONLY_NAME=...       limit to names containing this substring
 */
const path = require('path');
const http = require('http');
const https = require('https');
const { readLatestBatch, writeBatch } = require('../src/store/batches');
const { entityId } = require('../src/store/entity_id');
const { personKeyFromUrl } = require('../src/store/source_key');
const structured = require('../src/importers/structured');

const ENDPOINT = process.env.LMSTUDIO_URL || 'http://127.0.0.1:1234/v1/chat/completions';
const MODEL = process.env.LMSTUDIO_MODEL || 'gemma-4-e4b-uncensored-hauhaucs-aggressive';
const TIMEOUT = Number(process.env.LMSTUDIO_TIMEOUT || 600000);
const MAX_TOKENS = Number(process.env.LMSTUDIO_MAX_TOKENS || 16384);
const LOG = process.env.LMSTUDIO_LOG === '1';
const NO_LLM = process.env.NO_LLM === '1';
const ONLY_NAME = process.env.ONLY_NAME || '';

/** POST JSON to an OpenAI-compatible chat endpoint. */
function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(parsed, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      let body = '';
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error('LM Studio request timeout'));
      }, TIMEOUT);
      res.on('data', (x) => { body += x; });
      res.on('end', () => {
        clearTimeout(timer);
        if ((res.statusCode || 0) >= 400) {
          reject(new Error(body));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`non-JSON response from LM Studio: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(payload));
    req.end();
  });
}

function buildPrompt(text, url) {
  return `你是严谨的政府人物资料抽取器。仅依据给定原文输出JSON，不得补全或推测。`
    + `字段：name(string), gender(string), birthDate(string), nativePlace(string), `
    + `ethnicity(string), education(string), currentPositions(array of {organization,role,evidence}), `
    + `career(array of {date,organization,role,evidence}), summary(string), `
    + `confidence(number 0-1), deceased(boolean, 原文明确写出逝世/去世则为true，否则省略)。`
    + `每个非空字段必须有原文evidence；无法确认留空。原文：\n${text}\n来源：${url}`;
}

/** Call the model and return a validated, normalised candidate. */
async function callLlm(text, url) {
  const res = await postJson(ENDPOINT, {
    model: MODEL,
    messages: [
      { role: 'system', content: '只输出合法JSON，不要Markdown。' },
      { role: 'user', content: buildPrompt(text, url) },
    ],
    temperature: 0,
    max_tokens: MAX_TOKENS,
  });

  const choice = res.choices?.[0] || {};
  const message = choice.message || {};
  const finish = choice.finish_reason;

  if (LOG) {
    console.error(`[lm] finish=${finish} reasoning=${(message.reasoning_content || '').length} content=${(message.content || '').length}`);
  }
  if (finish === 'length') {
    throw new Error('LM Studio output truncated (finish_reason=length); raise LMSTUDIO_MAX_TOKENS');
  }

  const content = structured.stripFences(message.content);
  if (!content) {
    throw new Error('LM Studio returned empty content' + (message.reasoning_content ? ' (only reasoning_content)' : ''));
  }
  if (LOG) console.error('[lm] raw content: ' + content.slice(0, 400));

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error(`LM Studio returned invalid JSON: ${e.message}`);
  }
  return structured.requireStructured(parsed);
}

async function main() {
  const { name: inputName, data: batch } = readLatestBatch('cppcc-verified-', 'npm run verify:cppcc');

  const records = [];
  const errors = [];

  const candidates = batch.records.filter((x) => x.verification?.status === 'candidate'
    && (!ONLY_NAME || x.name.includes(ONLY_NAME)));

  for (const x of candidates) {
    try {
      const raw = x.verification.textSample || '';
      const url = x.external.officialUrl;

      let extracted = structured.extractByRules(x.name, raw, url);
      let llmError = null;

      if (!NO_LLM) {
        try {
          extracted = structured.enrichDeath({ ...extracted, ...(await callLlm(raw, url)) }, raw);
        } catch (e) {
          llmError = e.message;
          extracted = structured.enrichDeath(extracted, raw);
        }
      } else {
        extracted = structured.enrichDeath(extracted, raw);
      }

      records.push({
        id: entityId('person', personKeyFromUrl(x.url || extracted.url || x.id || '')),
        type: 'person',
        candidate: extracted,
        evidence: { sourceUrl: url, excerpt: raw },
        provenance: {
          method: llmError ? 'rules' : 'rules+llm',
          model: llmError ? null : MODEL,
          createdAt: new Date().toISOString(),
        },
        status: 'pending',
      });
    } catch (e) {
      errors.push({ id: x.id, error: e.message });
    }
  }

  const file = writeBatch('structured-', {
    input: inputName,
    createdAt: new Date().toISOString(),
    count: records.length,
    errors,
    records,
  });

  console.log(`structured ${records.length} candidates; errors ${errors.length}; model ${MODEL} -> ${path.basename(file)}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
