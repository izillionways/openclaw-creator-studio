import { checkDocument, hash, importImage, normalizeDocument, text } from './content.js';
import { independentReview, reviewModelRoute } from './review.js';
import { Store } from './store.js';

export class CreatorStudio {
  constructor(api, config, directory, assetRoots) {
    this.api = api;
    this.config = config;
    this.directory = directory;
    this.assetRoots = assetRoots;
    this.controllers = new Map();
  }

  get store() {
    if (this.closed) throw new Error('Creator Studio has stopped.');
    return this._store ??= new Store(this.directory, this.config);
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers.keys()) controller.abort();
    await Promise.allSettled(this.controllers.values());
    this._store?.close();
    this._store = undefined;
  }

  authorize(context) {
    if (this.closed) throw new Error('Creator Studio has stopped.');
    if (!context.agentId || !this.config.allowedAgents.includes(context.agentId)) throw new Error('This agent is not enabled for Creator Studio.');
    context.assertInvocationCurrent?.();
  }

  prepare(input) {
    if (!input || typeof input !== 'object') throw new Error('A structured document is required.');
    const assets = input.assets ?? [];
    if (!Array.isArray(assets) || assets.length > 12) throw new Error('An article may have at most 12 images.');
    const imported = assets.map((asset) => importImage(asset, this.assetRoots));
    return { document: normalizeDocument(input, imported), imported };
  }

  article(context, params) {
    this.authorize(context);
    if (params.action === 'list') return this.store.list(context.agentId);
    if (params.action === 'get') return this.store.get(context.agentId, params.articleId, params.version);
    if (!['create', 'revise'].includes(params.action)) throw new Error('Unknown article action.');
    const prepared = this.prepare(params.document);
    context.assertInvocationCurrent?.();
    context.assertInputCommitAllowed?.();
    if (params.action === 'create') {
      return this.store.create(context.agentId, params.topicKey, params.runKey, prepared.document, prepared.imported);
    }
    return this.store.revise(context.agentId, params.articleId, params.version, prepared.document, prepared.imported);
  }

  async review(context, params, signal) {
    this.authorize(context);
    const article = this.store.current(context.agentId, params.articleId, params.version);
    this.store.verify(article);
    if (['pending_human_review', 'approved_for_manual_publish'].includes(article.state) && article.review?.pass && article.checks?.pass) return article;
    const checks = checkDocument(article.document, this.config);
    if (!checks.pass) return this.store.finishReview(context.agentId, article.id, article.version, checks, null);
    const route = reviewModelRoute(this.api, this.config, context);
    signal?.throwIfAborted();
    context.assertInvocationCurrent?.();
    const callId = this.store.reserveReview(context.agentId, article.id, article.version);
    const controller = new AbortController();
    const finished = Promise.withResolvers();
    this.controllers.set(controller, finished.promise);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const { review, usage } = await independentReview(route, this.config, context, article, combined);
      this.authorize(context);
      return this.store.finishReview(context.agentId, article.id, article.version, checks, review, callId, usage);
    } catch {
      this._store?.failReview(callId);
      throw new Error('Independent review failed, was cancelled or became stale. No approval was granted; inspect the configured route, child sessions and retry limits.');
    } finally {
      this.controllers.delete(controller);
      finished.resolve();
    }
  }

  previewUrl(article) {
    return this.config.preview.enabled && this.config.preview.publicBaseUrl
      ? this.config.preview.publicBaseUrl + '/a/' + article.id + '/v/' + article.version : null;
  }

  async submit(context, params, signal) {
    this.authorize(context);
    const article = this.store.current(context.agentId, params.articleId, params.version);
    this.store.verify(article);
    if (article.state !== 'pending_human_review' || !article.review?.pass || !article.checks?.pass) {
      throw new Error('Submission requires a current version that passed both checks and independent review.');
    }
    const previewUrl = this.previewUrl(article);
    if (!this.config.notification.enabled) {
      return { articleId: article.id, version: article.version, hash: article.hash, previewUrl, notification: 'disabled' };
    }
    const route = this.config.notification;
    const adapter = await this.api.runtime?.channel?.outbound?.loadAdapter?.(route.channel);
    if (typeof adapter?.sendText !== 'function') throw new Error('The configured channel has no text outbound adapter.');
    this.authorize(context);
    signal?.throwIfAborted();
    const latest = this.store.current(context.agentId, article.id, article.version);
    if (latest.state !== 'pending_human_review') throw new Error('The article state changed before sending.');
    const destination = hash(JSON.stringify([route.channel, route.accountId, route.to]));
    const delivery = this.store.notification(article, destination);
    if (!delivery.claimed) return { articleId: article.id, version: article.version, previewUrl, notification: delivery.state === 'sent' ? 'sent' : 'unknown', receipt: delivery.receipt };
    try {
      const receipt = await adapter.sendText({
        cfg: context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config ?? this.api.config,
        accountId: route.accountId, to: route.to, signal,
        text: [
          article.document.title, article.document.summary.slice(0, 500),
          'Article: ' + article.id + ' v' + article.version + ' · ' + article.hash.slice(0, 12),
          previewUrl, '/creator approve ' + article.id + ' ' + article.version,
          'Approval authorizes this version for manual publication only.',
        ].join('\n\n'),
        assertDirectAdapterHandoff: () => {
          this.authorize(context);
          signal?.throwIfAborted();
          const current = this.store.current(context.agentId, article.id, article.version);
          if (current.state !== 'pending_human_review') throw new Error('The article changed before delivery.');
        },
      });
      if (!receipt?.messageId) throw new Error('Channel returned no receipt.');
      this.store.finishNotification(article, destination, 'sent', String(receipt.messageId));
      return { articleId: article.id, version: article.version, previewUrl, notification: 'sent', receipt: String(receipt.messageId) };
    } catch {
      // shortcut: uncertain sends require manual reconciliation; add retries only with a channel idempotency contract.
      this.store.finishNotification(article, destination, 'unknown');
      return { articleId: article.id, version: article.version, previewUrl, notification: 'unknown', message: 'Do not automatically resend. Check the destination and review this exact version manually.' };
    }
  }

  export(context, params) {
    this.authorize(context);
    return this.store.export(context.agentId, params.articleId, params.version);
  }

  command(context) {
    if (!context.isAuthorizedSender || !context.senderId || !context.accountId) throw new Error('An authenticated, explicitly configured sender is required.');
    if (!this.config.approvers.some((approver) => approver.channel === context.channel &&
        approver.accountId === context.accountId && approver.senderId === context.senderId)) {
      throw new Error('This sender is not an approver.');
    }
    const match = /^(status|approve|reject|revise|published)\s+(cs-[a-f0-9]{20})(?:\s+v?([1-9][0-9]*))?(?:\s+([\s\S]+))?$/.exec((context.args ?? '').trim());
    if (!match) throw new Error('Use /creator status|approve|reject|revise|published ARTICLE_ID VERSION [reason].');
    const [, action, id, rawVersion, rawReason = ''] = match;
    const agentId = this.store.owner(id);
    const authorized = this.config.allowedAgents.includes(agentId) && this.config.approvers.some((approver) =>
      approver.agentId === agentId && approver.channel === context.channel &&
      approver.accountId === context.accountId && approver.senderId === context.senderId);
    if (!authorized) throw new Error('This sender is not an approver for this article.');
    if (rawVersion && !Number.isSafeInteger(Number(rawVersion))) throw new Error('Invalid version.');
    const article = this.store.get(agentId, id, rawVersion ? Number(rawVersion) : undefined);
    if (action === 'status') return article;
    if (!rawVersion || !Number.isSafeInteger(Number(rawVersion))) throw new Error('A specific version is required.');
    const reason = rawReason ? text(rawReason, 'reason', 2000) : '';
    context.assertOwnerCurrent?.();
    return this.store.decide(agentId, id, Number(rawVersion), action, {
      channel: context.channel, accountId: context.accountId, senderId: context.senderId,
    }, reason);
  }
}
