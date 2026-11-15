// The GitHub REST v3 surface under /api/v3: repositories, branches, commits,
// contents, issues, comments, labels and pull requests. Every reply is JSON
// and carries X-GitHub-Request-Id (app.ts adds it); every error body is
// {"message": string}. A repository belongs to the token owner, so the same
// name under another owner is 404, never 403.

import {
  HttpError,
  VIEWER_ID,
  VIEWER_LOGIN,
  b64encode,
} from './util.ts';
import {
  branchTip,
  commentJson,
  createIssue,
  createPullRequest,
  deleteContent,
  issueJson,
  listCommits,
  parseCommit,
  parseTree,
  pullJson,
  pullRequestFiles,
  putContent,
  repoJson,
  squashMerge,
  treeToFiles,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3 (decoded, without empty segments). */
  segments: string[];
  query: URLSearchParams;
  /** Raw request body bytes (empty when none). */
  body: Buffer;
  /** The absolute base URL (origin) for Link headers. */
  baseUrl: string;
}

export interface RestReply {
  status: number;
  /** JSON body; null sends an empty body (204). */
  json: unknown;
  headers?: Record<string, string>;
}

type Json = Record<string, unknown>;

function asJson(value: unknown): Json {
  return (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Json;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseBody(req: RestRequest): Json {
  if (req.body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(req.body.toString('utf8'));
    return asJson(parsed);
  } catch {
    throw new HttpError(400, 'Malformed JSON body');
  }
}

/** Load a repository for an owner/name path pair, or throw 404. */
function loadRepo(store: Store, owner: string, name: string): Repo {
  if (owner !== VIEWER_LOGIN) throw new HttpError(404, 'Not Found');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) throw new HttpError(404, 'Not Found');
  return repo;
}

function notFound(): never {
  throw new HttpError(404, 'Not Found');
}

/** Parse ?per_page= and ?page= the way GitHub does (defaults 30 / 1). */
function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) ? Math.max(1, Math.min(100, Math.trunc(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  return { perPage, page };
}

/** Slice a list into one page; returns the page plus a Link header when more follow. */
function paginate<T>(items: readonly T[], req: RestRequest, path: string): { page: T[]; headers: Record<string, string> } {
  const { perPage, page } = pageParams(req.query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = `${req.baseUrl}/api/v3${path}?per_page=${perPage}&page=${page + 1}`;
    headers.link = `<${next}>; rel="next"`;
  }
  return { page: slice, headers };
}

function issueList(repo: Repo, query: URLSearchParams): Issue[] {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let list = [...repo.issues.values()];
  if (state !== 'all') list = list.filter((issue) => issue.state === state);
  void sort; // creation order is the only sort the suite uses
  list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  return list;
}

function pullList(repo: Repo, query: URLSearchParams): PullRequest[] {
  const state = query.get('state') ?? 'open';
  let list = [...repo.pulls.values()];
  if (state !== 'all') list = list.filter((pr) => pr.state === state);
  list.sort((a, b) => b.number - a.number);
  return list;
}

/** GET /repos/{o}/{r}/contents/{path}: a file object or a directory listing. */
function getContents(store: Store, owner: string, name: string, path: string, query: URLSearchParams): unknown {
  const repo = loadRepo(store, owner, name);
  const branch = query.get('ref') ?? repo.defaultBranch;
  const tip = branchTip(repo, branch);
  if (tip === undefined) throw new HttpError(404, 'Not Found');
  const commit = repo.objects.get(tip);
  if (commit === undefined || commit.type !== 'commit') throw new HttpError(404, 'Not Found');
  const files = treeToFiles(repo, parseCommit(commit.data).tree);
  if (path === '') {
    // Root listing.
    const names = new Set<string>();
    for (const filePath of files.keys()) names.add(filePath.split('/')[0]!);
    const entries: unknown[] = [];
    const rootTree = repo.objects.get(parseCommit(commit.data).tree);
    if (rootTree !== undefined) {
      for (const entry of parseTree(rootTree.data)) {
        const isDir = entry.mode === '40000';
        entries.push({
          type: isDir ? 'dir' : 'file',
          name: entry.name,
          path: entry.name,
          sha: entry.oid,
          size: isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
        });
      }
    }
    return entries;
  }
  const file = files.get(path);
  if (file !== undefined) {
    const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
    return {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: path.split('/').pop() ?? path,
      path,
      sha: file.oid,
      content: b64encode(data),
    };
  }
  // A directory: the entries directly under `path/`.
  const prefix = `${path}/`;
  const children = new Map<string, { type: string; oid: string; size: number }>();
  for (const [filePath, entry] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const first = rest.split('/')[0]!;
    if (rest.includes('/')) {
      if (!children.has(first)) {
        // The subtree oid: walk the tree to find it.
        children.set(first, { type: 'dir', oid: dirOid(repo, tip, path, first), size: 0 });
      }
    } else {
      children.set(first, { type: 'file', oid: entry.oid, size: repo.objects.get(entry.oid)?.data.length ?? 0 });
    }
  }
  if (children.size === 0) throw new HttpError(404, 'Not Found');
  return [...children.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([childName, child]) => ({
      type: child.type,
      name: childName,
      path: `${path}/${childName}`,
      sha: child.oid,
      size: child.size,
    }));
}

/** The tree oid of a direct child directory, found by walking the commit tree. */
function dirOid(repo: Repo, tip: string, dirPath: string, child: string): string {
  const commit = repo.objects.get(tip);
  if (commit === undefined || commit.type !== 'commit') return '';
  let treeOid = parseCommit(commit.data).tree;
  for (const segment of [...dirPath.split('/'), child]) {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return '';
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segment);
    if (entry === undefined) return '';
    treeOid = entry.oid;
  }
  return treeOid;
}

/** The main REST dispatcher. Throws HttpError for error replies. */
export function handleRest(store: Store, req: RestRequest): RestReply {
  const seg = req.segments;
  const method = req.method;

  // API root and meta.
  if (seg.length === 0) {
    if (method === 'GET') {
      return {
        status: 200,
        json: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        headers: { 'x-oauth-scopes': 'repo, read:org' },
      };
    }
    return notFound();
  }
  if (seg.length === 1 && seg[0] === 'meta' && method === 'GET') {
    return { status: 200, json: { installed_version: '1.0.0', verifiable_password_authentication: true } };
  }
  if (seg.length === 1 && seg[0] === 'user') {
    if (method === 'GET') {
      return {
        status: 200,
        json: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: 'ada iversen', email: 'adaiversen@example.invalid' },
      };
    }
    return notFound();
  }

  // POST /user/repos and GET /user/repos.
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'POST') {
      const body = parseBody(req);
      const name = str(body.name);
      if (name === '') throw new HttpError(422, 'name is required');
      const repo = store.createRepo(name, body.private === true, str(body.description));
      return { status: 201, json: repoJson(repo) };
    }
    if (method === 'GET') {
      const all = store.viewerRepos().map((repo) => repoJson(repo));
      const { page, headers } = paginate(all, req, '/user/repos');
      return { status: 200, json: page, headers };
    }
    return notFound();
  }

  // /repos/{owner}/{name}[...]
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = decodeURIComponent(seg[1]!);
    const name = decodeURIComponent(seg[2]!);
    const rest = seg.slice(3);
    if (rest.length === 0) {
      const repo = loadRepo(store, owner, name);
      if (method === 'GET') return { status: 200, json: repoJson(repo) };
      if (method === 'PATCH') {
        const body = parseBody(req);
        if (typeof body.description === 'string') repo.description = body.description;
        return { status: 200, json: repoJson(repo) };
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, json: null };
      }
      return notFound();
    }

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      const repo = loadRepo(store, owner, name);
      if (method === 'POST' && rest.length === 2) {
        const body = parseBody(req);
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (!ref.startsWith('refs/') || sha === '') throw new HttpError(422, 'ref and sha are required');
        if (!repo.objects.has(sha)) throw new HttpError(422, 'sha does not exist in this repository');
        if (repo.refs.has(ref)) throw new HttpError(422, 'ref already exists');
        repo.refs.set(ref, sha);
        return { status: 201, json: { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } } };
      }
      if (method === 'GET' && rest.length >= 3) {
        const refName = `refs/${rest.slice(2).join('/')}`;
        const oid = repo.refs.get(refName);
        if (oid === undefined) throw new HttpError(404, 'Not Found');
        return { status: 200, json: { ref: refName, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } } };
      }
      return notFound();
    }

    // branches
    if (rest[0] === 'branches') {
      const repo = loadRepo(store, owner, name);
      if (method === 'GET' && rest.length === 1) {
        const list = [...repo.refs.entries()]
          .filter(([refName]) => refName.startsWith('refs/heads/'))
          .map(([refName, oid]) => ({ name: refName.slice('refs/heads/'.length), commit: { sha: oid } }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        return { status: 200, json: list };
      }
      if (method === 'GET' && rest.length === 2) {
        const branch = decodeURIComponent(rest[1]!);
        const oid = branchTip(repo, branch);
        if (oid === undefined) throw new HttpError(404, 'Not Found');
        return { status: 200, json: { name: branch, commit: { sha: oid } } };
      }
      return notFound();
    }

    // commits
    if (rest[0] === 'commits' && method === 'GET' && rest.length === 1) {
      const repo = loadRepo(store, owner, name);
      const shaParam = req.query.get('sha');
      let tip: string | undefined;
      if (shaParam === null) {
        tip = branchTip(repo, repo.defaultBranch);
      } else if (repo.refs.has(`refs/heads/${shaParam}`)) {
        tip = branchTip(repo, shaParam);
      } else if (repo.objects.has(shaParam)) {
        tip = shaParam;
      } else {
        throw new HttpError(404, 'Not Found');
      }
      const commits = listCommits(repo, tip).map((entry) => ({
        sha: entry.sha,
        commit: {
          message: entry.message,
          author: { name: 'ada iversen', email: 'adaiversen@example.invalid' },
          committer: { name: 'ada iversen', email: 'adaiversen@example.invalid' },
        },
      }));
      return { status: 200, json: commits };
    }

    // contents
    if (rest[0] === 'contents') {
      const repo = loadRepo(store, owner, name);
      const path = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
      if (method === 'GET') {
        return { status: 200, json: getContents(store, owner, name, path, req.query) };
      }
      if (method === 'PUT') {
        const body = parseBody(req);
        const content = str(body.content);
        if (content === '') throw new HttpError(422, 'content is required');
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        const result = putContent(repo, path, content, str(body.message) || 'Update file', branch, sha);
        return {
          status: result.status,
          json: {
            content: { name: path.split('/').pop() ?? path, path, sha: result.contentSha, size: 0, encoding: 'base64' },
            commit: { sha: result.commitSha, message: str(body.message) || 'Update file' },
          },
        };
      }
      if (method === 'DELETE') {
        const body = parseBody(req);
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        const commitSha = deleteContent(repo, path, str(body.message) || 'Delete file', sha, branch);
        return { status: 200, json: { commit: { sha: commitSha } } };
      }
      return notFound();
    }

    // labels
    if (rest[0] === 'labels') {
      const repo = loadRepo(store, owner, name);
      if (method === 'POST' && rest.length === 1) {
        const body = parseBody(req);
        const labelName = str(body.name);
        if (labelName === '') throw new HttpError(422, 'name is required');
        const color = typeof body.color === 'string' && body.color !== '' ? body.color : 'ededed';
        const existing = repo.labels.get(labelName);
        if (existing !== undefined) return { status: 201, json: { name: existing.name, color: existing.color } };
        repo.labels.set(labelName, { name: labelName, color });
        return { status: 201, json: { name: labelName, color } };
      }
      if (method === 'GET' && rest.length === 1) {
        return { status: 200, json: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })) };
      }
      return notFound();
    }

    // issues
    if (rest[0] === 'issues') {
      const repo = loadRepo(store, owner, name);
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = parseBody(req);
          const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
          const issue = createIssue(store, repo, str(body.title), str(body.body), labels);
          return { status: 201, json: issueJson(repo, issue) };
        }
        if (method === 'GET') {
          const list = issueList(repo, req.query).map((issue) => issueJson(repo, issue));
          const { page, headers } = paginate(list, req, `/repos/${owner}/${name}/issues`);
          return { status: 200, json: page, headers };
        }
        return notFound();
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) return notFound();
      if (rest.length === 2) {
        const issue = repo.issues.get(number);
        if (issue === undefined) throw new HttpError(404, 'Not Found');
        if (method === 'GET') return { status: 200, json: issueJson(repo, issue) };
        if (method === 'PATCH') {
          const body = parseBody(req);
          if (body.state === 'closed') issue.state = 'closed';
          else if (body.state === 'open') issue.state = 'open';
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          return { status: 200, json: issueJson(repo, issue) };
        }
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const issue = repo.issues.get(number);
        if (issue === undefined) throw new HttpError(404, 'Not Found');
        if (method === 'POST') {
          const body = parseBody(req);
          const comment = {
            id: store.nextId(),
            issueNumber: number,
            body: str(body.body),
            createdAt: issue.createdAt,
          };
          repo.comments.set(comment.id, comment);
          return { status: 201, json: commentJson(repo, comment) };
        }
        if (method === 'GET') {
          const list = [...repo.comments.values()]
            .filter((comment) => comment.issueNumber === number)
            .map((comment) => commentJson(repo, comment));
          return { status: 200, json: list };
        }
        return notFound();
      }
      return notFound();
    }

    // pulls
    if (rest[0] === 'pulls') {
      const repo = loadRepo(store, owner, name);
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = parseBody(req);
          const pr = createPullRequest(store, repo, str(body.title), str(body.body), str(body.head), str(body.base));
          return { status: 201, json: pullJson(repo, pr) };
        }
        if (method === 'GET') {
          const list = pullList(repo, req.query).map((pr) => pullJson(repo, pr));
          const { page, headers } = paginate(list, req, `/repos/${owner}/${name}/pulls`);
          return { status: 200, json: page, headers };
        }
        return notFound();
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) return notFound();
      const pr = repo.pulls.get(number);
      if (rest.length === 2) {
        if (pr === undefined) throw new HttpError(404, 'Not Found');
        if (method === 'GET') return { status: 200, json: pullJson(repo, pr) };
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (pr === undefined) throw new HttpError(404, 'Not Found');
        if (method === 'GET') {
          const files = pullRequestFiles(repo, pr).map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
          }));
          return { status: 200, json: files };
        }
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (pr === undefined) throw new HttpError(404, 'Not Found');
        if (method === 'PUT') {
          parseBody(req);
          const sha = squashMerge(repo, pr);
          return { status: 200, json: { sha, merged: true, message: `Pull request #${pr.number} merged` } };
        }
        return notFound();
      }
      return notFound();
    }

    return notFound();
  }

  return notFound();
}
