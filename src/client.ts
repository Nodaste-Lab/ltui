import { createRequire } from 'node:module';
import path from 'node:path';
import { LinearClient } from '@linear/sdk';
import type { ResolvedConfig } from './config.js';

let cachedClient: any = null;
const requireFn = createRequire(import.meta.url);

export function createLinearClient(resolved: ResolvedConfig): LinearClient {
  if (cachedClient) return cachedClient;
  const mockModule = process.env.LTUI_TEST_CLIENT_MODULE;
  if (mockModule) {
    const resolvedPath = path.resolve(mockModule);
    const factory = requireFn(resolvedPath);
    if (typeof factory.createMockLinearClient !== 'function') {
      throw new Error('mock_error Invalid LTUI_TEST_CLIENT_MODULE');
    }
    cachedClient = factory.createMockLinearClient(resolved);
    return cachedClient;
  }
  if (!resolved.apiKey) {
    throw new Error('auth_missing No API key available for Linear client');
  }

  const rawExpireIn = process.env.LTUI_PUBLIC_FILE_URLS_EXPIRE_IN;
  const parsedExpireIn = rawExpireIn ? parseInt(rawExpireIn, 10) : NaN;
  const expireIn = Number.isFinite(parsedExpireIn) && parsedExpireIn > 0 ? parsedExpireIn : 60 * 60;

  // Request signed uploads.linear.app URLs so tools without custom headers can fetch files.
  cachedClient = new LinearClient({
    apiKey: resolved.apiKey,
    headers: {
      'public-file-urls-expire-in': String(expireIn),
    },
  });
  return cachedClient;
}
