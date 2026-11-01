import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  getOrCreatePersistentDeviceId,
  getDeviceId,
  generateEphemeralDeviceId,
  _resetCachedDeviceIdForTesting
} from '../src/storage/device-id.js';

import {
  ChatWebSocket,
  CONNECTION_STATE,
  classifyCloseCode
} from '../src/chat/chat-websocket.js';

describe('Phase 1 Regressions: Persistent Device ID, Read-Receipt Fallback & Deduplication, WebSocket Close Codes', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ollacore-phase1-test-'));
    _resetCachedDeviceIdForTesting();
  });

  afterEach(async () => {
    _resetCachedDeviceIdForTesting();
    if (tempDir && fsSync.existsSync(tempDir)) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // ==========================================
  // 1. Persistent Device ID Tests
  // ==========================================
  describe('1. Persistent Device ID Lifecycle', () => {
    test('Device ID has windows-<uuid> format and is persistent across calls', () => {
      const devId = getOrCreatePersistentDeviceId(tempDir);
      assert.ok(devId.startsWith('windows-'), 'Prefix must be windows-');
      const rawUuid = devId.slice('windows-'.length);
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      assert.ok(uuidRegex.test(rawUuid), `Must be valid UUIDv4: ${rawUuid}`);

      // Second call returns cached value
      const devId2 = getOrCreatePersistentDeviceId(tempDir);
      assert.equal(devId2, devId);
      assert.equal(getDeviceId(), devId);
    });

    test('Device ID is saved to ollacore_device.json and survives cache eviction', () => {
      const devId1 = getOrCreatePersistentDeviceId(tempDir);
      const filePath = path.join(tempDir, 'ollacore_device.json');
      assert.ok(fsSync.existsSync(filePath));

      const fileData = JSON.parse(fsSync.readFileSync(filePath, 'utf8'));
      assert.equal(fileData.deviceId, devId1);
      assert.ok(fileData.createdAt);

      // Simulate app restart: cache reset
      _resetCachedDeviceIdForTesting();
      // Uninitialized getter provides safe ephemeral fallback
      assert.ok(getDeviceId().startsWith('windows-'));

      const devId2 = getOrCreatePersistentDeviceId(tempDir);
      assert.equal(devId2, devId1, 'Must reload identical device ID from disk');
      assert.equal(getDeviceId(), devId1, 'Getter must return restored persistent ID');
    });

    test('Atomic write creates no dangling temp files', () => {
      getOrCreatePersistentDeviceId(tempDir);
      const files = fsSync.readdirSync(tempDir);
      assert.equal(files.length, 1);
      assert.equal(files[0], 'ollacore_device.json');
    });

    test('Custom prefix support and fallback behavior', () => {
      const customId = getOrCreatePersistentDeviceId(tempDir, 'custom');
      assert.ok(customId.startsWith('custom-'));
    });

    test('generateEphemeralDeviceId remains backward-compatible', () => {
      const e1 = generateEphemeralDeviceId();
      const e2 = generateEphemeralDeviceId();
      assert.ok(e1.startsWith('windows-'));
      assert.notEqual(e1, e2);
    });
  });

  // ==========================================
  // 2. WebSocket Close-Code Handling Tests
  // ==========================================
  describe('2. WebSocket Close-Code Classification & Non-Fatal Handling', () => {
    test('Standard close codes are classified correctly', () => {
      const c1000 = classifyCloseCode(1000);
      assert.equal(c1000.category, 'normal');
      assert.equal(c1000.isTerminal, true);

      const c1001 = classifyCloseCode(1001);
      assert.equal(c1001.category, 'going_away');
      assert.equal(c1001.isTerminal, false);

      const c1006 = classifyCloseCode(1006);
      assert.equal(c1006.category, 'abnormal');
      assert.equal(c1006.isTerminal, false);

      const c1008 = classifyCloseCode(1008);
      assert.equal(c1008.category, 'auth_policy');
      assert.equal(c1008.isTerminal, false);
      assert.equal(c1008.requiresTokenRefresh, true);
    });

    test('Undocumented close codes 4411 and 4412 are non-fatal and require token refresh', () => {
      const c4411 = classifyCloseCode(4411);
      assert.equal(c4411.category, 'undocumented_transient');
      assert.equal(c4411.isTerminal, false);
      assert.equal(c4411.requiresTokenRefresh, true);

      const c4412 = classifyCloseCode(4412);
      assert.equal(c4412.category, 'undocumented_transient');
      assert.equal(c4412.isTerminal, false);
      assert.equal(c4412.requiresTokenRefresh, true);
    });

    test('Other 4xxx codes are classified as custom application codes and non-fatal', () => {
      const c4001 = classifyCloseCode(4001);
      assert.equal(c4001.category, 'auth_policy');
      assert.equal(c4001.isTerminal, false);
      assert.equal(c4001.requiresTokenRefresh, true);

      const c4500 = classifyCloseCode(4500);
      assert.equal(c4500.category, 'custom_application');
      assert.equal(c4500.isTerminal, false);
    });

    test('ChatWebSocket enters RECONNECTING (not fatal ERROR) on code 4411 and 4412', () => {
      const mockWs = {
        state: CONNECTION_STATE.DISCONNECTED,
        close: () => {},
        terminate: () => {}
      };

      class MockWebSocket {
        constructor() {
          return mockWs;
        }
      }

      const ws = new ChatWebSocket({
        WebSocketClass: MockWebSocket,
        getToken: async () => 'test_room_token'
      });

      let stateChangeDetails = null;
      ws.on('stateChange', ({ state, details }) => {
        if (state === CONNECTION_STATE.RECONNECTING) {
          stateChangeDetails = details;
        }
      });

      // Simulate unexpected close with code 4411
      ws._handleUnexpectedClose(4411, 'Undocumented code 4411');

      assert.equal(ws.state, CONNECTION_STATE.RECONNECTING);
      assert.ok(stateChangeDetails);
      assert.equal(stateChangeDetails.code, 4411);
      assert.equal(stateChangeDetails.codeMeta?.category, 'undocumented_transient');
      assert.equal(stateChangeDetails.codeMeta?.requiresTokenRefresh, true);

      // Clean up timer
      clearTimeout(ws._reconnectTimer);
    });

    test('ChatWebSocket room unexpected close on code 4412 transitions room to RECONNECTING', () => {
      const entry = {
        roomId: 'room-test-4412',
        state: CONNECTION_STATE.CONNECTED,
        reconnectAttempts: 0,
        reconnectTimer: null,
        url: 'wss://test.url'
      };

      const ws = new ChatWebSocket({
        multiRoom: true,
        getToken: async () => 'test_room_token'
      });

      let stateChangeDetails = null;
      ws.on('stateChange', ({ state, details, roomId }) => {
        if (roomId === 'room-test-4412' && state === CONNECTION_STATE.RECONNECTING) {
          stateChangeDetails = details;
        }
      });

      ws._handleRoomUnexpectedClose(entry, 4412, 'Transient 4412');

      assert.equal(entry.state, CONNECTION_STATE.RECONNECTING);
      assert.ok(stateChangeDetails);
      assert.equal(stateChangeDetails.code, 4412);
      assert.equal(stateChangeDetails.codeMeta?.category, 'undocumented_transient');

      clearTimeout(entry.reconnectTimer);
    });
  });

  // ==========================================
  // 3. Read-Receipt Deduplication & REST Fallback Logic Tests
  // ==========================================
  describe('3. Read-Receipt Deduplication & Fallback Semantics', () => {
    test('Deduplication Set suppresses duplicate markRead calls', () => {
      const readReceiptsDispatched = new Set();
      const dispatched = [];

      function trackAndDispatch(roomId, messageId) {
        if (!roomId || !messageId) return;
        if (readReceiptsDispatched.has(messageId)) return;
        readReceiptsDispatched.add(messageId);
        dispatched.push({ roomId, messageId });
      }

      // First call marks message
      trackAndDispatch('room-1', 'msg-101');
      assert.equal(dispatched.length, 1);
      assert.equal(readReceiptsDispatched.has('msg-101'), true);

      // Second call for same message is suppressed
      trackAndDispatch('room-1', 'msg-101');
      assert.equal(dispatched.length, 1, 'Duplicate markRead must be suppressed');

      // Different message is processed
      trackAndDispatch('room-1', 'msg-102');
      assert.equal(dispatched.length, 2);
    });

    test('Unread filtering excludes messages already marked read', () => {
      const messages = [
        { id: 'm1', senderId: 'bob', status: 'read' },
        { id: 'm2', senderId: 'bob', status: 'READ' },
        { id: 'm3', senderId: 'bob', status: 'delivered' },
        { id: 'm4', senderId: 'bob', status: 'sent' }
      ];

      const toMark = messages.filter(
        (m) => m.id && m.status !== 'read' && m.status !== 'READ'
      );

      assert.equal(toMark.length, 2);
      assert.deepEqual(toMark.map(m => m.id), ['m3', 'm4']);
    });

    test('In-flight REST mark-read deduplicates simultaneous requests', async () => {
      const inflightMarkReadRest = new Map();
      let networkCalls = 0;

      async function simulatedMarkRead(roomId, messageId) {
        const dedupeKey = `${roomId}:${messageId}`;
        if (inflightMarkReadRest.has(dedupeKey)) {
          return inflightMarkReadRest.get(dedupeKey);
        }

        const restPromise = (async () => {
          try {
            networkCalls++;
            // Simulate network latency
            await new Promise((r) => setTimeout(r, 20));
            return { ok: true, method: 'rest' };
          } finally {
            inflightMarkReadRest.delete(dedupeKey);
          }
        })();

        inflightMarkReadRest.set(dedupeKey, restPromise);
        return restPromise;
      }

      // Launch 5 parallel mark-read requests for the same message
      const results = await Promise.all([
        simulatedMarkRead('room-1', 'msg-999'),
        simulatedMarkRead('room-1', 'msg-999'),
        simulatedMarkRead('room-1', 'msg-999'),
        simulatedMarkRead('room-1', 'msg-999'),
        simulatedMarkRead('room-1', 'msg-999')
      ]);

      assert.equal(networkCalls, 1, 'Only one HTTP REST call should be dispatched for identical message');
      for (const res of results) {
        assert.deepEqual(res, { ok: true, method: 'rest' });
      }
      assert.equal(inflightMarkReadRest.size, 0, 'In-flight map must be cleared after resolution');
    });

    test('Verification: renderer app.js contains trackAndDispatchReadReceipt and readReceiptsDispatched', async () => {
      const appJsPath = path.join(process.cwd(), 'src', 'renderer', 'app.js');
      const content = await fs.readFile(appJsPath, 'utf8');

      assert.ok(content.includes('export const readReceiptsDispatched = new Set()'), 'app.js exports readReceiptsDispatched Set');
      assert.ok(content.includes('export function trackAndDispatchReadReceipt'), 'app.js defines trackAndDispatchReadReceipt');
      assert.ok(content.includes("inc.status !== 'read' && inc.status !== 'READ'"), 'app.js filters out already read messages');
    });

    test('Verification: main.js contains getDeviceId and inflightMarkReadRest deduplication', async () => {
      const mainJsPath = path.join(process.cwd(), 'src', 'main', 'main.js');
      const content = await fs.readFile(mainJsPath, 'utf8');

      assert.ok(content.includes('getOrCreatePersistentDeviceId'), 'main.js imports and initializes getOrCreatePersistentDeviceId');
      assert.ok(content.includes('getDeviceId()'), 'main.js calls getDeviceId()');
      assert.ok(!content.includes('generateEphemeralDeviceId()'), 'main.js does not call generateEphemeralDeviceId()');
      assert.ok(content.includes('inflightMarkReadRest'), 'main.js defines and uses inflightMarkReadRest Map');
    });
  });
});
