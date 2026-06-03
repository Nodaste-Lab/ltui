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

function headerValue(headers: HeadersLike | Record<string, string>, name: string): string | null {
  if (typeof (headers as HeadersLike).get === 'function') {
    return (headers as HeadersLike).get?.(name) ?? null;
  }
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
}
