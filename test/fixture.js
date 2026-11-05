import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../src/config.js';
import { CreatorStudio } from '../src/studio.js';

export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');

export function makeResult(review = { pass: true, findings: [] }) {
  return {
    role: 'assistant', content: [{ type: 'text', text: JSON.stringify(review) }], stopReason: 'stop',
    model: 'model', provider: 'fixture',
    usage: { input: 100, output: 30, cost: { total: 0.001 } },
  };
}

export function fixture(t, overrides = {}, complete) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'creator-studio-test-')));
  const media = path.join(root, 'media');
  mkdirSync(media, { mode: 0o700 });
  const image = path.join(media, 'diagram.png');
  writeFileSync(image, png);
  const config = normalizeConfig({
    allowedAgents: ['writer', 'other'], minBodyChars: 10, maxDailyDrafts: 10, enableReview: true,
    approvers: [{ agentId: 'writer', channel: 'test-chat', accountId: 'sandbox', senderId: 'owner' }],
    ...overrides,
  });
  const calls = [];
  const waits = [];
  const reads = [];
  const deletions = [];
  const runs = new Map();
  const sends = [];
  const api = {
    config: {
      agents: { entries: { writer: { model: 'fixture/model' }, other: { model: 'fixture/model' } } },
      models: { providers: { fixture: { agentRuntime: { id: 'codex' } } } },
    },
    runtime: {
      state: { resolveStateDir: () => root },
      subagent: {
        run: async (params) => {
          params.assertCurrent?.();
          calls.push(params);
          const runId = 'fixture-run-' + calls.length;
          const completion = Promise.resolve(complete ? complete(params) : makeResult());
          completion.catch(() => {});
          runs.set(runId, { params, completion });
          return { runId, sessionKey: params.sessionKey, runtime: { harness: 'codex', provider: 'fixture', model: 'model' } };
        },
        waitForRun: async (params) => {
          waits.push(params);
          let timer;
          try {
            return await Promise.race([
              runs.get(params.runId).completion.then(() => ({ status: 'ok' }), () => ({ status: 'error' })),
              new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'timeout' }), params.timeoutMs); }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        },
        getSessionMessages: async (params) => {
          reads.push(params);
          const run = [...runs.values()].find((entry) => entry.params.sessionKey === params.sessionKey);
          return { messages: [{ role: 'user', content: run.params.message }, await run.completion] };
        },
        deleteSession: async (params) => { deletions.push(params); },
      },
      channel: { outbound: { loadAdapter: async () => ({
        sendText: async (params) => {
          params.assertDirectAdapterHandoff?.();
          sends.push(params);
          return { messageId: 'fixture-receipt' };
        },
      }) } },
    },
  };
  const context = { agentId: 'writer', config: api.config, assertInvocationCurrent() {} };
  const human = { channel: 'test-chat', accountId: 'sandbox', senderId: 'owner', isAuthorizedSender: true };
  const studio = new CreatorStudio(api, config, path.join(root, 'data'), [media]);
  t.after(async () => { await studio.close(); rmSync(root, { recursive: true, force: true }); });
  const document = {
    title: 'Example evidence-backed article / 示例',
    summary: 'A synthetic fixture, not a live tool test or real research.',
    language: 'zh-CN', platform: 'generic',
    blocks: [
      { type: 'paragraph', text: 'This synthetic article demonstrates evidence records and versioned approvals. 这份测试稿不代表真实工具实测。' },
      { type: 'image', assetId: 'diagram' },
      { type: 'code', text: 'console.log("fixture only");' },
    ],
    sources: [{
      id: 'source', url: 'https://example.com/docs', title: 'Synthetic source fixture',
      checkedAt: '2025-01-01T00:00:00Z', kind: 'primary',
      excerpt: 'Synthetic evidence for local tests only.',
    }],
    claims: [{ text: 'The fixture contains evidence metadata.', sourceIds: ['source'] }],
    assets: [{ id: 'diagram', path: image, alt: 'Synthetic fixture diagram', kind: 'illustration' }],
  };
  const create = (extra = {}) => studio.article(context, { action: 'create', topicKey: 'fixture-topic', document, ...extra });
  const decide = (article, action, reason = '') => studio.command({
    ...human, args: action + ' ' + article.id + ' ' + article.version + (reason ? ' ' + reason : ''),
  });
  return { root, media, image, config, api, context, human, studio, document, calls, waits, reads, deletions, sends, create, decide };
}
