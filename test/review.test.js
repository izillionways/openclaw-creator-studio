import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { checkDocument } from '../src/content.js';
import { fixture, makeResult } from './fixture.js';

test('missing subagent APIs fail before reserving usage and never fall back to a writer completion', async (t) => {
  const f = fixture(t, { maxReviewAttempts: 1 });
  const article = f.create();
  const request = { articleId: article.id, version: 1 };
  const nativeRun = f.api.runtime.subagent.run;
  delete f.api.runtime.subagent.run;
  f.api.runtime.llm = { complete() { assert.fail('Writer completion must not substitute for a review subagent.'); } };
  await assert.rejects(f.studio.review(f.context, request), /subagent session APIs/);
  assert.equal(f.calls.length, 0);
  f.api.runtime.subagent.run = nativeRun;
  assert.equal((await f.studio.review(f.context, request)).state, 'pending_human_review');
});

test('each reviewed version gets a fresh child session and retained run receipt', async (t) => {
  const f = fixture(t);
  const article = f.create();
  await f.studio.review(f.context, { articleId: article.id, version: 1 });
  f.studio.article(f.context, { action: 'revise', articleId: article.id, version: 1, document: { ...f.document, title: 'Revision' } });
  const reviewed = await f.studio.review(f.context, { articleId: article.id, version: 2 });
  assert.notEqual(f.calls[0].sessionKey, f.calls[1].sessionKey);
  assert.deepEqual(JSON.parse(f.calls[1].message), {
    articleId: article.id, version: 2, hash: reviewed.hash, article: reviewed.document,
  });
  assert.equal(reviewed.review.sessionKey, f.calls[1].sessionKey);
  assert.equal(reviewed.review.runId, 'fixture-run-2');
  assert.equal(f.calls[1].completionDelivery, undefined);
  assert.deepEqual(f.reads.map((entry) => entry.sessionKey), f.deletions.map((entry) => entry.sessionKey));
  assert.deepEqual(JSON.parse(f.studio.store.db.prepare('SELECT usage FROM review_calls WHERE state=? LIMIT 1').get('finished').usage), {
    inputTokens: 100, outputTokens: 30, costUsd: 0.001,
  });
});

test('legacy approved reviews are retained without relabeling or a new model call', async (t) => {
  const f = fixture(t);
  const article = f.create();
  const legacy = { pass: true, findings: [], runtime: 'codex', model: 'model', provider: 'fixture' };
  f.studio.store.finishReview('writer', article.id, 1, checkDocument(article.document, f.config), legacy);
  f.decide(article, 'approve');
  const request = { articleId: article.id, version: 1 };
  const retained = await f.studio.review(f.context, request);
  assert.equal(retained.state, 'approved_for_manual_publish');
  assert.deepEqual(retained.review, legacy);
  assert.equal(f.calls.length, 0);
  assert.ok(f.studio.export(f.context, request).directory);
});

test('pending and observation timeouts are polled; full session output is used instead of a capped snapshot', async (t) => {
  const findings = Array.from({ length: 3 }, () => ({ severity: 'warning', message: 'x'.repeat(1500), sourceIds: ['source'] }));
  const f = fixture(t, {}, async () => makeResult({ pass: true, findings }));
  const statuses = ['pending', 'timeout', 'ok'];
  f.api.runtime.subagent.waitForRun = async () => ({
    status: statuses.shift(), terminalReply: { disposition: 'visible', text: '{"truncated' },
  });
  const article = f.create();
  const reviewed = await f.studio.review(f.context, { articleId: article.id, version: 1 });
  assert.equal(reviewed.state, 'pending_human_review');
  assert.deepEqual(reviewed.review.findings, findings);
  assert.equal(statuses.length, 0);
  assert.equal(f.reads.length, 1);
  assert.equal(f.deletions.length, 1);
});

test('a mismatched receipt never reads or deletes the unrelated session', async (t) => {
  const f = fixture(t);
  const nativeRun = f.api.runtime.subagent.run;
  f.api.runtime.subagent.run = async (params) => ({ ...await nativeRun(params), sessionKey: 'agent:writer:main' });
  const article = f.create();
  await assert.rejects(f.studio.review(f.context, { articleId: article.id, version: 1 }), /failed/);
  assert.equal(f.reads.length, 0);
  assert.deepEqual(f.deletions, [{ sessionKey: f.calls[0].sessionKey, deleteTranscript: true }]);
  assert.equal(f.studio.store.get('writer', article.id).review, null);
});

test('a different admitted harness is refused and its owned child session is cleaned', async (t) => {
  const f = fixture(t);
  const nativeRun = f.api.runtime.subagent.run;
  f.api.runtime.subagent.run = async (params) => ({
    ...await nativeRun(params), runtime: { harness: 'other', provider: 'fixture', model: 'model' },
  });
  const article = f.create();
  await assert.rejects(f.studio.review(f.context, { articleId: article.id, version: 1 }), /failed/);
  assert.equal(f.waits.length, 0);
  assert.equal(f.deletions.length, 1);
});

test('terminal errors, timeouts and yielded runs cannot be salvaged from a passing transcript', async (t) => {
  const f = fixture(t, { maxReviewCallsPerDay: 10 });
  for (const outcome of [{ status: 'error' }, { status: 'timeout', endedAt: Date.now() }, { status: 'ok', yielded: true }]) {
    f.api.runtime.subagent.waitForRun = async () => outcome;
    const article = f.create({ topicKey: JSON.stringify(outcome) });
    await assert.rejects(f.studio.review(f.context, { articleId: article.id, version: 1 }), /failed/);
    assert.equal(f.studio.store.get('writer', article.id).state, 'qa_failed');
  }
  assert.equal(f.reads.length, 0);
  assert.equal(f.deletions.length, 3);
});

test('truncated, non-final and absent assistant messages cannot pass review', async (t) => {
  const f = fixture(t, { maxReviewCallsPerDay: 10 });
  for (const result of [
    { ...makeResult(), __openclaw: { truncated: true } },
    { ...makeResult(), phase: 'commentary' },
    { ...makeResult(), role: 'user' },
  ]) {
    f.api.runtime.subagent.getSessionMessages = async () => ({ messages: [result] });
    const article = f.create({ topicKey: 'invalid-message-' + f.calls.length });
    await assert.rejects(f.studio.review(f.context, { articleId: article.id, version: 1 }), /failed/);
  }
  assert.equal(f.deletions.length, 3);
});

test('review deadline cleans a still-running session and grants no approval', async (t) => {
  const f = fixture(t, { reviewTimeoutMs: 1000 }, () => new Promise(() => {}));
  const article = f.create();
  await assert.rejects(f.studio.review(f.context, { articleId: article.id, version: 1 }), /cancelled/);
  assert.equal(f.deletions.length, 1);
  assert.equal(f.reads.length, 0);
  assert.equal(f.studio.store.get('writer', article.id).state, 'qa_failed');
  assert.throws(() => f.decide(article, 'approve'), /reviewed current version/);
});

test('cancellation during admission still cleans a late accepted session', async (t) => {
  const f = fixture(t);
  const nativeRun = f.api.runtime.subagent.run;
  const admission = Promise.withResolvers();
  f.api.runtime.subagent.run = async (params) => {
    const accepted = await nativeRun(params);
    await admission.promise;
    return accepted;
  };
  const article = f.create();
  const controller = new AbortController();
  const pending = f.studio.review(f.context, { articleId: article.id, version: 1 }, controller.signal);
  controller.abort();
  admission.resolve();
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(f.deletions, [{ sessionKey: f.calls[0].sessionKey, deleteTranscript: true }]);
  assert.equal(f.waits.length, 0);
});

test('cleanup failure discards a passing result without exposing runtime errors', async (t) => {
  const f = fixture(t);
  f.api.runtime.subagent.deleteSession = async () => { throw new Error('fake-secret-cleanup-error'); };
  const article = f.create();
  await assert.rejects(f.studio.review(f.context, { articleId: article.id, version: 1 }), (error) => {
    assert.ok(!error.message.includes('fake-secret'));
    return true;
  });
  assert.equal(f.studio.store.get('writer', article.id).state, 'qa_failed');
  assert.equal(f.studio.store.get('writer', article.id).review, null);
});

test('shutdown waits for child cleanup and records the cancelled attempt before closing storage', async (t) => {
  const f = fixture(t);
  const waiting = Promise.withResolvers();
  const cleanup = Promise.withResolvers();
  const cleanupStarted = Promise.withResolvers();
  f.api.runtime.subagent.waitForRun = () => waiting.promise;
  f.api.runtime.subagent.deleteSession = async (params) => {
    f.deletions.push(params);
    cleanupStarted.resolve();
    await cleanup.promise;
  };
  const article = f.create();
  const review = assert.rejects(f.studio.review(f.context, { articleId: article.id, version: 1 }), /cancelled/);
  await setImmediate();
  let stopped = false;
  const stopping = f.studio.close().then(() => { stopped = true; });
  waiting.resolve({ status: 'pending' });
  await cleanupStarted.promise;
  assert.equal(stopped, false);
  assert.equal(f.studio._store.db.prepare('SELECT state FROM review_calls').get().state, 'running');
  cleanup.resolve();
  await Promise.all([review, stopping]);
  assert.equal(stopped, true);
  assert.equal(f.studio._store, undefined);
  assert.equal(f.deletions.length, 1);
  const database = new DatabaseSync(path.join(f.root, 'data', 'studio.sqlite'), { readOnly: true });
  try {
    assert.equal(database.prepare('SELECT state FROM review_calls').get().state, 'failed');
  } finally {
    database.close();
  }
});
