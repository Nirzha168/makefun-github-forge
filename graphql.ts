// The GraphQL v4 surface at /api/graphql: a small hand-written parser and
// executor for exactly the documents gh and github-mcp-server send. No schema
// library, no code generation — the documents are fixed, so the executor is a
// resolver table keyed by parent type and field name, with a static
// introspection table for the __type probes.
//
// Unknown fields are GraphQL errors (HTTP 200 with an `errors` array naming
// the field); an unknown repository is data.repository = null with no errors.
// A JSON array body is operation batching: one result per document, in order.

import {
  HttpError,
  VIEWER_ID,
  VIEWER_LOGIN,
  globalId,
  issueCursor,
  parseGlobalId,
  parseIssueCursor,
} from './util.ts';
import {
  branchTip,
  createIssue,
  createPullRequest,
  pullRequestFiles,
  pullRequestMergeable,
  squashMerge,
  type IssueComment as Comment,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------------------------------------
// Lexer and parser.
// ---------------------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === ';') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // A plain double-quoted string (the documents never use block strings).
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const escaped = source[i + 1]!;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let value = '';
      while (i < source.length && /[0-9.]/.test(source[i]!)) {
        value += source[i];
        i += 1;
      }
      tokens.push(value.includes('.') ? { kind: 'float', value } : { kind: 'int', value });
      continue;
    }
    if (isNameStart(ch)) {
      let value = '';
      while (i < source.length && isNameChar(source[i]!)) {
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`GraphQL lexer: unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface Selection {
  kind: 'field' | 'fragment' | 'inline';
  name?: string;
  alias?: string;
  args?: { name: string; value: ValueNode }[];
  selections?: Selection[];
  typeCondition?: string;
}

interface Operation {
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions: { name: string; type: string; defaultValue?: ValueNode }[];
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`GraphQL parser: expected ${value}, got ${token.kind} ${'value' in token ? token.value : ''}`);
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('GraphQL parser: expected a name');
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: Selection[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', variableDefinitions: [], selections: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'fragment') {
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('GraphQL parser: expected "on" in a fragment');
        const typeCondition = this.expectName();
        fragments.set(name, { typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value as string;
        const variableDefinitions = this.parseVariableDefinitions();
        const selections = this.parseSelectionSet();
        operations.push({ operation: keyword, name, variableDefinitions, selections });
        continue;
      }
      throw new Error(`GraphQL parser: unexpected definition ${keyword}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Operation['variableDefinitions'] {
    const defs: Operation['variableDefinitions'] = [];
    if (!this.acceptPunct('(')) return defs;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.acceptPunct('=')) defaultValue = this.parseValue();
      defs.push({ name, type, defaultValue });
    }
    return defs;
  }

  private parseType(): string {
    let type = '';
    if (this.acceptPunct('[')) {
      type = `[${this.parseType()}]`;
    } else {
      type = this.expectName();
    }
    if (this.acceptPunct('!')) type += '!';
    return type;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.acceptPunct('}')) {
      if (this.peek().kind === 'punct' && this.peek().value === '...') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else {
          const name = this.expectName();
          selections.push({ kind: 'fragment', name });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | undefined;
      if (this.acceptPunct(':')) {
        alias = name;
        name = this.expectName();
      }
      let args: { name: string; value: ValueNode }[] | undefined;
      if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
      let subSelections: Selection[] | undefined;
      if (this.peek().kind === 'punct' && this.peek().value === '{') subSelections = this.parseSelectionSet();
      selections.push({ kind: 'field', name, alias, args, selections: subSelections });
    }
    return selections;
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.expectPunct('(');
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`GraphQL parser: unexpected value token ${token.kind}`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Value resolution and the resolver table.
// ---------------------------------------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(args: { name: string; value: ValueNode }[] | undefined, name: string, variables: Variables): unknown {
  const found = args?.find((arg) => arg.name === name);
  if (found === undefined) return undefined;
  return resolveValue(found.value, variables);
}

/** A resolved object: its GraphQL type plus the store record behind it. */
interface GqlObject {
  __kind: string;
  [key: string]: unknown;
}

function wrap(kind: string, record: Record<string, unknown>): GqlObject {
  return { __kind: kind, ...record };
}

function repoObject(store: Store, repo: Repo): GqlObject {
  return wrap('Repository', { store, repo });
}

function issueObject(store: Store, repo: Repo, issue: Issue): GqlObject {
  return wrap('Issue', { store, repo, issue });
}

function pullObject(store: Store, repo: Repo, pr: PullRequest): GqlObject {
  return wrap('PullRequest', { store, repo, pr });
}

function userObject(): GqlObject {
  return wrap('User', { login: VIEWER_LOGIN, id: VIEWER_ID });
}

interface IssueOrder {
  states?: string[];
  orderBy?: { field?: string; direction?: string };
}

/** The issues connection of a repository, ordered and cursor-paginated. */
function issuesConnection(store: Store, repo: Repo, first: number | undefined, after: string | undefined, order: IssueOrder): GqlObject {
  let list = [...repo.issues.values()];
  if (order.states !== undefined && order.states.length > 0) {
    const wanted = new Set(order.states.map((state) => state.toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const direction = order.orderBy?.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => (a.number - b.number) * direction);
  if (after !== undefined && after !== null && after !== '') {
    const cursorNumber = parseIssueCursor(after);
    if (cursorNumber !== null) {
      list = list.filter((issue) => (direction === -1 ? issue.number < cursorNumber : issue.number > cursorNumber));
    }
  }
  const limit = first !== undefined && Number.isFinite(first) ? Math.max(0, Math.trunc(first)) : list.length;
  const page = list.slice(0, limit);
  const hasNextPage = list.length > limit;
  const endCursor = page.length > 0 ? issueCursor(page[page.length - 1]!.number) : null;
  return wrap('IssueConnection', {
    nodes: page.map((issue) => issueObject(store, repo, issue)),
    pageInfo: wrap('PageInfo', { hasNextPage, endCursor }),
  });
}

function pullsConnection(store: Store, repo: Repo, first: number | undefined): GqlObject {
  const list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
  const limit = first !== undefined && Number.isFinite(first) ? Math.max(0, Math.trunc(first)) : list.length;
  return wrap('PullRequestConnection', {
    nodes: list.slice(0, limit).map((pr) => pullObject(store, repo, pr)),
  });
}

function filesConnection(store: Store, repo: Repo, pr: PullRequest, first: number | undefined): GqlObject {
  const files = pullRequestFiles(repo, pr);
  const limit = first !== undefined && Number.isFinite(first) ? Math.max(0, Math.trunc(first)) : files.length;
  return wrap('PullRequestChangedFileConnection', {
    nodes: files.slice(0, limit).map((file) => wrap('PullRequestChangedFile', { path: file.filename, additions: file.additions, deletions: file.deletions })),
  });
}

function findRepoByGlobalId(store: Store, id: string): Repo | undefined {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return undefined;
  return store.getRepo(parsed.parts[0] ?? '', parsed.parts[1] ?? '');
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | undefined {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue') return undefined;
  const repo = store.getRepo(parsed.parts[0] ?? '', parsed.parts[1] ?? '');
  if (repo === undefined) return undefined;
  const issue = repo.issues.get(Number(parsed.parts[2] ?? ''));
  if (issue === undefined) return undefined;
  return { repo, issue };
}

function findPullByGlobalId(store: Store, id: string): { repo: Repo; pr: PullRequest } | undefined {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return undefined;
  const repo = store.getRepo(parsed.parts[0] ?? '', parsed.parts[1] ?? '');
  if (repo === undefined) return undefined;
  const pr = repo.pulls.get(Number(parsed.parts[2] ?? ''));
  if (pr === undefined) return undefined;
  return { repo, pr };
}

type Resolver = (obj: GqlObject, args: Record<string, unknown>, ctx: { store: Store }) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObject(),
    repository: (_obj, args, ctx) => {
      const owner = args.owner as string | undefined;
      const name = args.name as string | undefined;
      if (owner === undefined || name === undefined) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo === undefined ? null : repoObject(ctx.store, repo);
    },
    node: (_obj, args, ctx) => {
      const id = args.id as string | undefined;
      if (id === undefined) return null;
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const repo = ctx.store.getRepo(parsed.parts[0] ?? '', parsed.parts[1] ?? '');
        return repo === undefined ? null : repoObject(ctx.store, repo);
      }
      if (parsed.kind === 'Issue') {
        const found = findIssueByGlobalId(ctx.store, id);
        return found === undefined ? null : issueObject(ctx.store, found.repo, found.issue);
      }
      if (parsed.kind === 'PullRequest') {
        const found = findPullByGlobalId(ctx.store, id);
        return found === undefined ? null : pullObject(ctx.store, found.repo, found.pr);
      }
      return null;
    },
    __type: (_obj, args) => {
      const name = args.name as string | undefined;
      if (name === undefined) return null;
      return typeObject(name);
    },
  },
  Mutation: {
    createIssue: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(ctx.store, input.repositoryId) : undefined;
      if (repo === undefined) throw new Error('createIssue: repositoryId does not resolve to a repository');
      const issue = createIssue(ctx.store, repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '');
      return wrap('CreateIssuePayload', { issue: issueObject(ctx.store, repo, issue) });
    },
    closeIssue: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.issueId === 'string' ? findIssueByGlobalId(ctx.store, input.issueId) : undefined;
      if (found === undefined) throw new Error('closeIssue: issueId does not resolve to an issue');
      found.issue.state = 'closed';
      return wrap('CloseIssuePayload', { issue: issueObject(ctx.store, found.repo, found.issue) });
    },
    createPullRequest: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(ctx.store, input.repositoryId) : undefined;
      if (repo === undefined) throw new Error('createPullRequest: repositoryId does not resolve to a repository');
      const pr = createPullRequest(
        ctx.store,
        repo,
        String(input.title ?? ''),
        '',
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      return wrap('CreatePullRequestPayload', { pullRequest: pullObject(ctx.store, repo, pr) });
    },
    mergePullRequest: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.pullRequestId === 'string' ? findPullByGlobalId(ctx.store, input.pullRequestId) : undefined;
      if (found === undefined) throw new Error('mergePullRequest: pullRequestId does not resolve to a pull request');
      squashMerge(found.repo, found.pr);
      return wrap('MergePullRequestPayload', { pullRequest: pullObject(ctx.store, found.repo, found.pr) });
    },
    addComment: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.subjectId === 'string' ? findIssueByGlobalId(ctx.store, input.subjectId) : undefined;
      if (found === undefined) throw new Error('addComment: subjectId does not resolve to an issue');
      const comment: Comment = {
        id: ctx.store.nextId(),
        issueNumber: found.issue.number,
        body: String(input.body ?? ''),
        createdAt: found.issue.createdAt,
      };
      found.repo.comments.set(comment.id, comment);
      const node = wrap('Comment', {
        id: globalId('Comment', [found.repo.owner, found.repo.name, String(comment.id)]),
        body: comment.body,
      });
      return wrap('AddCommentPayload', { commentEdge: wrap('CommentEdge', { node }) });
    },
  },
  Repository: {
    id: (obj) => {
      const repo = obj.repo as Repo;
      return globalId('Repository', [repo.owner, repo.name]);
    },
    databaseId: (obj) => (obj.repo as Repo).id,
    name: (obj) => (obj.repo as Repo).name,
    nameWithOwner: (obj) => {
      const repo = obj.repo as Repo;
      return `${repo.owner}/${repo.name}`;
    },
    owner: () => userObject(),
    description: (obj) => (obj.repo as Repo).description,
    defaultBranchRef: (obj) => {
      const repo = obj.repo as Repo;
      const tip = branchTip(repo, repo.defaultBranch);
      if (tip === undefined) return null;
      return wrap('Ref', { name: repo.defaultBranch });
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (obj, args, ctx) => {
      const repo = obj.repo as Repo;
      const number = args.number as number | undefined;
      if (number === undefined) return null;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueObject(ctx.store, repo, issue);
    },
    issues: (obj, args, ctx) => {
      const repo = obj.repo as Repo;
      const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
      const states = args.states as string[] | undefined;
      return issuesConnection(ctx.store, repo, args.first as number | undefined, args.after as string | undefined, { states, orderBy });
    },
    pullRequests: (obj, args, ctx) => pullsConnection(ctx.store, obj.repo as Repo, args.first as number | undefined),
    pullRequest: (obj, args, ctx) => {
      const repo = obj.repo as Repo;
      const number = args.number as number | undefined;
      if (number === undefined) return null;
      const pr = repo.pulls.get(number);
      return pr === undefined ? null : pullObject(ctx.store, repo, pr);
    },
  },
  Issue: {
    id: (obj) => {
      const repo = obj.repo as Repo;
      const issue = obj.issue as Issue;
      return globalId('Issue', [repo.owner, repo.name, String(issue.number)]);
    },
    number: (obj) => (obj.issue as Issue).number,
    title: (obj) => (obj.issue as Issue).title,
    state: (obj) => (obj.issue as Issue).state.toUpperCase(),
    body: (obj) => (obj.issue as Issue).body,
    url: (obj) => {
      const repo = obj.repo as Repo;
      const issue = obj.issue as Issue;
      return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
    },
  },
  PullRequest: {
    id: (obj) => {
      const repo = obj.repo as Repo;
      const pr = obj.pr as PullRequest;
      return globalId('PullRequest', [repo.owner, repo.name, String(pr.number)]);
    },
    number: (obj) => (obj.pr as PullRequest).number,
    title: (obj) => (obj.pr as PullRequest).title,
    state: (obj) => {
      const pr = obj.pr as PullRequest;
      return pr.merged ? 'MERGED' : pr.state.toUpperCase();
    },
    merged: (obj) => (obj.pr as PullRequest).merged,
    headRefName: (obj) => (obj.pr as PullRequest).headRef,
    baseRefName: (obj) => (obj.pr as PullRequest).baseRef,
    mergeable: (obj) => pullRequestMergeable(obj.repo as Repo, obj.pr as PullRequest),
    body: (obj) => (obj.pr as PullRequest).body,
    files: (obj, args, ctx) => filesConnection(ctx.store, obj.repo as Repo, obj.pr as PullRequest, args.first as number | undefined),
  },
  User: {
    login: (obj) => (obj.login as string | undefined) ?? VIEWER_LOGIN,
    id: () => VIEWER_ID,
  },
  Ref: {
    name: (obj) => obj.name as string,
  },
  IssueConnection: {
    nodes: (obj) => obj.nodes as GqlObject[],
    pageInfo: (obj) => obj.pageInfo as GqlObject,
    totalCount: (obj) => (obj.nodes as GqlObject[]).length,
  },
  PullRequestConnection: {
    nodes: (obj) => obj.nodes as GqlObject[],
  },
  PullRequestChangedFileConnection: {
    nodes: (obj) => obj.nodes as GqlObject[],
  },
  PullRequestChangedFile: {
    path: (obj) => obj.path as string,
    additions: (obj) => obj.additions as number,
    deletions: (obj) => obj.deletions as number,
  },
  PageInfo: {
    hasNextPage: (obj) => obj.hasNextPage as boolean,
    endCursor: (obj) => obj.endCursor as string | null,
  },
  CreateIssuePayload: {
    issue: (obj) => obj.issue as GqlObject,
  },
  CloseIssuePayload: {
    issue: (obj) => obj.issue as GqlObject,
  },
  CreatePullRequestPayload: {
    pullRequest: (obj) => obj.pullRequest as GqlObject,
  },
  MergePullRequestPayload: {
    pullRequest: (obj) => obj.pullRequest as GqlObject,
  },
  AddCommentPayload: {
    commentEdge: (obj) => obj.commentEdge as GqlObject,
  },
  CommentEdge: {
    node: (obj) => obj.node as GqlObject,
  },
  Comment: {
    id: (obj) => obj.id as string,
    body: (obj) => obj.body as string,
  },
  __Type: {
    name: (obj) => obj.name as string,
    fields: (obj) => (obj.fields as string[]).map((name) => wrap('__Field', { name })),
    enumValues: (obj) => (obj.enumValues as string[]).map((name) => wrap('__EnumValue', { name })),
  },
  __Field: {
    name: (obj) => obj.name as string,
  },
  __EnumValue: {
    name: (obj) => obj.name as string,
  },
};

// ---------------------------------------------------------------------------------------------------------
// Introspection: the static schema surface gh feature-detects.
// ---------------------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'author', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'url', 'createdAt', 'author', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt'],
  User: ['id', 'login', 'name', 'email'],
  SearchType: [],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function typeObject(name: string): GqlObject | null {
  const fields = TYPE_FIELDS[name];
  const enumValues = TYPE_ENUM_VALUES[name];
  if (fields === undefined && enumValues === undefined) return null;
  return wrap('__Type', { name, fields: fields ?? [], enumValues: enumValues ?? [] });
}

// ---------------------------------------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------------------------------------

interface ExecutionResult {
  data: Record<string, unknown> | null;
  errors?: { message: string }[];
}

function executeSelections(
  obj: GqlObject,
  selections: Selection[],
  variables: Variables,
  document: Document,
  ctx: { store: Store },
  errors: { message: string }[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== obj.__kind) continue;
      Object.assign(out, executeSelections(obj, selection.selections ?? [], variables, document, ctx, errors));
      continue;
    }
    if (selection.kind === 'fragment') {
      const fragment = document.fragments.get(selection.name ?? '');
      if (fragment === undefined) continue;
      if (fragment.typeCondition !== obj.__kind) continue;
      Object.assign(out, executeSelections(obj, fragment.selections, variables, document, ctx, errors));
      continue;
    }
    const fieldName = selection.name!;
    const responseKey = selection.alias ?? fieldName;
    if (fieldName === '__typename') {
      out[responseKey] = obj.__kind;
      continue;
    }
    const table = RESOLVERS[obj.__kind];
    const resolver = table?.[fieldName];
    if (resolver === undefined) {
      errors.push({ message: `Cannot query field "${fieldName}" on type "${obj.__kind}".` });
      out[responseKey] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args ?? []) args[arg.name] = resolveValue(arg.value, variables);
    let value: unknown;
    try {
      value = resolver(obj, args, ctx);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = resolveFieldValue(value, selection.selections, variables, document, ctx, errors);
  }
  return out;
}

function resolveFieldValue(
  value: unknown,
  selections: Selection[] | undefined,
  variables: Variables,
  document: Document,
  ctx: { store: Store },
  errors: { message: string }[],
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => resolveFieldValue(entry, selections, variables, document, ctx, errors));
  }
  if (typeof value === 'object' && '__kind' in (value as Record<string, unknown>)) {
    if (selections === undefined || selections.length === 0) return null;
    return executeSelections(value as GqlObject, selections, variables, document, ctx, errors);
  }
  return value;
}

function executeOperation(store: Store, operation: Operation, variables: Variables, document: Document): ExecutionResult {
  const errors: { message: string }[] = [];
  const rootKind = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const merged: Variables = { ...variables };
  for (const def of operation.variableDefinitions) {
    if (!(def.name in merged) && def.defaultValue !== undefined) {
      merged[def.name] = resolveValue(def.defaultValue, variables);
    }
  }
  const root = wrap(rootKind, {});
  const ctx = { store };
  const data = executeSelections(root, operation.selections, merged, document, ctx, errors);
  const result: ExecutionResult = { data };
  if (errors.length > 0) result.errors = errors;
  return result;
}

/**
 * Execute a GraphQL request body: a single operation object, or a JSON array
 * of operation objects (batching — one result per document, in order).
 */
export function handleGraphQLBody(store: Store, body: Buffer): ExecutionResult | ExecutionResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Malformed JSON body');
  }
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => executeBatchEntry(store, entry));
  }
  return executeSingle(store, parsed);
}

function executeSingle(store: Store, parsed: unknown): ExecutionResult {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'GraphQL requests must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string') throw new HttpError(400, 'query is required');
  const variables = (record.variables ?? {}) as Variables;
  if (variables !== null && typeof variables !== 'object') throw new HttpError(400, 'variables must be an object');
  return executeDocument(store, query, variables as Variables);
}

function executeBatchEntry(store: Store, entry: unknown): ExecutionResult {
  if (entry === null || typeof entry !== 'object') return { data: null, errors: [{ message: 'each batch entry must be an object' }] };
  const record = entry as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
  const variables = (record.variables ?? {}) as Variables;
  return executeDocument(store, query, variables as Variables);
}

function executeDocument(store: Store, query: string, variables: Variables): ExecutionResult {
  let document: Document;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = document.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in the document' }] };
  return executeOperation(store, operation, variables, document);
}
