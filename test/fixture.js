import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../src/config.js';
import { CreatorStudio } from '../src/studio.js';

export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');

export function makeResult(review = { pass: true, findings: [] }) {
  return {
    text: JSON.stringify(review), model: 'fixture/model', provider: 'fixture', agentId: 'writer',
    execution: { mode: 'isolated-agent-runtime', owner: { kind: 'harness', id: 'codex' } },
    usage: { inputTokens: 100, outputTokens: 30, costUsd: 0.001 },
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
  const sends = [];
  const api = {
    config: {
      agents: { entries: { writer: { model: 'fixture/model' }, other: { model: 'fixture/model' } } },
      models: { providers: { fixture: { agentRuntime: { id: 'codex' } } } },
    },
    runtime: {
      state: { resolveStateDir: () => root },
      llm: { complete: async (params) => { calls.push(params); return complete ? complete(params) : makeResult(); } },
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
  t.after(() => { studio.close(); rmSync(root, { recursive: true, force: true }); });
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
  return { root, media, image, config, api, context, human, studio, document, calls, sends, create, decide };
}
