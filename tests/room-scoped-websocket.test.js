import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChatWebSocket, CONNECTION_STATE } from '../src/chat/chat-websocket.js';
import { ChatApi } from '../src/api/chat-api.js';

class MockWebSocket {
  static instances = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sentData = [];
    this.closed = false;
    this.closeCode = null;
    this.closeReason = null;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    MockWebSocket.instances.push(this);
  }

  simulateOpen() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }

  send(data) {
    this.sentData.push(data);
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    if (this.onclose) this.onclose({ code, reason });
  }
}

describe('Room-Scoped WebSocket Architecture & Lifecycle', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
  });

  // Requirement 10A: Authenticated startup does NOT create a global Chat WebSocket
  test('A. Authenticated startup does NOT create a global Chat WebSocket (idle when no room is selected)', async () => {
    // When initialized without a room, WebSocket should be disconnected and not attempt socket instantiation
    const ws = new ChatWebSocket({
      WebSocketClass: MockWebSocket,
      getToken: async (roomId) => {
        if (!roomId) return null;
        return `rt_token_for_${roomId}`;
      }
    });

    assert.equal(ws.state, CONNECTION_STATE.DISCONNECTED);
    assert.equal(ws.roomId, null);

    // If connect() is called without a room or token, it must not create a WebSocket instance
    await ws.connect();
    assert.equal(MockWebSocket.instances.length, 0);
    assert.equal(ws.state, CONNECTION_STATE.ERROR);
  });

  // Requirement 10B & 10C & 10D: Selecting a room obtains a room token and connects WebSocket with that token
  test('B, C, D. Selecting a room connects WebSocket with room token and protocol chatbox, bearer.<room-token>', async () => {
    const mockRoomToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.room_token_alpha.sig';
    const ws = new ChatWebSocket({
      WebSocketClass: MockWebSocket
    });

    await ws.connect({
      roomId: 'room_123',
      token: mockRoomToken,
      url: 'wss://api.ollacore.com/v1/chat/ws'
    });

    assert.equal(ws.roomId, 'room_123');
    assert.equal(MockWebSocket.instances.length, 1);
    const socket = MockWebSocket.instances[0];
    assert.equal(socket.url, 'wss://api.ollacore.com/v1/chat/ws');
    assert.deepEqual(socket.protocols, ['chatbox', `bearer.${mockRoomToken}`]);

    socket.simulateOpen();
    assert.equal(ws.state, CONNECTION_STATE.CONNECTED);
    ws.disconnect();
  });

  // Requirement 10E: du_ token is never used as the WebSocket bearer token
  test('E. du_ token is never used as the WebSocket bearer token (fails with clear rejection)', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room_xyz',
      token: 'du_directory_session_token_abc123',
      WebSocketClass: MockWebSocket
    });

    let caughtError = null;
    ws.on('error', (err) => { caughtError = err; });

    await ws.connect();

    assert.equal(ws.state, CONNECTION_STATE.ERROR);
    assert.equal(MockWebSocket.instances.length, 0);
    assert.ok(caughtError);
    assert.match(caughtError.message, /Cannot connect ChatWebSocket with Directory session token; room access token required/i);
  });

  // Requirement 10F: Switching Room A -> Room B disconnects Room A and connects Room B
  test('F. Switching Room A -> Room B disconnects Room A and connects Room B', async () => {
    const ws = new ChatWebSocket({
      WebSocketClass: MockWebSocket
    });

    // Step 1: Connect to Room A
    await ws.connect({
      roomId: 'room_A',
      token: 'rt_token_A',
      url: 'wss://api.ollacore.com/v1/chat/ws'
    });

    assert.equal(MockWebSocket.instances.length, 1);
    const socketA = MockWebSocket.instances[0];
    socketA.simulateOpen();
    assert.equal(ws.state, CONNECTION_STATE.CONNECTED);
    assert.equal(ws.roomId, 'room_A');

    // Step 2: Switch to Room B
    await ws.connect({
      roomId: 'room_B',
      token: 'rt_token_B',
      url: 'wss://api.ollacore.com/v1/chat/ws'
    });

    // Room A socket must be closed cleanly
    assert.ok(socketA.closed);
    assert.equal(socketA.closeCode, 1000);

    // Room B socket must be newly created
    assert.equal(MockWebSocket.instances.length, 2);
    const socketB = MockWebSocket.instances[1];
    assert.equal(ws.roomId, 'room_B');
    assert.deepEqual(socketB.protocols, ['chatbox', 'bearer.rt_token_B']);

    socketB.simulateOpen();
    assert.equal(ws.state, CONNECTION_STATE.CONNECTED);
    ws.disconnect();
  });

  // Requirement 10G: Expired room token causes token refresh
  test('G. Expired room token causes token refresh via RoomTokenCache / ChatApi', async () => {
    let fetchCount = 0;
    const mockFetch = async (url) => {
      fetchCount++;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: `rt_token_v${fetchCount}`,
          expires_at: new Date(Date.now() - 5000).toISOString(), // already expired
          chat_websocket_url: 'wss://api.ollacore.com/v1/chat/ws'
        })
      };
    };

    const chatApi = new ChatApi({ fetchFn: mockFetch });

    // First resolution: fetches token v1
    const token1 = await chatApi.resolveRoomToken('du_sess', 'room_test', 'device_1');
    assert.equal(token1, 'rt_token_v1');
    assert.equal(fetchCount, 1);

    // Second resolution: because expires_at was in the past, cache is evicted and it fetches fresh token v2
    const token2 = await chatApi.resolveRoomToken('du_sess', 'room_test', 'device_1');
    assert.equal(token2, 'rt_token_v2');
    assert.equal(fetchCount, 2);
  });

  // Requirement 10H: Logout disconnects the active room socket
  test('H. Logout disconnects the active room socket cleanly', async () => {
    const ws = new ChatWebSocket({
      roomId: 'room_active',
      token: 'rt_active_token',
      WebSocketClass: MockWebSocket
    });

    await ws.connect();
    const socket = MockWebSocket.instances[0];
    socket.simulateOpen();
    assert.equal(ws.state, CONNECTION_STATE.CONNECTED);

    // Simulate logout action
    ws.disconnect();
    ws.roomId = null;
    ws._token = null;

    assert.equal(ws.state, CONNECTION_STATE.DISCONNECTED);
    assert.equal(ws.roomId, null);
    assert.ok(socket.closed);
    assert.equal(socket.closeCode, 1000);
  });
});
