const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');

process.env.B24_WEBHOOK_URL = 'https://example.bitrix24.ru/rest/1/test-token';
process.env.EVENT_API_TIMEOUT_MS = '25';

const { createEventHandler } = require('../lib/bitrix-event-api');
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test('event endpoint returns a bounded error when Bitrix never responds', async () => {
  global.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  const response = createResponse();
  await createEventHandler()({ method: 'GET', query: { id: '329' } }, response);

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.code, 'UPSTREAM_TIMEOUT');
  assert.match(response.body.error, /timed out/);
});

test('event endpoint returns normalized event data when Bitrix responds', async () => {
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      result: {
        item: {
          id: 329,
          ufCrm21EventState: 1111,
          ufCrm21_1739459683: 'OPEN',
          ufCrm21DpoName: 'Test event',
          ufCrm21EventAddr: 'г. Москва, ул. Тестовая'
        }
      }
    })
  });

  const response = createResponse();
  await createEventHandler()({ method: 'GET', query: { id: '329' } }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.id, 329);
  assert.equal(response.body.registrationOpen, true);
  assert.equal(response.body.city, 'Москва');
});