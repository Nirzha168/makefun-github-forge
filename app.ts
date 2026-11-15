// The forge's HTTP server: one process, one in-memory store, stdlib only.
// Routes:
//   GET  /healthz                    the env's boot probe (no auth)
//   /api/v3/*                        GitHub REST v3 (Bearer auth)
//   POST /api/graphql                GraphQL v4, single or batched (Bearer auth)
//   POST /mcp                        MCP JSON-RPC 2.0, modern 2026-07-28 (Bearer auth)
//   /{owner}/{repo}.git/info/refs    git smart-HTTP advertisements (no auth)
//   /{owner}/{repo}.git/git-upload-pack | git-receive-pack (no auth)
// Everything else is a JSON 404. Every reply carries X-GitHub-Request-Id
// (an incrementing counter: no wall clock, no unseeded randomness anywhere).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HttpError, VIEWER_LOGIN } from './util.ts';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQLBody } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  applyPush,
  fetchV0Response,
  fetchV2Response,
  lsRefsResponse,
  parseReceivePack,
  parseUploadPackV0,
  parseUploadPackV2,
  pushReportResponse,
  v0Advertisement,
  v2Advertisement,
} from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

interface RouteContext {
  store: Store;
  token: string;
  requestCount: number;
}

function nextRequestId(ctx: RouteContext): string {
  ctx.requestCount += 1;
  return `req-${ctx.requestCount}`;
}

function sendJson(ctx: RouteContext, res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(ctx),
    ...headers,
  });
  res.end(text);
}

function sendRaw(ctx: RouteContext, res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(ctx),
  });
  res.end(body);
}

function sendEmpty(ctx: RouteContext, res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId(ctx), 'content-length': 0 });
  res.end();
}

/** The bearer token this request carries, or null. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match === null ? null : match[1]!;
}

/** True when the request is authorized for the API surfaces. */
function authorized(ctx: RouteContext, req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (ctx.token === '') return true;
  return token === ctx.token;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathSegments(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment !== '');
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The repository a git path names, or null when the owner/repo does not exist. */
function gitRepo(ctx: RouteContext, owner: string, repoName: string): ReturnType<Store['getRepo']> {
  if (owner !== VIEWER_LOGIN) return undefined;
  return ctx.store.getRepo(owner, repoName);
}

async function handleGit(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams): Promise<void> {
  const method = req.method ?? 'GET';
  const owner = decodeSegment(segments[0]!);
  const repoName = decodeSegment(segments[1]!).replace(/\.git$/, '');
  const repo = gitRepo(ctx, owner, repoName);
  if (repo === undefined) {
    sendJson(ctx, res, 404, { message: 'Not Found' });
    return;
  }
  const tail = segments.slice(2);
  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      if ((req.headers['git-protocol'] ?? '') === 'version=2') {
        sendRaw(ctx, res, 200, v2Advertisement(repo), 'application/x-git-upload-pack-advertisement');
      } else {
        sendRaw(ctx, res, 200, v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      }
      return;
    }
    if (service === 'git-receive-pack') {
      sendRaw(ctx, res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendJson(ctx, res, 400, { message: 'service is required' });
    return;
  }
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    const body = await readBody(req);
    try {
      if ((req.headers['git-protocol'] ?? '') === 'version=2') {
        const parsed = parseUploadPackV2(body);
        if (parsed.command === 'ls-refs') {
          sendRaw(ctx, res, 200, lsRefsResponse(repo, parsed.lsRefs), 'application/x-git-upload-pack-result');
        } else if (parsed.command === 'fetch') {
          sendRaw(ctx, res, 200, fetchV2Response(repo, parsed.fetch), 'application/x-git-upload-pack-result');
        } else {
          sendJson(ctx, res, 400, { message: `unknown upload-pack command "${parsed.command}"` });
        }
      } else {
        const args = parseUploadPackV0(body);
        sendRaw(ctx, res, 200, fetchV0Response(repo, args), 'application/x-git-upload-pack-result');
      }
    } catch {
      // A malformed upload-pack POST must not crash the server.
      sendJson(ctx, res, 400, { message: 'Malformed upload-pack request' });
    }
    return;
  }
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    const body = await readBody(req);
    try {
      const { commands, pack } = parseReceivePack(body);
      const result = applyPush(repo, commands, pack);
      sendRaw(ctx, res, 200, pushReportResponse(result), 'application/x-git-receive-pack-result');
    } catch {
      sendJson(ctx, res, 400, { message: 'Malformed receive-pack request' });
    }
    return;
  }
  sendJson(ctx, res, 404, { message: 'Not Found' });
}

async function handleRequest(ctx: RouteContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(ctx, res, 400, { message: 'Bad Request' });
    return;
  }
  const segments = pathSegments(url.pathname);

  // The env's boot check calls this twice: 200 {"ok":true}.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    sendJson(ctx, res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
    await handleGit(ctx, req, res, segments, url.searchParams);
    return;
  }

  // The API surfaces need a bearer token.
  if (
    (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') ||
    (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') ||
    (segments.length === 1 && segments[0] === 'mcp')
  ) {
    if (!authorized(ctx, req)) {
      sendJson(ctx, res, 401, { message: 'Requires authentication' });
      return;
    }
  }

  // REST v3.
  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    const host = req.headers.host ?? '127.0.0.1';
    const reply = handleRest(ctx.store, {
      method,
      segments: segments.slice(2).map(decodeSegment),
      query: url.searchParams,
      body,
      baseUrl: `http://${host}`,
    });
    if (reply.json === null) {
      sendEmpty(ctx, res, reply.status);
      return;
    }
    sendJson(ctx, res, reply.status, reply.json, reply.headers ?? {});
    return;
  }

  // GraphQL v4.
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    if (method !== 'POST') {
      sendJson(ctx, res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const body = await readBody(req);
    const result = handleGraphQLBody(ctx.store, body);
    sendJson(ctx, res, 200, result);
    return;
  }

  // MCP.
  if (segments.length === 1 && segments[0] === 'mcp') {
    if (method !== 'POST') {
      sendJson(ctx, res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const body = await readBody(req);
    const { status, json } = handleMcp(ctx.store, body);
    if (json === null) {
      sendEmpty(ctx, res, status);
      return;
    }
    sendJson(ctx, res, status, json);
    return;
  }

  sendJson(ctx, res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const ctx: RouteContext = {
    store: new Store(),
    token: process.env.MAKEFUN_SHOP_TOKEN ?? '',
    requestCount: 0,
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // A client that disconnects mid-response must not crash the process
    // (an EPIPE on the socket is an ordinary event, not a server error).
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    handleRequest(ctx, req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        if (!res.headersSent) sendJson(ctx, res, err.status, { message: err.message });
        return;
      }
      process.stderr.write(`[entry] unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) sendJson(ctx, res, 500, { message: 'Internal Server Error' });
    });
  });
  server.on('connection', (socket) => socket.setNoDelay(true));
  return server;
}
