import { timingSafeEqual, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { renderHtml } from './content.js';

const digest = (value) => createHash('sha256').update(value).digest();

export function createPreviewHandler(studio, password) {
  if (typeof password !== 'string' || password.length < 24 || password.includes('\0')) {
    throw new Error('Private preview requires an environment password of at least 24 characters.');
  }
  const expected = digest(studio.config.preview.username + ':' + password);
  return (request, response) => {
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const authorization = request.headers.authorization;
    const encoded = typeof authorization === 'string' && authorization.startsWith('Basic ') ? authorization.slice(6) : '';
    const supplied = encoded.length <= 4096 ? Buffer.from(encoded, 'base64').toString('utf8') : '';
    if (!timingSafeEqual(digest(supplied), expected)) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Creator Studio", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Authentication required.');
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    const match = /^\/a\/(cs-[a-f0-9]{20})\/v\/([1-9][0-9]*)(?:\/assets\/([a-f0-9]{64}\.(png|jpg|webp)))?$/.exec(request.url ?? '');
    if (!match || !Number.isSafeInteger(Number(match[2]))) {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const [, id, rawVersion, filename, extension] = match;
      const article = studio.store.get(studio.store.owner(id), id, Number(rawVersion));
      if (!studio.config.allowedAgents.includes(article.agentId)) throw new Error('Agent disabled.');
      if (!filename) studio.store.verify(article);
      const bytes = filename
        ? studio.store.assetBytes(article, filename)
        : Buffer.from(renderHtml(article.document, {
          version: article.version,
          status: article.version === article.currentVersion ? article.state : 'superseded',
          assetPrefix: '/a/' + id + '/v/' + article.version + '/assets/',
        }));
      response.writeHead(200, {
        'Content-Type': filename ? ({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' })[extension] : 'text/html; charset=utf-8',
        'Content-Length': bytes.length,
      });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch {
      response.writeHead(404);
      response.end();
    }
  };
}

export async function startPreview(studio, password) {
  const server = createServer(createPreviewHandler(studio, password));
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxRequestsPerSocket = 100;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(studio.config.preview.port, '127.0.0.1', resolve);
  });
  return server;
}
