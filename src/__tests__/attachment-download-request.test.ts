import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAttachmentDownloadRequest, downloadToDir } from '../commands/issues.js';

test('private Linear uploads use exactly one Bearer token and fail closed on redirects', () => {
  const request = buildAttachmentDownloadRequest(
    new URL('https://uploads.linear.app/workspace/file.png'),
    'Bearer Bearer lin_api_test'
  );

  assert.deepEqual(request, {
    headers: { Authorization: 'Bearer lin_api_test' },
    redirect: 'error',
  });
});

test('authenticated downloads pass fail-closed redirect policy to the fetch seam', async () => {
  const downloadDir = mkdtempSync(path.join(os.tmpdir(), 'ltui-attachment-download-'));
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response('', {
      status: 302,
      headers: { location: 'https://example.com/redirect-target' },
    });
  };

  try {
    const result = await downloadToDir('https://uploads.linear.app/workspace/file.png', downloadDir, {
      overwrite: false,
      apiKey: 'lin_api_test',
      suggestedBaseName: 'file',
      validateImage: false,
    });

    assert.equal(result.downloadStatus, 'failed');
    assert.equal(result.downloadError, 'http_302');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init?.redirect, 'error');
    assert.deepEqual(calls[0].init?.headers, { Authorization: 'Bearer lin_api_test' });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(downloadDir, { recursive: true, force: true });
  }
});

test('only the exact private upload origin receives authorization', () => {
  const urls = [
    'http://uploads.linear.app/workspace/file.png',
    'https://uploads.linear.app:444/workspace/file.png',
    'https://uploads.linear.app.example.com/workspace/file.png',
    'https://example.com/workspace/file.png',
  ];

  for (const url of urls) {
    const request = buildAttachmentDownloadRequest(new URL(url), 'lin_api_test');
    assert.deepEqual(request, { headers: {} }, url);
  }
});
