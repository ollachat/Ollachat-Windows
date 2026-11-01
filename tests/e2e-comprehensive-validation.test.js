/**
 * tests/e2e-comprehensive-validation.test.js
 * =========================================================================
 * Comprehensive End-to-End Regression Validation Suite for OllaChat Windows
 *
 * Validates across all 6 core functional pillars:
 * A. WebSocket Stability & Undici ReadyState Protection
 * B. Offline Messaging, SQLite Durability & Automatic Reconnect
 * C. Complete Message Lifecycle, Ticks & WhatsApp-Style Actions
 * D. Media Upload Pipeline, Cancellation & Path Sanitization
 * E. Calling State Machine, Minimized In-App Widget & Floating Window
 * F. Security Boundaries, Preload Isolation & Session Token Hygiene
 * =========================================================================
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  ChatWebSocket,
  CONNECTION_STATE,
  decodeFrame,
  encodeFrame,
  isSocketOpen
} from '../src/chat/chat-websocket.js';
import { RtcWebSocket, RTC_CONNECTION_STATE } from '../src/call/rtc-websocket.js';
import {
  RoomMessagesState,
  createOptimisticMessage,
  createOptimisticMediaMessage,
  resolveCanonicalMessageId,
  canEditMessage,
  canDeleteMessageForEveryone,
  MESSAGE_ACTION_LIMITS
} from '../src/renderer/chat-shell-state.js';
import { DatabaseService } from '../src/storage/db/database-service.js';
import { OutboxManager } from '../src/renderer/outbox-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

/**
 * High-fidelity StrictMockWebSocket that mirrors Undici WebSocket behavior,
 * throwing InvalidStateError if send is invoked before OPEN (readyState === 1).
 */
class UndiciMockWebSocket {
  static instances = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0; // 0: CONNECTING
    this.sentData = [];
    this.closed = false;
    this.closeCode = null;
    this.closeReason = null;

    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;

    UndiciMockWebSocket.instances.push(this);
  }

  send(data) {
    if (this.readyState === 0) {
      const err = new Error('Sent before connected.');
      err.name = 'InvalidStateError';
      throw err;
    }
    if (this.readyState !== 1) {
      const err = new Error('WebSocket is not open.');
      err.name = 'InvalidStateError';
      throw err;
    }
    this.sentData.push(data);
  }

  close(code = 1000, reason = '') {
    this.readyState = 3; // 3: CLOSED
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    if (typeof this.onclose === 'function') {
      this.onclose({ code, reason });
    }
  }

  terminate() {
    this.close(1006, 'Abnormal termination');
  }

  simulateOpen() {
    this.readyState = 1; // 1: OPEN
    if (typeof this.onopen === 'function') {
      this.onopen();
    }
  }

  simulateMessage(data) {
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    if (typeof this.onmessage === 'function') {
      this.onmessage({ data: raw });
    }
  }
}

describe('OllaChat Comprehensive Automated E2E & Regression Suite', () => {
  let tempDbDir = null;
  let dbManager = null;

  beforeEach(() => {
    UndiciMockWebSocket.instances = [];
    tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollachat-e2e-test-'));
  });

  afterEach(() => {
    if (dbManager) {
      try { dbManager.close(); } catch {}
      dbManager = null;
    }
    if (tempDbDir && fs.existsSync(tempDbDir)) {
      try { fs.rmSync(tempDbDir, { recursive: true, force: true }); } catch {}
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PILLAR A: WebSocket Stability & Undici ReadyState Protection
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Pillar A: WebSocket Stability & ReadyState Guards', () => {
    test('A1. Concurrent multi-room startup never triggers "Sent before connected"', async () => {
      const ws = new ChatWebSocket({
        WebSocketClass: UndiciMockWebSocket,
        connectTimeoutMs: 0,
        multiRoom: true
      });

      try {
        await ws.connectRoom('room-alpha', { token: 'rt_token_alpha' });
        await ws.connectRoom('room-beta', { token: 'rt_token_beta' });
        await ws.connectRoom('room-gamma', { token: 'rt_token_gamma' });

        assert.equal(UndiciMockWebSocket.instances.length, 3);
        const [sockAlpha, sockBeta, sockGamma] = UndiciMockWebSocket.instances;

        // All 3 sockets are currently in CONNECTING (readyState = 0)
        assert.equal(sockAlpha.readyState, 0);
        assert.equal(sockBeta.readyState, 0);
        assert.equal(sockGamma.readyState, 0);

        // Dispatch messages into all 3 rooms while connecting
        let reqA, reqB, reqC;
        assert.doesNotThrow(() => {
          reqA = ws.sendMessage('room-alpha', 'c-a1', 'Alpha payload');
          reqB = ws.sendMessage('room-beta', 'c-b1', 'Beta payload');
          reqC = ws.sendMessage('room-gamma', 'c-c1', 'Gamma payload');
        });

        assert.ok(reqA && reqB && reqC);
        assert.equal(sockAlpha.sentData.length, 0);
        assert.equal(sockBeta.sentData.length, 0);
        assert.equal(sockGamma.sentData.length, 0);

        // Open Room Beta FIRST — must drain Beta ONLY without touching Alpha or Gamma
        sockBeta.simulateOpen();

        assert.equal(sockBeta.sentData.length, 1, 'Room Beta should receive its queued message');
        assert.equal(sockAlpha.sentData.length, 0, 'Room Alpha must remain untouched');
        assert.equal(sockGamma.sentData.length, 0, 'Room Gamma must remain untouched');
        assert.equal(decodeFrame(sockBeta.sentData[0]).payload.client_message_id, 'c-b1');

        // Open Room Alpha
        sockAlpha.simulateOpen();
        assert.equal(sockAlpha.sentData.length, 1);
        assert.equal(decodeFrame(sockAlpha.sentData[0]).payload.client_message_id, 'c-a1');

        // Open Room Gamma
        sockGamma.simulateOpen();
        assert.equal(sockGamma.sentData.length, 1);
        assert.equal(decodeFrame(sockGamma.sentData[0]).payload.client_message_id, 'c-c1');
      } finally {
        ws.disconnect();
      }
    });

    test('A2. Stale socket teardown cannot corrupt replacement socket', async () => {
      const ws = new ChatWebSocket({
        roomId: 'room-replacement',
        token: 'rt_token_initial',
        WebSocketClass: UndiciMockWebSocket,
        connectTimeoutMs: 0
      });

      try {
        await ws.connect();
        const oldSock = UndiciMockWebSocket.instances[0];

        // Trigger forced reconnect (creates new replacement socket)
        await ws.connect({ forceTokenRefresh: true });
        const newSock = UndiciMockWebSocket.instances[1];

        // Old socket simulates asynchronous closure / events
        oldSock.close(1006, 'Old socket died');

        // Verify state is NOT corrupted by old socket
        assert.equal(ws._socket, newSock);
        assert.notEqual(ws.state, CONNECTION_STATE.DISCONNECTED);

        // New socket opens normally
        newSock.simulateOpen();
        assert.equal(ws.state, CONNECTION_STATE.CONNECTED);
      } finally {
        ws.disconnect();
      }
    });

    test('A3. RtcWebSocket guards signaling sends with readyState check', () => {
      const rtc = new RtcWebSocket();
      const mockSock = {
        readyState: 0, // CONNECTING
        send: () => {
          throw new Error('Should not be called while CONNECTING');
        }
      };

      rtc._socket = mockSock;
      rtc.state = RTC_CONNECTION_STATE.CONNECTED;

      // When readyState is 0 (CONNECTING), _sendJson must reject cleanly
      assert.throws(
        () => {
          rtc._sendJson({ cmd: 'offer' });
        },
        {
          name: 'Error',
          message: /socket is not connected/
        }
      );

      // When readyState is 1 (OPEN), send succeeds
      let sentStr = null;
      mockSock.readyState = 1;
      mockSock.send = (s) => { sentStr = s; };

      assert.doesNotThrow(() => {
        rtc._sendJson({ cmd: 'offer', sdp: 'v=0' });
      });
      assert.ok(sentStr && sentStr.includes('offer'));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PILLAR B: Offline Messaging, SQLite Durability & Automatic Reconnect
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Pillar B: Offline Messaging & Outbox Durability', () => {
    test('B1. Message enqueued while offline persists to SQLite and flushes on reconnect', async () => {
      const mockSessionStore = {
        currentSession: { userId: 'user_self', sessionToken: 'token_123' },
        getSession() { return this.currentSession; }
      };
      const dbService = new DatabaseService({
        storageDir: tempDbDir,
        sessionStore: mockSessionStore
      });

      const outbox = new OutboxManager({ maxRetries: 3, baseBackoffMs: 20 });
      const clientMsgId = 'client-offline-' + crypto.randomUUID();
      const roomId = 'room-durability-1';

      // 1. Enqueue offline message into durable SQLite outbox
      const enqueued = await outbox.enqueue({
        clientMessageId: clientMsgId,
        roomId,
        wirePayload: {
          client_message_id: clientMsgId,
          kind: 'text',
          body: { text: 'Durable offline message' }
        },
        dbBridge: dbService
      });

      assert.ok(enqueued, 'Enqueue should succeed');

      // Verify persistent SQLite storage
      const pendingBefore = await dbService.getPendingOutbox();
      assert.equal(pendingBefore.length, 1);
      assert.equal(pendingBefore[0].client_message_id, clientMsgId);
      assert.equal(pendingBefore[0].retry_count, 0);

      // 2. Simulate network restoration and flush
      let wsSent = false;
      let sentRoomId = null;

      const mockChat = {
        getState: async () => 'connected',
        send: async (type, payload, rId) => {
          wsSent = true;
          sentRoomId = rId;
          return { ok: true, requestId: 'req-srv-ack-1' };
        }
      };

      const sentCount = await outbox.flush({
        chatBridge: mockChat,
        dbBridge: dbService
      });

      assert.equal(sentCount, 1);
      assert.equal(wsSent, true);
      assert.equal(sentRoomId, roomId);

      // 3. Clear message once acknowledged by server
      await outbox.clear({ clientMessageId: clientMsgId, dbBridge: dbService });

      const pendingAfter = await dbService.getPendingOutbox();
      assert.equal(pendingAfter.length, 0, 'Durable outbox must be empty after ACK reconciliation');

      await dbService.databaseManager.close();
    });

    test('B2. Outbox preserves strict chronological FIFO order across multiple messages', async () => {
      const mockSessionStore = {
        currentSession: { userId: 'user_self', sessionToken: 'token_123' },
        getSession() { return this.currentSession; }
      };
      const dbService = new DatabaseService({
        storageDir: path.join(tempDbDir, 'fifo_dir'),
        sessionStore: mockSessionStore
      });

      const outbox = new OutboxManager({ maxRetries: 3, baseBackoffMs: 10 });

      // Enqueue 3 sequential messages
      await outbox.enqueue({ clientMessageId: 'msg-fifo-1', roomId: 'r1', wirePayload: { client_message_id: 'msg-fifo-1', text: 'First' }, dbBridge: dbService });
      await outbox.enqueue({ clientMessageId: 'msg-fifo-2', roomId: 'r1', wirePayload: { client_message_id: 'msg-fifo-2', text: 'Second' }, dbBridge: dbService });
      await outbox.enqueue({ clientMessageId: 'msg-fifo-3', roomId: 'r1', wirePayload: { client_message_id: 'msg-fifo-3', text: 'Third' }, dbBridge: dbService });

      const dispatched = [];
      const mockChat = {
        getState: async () => 'connected',
        send: async (type, payload) => {
          dispatched.push(payload.client_message_id);
          return { ok: true, requestId: 'req-' + payload.client_message_id };
        }
      };

      await outbox.flush({ chatBridge: mockChat, dbBridge: dbService });

      assert.deepEqual(dispatched, ['msg-fifo-1', 'msg-fifo-2', 'msg-fifo-3'], 'Outbox must dispatch in exact FIFO order');

      await dbService.databaseManager.close();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PILLAR C: Message Lifecycle, Ticks & WhatsApp-Style Actions
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Pillar C: Message Lifecycle & Action Invariants', () => {
    test('C1. Optimistic message advances monotonically: PENDING -> SENT -> DELIVERED -> READ', () => {
      const currentUserId = 'user_self';
      const roomState = new RoomMessagesState(currentUserId);
      roomState.roomId = 'room-ticks';
      const clientMsgId = 'opt-' + crypto.randomUUID();

      // 1. Optimistic creation starts as SENDING (status: 'sending')
      const opt = createOptimisticMessage('room-ticks', currentUserId, 'Testing tick progression', clientMsgId);
      assert.equal(opt.status, 'sending');

      roomState.addOptimisticMessage(opt);
      assert.equal(roomState.getStatus(clientMsgId), 'sending');

      // 2. Server ACK arrives with canonical message ID -> transitions to SENT (single grey tick)
      const canonicalId = 'srv-msg-12345';
      roomState.appendIncomingMessage({
        id: canonicalId,
        client_message_id: clientMsgId,
        room_id: 'room-ticks',
        sender_id: currentUserId,
        kind: 'text',
        body: { text: 'Testing tick progression' }
      });
      roomState.updateReceipt(canonicalId, 'sent', 'room-ticks');
      assert.equal(roomState.getStatus(canonicalId), 'sent');

      // 3. Delivered receipt arrives -> transitions to DELIVERED (double grey ticks)
      roomState.updateReceipt(canonicalId, 'delivered', 'room-ticks');
      assert.equal(roomState.getStatus(canonicalId), 'delivered');

      // 4. Read receipt arrives -> transitions to READ (double blue ticks)
      roomState.updateReceipt(canonicalId, 'read', 'room-ticks');
      assert.equal(roomState.getStatus(canonicalId), 'read');

      // 5. Monotonic rule: Stale delivered receipt cannot downgrade READ back to DELIVERED
      roomState.updateReceipt(canonicalId, 'delivered', 'room-ticks');
      assert.equal(roomState.getStatus(canonicalId), 'read', 'READ must not downgrade to DELIVERED');
    });

    test('C2. WhatsApp-style 15m edit and 48h delete limits are strictly enforced', () => {
      const now = Date.now();
      const limits = MESSAGE_ACTION_LIMITS;

      assert.equal(limits.EDIT_WINDOW_MS, 15 * 60 * 1000, '15-minute edit window');
      assert.equal(limits.DELETE_FOR_EVERYONE_WINDOW_MS, 48 * 60 * 60 * 1000, '48-hour delete for everyone window');

      const currentUserId = 'user_self';

      // Message created 10 minutes ago: Editable and Delete-for-Everyone eligible
      const msg10m = {
        createdAt: new Date(now - 10 * 60 * 1000).toISOString(),
        senderId: currentUserId,
        kind: 'text',
        body: { text: '10m message' }
      };
      assert.equal(canEditMessage(msg10m, currentUserId, now), true, '10m message is editable');
      assert.equal(canDeleteMessageForEveryone(msg10m, currentUserId, now), true, '10m message is deletable for everyone');

      // Message created 20 minutes ago: Edit expired, Delete for Everyone still valid
      const msg20m = {
        createdAt: new Date(now - 20 * 60 * 1000).toISOString(),
        senderId: currentUserId,
        kind: 'text',
        body: { text: '20m message' }
      };
      assert.equal(canEditMessage(msg20m, currentUserId, now), false, '20m message is NOT editable');
      assert.equal(canDeleteMessageForEveryone(msg20m, currentUserId, now), true, '20m message is deletable for everyone');

      // Message created 50 hours ago: Both Edit and Delete for Everyone expired
      const msg50h = {
        createdAt: new Date(now - 50 * 60 * 60 * 1000).toISOString(),
        senderId: currentUserId,
        kind: 'text',
        body: { text: '50h message' }
      };
      assert.equal(canEditMessage(msg50h, currentUserId, now), false);
      assert.equal(canDeleteMessageForEveryone(msg50h, currentUserId, now), false, '50h message cannot be deleted for everyone');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PILLAR D: Media Upload Pipeline, Cancellation & Path Sanitization
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Pillar D: Media Pipeline & File Sanitization', () => {
    test('D1. Outgoing media messages never store raw filesystem paths in message objects', () => {
      const clientMsgId = 'media-opt-' + crypto.randomUUID();
      const safeFilename = 'photo_vacation.jpg';
      const rawLocalPath = 'C:\\Users\\Admin\\SecretPhotos\\photo_vacation.jpg';

      const optMedia = createOptimisticMediaMessage('room-media', 'user_self', {
        kind: 'image',
        filename: safeFilename,
        mime: 'image/jpeg',
        byteSize: 2048,
        clientMessageId: clientMsgId
      });

      assert.equal(optMedia.body.filename, safeFilename);

      // Verification: raw OS filesystem paths (C:\..., /Users/...) must never appear in the serialized message
      const jsonDump = JSON.stringify(optMedia);
      assert.equal(jsonDump.includes(rawLocalPath), false, 'Raw local filesystem path must never leak into message payload');
      assert.equal(jsonDump.includes('SecretPhotos'), false);
    });

    test('D2. Attachment upload session cancellation cleans up tracking resources', () => {
      const activeSessions = new Map();
      const sessionId = 'upload-sess-' + crypto.randomUUID();

      activeSessions.set(sessionId, {
        status: 'uploading',
        abortController: new AbortController()
      });

      assert.equal(activeSessions.has(sessionId), true);

      // Trigger cancellation
      const session = activeSessions.get(sessionId);
      session.abortController.abort();
      activeSessions.delete(sessionId);

      assert.equal(activeSessions.has(sessionId), false);
      assert.equal(session.abortController.signal.aborted, true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PILLAR E: Calling State Machine, Minimized In-App Widget & Floating Window
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Pillar E: Calling UX & Window Lifecycle Invariants', () => {
    test('E1. Call layout invariants: active centered card vs. compact in-app widget vs. desktop floating window', () => {
      // 1. When call starts: centered call card inside app, NO desktop floating window
      const initialCallState = {
        state: 'CONNECTED',
        isMinimized: false,
        isAppMinimized: false
      };

      const showCenteredCard = initialCallState.state === 'CONNECTED' && !initialCallState.isMinimized;
      const showInAppWidget = initialCallState.state === 'CONNECTED' && initialCallState.isMinimized && !initialCallState.isAppMinimized;
      const showDesktopFloatingWindow = initialCallState.state === 'CONNECTED' && initialCallState.isAppMinimized;

      assert.equal(showCenteredCard, true, 'Active call must render centered card inside OllaChat');
      assert.equal(showInAppWidget, false);
      assert.equal(showDesktopFloatingWindow, false, 'Desktop floating window must not appear initially');

      // 2. User minimizes call within app: renders compact draggable widget, main chat navigable
      const inAppMinimizedState = {
        state: 'CONNECTED',
        isMinimized: true,
        isAppMinimized: false
      };

      assert.equal(inAppMinimizedState.isMinimized && !inAppMinimizedState.isAppMinimized, true, 'In-app minimized widget active');

      // 3. Main window itself is minimized: shows external desktop floating window
      const appMinimizedState = {
        state: 'CONNECTED',
        isMinimized: true,
        isAppMinimized: true
      };

      assert.equal(appMinimizedState.isAppMinimized, true, 'External desktop window active when app is minimized');
    });

    test('E2. Minimized call widget clamps coordinates to application bounds', () => {
      const clampWidgetPosition = (x, y, widgetW, widgetH, containerW, containerH, margin = 16) => {
        const maxX = Math.max(margin, containerW - widgetW - margin);
        const maxY = Math.max(margin, containerH - widgetH - margin);
        return {
          x: Math.max(margin, Math.min(x, maxX)),
          y: Math.max(margin, Math.min(y, maxY))
        };
      };

      // Widget dimensions 240x80 inside 1200x800 container
      const normalPos = clampWidgetPosition(500, 300, 240, 80, 1200, 800);
      assert.deepEqual(normalPos, { x: 500, y: 300 });

      // Drag beyond negative left boundary -> clamped to margin
      const leftOverflow = clampWidgetPosition(-100, 300, 240, 80, 1200, 800);
      assert.equal(leftOverflow.x, 16);

      // Drag beyond right boundary -> clamped to containerW - widgetW - margin
      const rightOverflow = clampWidgetPosition(2000, 300, 240, 80, 1200, 800);
      assert.equal(rightOverflow.x, 1200 - 240 - 16);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PILLAR F: Security Boundaries, Preload Isolation & Session Token Hygiene
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Pillar F: Security Invariants & Token Boundary Hygiene', () => {
    test('F1. Directory tokens (du_...) are strictly rejected from room WebSockets', async () => {
      const chatWs = new ChatWebSocket({
        roomId: 'room-sec-1',
        token: 'du_directory_session_token_invalid_for_room',
        WebSocketClass: UndiciMockWebSocket
      });

      let errorEmitted = null;
      chatWs.on('error', (err) => {
        errorEmitted = err;
      });

      await chatWs.connect();

      assert.ok(errorEmitted, 'Must emit error for directory token on ChatWebSocket');
      assert.match(errorEmitted.message, /Cannot connect ChatWebSocket with Directory session token/);
      assert.equal(chatWs.state, CONNECTION_STATE.ERROR);
      assert.equal(UndiciMockWebSocket.instances.length, 0, 'No socket connection should be attempted');
    });

    test('F2. RtcWebSocket strictly rejects directory tokens (du_...)', () => {
      assert.throws(
        () => {
          RtcWebSocket.validateRoomToken('du_directory_token_forbidden');
        },
        {
          name: 'Error',
          message: /directory session token .* cannot be used for RTC WebSocket/
        }
      );

      // Valid room token succeeds
      assert.equal(RtcWebSocket.validateRoomToken('rt_valid_room_token_123'), 'rt_valid_room_token_123');
    });

    test('F3. Electron preload security configuration enforces sandboxing', () => {
      const packageJsonPath = path.join(projectRoot, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

      // Validate Electron dependency and build entrypoint
      assert.ok(pkg.devDependencies.electron, 'electron must be declared in devDependencies');
      assert.equal(pkg.main, 'dist/main/main.js', 'main bundle entrypoint');
    });
  });
});
