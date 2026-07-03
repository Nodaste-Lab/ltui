import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveConfig, type ResolvedConfig } from './config.js';

export interface LinearBudgetIdentity {
  apiKey?: string | null;
  workspaceId?: string | null;
  endpoint?: string | null;
}

export interface RateLimitInfo {
  requests: {
    limit: string | null;
    remaining: string | null;
    reset: string | null;
  };
  complexity: {
    limit: string | null;
    remaining: string | null;
  };
}

type HeadersLike = {
  get?: (name: string) => string | null;
};

const HEADER_KEYS = {
  requestsLimit: 'x-ratelimit-requests-limit',
  requestsRemaining: 'x-ratelimit-requests-remaining',
  requestsReset: 'x-ratelimit-requests-reset',
  complexityLimit: 'x-ratelimit-complexity-limit',
  complexityRemaining: 'x-ratelimit-complexity-remaining',
};

export function extractRateLimitInfo(headers: HeadersLike | Record<string, string> | undefined): RateLimitInfo | undefined {
  if (!headers) return undefined;
  const info: RateLimitInfo = {
    requests: {
      limit: headerValue(headers, HEADER_KEYS.requestsLimit),
      remaining: headerValue(headers, HEADER_KEYS.requestsRemaining),
      reset: headerValue(headers, HEADER_KEYS.requestsReset),
    },
    complexity: {
      limit: headerValue(headers, HEADER_KEYS.complexityLimit),
      remaining: headerValue(headers, HEADER_KEYS.complexityRemaining),
    },
  };
  if (
    info.requests.limit === null &&
    info.requests.remaining === null &&
    info.requests.reset === null &&
    info.complexity.limit === null &&
    info.complexity.remaining === null
  ) {
    return undefined;
  }
  return info;
}

export function extractRateLimitInfoFromError(error: unknown): RateLimitInfo | undefined {
  const err = error as {
    raw?: { response?: { headers?: HeadersLike | Record<string, string> } };
    response?: { headers?: HeadersLike | Record<string, string> };
  };
  return extractRateLimitInfo(err?.raw?.response?.headers ?? err?.response?.headers);
}

export function formatRateLimitLine(info: RateLimitInfo): string {
  return [
    'RATE_LIMIT',
    `requestsLimit=${info.requests.limit ?? ''}`,
    `requestsRemaining=${info.requests.remaining ?? ''}`,
    `requestsReset=${info.requests.reset ?? ''}`,
    `complexityLimit=${info.complexity.limit ?? ''}`,
    `complexityRemaining=${info.complexity.remaining ?? ''}`,
  ].join(' ');
}

export function formatRateLimitBackoffHint(info: RateLimitInfo | undefined): string | undefined {
  if (!info) return undefined;
  const parts = [
    `requestsRemaining=${info.requests.remaining ?? ''}`,
    `requestsReset=${info.requests.reset ?? ''}`,
    `complexityRemaining=${info.complexity.remaining ?? ''}`,
  ];
  return `${parts.join(' ')}; wait until reset before retrying, and retry with a smaller --limit or narrower filters.`;
}

export function recordSharedLinearBudget(input: RateLimitInfo | unknown, identity?: LinearBudgetIdentity): void {
  const info = isRateLimitInfo(input) ? input : extractRateLimitInfoFromError(input);
  const stateFromError = rateLimitStateFromError(input);
  if (!info && !stateFromError) return;

  const budgetIdentity = identity ?? resolveBudgetIdentity();
  const now = new Date();
  const state = mergeBudgetState(readBudgetState(budgetIdentity), {
    schema_version: 1,
    linear_endpoint: endpointHost(budgetIdentity),
    workspace_key: workspaceKey(budgetIdentity),
    workspace_id: budgetIdentity.workspaceId ?? null,
    token_fingerprint: tokenFingerprint(budgetIdentity),
    request_limit: numberOrNull(info?.requests.limit),
    request_remaining: numberOrNull(info?.requests.remaining),
    complexity_limit: numberOrNull(info?.complexity.limit),
    complexity_remaining: numberOrNull(info?.complexity.remaining),
    reset_at: resetIso(info?.requests.reset) ?? stateFromError?.reset_at ?? null,
    backoff_until: stateFromError?.backoff_until ?? backoffFromInfo(info),
    source: 'ltui',
    reason: stateFromError?.reason ?? null,
    updated_at: now.toISOString(),
  });

  writeBudgetState(state, budgetIdentity);
}

export function warnIfSharedLinearBackoffActive(identity?: LinearBudgetIdentity): void {
  const state = readBudgetState(identity ?? resolveBudgetIdentity());
  if (!state?.backoff_until) return;
  const until = Date.parse(state.backoff_until);
  if (Number.isFinite(until) && until > Date.now()) {
    process.stderr.write(`LINEAR_BUDGET_BACKOFF backoffUntil=${state.backoff_until} source=${state.source ?? ''}\n`);
  }
}

function headerValue(headers: HeadersLike | Record<string, string>, name: string): string | null {
  if (typeof (headers as HeadersLike).get === 'function') {
    return (headers as HeadersLike).get?.(name) ?? null;
  }
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
}

function isRateLimitInfo(value: unknown): value is RateLimitInfo {
  return !!value && typeof value === 'object' && 'requests' in value && 'complexity' in value;
}

function rateLimitStateFromError(error: unknown): { reason: string; reset_at: string | null; backoff_until: string } | null {
  const message = String((error as Error)?.message ?? error ?? '');
  if (!/rate.?limit/i.test(message)) return null;
  const resetAt = resetIso(extractRateLimitInfoFromError(error)?.requests.reset);
  const backoffUntil = resetAt ?? new Date(Date.now() + 15 * 60 * 1000).toISOString();
  return { reason: message.slice(0, 300), reset_at: resetAt, backoff_until: backoffUntil };
}

function backoffFromInfo(info: RateLimitInfo | undefined): string | null {
  if (!info) return null;
  if (info.requests.remaining === '0' || info.complexity.remaining === '0') {
    return resetIso(info.requests.reset) ?? new Date(Date.now() + 15 * 60 * 1000).toISOString();
  }
  return null;
}

export function linearBudgetIdentityFromResolvedConfig(resolved: ResolvedConfig): LinearBudgetIdentity {
  return {
    apiKey: resolved.apiKey ?? null,
    workspaceId: process.env.LINEAR_WORKSPACE_ID ?? resolved.config.profiles?.[resolved.profileName]?.workspace ?? null,
    endpoint: process.env.LINEAR_API_URL ?? null,
  };
}

function resolveBudgetIdentity(): LinearBudgetIdentity {
  try {
    return linearBudgetIdentityFromResolvedConfig(resolveConfig(profileFromArgv() ?? process.env.LTUI_PROFILE));
  } catch {
    return {
      apiKey: process.env.LINEAR_API_KEY ?? null,
      workspaceId: process.env.LINEAR_WORKSPACE_ID ?? null,
      endpoint: process.env.LINEAR_API_URL ?? null,
    };
  }
}

function profileFromArgv(): string | undefined {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--profile') return args[index + 1];
    if (arg?.startsWith('--profile=')) return arg.slice('--profile='.length);
  }
  return undefined;
}

function sharedBudgetPath(identity: LinearBudgetIdentity): string {
  if (process.env.LINEAR_BUDGET_STATE_PATH) return path.resolve(process.env.LINEAR_BUDGET_STATE_PATH);
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? '.', '.local', 'state');
  return path.join(stateHome, 'linear', 'budget-v1', endpointHost(identity), workspaceKey(identity), `${tokenFingerprint(identity)}.json`);
}

function endpointHost(identity: LinearBudgetIdentity): string {
  const endpoint = identity.endpoint ?? process.env.LINEAR_API_URL ?? 'https://api.linear.app/graphql';
  try {
    return new URL(endpoint).host || 'unknown';
  } catch {
    return 'unknown';
  }
}

function workspaceKey(identity: LinearBudgetIdentity): string {
  return identity.workspaceId ?? process.env.LINEAR_WORKSPACE_ID ?? 'unknown';
}

function tokenFingerprint(identity: LinearBudgetIdentity): string {
  return crypto.createHash('sha256').update(identity.apiKey ?? process.env.LINEAR_API_KEY ?? '').digest('hex').slice(0, 12);
}

function readBudgetState(identity: LinearBudgetIdentity): Record<string, any> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(sharedBudgetPath(identity), 'utf8'));
    return parsed?.schema_version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function writeBudgetState(state: Record<string, any>, identity: LinearBudgetIdentity): void {
  const file = sharedBudgetPath(identity);
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp); } catch {}
  }
}

function mergeBudgetState(current: Record<string, any> | null, next: Record<string, any>): Record<string, any> {
  if (!current) return next;
  const currentReset = timeMillis(current.reset_at);
  const nextReset = timeMillis(next.reset_at);
  const newerResetWindow = nextReset !== null && (currentReset === null || nextReset > currentReset);
  return {
    ...current,
    ...next,
    request_remaining: newerResetWindow
      ? next.request_remaining ?? current.request_remaining ?? null
      : lowerNumber(current.request_remaining, next.request_remaining),
    complexity_remaining: newerResetWindow
      ? next.complexity_remaining ?? current.complexity_remaining ?? null
      : lowerNumber(current.complexity_remaining, next.complexity_remaining),
    reset_at: newerResetWindow ? next.reset_at : earlierTime(current.reset_at, next.reset_at),
    backoff_until: newerResetWindow ? next.backoff_until ?? null : laterTime(current.backoff_until, next.backoff_until),
  };
}

function lowerNumber(left: any, right: any): number | null {
  const values = [left, right].filter(value => typeof value === 'number');
  return values.length ? Math.min(...values) : null;
}

function earlierTime(left: any, right: any): string | null {
  if (!left) return right ?? null;
  if (!right) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function laterTime(left: any, right: any): string | null {
  if (!left) return right ?? null;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function timeMillis(value: any): number | null {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function numberOrNull(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resetIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    return new Date(millis).toISOString();
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}
