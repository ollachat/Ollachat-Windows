import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatWebSocket, CONNECTION_STATE } from '../src/chat/chat-websocket.js';
import { OutboxManager } from '../src/renderer/outbox-manager.js';

test('1. reconnectAll breaks pending exponential backoff and initiates reconnect immediately', async () => {
  let instancesCreated = 0;
  class MockSocket {
    constructor(url, protocols) {
      instancesCreated++;
      this.url = url;
      this.protocols = protocols;
      this.onopen = null;
      this.onclose = null;
      this.onerror = null;
      this.onmessage = null;
    }
    close() {
      if (this.onclose) this.onclose({ code: 1006, reason: 'Abrupt drop' });
    }
  }

  const ws = new ChatWebSocket({
    multiRoom: true,
    WebSocketClass: MockSocket,
    maxReconnectAttempts: 10,
    getToken: async (roomId) => `token_fresh_${roomId}`
  });

  try {
    // Connect room 1
    const entry = await ws.connectRoom('room_1', { token: 'token_initial_1' });
    assert.ok(entry);
    assert.equal(instancesCreated, 1);

    // Trigger unexpected drop
    entry.socket.close();
    assert.equal(entry.state, CONNECTION_STATE.RECONNECTING);
    assert.ok(entry.reconnectTimer, 'reconnect timer must be scheduled');

    // Call reconnectAll with resetBackoff
    ws.reconnectAll({ forceTokenRefresh: true, resetBackoff: true });
    await new Promise((r) => setImmediate(r));

    // Verify reconnect timer was cleared and a new socket instance was created immediately
    assert.equal(entry.reconnectAttempts, 0);
    assert.equal(instancesCreated, 2, 'New socket must be created immediately without waiting for backoff timer');
    assert.equal(entry.state, CONNECTION_STATE.CONNECTING);
  } finally {
    ws.disconnect();
  }
});

test('2. _handleRoomUnexpectedClose does not abort reconnect loop if token resolution fails offline', async () => {
  let tokenFetchCount = 0;

  class MockSocket {
    constructor() {
      this.onclose = null;
    }
    close() {
      if (this.onclose) this.onclose({ code: 1006, reason: 'Network lost' });
    }
  }

  const ws = new ChatWebSocket({
    multiRoom: true,
    WebSocketClass: MockSocket,
    maxReconnectAttempts: 5,
    getToken: async () => {
      tokenFetchCount++;
      if (tokenFetchCount === 1) {
        return 'valid_token_1';
      }
      return null;
    }
  });

  try {
    const entry = await ws.connectRoom('room_offline', { token: 'valid_token_1' });
    assert.ok(entry);

    // Simulate network drop
    entry.socket.close();
    assert.equal(entry.state, CONNECTION_STATE.RECONNECTING);
    assert.ok(entry.reconnectTimer);

    // Even if token retrieval returns null, reconnect attempt is maintained
    await ws.connectRoom('room_offline', { token: null, forceTokenRefresh: true });
    assert.ok(entry.state === CONNECTION_STATE.RECONNECTING || entry.state === CONNECTION_STATE.CONNECTING);
  } finally {
    ws.disconnect();
  }
});

test('3. Aggregate state in multiRoom mode emits roomId: null for global connection indicator', async () => {
  class MockSocket {
    constructor() {
      this.onopen = null;
      this.onclose = null;
    }
    open() {
      if (this.onopen) this.onopen();
    }
  }

  const ws = new ChatWebSocket({
    multiRoom: true,
    WebSocketClass: MockSocket,
    getToken: async (rId) => `token_${rId}`
  });

  try {
    const stateChanges = [];
    ws.on('stateChange', (evt) => {
      stateChanges.push(evt);
    });

    const entry = await ws.connectRoom('room_abc', { token: 'tok_abc' });
    entry.socket.open();

    // Find the aggregate stateChange event
    const aggregateEvent = stateChanges.find((e) => e.state === CONNECTION_STATE.CONNECTED && e.roomId === null);
    assert.ok(aggregateEvent, 'Aggregate state change must emit roomId: null so any selected room recognizes global connection');

    // Find room-specific event
    const roomSpecificEvent = stateChanges.find((e) => e.state === CONNECTION_STATE.CONNECTED && e.roomId === 'room_abc');
    assert.ok(roomSpecificEvent, 'Room-specific state change must emit the exact roomId');
  } finally {
    ws.disconnect();
  }
});

test('4. OutboxManager flush waits for in-progress WebSocket handshake before aborting', async () => {
  let wsState = 'connecting';
  const fakeChat = {
    getState: async () => wsState,
    send: async (type, payload) => ({ ok: true, requestId: 'req_123' })
  };

  const fakeDb = {
    getPendingOutbox: async () => [
      {
        client_message_id: 'cid_test_flush',
        room_id: 'room_1',
        payload_json: JSON.stringify({ wirePayload: { text: 'Hello after reconnect' }, roomId: 'room_1' }),
        retry_count: 0
      }
    ],
    updatePendingOutboxAttempt: async () => {},
    clearPendingOutbox: async () => {}
  };

  const manager = new OutboxManager();

  // Simulate handshake completing 300ms after flush starts
  const handshakeTimer = setTimeout(() => {
    wsState = 'connected';
  }, 300);

  try {
    const sent = await manager.flush({
      chatBridge: fakeChat,
      dbBridge: fakeDb
    });

    assert.equal(sent, 1, 'Outbox flush must wait for active handshake to complete and send queued items');
  } finally {
    clearTimeout(handshakeTimer);
  }
});
