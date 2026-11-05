import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import plugin from '../src/index.js';
import { manifest, normalizeConfig } from '../src/config.js';
import { publicUrl, renderHtml, renderMarkdown } from '../src/content.js';
import { createPreviewHandler, startPreview } from '../src/preview.js';
import { fixture, makeResult } from './fixture.js';

test('only explicitly enabled agents see tools; discovery performs no runtime access', (t) => {
  const f = fixture(t);
  const registrations = [];
  let service;
  plugin.register({
    ...f.api, pluginConfig: { allowedAgents: ['writer'], dataDir: path.join(f.root, 'plugin-data') },
    registerTool: (factory, options) => registrations.push({ factory, options }),
    registerCommand() {}, registerService: (value) => { service = value; },
  });
  assert.deepEqual(registrations.map((entry) => entry.options.name), manifest.contracts.tools);
  for (const { factory, options } of registrations) {
    assert.equal(options.optional, true);
    assert.equal(factory.contextVersion, 2);
    assert.equal(factory.create({ agentId: 'unapproved' }), null);
    assert.ok(factory.create(f.context));
  }
  assert.ok(!existsSync(path.join(f.root, 'plugin-data')));
  for (const registrationMode of ['discovery', 'cli-metadata', 'setup-only', 'setup-runtime']) {
    plugin.register({
      registrationMode,
      get runtime() { throw new Error('Metadata discovery must not access runtime'); },
      registerTool() { throw new Error('Unexpected tool registration'); },
    });
  }
  service.stop();
});

test('tools cannot impersonate another agent or approve through supplied arguments', async (t) => {
  const f = fixture(t);
  const article = f.create();
  assert.throws(() => f.studio.article({ ...f.context, agentId: 'unknown' }, { action: 'list' }), /not enabled/);
  assert.throws(() => f.studio.article({ ...f.context, agentId: 'other' }, { action: 'get', articleId: article.id }), /not found/);
  assert.throws(() => f.studio.article(f.context, { action: 'approve', articleId: article.id, version: 1, senderId: 'owner' }), /Unknown article action/);
  for (const human of [
    { ...f.human, senderId: 'stranger', senderIsOwner: true },
    { ...f.human, accountId: 'other-account' },
    { ...f.human, channel: 'other-channel' },
    { ...f.human, isAuthorizedSender: false },
  ]) {
    assert.throws(() => f.studio.command({ ...human, args: 'approve ' + article.id + ' 1' }), /approver|authenticated/);
  }
});

test('native tool factories and human command are wired through the same version gates', async (t) => {
  const f = fixture(t);
  const registered = new Map();
  let command;
  let service;
  plugin.register({
    ...f.api, pluginConfig: f.config,
    registerTool: (factory, options) => registered.set(options.name, factory.create(f.context)),
    registerCommand: (value) => { command = value; },
    registerService: (value) => { service = value; },
  });
  assert.equal(command.requireAuth, true);
  const invoke = async (name, args) => {
    const result = await registered.get(name).execute('fixture-call', args);
    assert.ok(!result.isError, result.content[0].text);
    return result.details;
  };
  try {
    await service.start();
    const first = await invoke('creator_article', { action: 'create', topicKey: 'native-fixture', document: f.document });
    const request = { articleId: first.id, version: 1 };
    assert.equal((await invoke('creator_review', request)).state, 'pending_human_review');
    assert.equal((await invoke('creator_submit', request)).notification, 'disabled');
    assert.match(command.handler({ ...f.human, args: 'approve ' + first.id + ' 1' }).text, /approved_for_manual_publish/);
    assert.ok(existsSync((await invoke('creator_export', request)).directory));
    await invoke('creator_article', { ...request, action: 'revise', document: { ...f.document, title: 'Revised native fixture' } });
    assert.match(command.handler({ ...f.human, args: 'status ' + first.id + ' 1' }).text, /superseded/);
    const stale = await registered.get('creator_export').execute('fixture-stale', request);
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /Stale version/);
  } finally {
    await service.stop();
  }
});

test('disabled model access and implicit runtime selection cause no model requests', async (t) => {
  const f = fixture(t, { enableReview: false });
  const article = f.create();
  await assert.rejects(f.studio.review(f.context, { articleId: article.id, version: 1 }), /disabled/);
  f.config.enableReview = true;
  f.api.config.models.providers.fixture.agentRuntime.id = 'auto';
  await assert.rejects(f.studio.review(f.context, { articleId: article.id, version: 1 }), /explicit/);
  assert.equal(f.calls.length, 0);
});

test('non-isolated or contradictory model results never grant review success', async (t) => {
  let malformed = { ...makeResult(), execution: { mode: 'direct-provider', owner: { kind: 'provider', id: 'fixture' } } };
  const f = fixture(t, {}, async () => malformed);
  const article = f.create();
  const request = { articleId: article.id, version: 1 };
  await assert.rejects(f.studio.review(f.context, request), /failed/);
  malformed = makeResult({ pass: true, findings: [{ severity: 'blocker', message: 'Contradiction', sourceIds: ['source'] }] });
  await assert.rejects(f.studio.review(f.context, request), /failed/);
  assert.equal(f.studio.store.get('writer', article.id).state, 'qa_failed');
});

test('revoked tool invocation cannot persist a completed review', async (t) => {
  let active = true;
  let finish;
  const f = fixture(t, {}, () => new Promise((resolve) => { finish = resolve; }));
  const article = f.create();
  const context = { ...f.context, assertInvocationCurrent() { if (!active) throw new Error('Revoked'); } };
  const pending = f.studio.review(context, { articleId: article.id, version: 1 });
  active = false;
  finish(makeResult());
  await assert.rejects(pending, /failed/);
  assert.notEqual(f.studio.store.get('writer', article.id).state, 'pending_human_review');
});

test('private source URLs, missing claim links and fake screenshot metadata are rejected', (t) => {
  const f = fixture(t);
  for (const url of ['file:///etc/passwd', 'https://localhost/x', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/', 'https://metadata.google.internal/', 'https://name:password@example.com/', 'https://example.com/?api_key=fixture', 'https://example.com/?X-Amz-Signature=fixture']) {
    assert.throws(() => publicUrl(url));
  }
  assert.throws(() => f.create({ document: { ...f.document, claims: [{ text: 'Unsupported', sourceIds: ['missing'] }] } }), /existing sources/);
  const assets = [{ ...f.document.assets[0], kind: 'screenshot' }];
  assert.throws(() => f.create({ document: { ...f.document, assets } }), /Screenshots require/);
});

test('image imports refuse arbitrary files, symlink escapes and active SVG', (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside.png');
  writeFileSync(outside, readFileSync(f.image));
  const linked = path.join(f.media, 'escape.png');
  symlinkSync(outside, linked);
  const svg = path.join(f.media, 'unsafe.svg');
  writeFileSync(svg, '<svg onload="alert(1)"></svg>');
  for (const image of [outside, linked, svg]) {
    assert.throws(() => f.create({ document: {
      ...f.document, assets: [{ ...f.document.assets[0], path: image }],
    } }), /allowed root|Only PNG/);
  }
});

test('renderers escape article HTML, unsafe descriptions and fenced code', (t) => {
  const f = fixture(t);
  const doc = structuredClone(f.document);
  doc.title = '<script>alert(1)</script>';
  doc.blocks[0].text = '<img src=x onerror=alert(1)> ![tracking](https://example.com/tracker)';
  doc.blocks[2].text = '~~~\n<script>alert(1)</script>';
  doc.assets[0].alt = '"><script>alert(1)</script>';
  doc.sources[0].url = 'https://example.com/![tracking](https://example.com/tracker)';
  const article = f.create({ document: doc });
  const html = renderHtml(article.document);
  const markdown = renderMarkdown(article.document);
  assert.ok(!html.includes('<script>'));
  assert.ok(markdown.startsWith('# &lt;script&gt;'));
  assert.ok(markdown.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(markdown.includes('\\!\\[tracking\\]'));
  assert.match(markdown, /~~~~\n~~~/);
  assert.ok(markdown.includes('](<https://example.com/![tracking](https://example.com/tracker)>)'));
  assert.ok(html.includes('&lt;script&gt;'));
});

function invoke(handler, url, authorization) {
  const headers = {};
  const response = {
    status: 200, headers, bytes: null,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    writeHead(status, extra) { this.status = status; Object.assign(headers, extra); },
    end(bytes) { this.bytes = bytes; },
  };
  handler({ method: 'GET', url, headers: { authorization } }, response);
  return response;
}

test('private preview authenticates article and image requests and rejects traversal', (t) => {
  const f = fixture(t);
  const article = f.create();
  const password = 'fixture-password-which-is-not-a-real-credential';
  const handler = createPreviewHandler(f.studio, password);
  const url = '/a/' + article.id + '/v/1';
  const auth = 'Basic ' + Buffer.from('reviewer:' + password).toString('base64');
  assert.throws(() => createPreviewHandler(f.studio, 'short'), /at least 24/);
  assert.equal(invoke(handler, url).status, 401);
  const imageUrl = url + '/assets/' + article.document.assets[0].file;
  assert.equal(invoke(handler, imageUrl).status, 401);
  assert.equal(invoke(handler, imageUrl, auth).status, 200);
  const preview = invoke(handler, url, auth);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers['Cache-Control'] ?? preview.headers['cache-control'], 'private, no-store');
  assert.ok(preview.bytes.toString().includes(imageUrl));
  for (const unsafe of [url + '/../studio.sqlite', url + '/assets/%2e%2e/secret', '/studio.sqlite', url + '/assets/unknown.png']) {
    assert.equal(invoke(handler, unsafe, auth).status, 404);
  }
});

test('preview server binds only loopback and serves a complete authenticated document', async (t) => {
  const f = fixture(t);
  const article = f.create();
  f.config.preview.port = 0;
  const password = 'fixture-preview-password-for-local-http-only';
  const server = await startPreview(f.studio, password);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  const response = await new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1', port: address.port, path: '/a/' + article.id + '/v/1',
      auth: 'reviewer:' + password,
    }, (result) => {
      let body = '';
      result.setEncoding('utf8');
      result.on('data', (chunk) => { body += chunk; });
      result.on('end', () => resolve({ status: result.statusCode, body }));
    });
    request.on('error', reject);
  });
  assert.equal(response.status, 200);
  assert.ok(response.body.includes(article.document.title));
});

test('modified exports and database symlinks fail safely', async (t) => {
  const f = fixture(t);
  const article = f.create();
  await f.studio.review(f.context, { articleId: article.id, version: 1 });
  f.decide(article, 'approve');
  const request = { articleId: article.id, version: 1 };
  const output = f.studio.export(f.context, request);
  writeFileSync(path.join(output.directory, 'article.html'), 'User edits must not be overwritten.');
  assert.throws(() => f.studio.export(f.context, request), /modified/);
  assert.equal(readFileSync(path.join(output.directory, 'article.html'), 'utf8'), 'User edits must not be overwritten.');
  const secondRoot = mkdtempSync(path.join(f.root, 'database-link-'));
  symlinkSync(path.join(f.root, 'target.sqlite'), path.join(secondRoot, 'studio.sqlite'));
  assert.throws(() => new Store(secondRoot, f.config), /regular file/);
});

test('foreign SQLite data is rejected without changing its journal mode or contents', (t) => {
  const f = fixture(t);
  const root = mkdtempSync(path.join(f.root, 'foreign-store-'));
  const filename = path.join(root, 'studio.sqlite');
  const foreign = new DatabaseSync(filename);
  foreign.exec("CREATE TABLE valuable(value TEXT); INSERT INTO valuable VALUES('preserve me');");
  const journal = foreign.prepare('PRAGMA journal_mode').get().journal_mode;
  foreign.close();
  assert.throws(() => new Store(root, f.config), /not owned/);
  const verify = new DatabaseSync(filename, { readOnly: true });
  assert.equal(verify.prepare('SELECT value FROM valuable').get().value, 'preserve me');
  assert.equal(verify.prepare('PRAGMA journal_mode').get().journal_mode, journal);
  verify.close();
});

test('stopped plugin objects cannot reopen persistent state', (t) => {
  const f = fixture(t);
  f.create();
  f.studio.close();
  assert.throws(() => f.studio.article(f.context, { action: 'list' }), /stopped/);
  assert.throws(() => f.studio.store, /stopped/);
});

test('configuration rejects credentials in preview links and validates limits', () => {
  assert.throws(() => normalizeConfig({ preview: { publicBaseUrl: 'https://name:password@example.com/' } }), /credentials/);
  assert.throws(() => normalizeConfig({ notification: { enabled: true } }), /Notifications require/);
  assert.throws(() => normalizeConfig({ minBodyChars: 100, maxBodyChars: 10 }), /cannot exceed/);
  assert.throws(() => normalizeConfig({ assetRoots: ['relative/path'] }), /absolute/);
  assert.throws(() => normalizeConfig({ unexpectedSetting: true }), /Unknown/);
});
