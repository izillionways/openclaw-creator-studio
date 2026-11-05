import path from 'node:path';
import manifest from '../openclaw.plugin.json' with { type: 'json' };
import { publicUrl } from './content.js';

export { manifest };

export function normalizeConfig(input = {}) {
  for (const key of Object.keys(input)) {
    if (!(key in manifest.configSchema.properties)) throw new Error('Unknown Creator Studio setting: ' + key);
  }
  const config = {
    allowedAgents: [], assetRoots: [], approvers: [], timeZone: 'UTC',
    minBodyChars: 600, maxBodyChars: 30000, requireBodyImage: true,
    maxDailyDrafts: 1, maxReviewCallsPerDay: 4, maxReviewAttempts: 2,
    enableReview: false, reviewTimeoutMs: 90000,
    reviewRuntimeOwners: ['codex', 'claude-cli'],
    ...input,
    preview: {
      enabled: false, port: 18890, username: 'reviewer',
      passwordEnv: 'CREATOR_STUDIO_PREVIEW_PASSWORD', publicBaseUrl: '',
      ...input.preview,
    },
    notification: { enabled: false, channel: '', accountId: '', to: '', ...input.notification },
  };
  for (const key of ['allowedAgents', 'assetRoots', 'reviewRuntimeOwners']) {
    if (!Array.isArray(config[key]) || config[key].some((value) => typeof value !== 'string' || !value.trim())) {
      throw new Error(key + ' must contain non-empty strings.');
    }
  }
  if (config.dataDir !== undefined && !path.isAbsolute(config.dataDir)) throw new Error('dataDir must be absolute.');
  if (config.assetRoots.some((root) => !path.isAbsolute(root))) throw new Error('assetRoots must be absolute.');
  for (const key of ['minBodyChars', 'maxBodyChars', 'maxDailyDrafts', 'maxReviewCallsPerDay', 'maxReviewAttempts', 'reviewTimeoutMs']) {
    const schema = manifest.configSchema.properties[key];
    if (!Number.isInteger(config[key]) || config[key] < schema.minimum || config[key] > schema.maximum) {
      throw new Error('Invalid ' + key + '.');
    }
  }
  if (config.minBodyChars > config.maxBodyChars) throw new Error('minBodyChars cannot exceed maxBodyChars.');
  for (const value of [config.requireBodyImage, config.enableReview, config.preview.enabled, config.notification.enabled]) {
    if (typeof value !== 'boolean') throw new Error('Enable flags must be booleans.');
  }
  if (!Array.isArray(config.approvers) || config.approvers.some((approver) =>
    ['agentId', 'channel', 'accountId', 'senderId'].some((key) => typeof approver[key] !== 'string' || !approver[key]))) {
    throw new Error('Approvers must identify an agent, channel, account and sender.');
  }
  new Intl.DateTimeFormat('en', { timeZone: config.timeZone }).format();
  if (!Number.isInteger(config.preview.port) || config.preview.port < 1024 || config.preview.port > 65535 ||
      !/^[A-Z_][A-Z0-9_]*$/.test(config.preview.passwordEnv) ||
      typeof config.preview.username !== 'string' || !config.preview.username || config.preview.username.includes(':')) {
    throw new Error('Invalid preview settings.');
  }
  if (config.preview.publicBaseUrl) {
    const url = new URL(publicUrl(config.preview.publicBaseUrl));
    if (url.protocol !== 'https:' || url.search || url.hash || url.pathname !== '/') {
      throw new Error('publicBaseUrl must be an HTTPS origin without a path, credentials or query.');
    }
    config.preview.publicBaseUrl = url.origin;
  }
  if (config.notification.enabled && (!config.preview.enabled || !config.preview.publicBaseUrl ||
      ['channel', 'accountId', 'to'].some((key) => typeof config.notification[key] !== 'string' || !config.notification[key]))) {
    throw new Error('Notifications require a private preview origin and an explicit channel, account and recipient.');
  }
  return config;
}
