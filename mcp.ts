// The Model Context Protocol surface at /mcp: JSON-RPC 2.0 over Streamable
// HTTP, modern era 2026-07-28. `server/discover` answers the server's
// identity, capabilities and supported revisions; `tools/list` offers the six
// tools github-mcp-server documents; `tools/call` runs them against the same
// in-memory store the REST and GraphQL surfaces use. A notification (no id)
// is answered 202 and ignored. A body that is not JSON is HTTP 400 with
// JSON-RPC -32700. An unknown tool is -32602, never HTTP 500.

import { HttpError, VIEWER_LOGIN } from './util.ts';
import {
  createIssue,
  createPullRequest,
  issueJson,
  pullJson,
  repoJson,
  squashMerge,
  type Store,
} from './store.ts';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const MCP_SERVER_NAME = 'makefun-github-forge';
export const MCP_SERVER_VERSION = '1.0.0';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

/** The tool table, built once: two tools/list calls must be byte-identical. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the token owner.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(text: string, structured: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}

function toolError(text: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

function loadRepo(store: Store, owner: unknown, repo: unknown): ReturnType<Store['getRepo']> {
  if (typeof owner !== 'string' || owner !== VIEWER_LOGIN) return undefined;
  if (typeof repo !== 'string') return undefined;
  return store.getRepo(owner, repo);
}

function missing(args: Record<string, unknown>, required: string[]): string | null {
  for (const name of required) {
    const value = args[name];
    if (value === undefined || value === null || value === '') return name;
  }
  return null;
}

/** Run one tool by name. Throws HttpError for store-level failures (422/404). */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const absent = missing(args, ['name']);
      if (absent !== null) return toolError(`create_repo: missing required argument "${absent}"`);
      const repo = store.createRepo(String(args.name), args.private === true, typeof args.description === 'string' ? args.description : '');
      const view = repoJson(repo);
      return toolResult(JSON.stringify(view), view);
    }
    case 'get_repo': {
      const absent = missing(args, ['owner', 'repo']);
      if (absent !== null) return toolError(`get_repo: missing required argument "${absent}"`);
      const repo = loadRepo(store, args.owner, args.repo);
      if (repo === undefined) return toolError(`get_repo: repository ${String(args.owner)}/${String(args.repo)} was not found`);
      const view = repoJson(repo);
      return toolResult(JSON.stringify(view), view);
    }
    case 'create_issue': {
      const absent = missing(args, ['owner', 'repo', 'title']);
      if (absent !== null) return toolError(`create_issue: missing required argument "${absent}"`);
      const repo = loadRepo(store, args.owner, args.repo);
      if (repo === undefined) return toolError(`create_issue: repository ${String(args.owner)}/${String(args.repo)} was not found`);
      const issue = createIssue(store, repo, String(args.title), typeof args.body === 'string' ? args.body : '');
      const view = issueJson(repo, issue);
      return toolResult(JSON.stringify(view), view);
    }
    case 'list_issues': {
      const absent = missing(args, ['owner', 'repo']);
      if (absent !== null) return toolError(`list_issues: missing required argument "${absent}"`);
      const repo = loadRepo(store, args.owner, args.repo);
      if (repo === undefined) return toolError(`list_issues: repository ${String(args.owner)}/${String(args.repo)} was not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number)
        .map((issue) => issueJson(repo, issue));
      return toolResult(JSON.stringify(list), { issues: list });
    }
    case 'create_pull_request': {
      const absent = missing(args, ['owner', 'repo', 'title', 'head', 'base']);
      if (absent !== null) return toolError(`create_pull_request: missing required argument "${absent}"`);
      const repo = loadRepo(store, args.owner, args.repo);
      if (repo === undefined) return toolError(`create_pull_request: repository ${String(args.owner)}/${String(args.repo)} was not found`);
      const pr = createPullRequest(store, repo, String(args.title), typeof args.body === 'string' ? args.body : '', String(args.head), String(args.base));
      const view = pullJson(repo, pr);
      return toolResult(JSON.stringify(view), view);
    }
    case 'merge_pull_request': {
      const absent = missing(args, ['owner', 'repo', 'pull_number']);
      if (absent !== null) return toolError(`merge_pull_request: missing required argument "${absent}"`);
      const repo = loadRepo(store, args.owner, args.repo);
      if (repo === undefined) return toolError(`merge_pull_request: repository ${String(args.owner)}/${String(args.repo)} was not found`);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pr = repo.pulls.get(number);
      if (pr === undefined) return toolError(`merge_pull_request: pull request #${String(number)} was not found`);
      const sha = squashMerge(repo, pr);
      const view = { number: pr.number, merged: true, sha, state: 'closed' };
      return toolResult(JSON.stringify(view), view);
    }
    default:
      return toolError(`unknown tool "${name}"`);
  }
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const SERVER_INFO = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };

function discoverResult(): Record<string, unknown> {
  return {
    supportedVersions: [MCP_PROTOCOL_VERSION, '2025-11-25'],
    capabilities: { tools: {} },
    serverInfo: { ...SERVER_INFO },
    _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
  };
}

/**
 * Handle one POST to /mcp. Returns {status, json} where json is null for a
 * notification answer (202, empty body). Throws HttpError(400) only for a
 * body that is not JSON at all (the -32700 parse error).
 */
export function handleMcp(store: Store, body: Buffer): { status: number; json: Record<string, unknown> | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, json: rpcError(null, -32700, 'Parse error') };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, json: rpcError(null, -32700, 'Parse error') };
  }
  const request = parsed as JsonRpcRequest;
  const id = request.id === undefined ? null : request.id;
  const method = request.method;
  // A notification (no id) is answered 202 and ignored.
  if (id === null && method !== undefined) {
    return { status: 202, json: null };
  }
  if (typeof method !== 'string') {
    return { status: 200, json: rpcError(id, -32600, 'Invalid Request') };
  }
  const params = request.params ?? {};
  switch (method) {
    case 'server/discover':
      return { status: 200, json: rpcResult(id, discoverResult()) };
    case 'initialize':
      // The legacy handshake, for a client that predates server/discover.
      return {
        status: 200,
        json: rpcResult(id, {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
        }),
      };
    case 'tools/list':
      return { status: 200, json: rpcResult(id, { tools: TOOLS }) };
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || name === '') {
        return { status: 200, json: rpcError(id, -32602, 'Invalid params: tools/call needs a tool name') };
      }
      if (!TOOLS.some((tool) => tool.name === name)) {
        return { status: 200, json: rpcError(id, -32602, `Unknown tool "${name}"`) };
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        return { status: 200, json: rpcError(id, -32602, 'Invalid params: arguments must be an object') };
      }
      try {
        const result = callTool(store, name, args);
        return { status: 200, json: rpcResult(id, result) };
      } catch (err) {
        if (err instanceof HttpError) {
          // A store refusal (422/404) is a tool execution error, not a
          // protocol error: the tool reports it with isError.
          return { status: 200, json: rpcResult(id, toolError(err.message)) };
        }
        throw err;
      }
    }
    case 'ping':
      return { status: 200, json: rpcResult(id, {}) };
    default:
      return { status: 200, json: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}
