import fs from 'node:fs';
import path from 'node:path';

const serverDir = path.resolve('..', 'server');

const testCode = `import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestHandler } from './server.js';
import { EventEmitter } from 'node:events';

class MockRequest extends EventEmitter {
  constructor({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    this._body = body;
  }
}

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.body = '';
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = { ...this.headers, ...headers };
    return this;
  }

  end(chunk) {
    if (chunk) this.body += chunk;
    this.emit('finish');
    return this;
  }
}

async function invokeHandler(handler, { method = 'GET', url = '/', headers = {}, body = null } = {}) {
  const req = new MockRequest({ method, url, headers, body });
  const res = new MockResponse();

  const promise = new Promise((resolve) => {
    res.on('finish', () => {
      let json = null;
      try { json = JSON.parse(res.body); } catch {}
      resolve({ status: res.statusCode, headers: res.headers, body: res.body, json });
    });
  });

  handler(req, res);

  if (body !== null && body !== undefined) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    req.emit('data', raw);
  }
  req.emit('end');

  return promise;
}

function createMockFetch(handlers = {}) {
  const calls = [];
  const mock = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', headers: options.headers || {}, body: options.body });
    for (const [pattern, responder] of Object.entries(handlers)) {
      if (url.includes(pattern)) {
        return responder(url, options);
      }
    }
    // Default fallback 404
    return {
      status: 404,
      ok: false,
      text: async () => JSON.stringify({ code: 'not_found', message: 'Not found' }),
      json: async () => ({ code: 'not_found', message: 'Not found' })
    };
  };
  mock.calls = calls;
  return mock;
}

describe('OllaChat Trusted Backend Tests', () => {
  const TEST_API_KEY = 'ak_test_secret_key_999999999999';

  test('1. Missing Authorization header -> 401', async () => {
    const handler = createRequestHandler({ apiKey: TEST_API_KEY });
    const res = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/v1/rooms/room_1/members',
      headers: {},
      body: { user_id: 'u_target' }
    });

    assert.equal(res.status, 401);
    assert.equal(res.json.code, 'unauthorized');
    assert.match(res.json.message, /Missing Authorization/);
  });

  test('2. Invalid du_ session -> 401', async () => {
    const mockFetch = createMockFetch({
      '/directory/me': () => ({
        status: 401,
        ok: false,
        text: async () => JSON.stringify({ code: 'unauthorized', message: 'Invalid session' }),
        json: async () => ({ code: 'unauthorized', message: 'Invalid session' })
      })
    });

    const handler = createRequestHandler({ apiKey: TEST_API_KEY, fetchFn: mockFetch });
    const res = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/v1/rooms/room_1/members',
      headers: { authorization: 'Bearer du_invalid' },
      body: { user_id: 'u_target' }
    });

    assert.equal(res.status, 401);
    assert.equal(res.json.code, 'unauthorized');
    assert.match(res.json.message, /Invalid or expired session/);
  });

  test('3. Normal member attempting Add -> 403', async () => {
    const mockFetch = createMockFetch({
      '/directory/me': () => ({
        status: 200,
        ok: true,
        json: async () => ({ user_id: 'caller_alice' })
      }),
      '/token': () => ({
        status: 200,
        ok: true,
        json: async () => ({ access_token: 'rt_token_alice' })
      }),
      '/participants': () => ({
        status: 200,
        ok: true,
        json: async () => ({
          participants: [
            { principal_id: 'caller_alice', role: 'member' },
            { principal_id: 'owner_bob', role: 'owner' }
          ]
        })
      })
    });

    const handler = createRequestHandler({ apiKey: TEST_API_KEY, fetchFn: mockFetch });
    const res = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/v1/rooms/room_1/members',
      headers: { authorization: 'Bearer du_alice' },
      body: { user_id: 'u_target' }
    });

    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'forbidden');
    assert.match(res.json.message, /Only group owners or admins/);
  });

  test('4. Normal member attempting Remove -> 403', async () => {
    const mockFetch = createMockFetch({
      '/directory/me': () => ({
        status: 200,
        ok: true,
        json: async () => ({ user_id: 'caller_alice' })
      }),
      '/token': () => ({
        status: 200,
        ok: true,
        json: async () => ({ access_token: 'rt_token_alice' })
      }),
      '/participants': () => ({
        status: 200,
        ok: true,
        json: async () => ({
          participants: [
            { principal_id: 'caller_alice', role: 'member' }
          ]
        })
      })
    });

    const handler = createRequestHandler({ apiKey: TEST_API_KEY, fetchFn: mockFetch });
    const res = await invokeHandler(handler, {
      method: 'DELETE',
      url: '/api/v1/rooms/room_1/members/target_user',
      headers: { authorization: 'Bearer du_alice' }
    });

    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'forbidden');
    assert.match(res.json.message, /Only group owners or admins/);
  });

  test('5. Owner Add -> backend calls OllaCore Customer Server API with ak_ key', async () => {
    let serverApiCalled = false;
    let authHeaderSent = '';
    let bodySent = '';

    const mockFetch = createMockFetch({
      '/directory/me': () => ({
        status: 200,
        ok: true,
        json: async () => ({ user_id: 'caller_owner' })
      }),
      '/token': () => ({
        status: 200,
        ok: true,
        json: async () => ({ access_token: 'rt_owner' })
      }),
      '/participants': () => ({
        status: 200,
        ok: true,
        json: async () => ({
          participants: [
            { principal_id: 'caller_owner', role: 'owner' }
          ]
        })
      }),
      '/server/rooms/room_1/members': (url, opts) => {
        serverApiCalled = true;
        authHeaderSent = opts.headers?.Authorization || opts.headers?.authorization;
        bodySent = opts.body;
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ success: true }),
          json: async () => ({ success: true })
        };
      }
    });

    const handler = createRequestHandler({ apiKey: TEST_API_KEY, fetchFn: mockFetch });
    const res = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/v1/rooms/room_1/members',
      headers: { authorization: 'Bearer du_owner' },
      body: { user_id: 'new_member_123' }
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
    assert.equal(serverApiCalled, true);
    assert.equal(authHeaderSent, \`Bearer \${TEST_API_KEY}\`);
    assert.deepEqual(JSON.parse(bodySent), { user_id: 'new_member_123' });
  });

  test('6. Admin Add -> backend calls OllaCore Customer Server API', async () => {
    let serverApiCalled = false;

    const mockFetch = createMockFetch({
      '/directory/me': () => ({
        status: 200,
        ok: true,
        json: async () => ({ user_id: 'caller_admin' })
      }),
      '/token': () => ({
        status: 200,
        ok: true,
        json: async () => ({ access_token: 'rt_admin' })
      }),
      '/participants': () => ({
        status: 200,
        ok: true,
        json: async () => ({
          participants: [
            { principal_id: 'caller_admin', role: 'admin' }
          ]
        })
      }),
      '/server/rooms/room_1/members': () => {
        serverApiCalled = true;
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ success: true }),
          json: async () => ({ success: true })
        };
      }
    });

    const handler = createRequestHandler({ apiKey: TEST_API_KEY, fetchFn: mockFetch });
    const res = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/v1/rooms/room_1/members',
      headers: { authorization: 'Bearer du_admin' },
      body: { user_id: 'new_member_456' }
    });

    assert.equal(res.status, 200);
    assert.equal(serverApiCalled, true);
  });

  test('7. Owner Remove -> backend calls OllaCore Customer Server API with DELETE', async () => {
    let serverDeleteCalled = false;
    let authHeaderSent = '';
    let targetUrlCalled = '';

    const mockFetch = createMockFetch({
      '/directory/me': () => ({
        status: 200,
        ok: true,
        json: async () => ({ user_id: 'caller_owner' })
      }),
      '/token': () => ({
        status: 200,
        ok: true,
        json: async () => ({ access_token: 'rt_owner' })
      }),
      '/participants': () => ({
        status: 200,
        ok: true,
        json: async () => ({
          participants: [
            { principal_id: 'caller_owner', role: 'owner' },
            { principal_id: 'victim_user', role: 'member' }
          ]
        })
      }),
      '/server/rooms/room_1/members/victim_user': (url, opts) => {
        serverDeleteCalled = true;
        targetUrlCalled = url;
        authHeaderSent = opts.headers?.Authorization || opts.headers?.authorization;
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ success: true }),
          json: async () => ({ success: true })
        };
      }
    });

    const handler = createRequestHandler({ apiKey: TEST_API_KEY, fetchFn: mockFetch });
    const res = await invokeHandler(handler, {
      method: 'DELETE',
      url: '/api/v1/rooms/room_1/members/victim_user',
      headers: { authorization: 'Bearer du_owner' }
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
    assert.equal(serverDeleteCalled, true);
    assert.match(targetUrlCalled, /\\/server\\/rooms\\/room_1\\/members\\/victim_user/);
    assert.equal(authHeaderSent, \`Bearer \${TEST_API_KEY}\`);
  });

  test('8. Admin Remove -> backend calls OllaCore Customer Server API', async () => {
    let serverDeleteCalled = false;

    const mockFetch = createMockFetch({
      '/directory/me': () => ({
        status: 200,
        ok: true,
        json: async () => ({ user_id: 'caller_admin' })
      }),
      '/token': () => ({
        status: 200,
        ok: true,
        json: async () => ({ access_token: 'rt_admin' })
      }),
      '/participants': () => ({
        status: 200,
        ok: true,
        json: async () => ({
          participants: [
            { principal_id: 'caller_admin', role: 'admin' },
            { principal_id: 'victim_user', role: 'member' }
          ]
        })
      }),
      '/server/rooms/room_1/members/victim_user': () => {
        serverDeleteCalled = true;
        return {
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ success: true }),
          json: async () => ({ success: true })
        };
      }
    });

    const handler = createRequestHandler({ apiKey: TEST_API_KEY, fetchFn: mockFetch });
    const res = await invokeHandler(handler, {
      method: 'DELETE',
      url: '/api/v1/rooms/room_1/members/victim_user',
      headers: { authorization: 'Bearer du_admin' }
    });

    assert.equal(res.status, 200);
    assert.equal(serverDeleteCalled, true);
  });

  test('9. OllaCore mutation failure -> propagated safely with status code', async () => {
    const mockFetch = createMockFetch({
      '/directory/me': () => ({
        status: 200,
        ok: true,
        json: async () => ({ user_id: 'caller_admin' })
      }),
      '/token': () => ({
        status: 200,
        ok: true,
        json: async () => ({ access_token: 'rt_admin' })
      }),
      '/participants': () => ({
        status: 200,
        ok: true,
        json: async () => ({
          participants: [
            { principal_id: 'caller_admin', role: 'admin' }
          ]
        })
      }),
      '/server/rooms/room_1/members': () => ({
        status: 404,
        ok: false,
        text: async () => JSON.stringify({ code: 'not_found', message: 'Room does not exist' }),
        json: async () => ({ code: 'not_found', message: 'Room does not exist' })
      })
    });

    const handler = createRequestHandler({ apiKey: TEST_API_KEY, fetchFn: mockFetch });
    const res = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/v1/rooms/room_1/members',
      headers: { authorization: 'Bearer du_admin' },
      body: { user_id: 'target' }
    });

    assert.equal(res.status, 404);
    assert.equal(res.json.code, 'not_found');
    assert.equal(res.json.message, 'Room does not exist');
  });

  test('10. ak_ never appears in client response body or headers', async () => {
    const mockFetch = createMockFetch({
      '/directory/me': () => ({
        status: 200,
        ok: true,
        json: async () => ({ user_id: 'caller_admin' })
      }),
      '/token': () => ({
        status: 200,
        ok: true,
        json: async () => ({ access_token: 'rt_admin' })
      }),
      '/participants': () => ({
        status: 200,
        ok: true,
        json: async () => ({
          participants: [{ principal_id: 'caller_admin', role: 'admin' }]
        })
      }),
      '/server/rooms/room_1/members': () => ({
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ success: true, debug_server_key: TEST_API_KEY }),
        json: async () => ({ success: true })
      })
    });

    const handler = createRequestHandler({ apiKey: TEST_API_KEY, fetchFn: mockFetch });
    const res = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/v1/rooms/room_1/members',
      headers: { authorization: 'Bearer du_admin' },
      body: { user_id: 'target' }
    });

    assert.equal(res.body.includes(TEST_API_KEY), false, 'ak_ secret key must NEVER appear in response body');
    const allHeaders = JSON.stringify(res.headers);
    assert.equal(allHeaders.includes(TEST_API_KEY), false, 'ak_ secret key must NEVER appear in response headers');
  });

  test('11. Missing OLLACORE_SERVER_API_KEY fails safely with 500', async () => {
    const mockFetch = createMockFetch({
      '/directory/me': () => ({
        status: 200,
        ok: true,
        json: async () => ({ user_id: 'caller_admin' })
      }),
      '/token': () => ({
        status: 200,
        ok: true,
        json: async () => ({ access_token: 'rt_admin' })
      }),
      '/participants': () => ({
        status: 200,
        ok: true,
        json: async () => ({
          participants: [{ principal_id: 'caller_admin', role: 'admin' }]
        })
      })
    });

    // Explicitly pass empty apiKey
    const handler = createRequestHandler({ apiKey: '', fetchFn: mockFetch });
    const res = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/v1/rooms/room_1/members',
      headers: { authorization: 'Bearer du_admin' },
      body: { user_id: 'target' }
    });

    assert.equal(res.status, 500);
    assert.equal(res.json.code, 'server_misconfigured');
  });

  test('12. Invalid request body -> 400', async () => {
    const mockFetch = createMockFetch({
      '/directory/me': () => ({
        status: 200,
        ok: true,
        json: async () => ({ user_id: 'caller_admin' })
      }),
      '/token': () => ({
        status: 200,
        ok: true,
        json: async () => ({ access_token: 'rt_admin' })
      }),
      '/participants': () => ({
        status: 200,
        ok: true,
        json: async () => ({
          participants: [{ principal_id: 'caller_admin', role: 'admin' }]
        })
      })
    });

    const handler = createRequestHandler({ apiKey: TEST_API_KEY, fetchFn: mockFetch });
    // Empty body
    const res = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/v1/rooms/room_1/members',
      headers: { authorization: 'Bearer du_admin' },
      body: {}
    });

    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'bad_request');
  });

  test('13. Health endpoint -> 200 ok', async () => {
    const handler = createRequestHandler({ apiKey: TEST_API_KEY });
    const res = await invokeHandler(handler, {
      method: 'GET',
      url: '/health'
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'ok');
  });
});
`;

fs.writeFileSync(path.join(serverDir, 'server.test.js'), testCode, 'utf8');
console.log('Successfully wrote ../server/server.test.js');
