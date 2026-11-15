# makefun-github-forge

[![make.fun](https://make.fun/badge.svg)](https://make.fun/bounty/github-core-clone-01)
[![bounty: github-core-clone-01](https://img.shields.io/badge/bounty-github--core--clone--01-blue)](https://make.fun/bounty/github-core-clone-01)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node: 22](https://img.shields.io/badge/node-22-brightgreen)](https://nodejs.org)

A standalone, GitHub-compatible git forge, written for the
[make.fun github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01).
One Node 22 process, standard library only, no git binary, no network beyond the
trial suite. It serves:

- **git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (capability advertisement, `ls-refs`, fetch with shallow/deepen) and
  receive-pack v0 (`report-status`, `side-band-64k`, `delete-refs`), with a
  hand-written packfile reader/writer (zlib + SHA-1, ofs/ref deltas).
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  issues, comments, labels and pull requests with squash merge.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and
  `github-mcp-server` send, including introspection, Relay global ids,
  cursor pagination and operation batching.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision
  `2026-07-28` (`server/discover`) with a legacy `initialize` fallback.

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`,
and polls `$MAKEFUN_ENV_URL/done` until the trial ends (see `main.ts`).

## Layout

- `main.ts` — the entry ↔ env lifecycle (kept as the starter ships it).
- `app.ts` — the HTTP server and routing.
- `store.ts` — the in-memory forge store: repositories, git objects and refs,
  issues, pull requests, labels and comments.
- `gitproto.ts` — pkt-line codec, packfile read/write, smart-HTTP handlers.
- `rest.ts` — the REST v3 routes.
- `graphql.ts` — the GraphQL parser, schema and executor.
- `mcp.ts` — the MCP endpoint and its tools.
- `util.ts` — shared helpers (hashing, base64, deterministic timestamps).

## Determinism

The forge never reads the wall clock and never uses unseeded randomness: every
timestamp it stores or serves comes from `MAKEFUN_TRIAL_NOW`, ids are
sequential or derived from the trial seed, and all state lives in memory in
request order — so two runs of one trial leave identical state.

## License

MIT — see [LICENSE](LICENSE).
