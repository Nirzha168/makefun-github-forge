// The forge's in-memory store: repositories, git objects and refs, issues,
// pull requests, labels and comments. Everything lives in memory, in request
// order, with no clock and no randomness, so two runs of one trial hold
// identical state.
//
// A repository's git state is a plain object store (oid -> {type, data}) plus
// a ref map. The REST contents API and the git smart-HTTP surface share it:
// a commit made through PUT /contents is a real git commit object that a
// later clone fetches, and a push through receive-pack moves the same refs
// the REST branch reads see.

import {
  DEFAULT_BRANCH,
  HttpError,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  ZERO_OID,
  b64decode,
  b64encode,
  globalId,
  hashObject,
  isOid,
  trialNowEpoch,
  trialNowIso,
} from './util.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagView {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export interface IssueComment {
  id: number;
  issueNumber: number;
  body: string;
  createdAt: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  /** The base branch tip when the pull request was opened. */
  baseSha: string;
  createdAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  comments: Map<number, IssueComment>;
  pulls: Map<number, PullRequest>;
  /** Shared issue + pull-request numbering, GitHub style. */
  nextNumber: number;
  nextCommentId: number;
}

/** The whole forge: every repository the trial created, by `owner/name`. */
export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextObjectId = 100000;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** The viewer's repositories, in creation order. */
  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    return out;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const existing = this.getRepo(VIEWER_LOGIN, name);
    if (existing !== undefined) throw new HttpError(422, 'Repository already exists');
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER_LOGIN,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: trialNowIso(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      comments: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** A fresh numeric id for a REST object (issue, comment, pull request). */
  nextId(): number {
    const id = this.nextObjectId;
    this.nextObjectId += 1;
    return id;
  }
}

// ---------------------------------------------------------------------------------------------
// Object model: hashing, parsing, building, reachability
// ---------------------------------------------------------------------------------------------

export function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new HttpError(500, 'corrupt tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  // The stored message ends with the newline git appends; the API presents it
  // without the trailing newline(s), so a stored 'Tidy issue pagination\n'
  // reads back as 'Tidy issue pagination'.
  const rawMessage = blank < 0 ? '' : text.slice(blank + 2);
  const message = rawMessage.replace(/[\r\n]+$/, '');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const fields = new Map<string, string>();
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) fields.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: fields.get('object') ?? '',
    type: (fields.get('type') ?? 'commit') as ObjectType,
    tag: fields.get('tag') ?? '',
    tagger: fields.get('tagger') ?? '',
    message,
  };
}

/** Build a commit object's bytes with the viewer's identity and the trial clock. */
export function buildCommitBytes(tree: string, parents: readonly string[], message: string): Buffer {
  const epoch = trialNowEpoch();
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const body = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${body}`, 'utf8');
}

/**
 * Every object reachable from `roots`, following commits, tags and trees.
 * Commits in `stopAt` are included with their tree closure, but their
 * parents are not followed: a shallow client's boundary commit is held, its
 * ancestors are not, so they must not count as already-held.
 */
export function collectReachable(repo: Repo, roots: Iterable<string>, stopAt?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root) && root !== ZERO_OID) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (stopAt === undefined || !stopAt.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` (or they are equal). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** The peeled commit of a ref target: a tag object resolves to its target commit. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Trees as file maps
// ---------------------------------------------------------------------------------------------

export interface FileEntry {
  oid: string;
  mode: string;
}

/** The flat file map of a tree: `path` -> blob. */
export function treeToFiles(repo: Repo, treeOid: string): Map<string, FileEntry> {
  const files = new Map<string, FileEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else files.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return files;
}

/** Build (and store) the tree objects for a flat file map; returns the root tree oid. */
export function filesToTree(repo: Repo, files: Map<string, FileEntry>): string {
  interface Node {
    files: Map<string, FileEntry>;
    dirs: Map<string, Node>;
  }
  const makeNode = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = makeNode();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = makeNode();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The file map of a branch tip, or an empty map for an unborn branch. */
export function branchFiles(repo: Repo, branch: string): Map<string, FileEntry> {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return new Map();
  const commit = repo.objects.get(tip);
  if (commit === undefined || commit.type !== 'commit') return new Map();
  return treeToFiles(repo, parseCommit(commit.data).tree);
}

/** The tip commit oid of a branch, or undefined when unborn. */
export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Commit a new file map on a branch; returns the new commit oid. */
export function commitFiles(repo: Repo, branch: string, files: Map<string, FileEntry>, message: string): string {
  const tree = filesToTree(repo, files);
  const parents: string[] = [];
  const tip = branchTip(repo, branch);
  if (tip !== undefined) parents.push(tip);
  const commitOid = putObject(repo, 'commit', buildCommitBytes(tree, parents, message));
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

// ---------------------------------------------------------------------------------------------
// Contents API (REST): file reads and writes as real git commits
// ---------------------------------------------------------------------------------------------

export interface ContentPutResult {
  status: 200 | 201;
  commitSha: string;
  contentSha: string;
  created: boolean;
}

/**
 * PUT /contents: create or update one file on a branch. A create on an unborn
 * repository starts the branch; a write to a branch that does not exist yet
 * starts it from the default branch tip. An update needs the current blob sha
 * or it is a 409. Returns the new commit and blob shas.
 */
export function putContent(
  repo: Repo,
  path: string,
  contentB64: string,
  message: string,
  branch: string,
  sha?: string,
): ContentPutResult {
  const bytes = b64decode(contentB64);
  const blobSha = putObject(repo, 'blob', bytes);
  // The starting file map and parent: the branch itself, else the default
  // branch tip (a new branch starts from it), else empty (an unborn repo).
  let files: Map<string, FileEntry>;
  let parents: string[] = [];
  const tip = branchTip(repo, branch);
  if (tip !== undefined) {
    files = branchFiles(repo, branch);
    parents = [tip];
  } else if (branch !== repo.defaultBranch) {
    const defaultTip = branchTip(repo, repo.defaultBranch);
    if (defaultTip !== undefined) {
      files = branchFiles(repo, repo.defaultBranch);
      parents = [defaultTip];
    } else {
      files = new Map();
    }
  } else {
    files = new Map();
  }
  const existing = files.get(path);
  if (existing !== undefined) {
    if (sha === undefined) throw new HttpError(409, 'sha is required to update a file');
    if (sha.toLowerCase() !== existing.oid.toLowerCase()) throw new HttpError(409, 'sha does not match the current blob');
  } else if (sha !== undefined) {
    throw new HttpError(409, 'sha does not match the current blob');
  }
  const created = existing === undefined;
  files.set(path, { oid: blobSha, mode: '100644' });
  const tree = filesToTree(repo, files);
  const commitSha = putObject(repo, 'commit', buildCommitBytes(tree, parents, message));
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { status: created ? 201 : 200, commitSha, contentSha: blobSha, created };
}

/** DELETE /contents: remove one file; the sha must match the current blob. */
export function deleteContent(repo: Repo, path: string, message: string, sha: string | undefined, branch: string): string {
  const files = branchFiles(repo, branch);
  const existing = files.get(path);
  if (existing === undefined) throw new HttpError(404, 'Not Found');
  if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) {
    throw new HttpError(409, 'sha does not match the current blob');
  }
  files.delete(path);
  return commitFiles(repo, branch, files, message);
}

// ---------------------------------------------------------------------------------------------
// Pull requests: diff, mergeability, squash merge
// ---------------------------------------------------------------------------------------------

export interface ChangedFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  /** The head version's blob oid (undefined when removed). */
  headOid?: string;
  /** The base version's blob oid (undefined when added). */
  baseOid?: string;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** The file-level diff between two trees. */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): ChangedFile[] {
  const baseFiles = treeToFiles(repo, baseTree);
  const headFiles = treeToFiles(repo, headTree);
  const out: ChangedFile[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base !== undefined && head !== undefined && base.oid === head.oid) continue;
    if (base === undefined && head !== undefined) {
      const data = repo.objects.get(head.oid)?.data ?? Buffer.alloc(0);
      const additions = countLines(data);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, headOid: head.oid });
    } else if (base !== undefined && head === undefined) {
      const data = repo.objects.get(base.oid)?.data ?? Buffer.alloc(0);
      const deletions = countLines(data);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, baseOid: base.oid });
    } else if (base !== undefined && head !== undefined) {
      const baseData = repo.objects.get(base.oid)?.data ?? Buffer.alloc(0);
      const headData = repo.objects.get(head.oid)?.data ?? Buffer.alloc(0);
      const additions = Math.max(1, countLines(headData));
      const deletions = countLines(baseData);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions, headOid: head.oid, baseOid: base.oid });
    }
  }
  return out;
}

/** The diff of a pull request: base tip at creation vs head tip now. */
export function pullRequestFiles(repo: Repo, pr: PullRequest): ChangedFile[] {
  const baseCommit = repo.objects.get(pr.baseSha);
  const headCommit = repo.objects.get(pr.headSha);
  if (baseCommit === undefined || headCommit === undefined) return [];
  if (baseCommit.type !== 'commit' || headCommit.type !== 'commit') return [];
  return diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
}

/** True when the squash merge would conflict with the base branch tip. */
export function pullRequestConflicts(repo: Repo, pr: PullRequest): boolean {
  const baseTip = branchTip(repo, pr.baseRef);
  if (baseTip === undefined) return false;
  if (baseTip === pr.baseSha) return false;
  const baseCommit = repo.objects.get(baseTip);
  const prBaseCommit = repo.objects.get(pr.baseSha);
  const headCommit = repo.objects.get(pr.headSha);
  if (baseCommit === undefined || prBaseCommit === undefined || headCommit === undefined) return false;
  const tipFiles = treeToFiles(repo, parseCommit(baseCommit.data).tree);
  const prBaseFiles = treeToFiles(repo, parseCommit(prBaseCommit.data).tree);
  const headFiles = treeToFiles(repo, parseCommit(headCommit.data).tree);
  for (const change of diffTrees(repo, parseCommit(prBaseCommit.data).tree, parseCommit(headCommit.data).tree)) {
    const atTip = tipFiles.get(change.filename);
    const atPrBase = prBaseFiles.get(change.filename);
    const atHead = headFiles.get(change.filename);
    const tipChanged = (atTip?.oid ?? null) !== (atPrBase?.oid ?? null);
    const headChanged = (atHead?.oid ?? null) !== (atPrBase?.oid ?? null);
    if (tipChanged && headChanged && (atTip?.oid ?? null) !== (atHead?.oid ?? null)) return true;
  }
  return false;
}

/** The GraphQL mergeable state of a pull request. */
export function pullRequestMergeable(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
  return pullRequestConflicts(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
}

/**
 * Squash-merge a pull request onto its base branch: one commit whose tree is
 * the base tip with the head's changed files applied. Throws 405 on conflict
 * or when the pull request is not open.
 */
export function squashMerge(repo: Repo, pr: PullRequest): string {
  if (pr.state !== 'open' || pr.merged) throw new HttpError(405, 'Pull request is not open');
  if (pullRequestConflicts(repo, pr)) throw new HttpError(405, 'Merge conflict');
  const baseTip = branchTip(repo, pr.baseRef);
  if (baseTip === undefined) throw new HttpError(405, 'Base branch does not exist');
  const baseCommit = repo.objects.get(baseTip);
  if (baseCommit === undefined || baseCommit.type !== 'commit') throw new HttpError(405, 'Base branch has no commit');
  const files = treeToFiles(repo, parseCommit(baseCommit.data).tree);
  for (const change of pullRequestFiles(repo, pr)) {
    if (change.status === 'removed') files.delete(change.filename);
    else if (change.headOid !== undefined) files.set(change.filename, { oid: change.headOid, mode: '100644' });
  }
  const tree = filesToTree(repo, files);
  const message = `Merge pull request #${pr.number} from ${VIEWER_LOGIN}/${pr.headRef}`;
  const commitOid = putObject(repo, 'commit', buildCommitBytes(tree, [baseTip], message));
  repo.refs.set(`refs/heads/${pr.baseRef}`, commitOid);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = trialNowIso();
  pr.mergeCommitSha = commitOid;
  return commitOid;
}

// ---------------------------------------------------------------------------------------------
// REST + GraphQL views of the store
// ---------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', [repo.owner, repo.name]),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}`,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', [repo.owner, repo.name, issue.number]),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(repo: Repo, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', [repo.owner, repo.name, comment.issueNumber, comment.id]),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

export function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: globalId('PullRequest', [repo.owner, repo.name, pr.number]),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: branchTip(repo, pr.baseRef) ?? pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: pr.createdAt,
    updated_at: pr.createdAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `/${repo.owner}/${repo.name}/pull/${pr.number}`,
  };
}

/** Create an issue; throws 422 when it names a label that does not exist. */
export function createIssue(store: Store, repo: Repo, title: string, body: string, labels: readonly string[] = []): Issue {
  for (const name of labels) {
    if (!repo.labels.has(name)) throw new HttpError(422, `Label '${name}' does not exist`);
  }
  const now = trialNowIso();
  const issue: Issue = {
    id: store.nextId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    createdAt: now,
    updatedAt: now,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

/** Create a pull request from an existing head branch; throws 422 on a duplicate open one. */
export function createPullRequest(store: Store, repo: Repo, title: string, body: string, head: string, base: string): PullRequest {
  const headSha = branchTip(repo, head);
  if (headSha === undefined) throw new HttpError(422, `Head branch '${head}' does not exist`);
  const baseSha = branchTip(repo, base);
  if (baseSha === undefined) throw new HttpError(422, `Base branch '${base}' does not exist`);
  for (const pr of repo.pulls.values()) {
    if (pr.state === 'open' && pr.headRef === head && pr.baseRef === base) {
      throw new HttpError(422, 'A pull request already exists for this head and base');
    }
  }
  const now = trialNowIso();
  const pr: PullRequest = {
    id: store.nextId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    headSha,
    baseRef: base,
    baseSha,
    createdAt: now,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pr.number, pr);
  return pr;
}

/** Commits reachable from a ref tip, newest first (parents before their ancestors). */
export function listCommits(repo: Repo, tip: string | undefined): Array<{ sha: string; message: string; tree: string }> {
  if (tip === undefined) return [];
  const out: Array<{ sha: string; message: string; tree: string }> = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    out.push({ sha: oid, message: commit.message, tree: commit.tree });
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}
