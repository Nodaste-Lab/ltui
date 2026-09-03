import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAttachmentDownloadRequest,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_MAX_DOWNLOAD_BYTES,
  downloadToDir,
} from '../commands/issues.js';

const PRIVATE_UPLOAD = 'https://uploads.linear.app/workspace/file.png';
const KNOWN_CUSTOMER_ZIP_BYTES = 167_138_784;

test('personal API keys use a raw GraphQL Authorization header', () => {
  const request = buildAttachmentDownloadRequest(new URL(PRIVATE_UPLOAD), 'lin_api_test');

  assert.deepEqual(request, {
    headers: { Authorization: 'lin_api_test' },
    redirect: 'error',
  });
});

test('strips accidental Bearer prefixes from personal API keys', () => {
  const request = buildAttachmentDownloadRequest(
    new URL(PRIVATE_UPLOAD),
    'Bearer Bearer lin_api_test'
  );

  assert.deepEqual(request, {
    headers: { Authorization: 'lin_api_test' },
    redirect: 'error',
  });
});

test('OAuth tokens keep a single Bearer Authorization header', () => {
  const oauth = '00a21d8b0c4e2375114e49c067dfb81eb0d2076f48354714cd5df984d87b67cc';
  const request = buildAttachmentDownloadRequest(new URL(PRIVATE_UPLOAD), `Bearer ${oauth}`);

  assert.deepEqual(request, {
    headers: { Authorization: `Bearer ${oauth}` },
    redirect: 'error',
  });
});

test('authenticated downloads send the GraphQL-compatible header and fail closed on redirects', async () => {
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
    const result = await downloadToDir(PRIVATE_UPLOAD, downloadDir, {
      overwrite: false,
      apiKey: 'lin_api_test',
      suggestedBaseName: 'file',
      validateImage: false,
    });

    assert.equal(result.downloadStatus, 'failed');
    assert.equal(result.downloadError, 'http_302');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init?.redirect, 'error');
    assert.deepEqual(calls[0].init?.headers, { Authorization: 'lin_api_test' });
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

test('HTTP 206 partial content is a successful download', async () => {
  const downloadDir = mkdtempSync(path.join(os.tmpdir(), 'ltui-attachment-download-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('zip-bytes', {
      status: 206,
      headers: { 'content-type': 'application/zip' },
    });

  try {
    const result = await downloadToDir(
      'https://uploads.linear.app/workspace/bundle',
      downloadDir,
      {
        overwrite: false,
        apiKey: 'lin_api_test',
        suggestedBaseName: 'Heddle Nodaste quarantine support bundle',
        validateImage: false,
      }
    );

    assert.equal(result.downloadStatus, 'downloaded');
    assert.equal(result.downloadError, '');
    assert.match(result.downloadPath, /\.zip$/);
    assert.equal(readFileSync(result.downloadPath, 'utf8'), 'zip-bytes');
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(downloadDir, { recursive: true, force: true });
  }
});

test('download limits cover the known customer zip', () => {
  assert.ok(
    DEFAULT_MAX_DOWNLOAD_BYTES >= KNOWN_CUSTOMER_ZIP_BYTES,
    `max download bytes ${DEFAULT_MAX_DOWNLOAD_BYTES} cannot fit ${KNOWN_CUSTOMER_ZIP_BYTES}`
  );
  assert.ok(
    DEFAULT_DOWNLOAD_TIMEOUT_MS > 30_000,
    `download timeout ${DEFAULT_DOWNLOAD_TIMEOUT_MS} is still the 30s value that cannot finish a 159 MiB transfer`
  );
});
