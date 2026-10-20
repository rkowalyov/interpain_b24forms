const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');

process.env.B24_LOADER_CDN_BASES = 'https://cdn.test.invalid/account';
process.env.B24_LOADER_CDN_TIMEOUT_MS = '10';
process.env.B24_LOADER_TOTAL_TIMEOUT_MS = '25';

const loaderHandler = require('../api/loader');
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function createResponse() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
}

test('loader endpoint stops when all CDN providers hang', async () => {
  global.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('CDN request aborted')), { once: true });
  });

  const response = createResponse();
  const startedAt = Date.now();
  await loaderHandler({ query: { formId: '739', ts: 'test' } }, response);

  assert.equal(response.statusCode, 502);
  assert.match(String(response.body), /loader proxy error/);
  assert.ok(Date.now() - startedAt < 500, 'loader should honor its total timeout budget');
});