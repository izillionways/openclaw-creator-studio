import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const root = mkdtempSync(path.join(os.tmpdir(), 'creator-studio-host-'));
try {
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace);
  const config = path.join(root, 'openclaw.json');
  writeFileSync(config, JSON.stringify({
    agents: {
      ownership: 'explicit', defaults: { systemAgent: { agentId: 'writer' } },
      entries: { writer: { workspace } },
    },
    plugins: {
      allow: ['creator-studio'], load: { paths: [project] },
      entries: { 'creator-studio': { enabled: true, config: { allowedAgents: ['writer'] } } },
    },
  }), { mode: 0o600 });
  const env = {
    ...process.env, OPENCLAW_STATE_DIR: path.join(root, 'state'),
    OPENCLAW_CONFIG_PATH: config, OPENCLAW_CONFIG_READONLY: '1', NODE_DISABLE_COMPILE_CACHE: '1',
  };
  function cli(args) {
    const result = spawnSync('openclaw', args, { env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  }
  const inspected = cli(['plugins', 'inspect', 'creator-studio', '--runtime', '--json']);
  assert.equal(inspected.plugin.status, 'loaded');
  assert.deepEqual(inspected.plugin.toolNames.sort(), [
    'creator_article', 'creator_export', 'creator_review', 'creator_submit',
  ]);
  assert.deepEqual(inspected.diagnostics, []);
  const listed = cli(['skills', 'list', '--agent', 'writer', '--json']);
  const skills = listed.skills.filter((skill) => skill.name.startsWith('creator-'));
  assert.deepEqual(skills.map((skill) => skill.name).sort(), [
    'creator-article-creator', 'creator-editorial-review', 'creator-topic-research',
  ]);
  assert.ok(skills.every((skill) => skill.eligible));
  console.log('PASS: isolated OpenClaw loader found four tools and three eligible Skills.');
  console.log('No Gateway was started; no production configuration was read or changed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
