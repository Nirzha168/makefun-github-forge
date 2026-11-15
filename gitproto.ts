// git smart HTTP: pkt-line framing, packfile read/write (zlib + SHA-1,
// ofs/ref deltas), protocol v2 upload-pack (advertisement, ls-refs, fetch)
// and v0 receive-pack (report-status, side-band-64k, delete-refs).
// Implemented from the protocol itself; no git binary anywhere.

import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  hashObject,
  isOid,
  sha1Hex,
} from './util.ts';
import {
  collectReachable,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  putObject,
  type GitObject,
  type ObjectType,
  type Repo,
} from './store.ts';

export const AGENT = 'makefun-github-forge/1.0';

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export interface PktParse {
  packets: Array<{ kind: 'data' | 'flush' | 'delim' | 'end'; payload?: Buffer }>;
  consumed: number;
}

export function parsePktLines(buf: Buffer): PktParse {
  const packets: PktParse['packets'] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (len === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
    } else if (len >= 4 && offset + len <= buf.length) {
      packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    } else {
      break;
    }
  }
  return { packets, consumed: offset };
}

function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// packfile
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), version 2, SHA-1 trailer. */
/** Memo of per-object pack entries (header + deflated body), keyed by object id. Content-addressed, so an entry never goes stale and the pack bytes are identical whether cached or not. */
const packEntryCache = new Map<string, Buffer>();
const PACK_ENTRY_CACHE_MAX = 8192;

function packEntry(object: GitObject): Buffer {
  const oid = hashObject(object.type, object.data);
  const cached = packEntryCache.get(oid);
  if (cached !== undefined) return cached;
  const entry = Buffer.concat([writePackHeader(object.type, object.data.length), deflateSync(object.data, { level: 1 })]);
  if (packEntryCache.size >= PACK_ENTRY_CACHE_MAX) packEntryCache.clear();
  packEntryCache.set(oid, entry);
  return entry;
}

export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) parts.push(packEntry(object));
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

function readVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/**
 * Read a packfile (version 2/3), resolving ofs/ref deltas. `resolveBase`
 * supplies a base object a thin pack leaves out. Returns the resolved objects
 * keyed by oid. Throws on a corrupt pack.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (sha1Hex(pack.subarray(0, trailerStart)) !== trailer) throw new Error('pack trailer checksum mismatch');
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const info = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    entry.data = info.buffer;
    if (entry.data.length !== header.size) throw new Error('pack entry size mismatch');
    offset += info.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: ObjectType; data: Buffer; oid: string } => {
    const prior = (entry as unknown as { _resolved?: { type: ObjectType; data: Buffer; oid: string } })._resolved;
    if (prior !== undefined) return prior;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = [...resolvedByOid.values()].find((candidate) => {
        const r = (candidate as unknown as { _resolved?: { oid: string } })._resolved;
        return r?.oid === entry.baseOid;
      });
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(entry.baseOid!);
        if (external === undefined) throw new Error('ref-delta base missing');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const resolved = { type, data, oid };
    (entry as unknown as { _resolved?: unknown })._resolved = resolved;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return resolved;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------------------------

export const DEFAULT_HEAD = 'refs/heads/main';

/** Sorted ref entries (HEAD first when requested), as the advertisements use. */
export function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function headTarget(repo: Repo): { oid: string; symref: string } {
  const oid = repo.refs.get(DEFAULT_HEAD) ?? ZERO_OID;
  return { oid, symref: DEFAULT_HEAD };
}

function v0Capabilities(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): string {
  const head = headTarget(repo);
  const common = [`agent=${AGENT}`];
  if (service === 'git-upload-pack') {
    return [...common, 'multi_ack', 'multi_ack_detailed', 'thin-pack', 'side-band-64k', 'side-band', 'ofs-delta', 'shallow', 'no-progress', `symref=HEAD:${head.symref}`].join(' ');
  }
  return [...common, 'report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'quiet'].join(' ');
}

/** The v0 ref advertisement body for a service, with the `# service=` preamble. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = v0Capabilities(service, repo);
  const lines: (string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const head = headTarget(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${head.oid} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = peelToCommit(repo, ref.oid);
        if (peeled !== null && peeled !== ref.oid) lines.push(`${peeled} ${ref.name}^{}\n`);
      }
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

/** The v2 capability advertisement body: it opens with `version 2` (no `# service=` preamble — that is v0 only). */
export function v2Advertisement(repo: Repo): Buffer {
  void repo;
  const lines: (string | 'flush')[] = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'flush',
  ];
  return pktLines(lines);
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

export interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** The v2 ls-refs response lines for a repo. */
export function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const refs = sortedRefs(repo);
  const head = headTarget(repo);
  const lines: string[] = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (keep('HEAD')) {
    if (head.oid === ZERO_OID) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${head.symref}` : ''}\n`);
    } else {
      lines.push(`${head.oid} HEAD${args.symrefs ? ` symref-target:${head.symref}` : ''}\n`);
    }
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(repo, ref.oid);
      if (peeled !== null && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return pktLines(lines as unknown as (string | 'flush')[]);
}

// ---------------------------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------------------------

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  /** `deepen-relative`: `depth` is an increment over the client's current depth. */
  deepenRelative: boolean;
  done: boolean;
}

/** Commits within `depth` generations of `wants` (depth null = whole history). */
function commitsWithinDepth(repo: Repo, wants: readonly string[], depth: number | null): Set<string> {
  const included = new Set<string>();
  const queue: Array<{ oid: string; distance: number }> = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      queue.push({ oid: target, distance: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, distance: 0 });
    }
  }
  while (queue.length > 0) {
    const { oid, distance } = queue.shift()!;
    if (included.has(oid)) continue;
    if (depth !== null && distance >= depth) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    included.add(oid);
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, distance: distance + 1 });
  }
  return included;
}

/**
 * The client's current shallow depth for `wants`: generations from a want
 * down to (and including) its shallow boundary. A depth-1 clone's tip is its
 * own boundary, so its depth is 1. Returns 0 when no boundary is reachable.
 */
function currentShallowDepth(repo: Repo, wants: readonly string[], shallow: ReadonlySet<string>): number {
  let best = Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  const queue: Array<{ oid: string; distance: number }> = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    const start = object.type === 'tag' ? parseTag(object.data).object : want;
    queue.push({ oid: start, distance: 0 });
  }
  while (queue.length > 0) {
    const { oid, distance } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (shallow.has(oid)) {
      best = Math.min(best, distance + 1);
      continue;
    }
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, distance: distance + 1 });
  }
  return best === Number.POSITIVE_INFINITY ? 0 : best;
}

/**
 * The objects a fetch must send, and the shallow boundary lines. `haveObjects`
 * are the objects the client already holds (reachable from its haves).
 */
export function computeFetch(
  repo: Repo,
  args: FetchArgs,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  // The client's haves stop at its shallow boundaries: it holds the boundary
  // commit and its tree, but not the boundary's ancestors.
  const haveReachable = collectReachable(repo, args.haves, new Set(args.shallow));
  const objects = new Map<string, GitObject>();
  const addObject = (oid: string): void => {
    const object = repo.objects.get(oid);
    if (object !== undefined && !haveReachable.has(oid)) objects.set(oid, object);
  };
  let shallow: string[] = [];
  let unshallow: string[] = [];
  // `deepen-relative` (real git's `--deepen`): the depth is an increment over
  // the client's current depth, measured to its shallow boundaries.
  let depth = args.depth;
  if (depth !== null && args.deepenRelative) {
    depth = depth + currentShallowDepth(repo, args.wants, new Set(args.shallow));
  }
  if (depth !== null) {
    const included = commitsWithinDepth(repo, args.wants, depth);
    // The boundary: included commits with a parent outside the included set.
    for (const oid of included) {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => !included.has(parent))) shallow.push(oid);
    }
    for (const boundary of args.shallow) {
      if (included.has(boundary)) unshallow.push(boundary);
    }
    // A shallow fetch sends only the included commits' own trees, not the
    // parents' trees: restrict the closure to the included commits + trees.
    const allowed = new Set<string>();
    for (const oid of included) {
      allowed.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const tree = parseCommit(object.data).tree;
      for (const reachable of collectReachable(repo, [tree])) allowed.add(reachable);
    }
    for (const oid of allowed) addObject(oid);
    // Tag objects named in wants ride along whole.
    for (const want of args.wants) {
      const object = repo.objects.get(want);
      if (object !== undefined && object.type === 'tag') addObject(want);
    }
  } else {
    const wanted = collectReachable(repo, args.wants);
    for (const oid of wanted) addObject(oid);
  }
  // Deterministic pack order by object id (the map key already is the hash;
  // never recompute the hash inside the comparator).
  return { objects: [...objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, object]) => object), shallow, unshallow };
}

/** Sideband-wrap pack bytes into band-1 pkt-lines (chunked under the pkt-line max). */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

/** Sideband-wrap arbitrary bytes into band-1 pkt-lines (chunked under the pkt-line max). */
export function sidebandBytes(bytes: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK))])));
  }
  return Buffer.concat(parts);
}

/** Parse a v2 upload-pack request body into its command and arguments. */
export function parseUploadPackV2(body: Buffer): { command: string; lsRefs: LsRefsArgs; fetch: FetchArgs } {
  const { packets } = parsePktLines(body);
  let command = '';
  const lsRefs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  const fetch: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenRelative: false, done: false };
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    const line = packet.payload.toString('utf8').trimEnd();
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    if (command === 'ls-refs') {
      if (line === 'peel') lsRefs.peel = true;
      else if (line === 'symrefs') lsRefs.symrefs = true;
      else if (line === 'unborn') lsRefs.unborn = true;
      else if (line.startsWith('ref-prefix ')) lsRefs.prefixes.push(line.slice('ref-prefix '.length));
    } else if (command === 'fetch') {
      if (line.startsWith('want ')) fetch.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) fetch.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) fetch.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) fetch.depth = Number.parseInt(line.slice(7), 10);
      else if (line === 'deepen-relative') fetch.deepenRelative = true;
      else if (line === 'done') fetch.done = true;
    }
  }
  return { command, lsRefs, fetch };
}

/** Parse a v0 upload-pack request body (wants/shallow/deepen, then haves/done). */
export function parseUploadPackV0(body: Buffer): FetchArgs {
  const { packets } = parsePktLines(body);
  const fetch: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenRelative: false, done: false };
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    let line = packet.payload.toString('utf8').trimEnd();
    // The first want line carries the client's capabilities after a space.
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    if (line.startsWith('want ')) fetch.wants.push(line.slice(5).trim().split(' ')[0]!);
    else if (line.startsWith('have ')) fetch.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) fetch.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) fetch.depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'deepen-relative') fetch.deepenRelative = true;
    else if (line === 'done') fetch.done = true;
  }
  return fetch;
}

/**
 * The v2 fetch response, per protocol-v2: sections are separated by delimiter
 * packets (0001) and the packfile section ends in a flush.
 *
 * When the client sent `done`, it finished negotiations, so the
 * acknowledgments section MUST be omitted: the response is the shallow-info
 * section (delim-terminated, when present) and then the packfile section
 * (flush-terminated). When nothing is new, the response is the
 * acknowledgments section alone, flush-terminated.
 *
 * On a negotiation round (no `done`), the acknowledgments section carries
 * the ACKs (or NAK); when a common base was found, `ready` follows and the
 * packfile follows in the same response (delim-separated); otherwise the
 * section ends in a flush and the client negotiates further.
 */
export function fetchV2Response(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = computeFetch(repo, args);
  const parts: Buffer[] = [];
  const ackLines: string[] = [];
  let anyAck = false;
  for (const have of args.haves) {
    if (repo.objects.has(have)) {
      ackLines.push(`ACK ${have}\n`);
      anyAck = true;
    }
  }
  if (!anyAck) ackLines.push('NAK\n');

  // The shallow-info + packfile tail shared by the done and ready paths.
  const packfileTail = (): void => {
    if (shallow.length > 0 || unshallow.length > 0) {
      const lines: (string | 'delim')[] = ['shallow-info\n'];
      for (const oid of shallow) lines.push(`shallow ${oid}\n`);
      for (const oid of unshallow) lines.push(`unshallow ${oid}\n`);
      lines.push('delim');
      parts.push(pktLines(lines));
    }
    if (objects.length > 0) {
      parts.push(pktLines(['packfile\n']));
      parts.push(sidebandPack(writePack(objects)));
      parts.push(pktFlush());
    }
  };

  if (args.done) {
    if (objects.length === 0) {
      parts.push(pktLines(['acknowledgments\n', ...ackLines, 'flush']));
      return Buffer.concat(parts);
    }
    packfileTail();
    return Buffer.concat(parts);
  }

  if (anyAck && objects.length > 0) {
    parts.push(pktLines(['acknowledgments\n', ...ackLines, 'ready\n', 'delim']));
    packfileTail();
  } else {
    parts.push(pktLines(['acknowledgments\n', ...ackLines, 'flush']));
  }
  return Buffer.concat(parts);
}

/** The v0 fetch response: NAK/ACK lines, shallow lines, then the sideband pack. */
export function fetchV0Response(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = computeFetch(repo, args);
  const parts: Buffer[] = [];
  let anyAck = false;
  for (const have of args.haves) {
    if (repo.objects.has(have)) {
      parts.push(pktLine(`ACK ${have}\n`));
      anyAck = true;
    }
  }
  if (!anyAck) parts.push(pktLine('NAK\n'));
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (objects.length > 0) {
    parts.push(sidebandPack(writePack(objects)));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

/** Parse a receive-pack request body into commands + the trailing pack bytes. */
export function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const { packets, consumed } = parsePktLines(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length >= 3 && isOid(parts[0]!) && isOid(parts[1]!)) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
  }
  return { commands, pack: body.subarray(consumed) };
}

/**
 * Apply a push: unpack the pack, then apply each command's fast-forward rule.
 * Returns the report-status lines in command order.
 */
export function applyPush(repo: Repo, commands: readonly PushCommand[], pack: Buffer): { lines: PushReportLine[]; unpackOk: boolean; unpackDetail: string } {
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const objects = readPack(pack, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
      return { lines: [], unpackOk, unpackDetail };
    }
  }
  const lines: PushReportLine[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        lines.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        lines.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        lines.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: the old value must match and the new tip must descend from it.
    if (current === undefined || current !== command.oldOid) {
      lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    const newObject = repo.objects.get(command.newOid);
    if (newObject === undefined) {
      lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    const newCommit = command.newOid === command.oldOid || isAncestor(repo, command.oldOid, command.newOid);
    if (!newCommit) {
      // A non-commit ref (a tag) that does not descend: refuse the same way.
      const target = newObject.type === 'tag' ? peelToCommit(repo, command.newOid) : null;
      const ok = target !== null && isAncestor(repo, command.oldOid, target);
      if (!ok) {
        lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    lines.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { lines, unpackOk, unpackDetail };
}

/**
 * The receive-pack response: the report-status stream inside sideband band 1.
 * The report is pkt-line framed inside band 1 and terminated by a flush
 * *inside* band 1 (verified against real git-http-backend: its band-1
 * payload is `000eunpack ok\n0017ok <ref>\n0000`), so the client's
 * receive_status sees the flush after the last ref line instead of EOF;
 * the outer flush then ends the sideband stream.
 */
export function pushReportResponse(result: { lines: PushReportLine[]; unpackOk: boolean; unpackDetail: string }): Buffer {
  const lines: (string | 'flush')[] = [`unpack ${result.unpackOk ? 'ok' : result.unpackDetail}\n`];
  for (const line of result.lines) {
    lines.push(line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.reason}\n`);
  }
  lines.push('flush');
  const report = pktLines(lines);
  const parts: Buffer[] = [sidebandBytes(report)];
  parts.push(pktFlush());
  return Buffer.concat(parts);
}
