import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CreatorStudio } from '../src/studio.js';
import { fixture, makeResult, png } from './fixture.js';

test('complete offline workflow seals approval and exports portable artifacts', async (t) => {
  const f = fixture(t);
  const article = f.create({ runKey: 'run-1' });
  assert.equal(article.state, 'draft');
  assert.throws(() => f.decide(article, 'approve'), /reviewed current version/);
  assert.throws(() => f.studio.export(f.context, { articleId: article.id, version: 1 }), /human approval/);
  const reviewed = await f.studio.review(f.context, { articleId: article.id, version: 1 });
  assert.equal(reviewed.state, 'pending_human_review');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].messages.length, 1);
  assert.equal(f.calls[0].execution.mode, 'isolated-agent-runtime');
  assert.equal(f.calls[0].tools, undefined);
  assert.equal(f.calls[0].agentId, 'writer');
  assert.equal(f.decide(reviewed, 'approve').state, 'approved_for_manual_publish');
  const exported = f.studio.export(f.context, { articleId: article.id, version: 1 });
  assert.ok(existsSync(path.join(exported.directory, 'article.html')));
  assert.ok(existsSync(path.join(exported.directory, 'article.md')));
  assert.ok(existsSync(path.join(exported.directory, 'assets', article.document.assets[0].file)));
  assert.ok(!readFileSync(path.join(exported.directory, 'article.json'), 'utf8').includes(f.root));
  assert.match(readFileSync(path.join(exported.directory, 'article.html'), 'utf8'), /Illustration; not a test result/);
  assert.deepEqual(f.studio.export(f.context, { articleId: article.id, version: 1 }), exported);
  assert.equal(f.decide(reviewed, 'published').state, 'manually_published');
  assert.deepEqual(f.studio.export(f.context, { articleId: article.id, version: 1 }), exported);
  assert.throws(() => f.studio.article(f.context, { action: 'revise', articleId: article.id, version: 1, document: f.document }), /closed/);
});

test('editing approved content creates a new immutable version and invalidates approval', async (t) => {
  const f = fixture(t);
  const first = f.create();
  await f.studio.review(f.context, { articleId: first.id, version: 1 });
  f.decide(first, 'approve');
  const second = f.studio.article(f.context, {
    action: 'revise', articleId: first.id, version: 1,
    document: { ...f.document, title: 'Corrected title' },
  });
  assert.equal(second.version, 2);
  assert.equal(second.state, 'draft');
  assert.notEqual(second.hash, first.hash);
  assert.equal(f.studio.store.get('writer', first.id, 1).document.title, first.document.title);
  assert.equal(f.studio.command({ ...f.human, args: 'status ' + first.id + ' 1' }).version, 1);
  assert.throws(() => f.decide(first, 'approve'), /Stale version/);
  assert.throws(() => f.studio.export(f.context, { articleId: first.id, version: 2 }), /human approval/);
});

test('image-only changes invalidate approval and retain the old image', async (t) => {
  const f = fixture(t);
  const first = f.create();
  await f.studio.review(f.context, { articleId: first.id, version: 1 });
  f.decide(first, 'approve');
  writeFileSync(f.image, Buffer.concat([png, Buffer.from('updated')]));
  const next = f.studio.article(f.context, { action: 'revise', articleId: first.id, version: 1, document: f.document });
  assert.equal(next.state, 'draft');
  assert.notEqual(first.document.assets[0].sha256, next.document.assets[0].sha256);
  assert.deepEqual(f.studio.store.assetBytes(first, first.document.assets[0].file), png);
});

test('a rejected article needs a real human revision request before an agent can resume it', async (t) => {
  const f = fixture(t);
  const first = f.create();
  f.decide(first, 'reject');
  assert.throws(() => f.studio.article(f.context, { action: 'revise', articleId: first.id, version: 1, document: f.document }), /closed/);
  await assert.rejects(f.studio.review(f.context, { articleId: first.id, version: 1 }), /closed/);
  assert.equal(f.calls.length, 0);
  f.decide(first, 'revise', 'Please add the missing limitation.');
  const second = f.studio.article(f.context, { action: 'revise', articleId: first.id, version: 1, document: { ...f.document, summary: 'Updated fixture summary.' } });
  assert.equal(second.version, 2);
});

test('run idempotency, topic deduplication and daily limits persist', (t) => {
  const f = fixture(t, { maxDailyDrafts: 1 });
  const first = f.create({ runKey: 'daily-1' });
  assert.equal(f.create({ runKey: 'daily-1' }).id, first.id);
  assert.equal(f.studio.store.list('writer').length, 1);
  assert.throws(() => f.create({ runKey: 'daily-1', document: { ...f.document, title: 'Different payload' } }), /another payload/);
  assert.throws(() => f.create(), /Topic already exists/);
  assert.throws(() => f.create({ topicKey: 'another-topic' }), /Daily draft limit/);
  f.studio.close();
  const reopened = new CreatorStudio(f.api, f.config, path.join(f.root, 'data'), [f.media]);
  t.after(() => reopened.close());
  assert.equal(reopened.store.get('writer', first.id).hash, first.hash);
  assert.throws(() => reopened.article(f.context, { action: 'create', topicKey: 'another', document: f.document }), /Daily draft limit/);
});

test('deterministic failures block model calls and human approval', async (t) => {
  const f = fixture(t, { minBodyChars: 5000 });
  const first = f.create();
  const result = await f.studio.review(f.context, { articleId: first.id, version: 1 });
  assert.equal(result.state, 'qa_failed');
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.decide(first, 'approve'), /reviewed current version/);
});

test('supplied evidence and its access limits survive review and export without research integrations', async (t) => {
  const f = fixture(t);
  const disclosure = 'This synthetic draft uses supplied materials; linked originals were not independently retrieved.';
  const document = structuredClone(f.document);
  document.blocks.unshift({ type: 'paragraph', text: disclosure });
  document.sources[0].excerpt = disclosure + ' Synthetic evidence for local tests only.';
  document.sources[0].checkedAt = new Date().toISOString();
  const article = f.create({ document });
  const request = { articleId: article.id, version: 1 };
  assert.equal((await f.studio.review(f.context, request)).state, 'pending_human_review');
  const reviewedInput = JSON.parse(f.calls[0].messages[0].content);
  assert.deepEqual(reviewedInput.article.sources, article.document.sources);
  f.decide(article, 'approve');
  const exported = f.studio.export(f.context, request);
  const saved = JSON.parse(readFileSync(path.join(exported.directory, 'article.json'), 'utf8'));
  assert.deepEqual(saved.document.sources, article.document.sources);
  assert.ok(readFileSync(path.join(exported.directory, 'article.html'), 'utf8').includes(disclosure));
});

test('secondary hot-list evidence alone cannot reach model review, approval or export', async (t) => {
  const f = fixture(t);
  const document = structuredClone(f.document);
  document.sources[0] = {
    ...document.sources[0], kind: 'secondary', title: 'Synthetic hot-list fixture',
    excerpt: 'Discovery lead only: rank 1, heat 42 points, observed in this synthetic fixture.',
  };
  const article = f.create({ document });
  const request = { articleId: article.id, version: 1 };
  const reviewed = await f.studio.review(f.context, request);
  assert.equal(reviewed.state, 'qa_failed');
  assert.ok(reviewed.checks.findings.some((finding) => finding.includes('primary source')));
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.decide(article, 'approve'), /reviewed current version/);
  assert.throws(() => f.studio.export(f.context, request), /human approval/);
});

test('independent blockers prevent submission', async (t) => {
  const f = fixture(t, {}, async () => makeResult({ pass: false, findings: [
    { severity: 'blocker', message: 'The claim lacks supporting evidence.', sourceIds: ['source'] },
  ] }));
  const first = f.create();
  const result = await f.studio.review(f.context, { articleId: first.id, version: 1 });
  assert.equal(result.state, 'qa_failed');
  await assert.rejects(f.studio.submit(f.context, { articleId: first.id, version: 1 }), /passed both/);
});

test('stale asynchronous review cannot approve a later version', async (t) => {
  let finish;
  const f = fixture(t, {}, () => new Promise((resolve) => { finish = resolve; }));
  const first = f.create();
  const pending = f.studio.review(f.context, { articleId: first.id, version: 1 });
  f.studio.article(f.context, { action: 'revise', articleId: first.id, version: 1, document: { ...f.document, title: 'Version 2' } });
  finish(makeResult());
  await assert.rejects(pending, /became stale/);
  const current = f.studio.store.get('writer', first.id);
  assert.equal(current.version, 2);
  assert.equal(current.state, 'draft');
  assert.equal(current.review, null);
});

test('a human rejection wins over a running review', async (t) => {
  let finish;
  const f = fixture(t, {}, () => new Promise((resolve) => { finish = resolve; }));
  const first = f.create();
  const pending = f.studio.review(f.context, { articleId: first.id, version: 1 });
  f.decide(first, 'reject');
  finish(makeResult());
  await assert.rejects(pending, /failed/);
  assert.equal(f.studio.store.get('writer', first.id).state, 'rejected');
});

test('malformed reviews consume bounded attempts without persisting provider secrets', async (t) => {
  const f = fixture(t, {}, async () => { throw new Error('fake-secret-that-must-not-appear'); });
  const first = f.create();
  const request = { articleId: first.id, version: 1 };
  await assert.rejects(f.studio.review(f.context, request), /Independent review failed/);
  await assert.rejects(f.studio.review(f.context, request), /Independent review failed/);
  await assert.rejects(f.studio.review(f.context, request), /attempt limit/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.studio.store.get('writer', first.id).state, 'qa_failed');
  assert.ok(!JSON.stringify(f.studio.store.get('writer', first.id)).includes('fake-secret'));
});

test('parallel review is refused and successful review is cached', async (t) => {
  let finish;
  const f = fixture(t, {}, () => new Promise((resolve) => { finish = resolve; }));
  const first = f.create();
  const request = { articleId: first.id, version: 1 };
  const pending = f.studio.review(f.context, request);
  await assert.rejects(f.studio.review(f.context, request), /already running/);
  finish(makeResult());
  await pending;
  await f.studio.review(f.context, request);
  assert.equal(f.calls.length, 1);
});

test('daily review quotas also apply across new article versions', async (t) => {
  const f = fixture(t, { maxReviewCallsPerDay: 1 });
  const first = f.create();
  await f.studio.review(f.context, { articleId: first.id, version: 1 });
  f.studio.article(f.context, { action: 'revise', articleId: first.id, version: 1, document: { ...f.document, title: 'Version 2' } });
  await assert.rejects(f.studio.review(f.context, { articleId: first.id, version: 2 }), /Daily review limit/);
  assert.equal(f.calls.length, 1);
});

test('notifications are sent once and uncertain deliveries are never blindly retried', async (t) => {
  const f = fixture(t, {
    preview: { enabled: true, publicBaseUrl: 'https://preview.example.com' },
    notification: { enabled: true, channel: 'test-chat', accountId: 'sandbox', to: 'owner' },
  });
  const first = f.create();
  const request = { articleId: first.id, version: 1 };
  await f.studio.review(f.context, request);
  assert.equal((await f.studio.submit(f.context, request)).notification, 'sent');
  assert.equal((await f.studio.submit(f.context, request)).notification, 'sent');
  assert.equal(f.sends.length, 1);
  assert.ok(!f.sends[0].text.includes('password'));
  const second = f.create({ topicKey: 'different-topic' });
  const secondRequest = { articleId: second.id, version: 1 };
  await f.studio.review(f.context, secondRequest);
  let attempts = 0;
  f.api.runtime.channel.outbound.loadAdapter = async () => ({
    sendText: async () => { attempts++; throw new Error('Response lost after possible delivery'); },
  });
  assert.equal((await f.studio.submit(f.context, secondRequest)).notification, 'unknown');
  assert.equal((await f.studio.submit(f.context, secondRequest)).notification, 'unknown');
  assert.equal(attempts, 1);
});

test('changing or corrupting stored assets prevents approval and export', async (t) => {
  const f = fixture(t);
  const first = f.create();
  await f.studio.review(f.context, { articleId: first.id, version: 1 });
  f.decide(first, 'approve');
  writeFileSync(path.join(f.studio.store.assetsDirectory, first.document.assets[0].file), 'corrupted');
  assert.throws(() => f.studio.export(f.context, { articleId: first.id, version: 1 }), /integrity/);
});
