import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { hash, renderHtml, renderMarkdown, text } from './content.js';

function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
    throw new Error('Creator Studio data directories must be real, private directories (0700).');
  }
  return realpathSync(directory);
}

export class Store {
  constructor(directory, config) {
    this.config = config;
    this.directory = privateDirectory(directory);
    this.assetsDirectory = privateDirectory(path.join(this.directory, 'assets'));
    this.exportsDirectory = privateDirectory(path.join(this.directory, 'exports'));
    const database = path.join(this.directory, 'studio.sqlite');
    const applicationId = 0x43535455;
    for (const filename of [database, database + '-wal', database + '-shm', database + '-journal']) {
      const stat = lstatSync(filename, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('The database must be a regular file.');
    }
    if (existsSync(database)) {
      const existing = new DatabaseSync(database, { readOnly: true });
      try {
        if (existing.prepare('PRAGMA application_id').get().application_id !== applicationId ||
            existing.prepare('PRAGMA user_version').get().user_version > 1) {
          throw new Error('This database is not owned by this Creator Studio version.');
        }
      } finally {
        existing.close();
      }
    }
    this.db = new DatabaseSync(database);
    chmodSync(database, 0o600);
    this.db.exec('PRAGMA application_id=' + applicationId + '; PRAGMA user_version=1;');
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS articles (' +
      'id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, topic_key TEXT NOT NULL, run_key TEXT, day TEXT NOT NULL,' +
      'state TEXT NOT NULL, current_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,' +
      'UNIQUE(agent_id, topic_key), UNIQUE(agent_id, run_key));' +
      'CREATE TABLE IF NOT EXISTS versions (' +
      'article_id TEXT REFERENCES articles(id), version INTEGER, hash TEXT NOT NULL, document TEXT NOT NULL,' +
      'checks TEXT, review TEXT, PRIMARY KEY(article_id, version));' +
      'CREATE TABLE IF NOT EXISTS events (' +
      'id INTEGER PRIMARY KEY, article_id TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL,' +
      'actor TEXT NOT NULL, hash TEXT NOT NULL, at TEXT NOT NULL, detail TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS review_calls (' +
      'id TEXT PRIMARY KEY, article_id TEXT NOT NULL, version INTEGER NOT NULL, agent_id TEXT NOT NULL,' +
      'day TEXT NOT NULL, state TEXT NOT NULL, expires INTEGER NOT NULL, usage TEXT);' +
      'CREATE TABLE IF NOT EXISTS notifications (' +
      'article_id TEXT NOT NULL, version INTEGER NOT NULL, destination TEXT NOT NULL, state TEXT NOT NULL,' +
      'receipt TEXT, PRIMARY KEY(article_id, version, destination));'
    );
  }

  close() { this.db.close(); }
  day() { return new Intl.DateTimeFormat('en-CA', { timeZone: this.config.timeZone }).format(new Date()); }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  get(agentId, id, version) {
    const article = this.db.prepare('SELECT * FROM articles WHERE id=? AND agent_id=?').get(id, agentId);
    if (!article) throw new Error('Article not found for this agent.');
    const row = this.db.prepare('SELECT * FROM versions WHERE article_id=? AND version=?')
      .get(id, version ?? article.current_version);
    if (!row) throw new Error('Article version not found.');
    return {
      id, agentId, version: row.version, currentVersion: article.current_version,
      state: article.state, hash: row.hash, document: JSON.parse(row.document),
      checks: row.checks ? JSON.parse(row.checks) : null,
      review: row.review ? JSON.parse(row.review) : null,
      createdAt: article.created_at, updatedAt: article.updated_at,
    };
  }

  current(agentId, id, version) {
    const article = this.get(agentId, id, version);
    if (version !== article.currentVersion) throw new Error('Stale version; use the exact current version.');
    return article;
  }

  owner(id) {
    const row = this.db.prepare('SELECT agent_id FROM articles WHERE id=?').get(id);
    if (!row) throw new Error('Article not found.');
    return row.agent_id;
  }

  list(agentId) {
    return this.db.prepare('SELECT id,topic_key AS topicKey,current_version AS version,state,updated_at AS updatedAt ' +
      'FROM articles WHERE agent_id=? ORDER BY updated_at DESC LIMIT 50').all(agentId);
  }

  event(article, kind, actor, detail = {}) {
    this.db.prepare('INSERT INTO events(article_id,version,kind,actor,hash,at,detail) VALUES(?,?,?,?,?,?,?)')
      .run(article.id, article.version, kind, JSON.stringify(actor), article.hash, new Date().toISOString(), JSON.stringify(detail));
  }

  setState(id, state) {
    this.db.prepare('UPDATE articles SET state=?,updated_at=? WHERE id=?').run(state, new Date().toISOString(), id);
  }

  installAssets(imported) {
    for (const { asset, bytes } of imported) {
      const target = path.join(this.assetsDirectory, asset.file);
      if (!existsSync(target)) writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
      if (lstatSync(target).isSymbolicLink() || hash(readFileSync(target)) !== asset.sha256) {
        throw new Error('Stored asset integrity check failed.');
      }
    }
  }

  create(agentId, topicKey, runKey, document, imported) {
    topicKey = text(topicKey, 'topic key', 200).toLowerCase();
    if (runKey !== undefined) runKey = text(runKey, 'run key', 200);
    const documentJson = JSON.stringify(document);
    const digest = hash(documentJson);
    return this.transaction(() => {
      if (runKey) {
        const previous = this.db.prepare('SELECT id FROM articles WHERE agent_id=? AND run_key=?').get(agentId, runKey);
        if (previous) {
          const first = this.get(agentId, previous.id, 1);
          if (first.hash !== digest) throw new Error('runKey already belongs to another payload; resume article ' + previous.id + '.');
          return { ...this.get(agentId, previous.id), reused: true };
        }
      }
      const duplicate = this.db.prepare('SELECT id FROM articles WHERE agent_id=? AND topic_key=?').get(agentId, topicKey);
      if (duplicate) throw new Error('Topic already exists as article ' + duplicate.id + '.');
      const day = this.day();
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM articles WHERE agent_id=? AND day=?').get(agentId, day).count;
      if (count >= this.config.maxDailyDrafts) throw new Error('Daily draft limit reached.');
      this.installAssets(imported);
      const id = 'cs-' + randomUUID().replaceAll('-', '').slice(0, 20);
      const at = new Date().toISOString();
      this.db.prepare('INSERT INTO articles VALUES(?,?,?,?,?,?,?,?,?)').run(id, agentId, topicKey, runKey ?? null, day, 'draft', 1, at, at);
      this.db.prepare('INSERT INTO versions(article_id,version,hash,document) VALUES(?,?,?,?)').run(id, 1, digest, documentJson);
      const article = this.get(agentId, id);
      this.event(article, 'created', { agentId });
      return article;
    });
  }

  revise(agentId, id, version, document, imported) {
    return this.transaction(() => {
      const current = this.current(agentId, id, version);
      if (['rejected', 'manually_published'].includes(current.state)) throw new Error('This article is closed; a human must request a revision first.');
      const digest = hash(JSON.stringify(document));
      if (digest === current.hash) return current;
      this.installAssets(imported);
      this.db.prepare('INSERT INTO versions(article_id,version,hash,document) VALUES(?,?,?,?)')
        .run(id, version + 1, digest, JSON.stringify(document));
      this.db.prepare('UPDATE articles SET current_version=? WHERE id=?').run(version + 1, id);
      this.setState(id, 'draft');
      const article = this.get(agentId, id);
      this.event(article, 'revised_approval_invalidated', { agentId }, { previousVersion: version });
      return article;
    });
  }

  verify(article) {
    if (hash(JSON.stringify(article.document)) !== article.hash) throw new Error('Draft integrity check failed.');
    for (const asset of article.document.assets) this.assetBytes(article, asset.file);
  }

  assetBytes(article, filename) {
    const asset = article.document.assets.find((item) => item.file === filename);
    if (!asset || !/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(filename)) throw new Error('Asset not found.');
    const target = path.join(this.assetsDirectory, filename);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('Stored asset integrity check failed.');
    const bytes = readFileSync(target);
    if (hash(bytes) !== asset.sha256) throw new Error('Stored asset integrity check failed.');
    return bytes;
  }

  reserveReview(agentId, id, version) {
    return this.transaction(() => {
      const article = this.current(agentId, id, version);
      if (['rejected', 'manually_published', 'revision_requested'].includes(article.state)) throw new Error('This article is closed or needs a revision.');
      const calls = this.db.prepare('SELECT * FROM review_calls WHERE article_id=? AND version=?').all(id, version);
      if (calls.some((call) => call.state === 'running' && call.expires > Date.now())) throw new Error('Review is already running.');
      if (calls.length >= this.config.maxReviewAttempts) throw new Error('Review attempt limit reached; revise the article before another review.');
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM review_calls WHERE agent_id=? AND day=?').get(agentId, this.day()).count;
      if (count >= this.config.maxReviewCallsPerDay) throw new Error('Daily review limit reached.');
      const callId = randomUUID();
      this.db.prepare('INSERT INTO review_calls VALUES(?,?,?,?,?,?,?,?)')
        .run(callId, id, version, agentId, this.day(), 'running', Date.now() + this.config.reviewTimeoutMs, null);
      return callId;
    });
  }

  finishReview(agentId, id, version, checks, review, callId, usage = {}) {
    return this.transaction(() => {
      if (callId) this.db.prepare('UPDATE review_calls SET state=?,usage=? WHERE id=?').run('finished', JSON.stringify(usage), callId);
      const article = this.current(agentId, id, version);
      if (['rejected', 'manually_published', 'revision_requested'].includes(article.state)) {
        throw new Error('A human changed the review state; the pending result was discarded.');
      }
      this.db.prepare('UPDATE versions SET checks=?,review=? WHERE article_id=? AND version=?')
        .run(JSON.stringify(checks), JSON.stringify(review), id, version);
      this.setState(id, checks.pass && review?.pass ? 'pending_human_review' : 'qa_failed');
      const result = this.get(agentId, id);
      this.event(result, 'reviewed', { agentId }, { pass: result.state === 'pending_human_review' });
      return result;
    });
  }

  failReview(callId) {
    this.transaction(() => {
      const call = this.db.prepare('SELECT * FROM review_calls WHERE id=?').get(callId);
      this.db.prepare('UPDATE review_calls SET state=? WHERE id=?').run('failed', callId);
      const article = this.get(call.agent_id, call.article_id);
      if (article.version === call.version && ['draft', 'qa_failed'].includes(article.state)) {
        this.setState(article.id, 'qa_failed');
        this.event(article, 'review_failed', { agentId: call.agent_id });
      }
    });
  }

  decide(agentId, id, version, action, actor, reason = '') {
    return this.transaction(() => {
      const article = this.current(agentId, id, version);
      this.verify(article);
      if (article.state === 'manually_published') throw new Error('Publication is already confirmed.');
      if (action === 'approve') {
        if (article.state === 'approved_for_manual_publish') return article;
        if (article.state !== 'pending_human_review' || !article.checks?.pass || !article.review?.pass) throw new Error('Only a reviewed current version can be approved.');
        this.setState(id, 'approved_for_manual_publish');
      } else if (action === 'reject') {
        this.setState(id, 'rejected');
      } else if (action === 'revise') {
        text(reason, 'revision reason', 2000);
        this.setState(id, 'revision_requested');
      } else if (action === 'published') {
        if (article.state !== 'approved_for_manual_publish') throw new Error('Only an approved version can be confirmed as manually published.');
        this.setState(id, 'manually_published');
      } else throw new Error('Unknown human decision.');
      this.event(article, action, actor, { reason });
      return this.get(agentId, id);
    });
  }

  notification(article, destination) {
    return this.transaction(() => {
      if (this.current(article.agentId, article.id, article.version).state !== 'pending_human_review') {
        throw new Error('This version is no longer pending human review.');
      }
      const existing = this.db.prepare('SELECT state,receipt FROM notifications WHERE article_id=? AND version=? AND destination=?')
        .get(article.id, article.version, destination);
      if (existing) return { ...existing, claimed: false };
      this.db.prepare('INSERT INTO notifications VALUES(?,?,?,?,?)').run(article.id, article.version, destination, 'sending', null);
      return { state: 'sending', claimed: true };
    });
  }

  finishNotification(article, destination, state, receipt) {
    this.db.prepare('UPDATE notifications SET state=?,receipt=? WHERE article_id=? AND version=? AND destination=?')
      .run(state, receipt ?? null, article.id, article.version, destination);
  }

  export(agentId, id, version) {
    return this.transaction(() => this.exportCurrent(agentId, id, version));
  }

  exportCurrent(agentId, id, version) {
    const article = this.current(agentId, id, version);
    if (!['approved_for_manual_publish', 'manually_published'].includes(article.state)) throw new Error('Export requires human approval of the current version.');
    this.verify(article);
    const files = {
      'article.html': Buffer.from(renderHtml(article.document, { status: 'approved_for_manual_publish', version })),
      'article.md': Buffer.from(renderMarkdown(article.document)),
      'article.json': Buffer.from(JSON.stringify({ id, version, hash: article.hash, document: article.document }, null, 2) + '\n'),
    };
    for (const asset of article.document.assets) files['assets/' + asset.file] = this.assetBytes(article, asset.file);
    const directory = path.join(this.exportsDirectory, id + '-v' + version + '-' + article.hash.slice(0, 16));
    if (existsSync(directory)) {
      if (lstatSync(directory).isSymbolicLink()) throw new Error('Export directory must not be a symlink.');
      for (const [name, bytes] of Object.entries(files)) {
        const target = path.join(directory, name);
        if (!existsSync(target) || lstatSync(target).isSymbolicLink() || !readFileSync(target).equals(bytes)) throw new Error('Existing export was modified; preserve it and resolve the conflict manually.');
      }
      return { id, version, hash: article.hash, directory };
    }
    const staging = mkdtempSync(path.join(this.exportsDirectory, '.export-'));
    try {
      privateDirectory(path.join(staging, 'assets'));
      for (const [name, bytes] of Object.entries(files)) writeFileSync(path.join(staging, name), bytes, { flag: 'wx', mode: 0o600 });
      renameSync(staging, directory);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    return { id, version, hash: article.hash, directory };
  }
}
