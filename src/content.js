import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function text(value, name, max = 10000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new Error(name + ' must be non-empty text (maximum ' + max + ' characters).');
  }
  return value.trim();
}

export function publicUrl(value) {
  const url = new URL(text(value, 'source URL', 2048));
  const hostname = url.hostname.toLowerCase();
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      !hostname.includes('.') || isIP(hostname.replace(/^\[|\]$/g, '')) ||
      /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(hostname) ||
      [...url.searchParams.keys()].some((key) => /^(access[-_]?token|api[-_]?key|token|auth(?:orization)?|signature|x-amz-signature|password|secret)$/i.test(key))) {
    throw new Error('Sources must use public HTTP(S) DNS names without credentials.');
  }
  return url.href;
}

export function importImage(input, roots) {
  const id = text(input.id, 'asset id', 80);
  const requested = path.resolve(text(input.path, 'asset path', 4096));
  const resolved = realpathSync(requested);
  const allowed = roots.some((root) => {
    const relative = path.relative(realpathSync(root), resolved);
    return relative !== '' && !relative.startsWith('..' + path.sep) &&
      relative !== '..' && !path.isAbsolute(relative);
  });
  if (!allowed) throw new Error('Asset is outside an allowed root.');
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Image must be a file no larger than 8 MiB.');
    bytes = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  let extension;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) extension = 'png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) extension = 'jpg';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') extension = 'webp';
  if (!extension) throw new Error('Only PNG, JPEG and WebP images are accepted; SVG/HTML are not accepted.');
  if (!['screenshot', 'illustration'].includes(input.kind)) throw new Error('Asset kind must be screenshot or illustration.');
  if (input.role !== undefined && !['cover', 'body'].includes(input.role)) throw new Error('Asset role must be cover or body.');
  const asset = {
    id, file: hash(bytes) + '.' + extension, sha256: hash(bytes),
    alt: text(input.alt, 'image description', 500), kind: input.kind,
    role: input.role === 'cover' ? 'cover' : 'body',
  };
  if (input.sourceId) asset.sourceId = text(input.sourceId, 'image source id', 80);
  if (input.kind === 'screenshot') {
    if (!asset.sourceId || !Number.isFinite(Date.parse(input.capturedAt))) {
      throw new Error('Screenshots require a sourceId and a valid capturedAt timestamp.');
    }
    asset.capturedAt = new Date(input.capturedAt).toISOString();
  }
  return { asset, bytes };
}

export function normalizeDocument(input, importedAssets) {
  const sourceIds = new Set();
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 40) {
    throw new Error('Provide between 1 and 40 sources.');
  }
  const sources = input.sources.map((source) => {
    const id = text(source.id, 'source id', 80);
    if (sourceIds.has(id)) throw new Error('Source IDs must be unique.');
    sourceIds.add(id);
    if (!Number.isFinite(Date.parse(source.checkedAt))) throw new Error('Each source needs a valid checkedAt timestamp.');
    if (!['primary', 'secondary'].includes(source.kind)) throw new Error('Source kind must be primary or secondary.');
    return {
      id, url: publicUrl(source.url), title: text(source.title, 'source title', 300),
      checkedAt: new Date(source.checkedAt).toISOString(), kind: source.kind,
      excerpt: text(source.excerpt, 'source evidence excerpt', 5000),
    };
  });
  const assets = importedAssets.map((item) => item.asset);
  const assetIds = new Set(assets.map((asset) => asset.id));
  if (assetIds.size !== assets.length) throw new Error('Asset IDs must be unique.');
  for (const asset of assets) {
    if (asset.sourceId && !sourceIds.has(asset.sourceId)) throw new Error('Image references an unknown source.');
  }
  if (!Array.isArray(input.blocks) || input.blocks.length < 1 || input.blocks.length > 150) {
    throw new Error('Provide between 1 and 150 content blocks.');
  }
  const blocks = input.blocks.map((block) => {
    switch (block.type) {
      case 'heading': return { type: 'heading', text: text(block.text, 'heading', 300) };
      case 'paragraph': return { type: 'paragraph', text: text(block.text, 'paragraph', 12000) };
      case 'code': return { type: 'code', text: text(block.text, 'code', 16000) };
      case 'list':
        if (!Array.isArray(block.items) || block.items.length < 1 || block.items.length > 40) throw new Error('A list needs 1–40 items.');
        return { type: 'list', items: block.items.map((item) => text(item, 'list item', 2000)) };
      case 'image':
        if (!assetIds.has(block.assetId)) throw new Error('Image block references an unknown asset.');
        return { type: 'image', assetId: block.assetId };
      default: throw new Error('Unknown content block type.');
    }
  });
  if (!Array.isArray(input.claims) || input.claims.length < 1 || input.claims.length > 60) {
    throw new Error('Provide 1–60 material claims linked to evidence.');
  }
  const claims = input.claims.map((claim) => {
    if (!Array.isArray(claim.sourceIds) || !claim.sourceIds.length ||
        claim.sourceIds.some((id) => !sourceIds.has(id))) throw new Error('Claims must reference existing sources.');
    return { text: text(claim.text, 'claim', 2000), sourceIds: [...new Set(claim.sourceIds)] };
  });
  return {
    title: text(input.title, 'title', 200), summary: text(input.summary, 'summary', 1000),
    language: text(input.language, 'language', 80), platform: text(input.platform ?? 'generic', 'platform', 80),
    blocks, sources, claims, assets,
  };
}

export function checkDocument(document, config) {
  const findings = [];
  const body = document.blocks.filter((block) => ['paragraph', 'heading', 'list'].includes(block.type))
    .map((block) => block.text ?? block.items.join('\n')).join('\n');
  const count = [...body.replace(/\s/g, '')].length;
  if (count < config.minBodyChars || count > config.maxBodyChars) findings.push('Body character count is outside the configured range.');
  if (!document.sources.some((source) => source.kind === 'primary')) findings.push('At least one primary source is required.');
  if (document.sources.some((source) => Date.parse(source.checkedAt) > Date.now() + 300000)) findings.push('Source verification timestamps cannot be in the future.');
  if (config.requireBodyImage && !document.blocks.some((block) => block.type === 'image' &&
      document.assets.find((asset) => asset.id === block.assetId)?.role === 'body')) findings.push('A body image is required; a cover does not count.');
  return { pass: findings.length === 0, bodyChars: count, findings };
}

export function renderHtml(document, { assetPrefix = 'assets/', status = 'draft', version = 1 } = {}) {
  const image = (asset) => '<figure><img src="' + escapeHtml(assetPrefix + asset.file) + '" alt="' +
    escapeHtml(asset.alt) + '"><figcaption>' + escapeHtml(asset.alt) + ' · ' +
    (asset.kind === 'illustration' ? 'Illustration; not a test result' : 'Source screenshot') + '</figcaption></figure>';
  const body = document.blocks.map((block) => {
    if (block.type === 'image') return image(document.assets.find((asset) => asset.id === block.assetId));
    if (block.type === 'list') return '<ul>' + block.items.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>';
    if (block.type === 'code') return '<pre><code>' + escapeHtml(block.text) + '</code></pre>';
    const tag = block.type === 'heading' ? 'h2' : 'p';
    return '<' + tag + '>' + escapeHtml(block.text).replace(/\n/g, '<br>') + '</' + tag + '>';
  }).join('\n');
  const sources = document.sources.map((source) => '<li><a href="' + escapeHtml(source.url) +
    '" rel="noreferrer noopener">' + escapeHtml(source.title) + '</a> · ' + escapeHtml(source.checkedAt) + '</li>').join('');
  return '<!doctype html><html lang="' + escapeHtml(document.language) + '"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">' +
    '<title>' + escapeHtml(document.title) + '</title><style>body{max-width:760px;margin:auto;padding:24px;font:17px/1.85 system-ui,sans-serif;color:#20252b;background:#fff}h1,h2{line-height:1.4}p,li{overflow-wrap:anywhere}img{max-width:100%;height:auto}figure{margin:24px 0}figcaption,aside{font-size:13px;color:#5b6470}pre{overflow:auto;background:#f4f6f8;padding:16px;border-radius:8px}a{color:#185abd}aside{border-bottom:1px solid #ddd;padding-bottom:12px}</style></head><body>' +
    '<aside>v' + version + ' · ' + escapeHtml(status) + ' · Manual publication only</aside><article><h1>' + escapeHtml(document.title) + '</h1>' +
    document.assets.filter((asset) => asset.role === 'cover').map(image).join('') + body +
    '<h2>Sources</h2><ol>' + sources + '</ol></article></body></html>';
}

export function renderMarkdown(document) {
  const plain = (value) => escapeHtml(value).replace(/([\\[\]*_#>!|~\x60])/g, '\\$1');
  return '# ' + plain(document.title) + '\n\n' + document.blocks.map((block) => {
    if (block.type === 'heading') return '## ' + plain(block.text);
    if (block.type === 'list') return block.items.map((item) => '- ' + plain(item)).join('\n');
    if (block.type === 'code') {
      const runs = block.text.match(/~+/g) ?? [];
      const fence = '~'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
      return fence + '\n' + block.text + '\n' + fence;
    }
    if (block.type === 'image') {
      const asset = document.assets.find((item) => item.id === block.assetId);
      return '![' + plain(asset.alt) + '](assets/' + asset.file + ')\n\n' +
        (asset.kind === 'illustration' ? '*Illustration; not a test result.*' : '*Source screenshot.*');
    }
    return plain(block.text);
  }).join('\n\n') + '\n\n## Sources\n\n' + document.sources.map((source) => '- [' + plain(source.title) + '](<' +
    source.url.replace(/[<>\\\s]/g, (char) => encodeURIComponent(char)) + '>) (' + source.checkedAt + ')').join('\n') + '\n';
}
