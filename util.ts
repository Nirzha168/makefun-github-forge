// Shared helpers for the forge: hashing, base64, deterministic time.
// The forge never reads the wall clock: every timestamp it stores or serves
// comes from MAKEFUN_TRIAL_NOW (the trial's opening time), with a fixed
// fallback so a run without the variable is still deterministic.

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
export const DEFAULT_BRANCH = 'main';
export const FALLBACK_NOW = '2026-11-14T06:30:00Z';

/** The trial's opening time as an ISO string; the only "now" the forge uses. */
export function trialNowIso(): string {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
    return raw;
  }
  return FALLBACK_NOW;
}

/** The trial's opening time as Unix seconds, for commit/tag objects. */
export function trialNowEpoch(): number {
  return Math.floor(Date.parse(trialNowIso()) / 1000);
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** git's object id: SHA-1 over `<type> <size>\0` + bytes. */
export function hashObject(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

export function b64encode(data: Buffer | string): string {
  return (typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64');
}

export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** Opaque, stable Relay-style global id: base64url of `Kind:owner/repo/...`. */
export function globalId(kind: string, parts: readonly (string | number)[]): string {
  const raw = `${kind}:${parts.join('/')}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Decode a global id back into its kind and parts, or null when malformed. */
export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const raw = Buffer.from(id, 'base64url').toString('utf8');
    const colon = raw.indexOf(':');
    if (colon < 0) return null;
    return { kind: raw.slice(0, colon), parts: raw.slice(colon + 1).split('/') };
  } catch {
    return null;
  }
}

/** Opaque cursor for issue pagination: base64url of `cursor:<number>`. */
export function issueCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

export function parseIssueCursor(cursor: string): number | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!raw.startsWith('cursor:')) return null;
    const n = Number(raw.slice('cursor:'.length));
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** An HTTP error carrying a status and a JSON {message} body. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** True for a 40-hex object id. */
export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export const ZERO_OID = '0'.repeat(40);
