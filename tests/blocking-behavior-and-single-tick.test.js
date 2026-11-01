import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

import {
  ChatShellState,
  RoomMessagesState,
  MESSAGE_STATUS,
  STATUS_RANKS,
  getTickDescriptor,
  createOptimisticMessage,
  getConversationTitle,
  getAvatarInitials,
  getDirectPeerUserId
} from '../src/renderer/chat-shell-state.js';
import { DatabaseService } from '../src/storage/db/database-service.js';
import { OutboxManager } from '../src/renderer/outbox-manager.js';
import {
  ChatApi,
  normalizeBlockItem,
  normalizeInboxItem,
  normalizeConversation
} from '../src/api/chat-api.js';
import { ChatWebSocket } from '../src/chat/chat-websocket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock WebSocket class for testing real-time events and frame handling
class MockWebSocket {
  static instances = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0; // 0: CONNECTING, 1: OPEN, 2: CLOSING, 3: CLOSED
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

  send(data) {
    if (this.readyState !== 1) {
      throw new Error(`WebSocket is not open (readyState: ${this.readyState})`);
    }
    this.sentData.push(data);
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    if (this.onclose) {
      this.onclose({ code, reason });
    }
  }

  simulateOpen() {
    this.readyState = 1;
    if (this.onopen) {
      this.onopen();
    }
  }

  simulateMessage(data) {
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    if (this.onmessage) {
      this.onmessage({ data: raw });
    }
  }
}

/**
 * Authoritative In-Memory OllaCore Server Simulator.
 * Enforces the complete OllaCore specification:
 * - Block list management (PUT/DELETE/GET /directory/blocks)
 * - Privacy filtering for blocked contacts (presence withholding, avatar suppression)
 * - Message acceptance vs delivery filtering (accept with ACK, withhold delivery from blocker)
 * - Reconnection sync isolation (blocked messages never delivered to blocker)
 */
class AuthoritativeOllaCoreServer {
  constructor() {
    this.blocks = new Map(); // blockerUserId -> Set of blockedUserIds
    this.userAvatars = new Map(); // userId -> { avatarUrl, avatarVersion }
    this.presence = new Map(); // userId -> boolean (online)
    this.storedMessages = []; // all accepted messages
    this.connections = new Map(); // userId -> MockWebSocket connection
  }

  blockUser(blockerId, targetId) {
    if (!this.blocks.has(blockerId)) {
      this.blocks.set(blockerId, new Set());
    }
    this.blocks.get(blockerId).add(targetId);
  }

  unblockUser(blockerId, targetId) {
    if (this.blocks.has(blockerId)) {
      this.blocks.get(blockerId).delete(targetId);
    }
  }

  isBlocked(blockerId, targetId) {
    return Boolean(this.blocks.get(blockerId)?.has(targetId));
  }

  setUserAvatar(userId, avatarUrl, avatarVersion = '1.0') {
    this.userAvatars.set(userId, { avatarUrl, avatarVersion });
  }

  /**
   * Resolves avatar for a requester according to privacy rules:
   * If target user has blocked requester, target's avatar is suppressed (null).
   * Otherwise returns real avatar.
   */
  resolveAvatarFor(requesterId, targetUserId) {
    if (this.isBlocked(targetUserId, requesterId)) {
      return { avatarUrl: null, avatarVersion: null };
    }
    return this.userAvatars.get(targetUserId) || { avatarUrl: null, avatarVersion: null };
  }

  /**
   * Sets presence and broadcasts presence.changed only to unblocked users.
   */
  setPresence(userId, isOnline) {
    this.presence.set(userId, Boolean(isOnline));
    const broadcastPayload = {
      type: 'presence.changed',
      payload: { principal_id: userId, online: Boolean(isOnline) }
    };

    for (const [recipientId, socket] of this.connections.entries()) {
      if (recipientId === userId) continue;
      // If user has blocked recipient, DO NOT send presence!
      if (this.isBlocked(userId, recipientId)) continue;
      if (socket && socket.readyState === 1) {
        socket.simulateMessage(broadcastPayload);
      }
    }
  }

  _getRecipientId(roomId, senderId) {
    if (!roomId) return null;
    const clean = roomId.replace(/^dm_/, '');
    if (clean.startsWith(`${senderId}_`)) {
      return clean.slice(senderId.length + 1);
    }
    if (clean.endsWith(`_${senderId}`)) {
      return clean.slice(0, clean.length - senderId.length - 1);
    }
    const parts = clean.split('_');
    return parts.find((p) => p !== senderId) || null;
  }

  /**
   * Authoritative message sending pipeline:
   * Accepts message from sender, returns ACK.
   * If recipient has blocked sender, withholds delivery from recipient.
   */
  handleIncomingSend(senderId, frame) {
    const { request_id, room_id, payload } = frame;
    const clientMsgId = payload?.client_message_id;
    const recipientId = this._getRecipientId(room_id, senderId);

    const serverMsgId = `srv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const eventSeq = this.storedMessages.length + 1;

    const storedMsg = {
      id: serverMsgId,
      roomId: room_id,
      room_id,
      senderId,
      sender_id: senderId,
      clientMessageId: clientMsgId,
      client_message_id: clientMsgId,
      body: payload?.body || {},
      kind: payload?.kind || 'text',
      eventSeq,
      event_seq: eventSeq,
      status: 'sent',
      createdAt: new Date().toISOString()
    };
    this.storedMessages.push(storedMsg);

    // 1. Authoritative Server ACK to Sender
    const ackFrame = {
      v: 1,
      type: 'ack',
      request_id,
      room_id,
      payload: {
        message: storedMsg
      }
    };

    const senderSocket = this.connections.get(senderId);
    if (senderSocket && senderSocket.readyState === 1) {
      senderSocket.simulateMessage(ackFrame);
    }

    // 2. Delivery to Recipient (strictly withheld if recipient blocked sender)
    const isDeliveryBlocked = this.isBlocked(recipientId, senderId);
    if (!isDeliveryBlocked) {
      const recipientSocket = this.connections.get(recipientId);
      if (recipientSocket && recipientSocket.readyState === 1) {
        recipientSocket.simulateMessage({
          v: 1,
          type: 'message.created',
          room_id,
          payload: storedMsg
        });
      }
    }

    return { storedMsg, isDeliveryBlocked };
  }

  /**
   * Reconnection sync for a user: returns messages for room, excluding any messages sent by blocked contacts
   */
  getSyncMessages(userId, roomId) {
    return this.storedMessages.filter((msg) => {
      if (msg.roomId !== roomId) return false;
      const sender = msg.senderId || msg.sender_id;
      // If user has blocked this sender, do not deliver!
      if (this.isBlocked(userId, sender)) return false;
      return true;
    });
  }
}

describe('OllaChat Blocking Behavior, Privacy & Single-Tick Contract Suite (12 Scenarios)', () => {
  let tmpDir;
  let dbService;
  let outbox;
  let serverSimulator;

  beforeEach(async () => {
    MockWebSocket.instances = [];
    serverSimulator = new AuthoritativeOllaCoreServer();

    tmpDir = path.join(os.tmpdir(), 'ollachat-blocking-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    await fsPromises.mkdir(tmpDir, { recursive: true });

    const mockSessionStore = {
      currentSession: {
        userId: 'user_b',
        sessionToken: 'token_b_secret',
        phone: '+15550002'
      },
      getSession() {
        return this.currentSession;
      }
    };
    dbService = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });
    outbox = new OutboxManager();
  });

  afterEach(async () => {
    if (dbService && dbService.databaseManager?.isOpen) {
      await dbService.databaseManager.close();
    }
    if (tmpDir) {
      await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 1: User A blocks User B
  // ═══════════════════════════════════════════════════════════════════
  test('1. User A blocks User B: persists in authoritative API and local state', async () => {
    let putRequested = false;
    const mockHttp = http.createServer((req, res) => {
      if (req.method === 'PUT' && req.url === '/v1/directory/blocks/user_b') {
        putRequested = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ blocked: true, user_id: 'user_b', since: '2026-10-27T00:00:00Z' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve) => mockHttp.listen(0, '127.0.0.1', resolve));
    const port = mockHttp.address().port;
    const api = new ChatApi({ baseUrl: `http://127.0.0.1:${port}/v1` });

    const res = await api.blockUser('token_a', 'user_b');
    assert.equal(putRequested, true);
    assert.equal(res.blocked, true);
    assert.equal(res.userId, 'user_b');

    // User A local state update
    const stateA = new ChatShellState();
    stateA.currentUser = { userId: 'user_a' };
    stateA.addBlockedUser({ userId: 'user_b', displayName: 'Bob' });
    assert.equal(stateA.isUserBlocked('user_b'), true);
    assert.equal(stateA.isUserBlocked('user_c'), false);

    // Persistence in SQLite blocked_users table
    await dbService.addBlockedUser({ userId: 'user_b', displayName: 'Bob' });
    const blockedList = await dbService.getBlockedUsers();
    assert.equal(blockedList.some((u) => u.userId === 'user_b'), true);

    await new Promise((resolve) => mockHttp.close(resolve));
  });

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 2: User B cannot see User A's online status
  // ═══════════════════════════════════════════════════════════════════
  test('2. User B cannot see User A online status while block is active', () => {
    serverSimulator.blockUser('user_a', 'user_b'); // A blocks B
    serverSimulator.setPresence('user_a', true);   // A is online

    // User B's state
    const stateB = new ChatShellState();
    stateB.currentUser = { userId: 'user_b' };
    const convAB = {
      roomId: 'dm_user_a_user_b',
      kind: 'direct',
      peerUserId: 'user_a',
      title: 'Alice',
      isBlocked: true,
      blockedByPeer: true
    };
    stateB.setInbox([convAB]);

    // Authoritative check: User B cannot see User A online
    assert.equal(stateB.isUserOnline('dm_user_a_user_b', 'user_a'), false);
    assert.equal(stateB.isUserTyping('dm_user_a_user_b', 'user_a'), false);

    // If an unexpected presence frame were received, state suppresses it
    stateB.setPresence('dm_user_a_user_b', 'user_a', true);
    assert.equal(stateB.isUserOnline('dm_user_a_user_b', 'user_a'), false);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 3: User B cannot see User A's profile photo
  // ═══════════════════════════════════════════════════════════════════
  test('3. User B cannot see User A profile photo: avatar suppressed to null without caching', () => {
    serverSimulator.setUserAvatar('user_a', 'https://cdn.ollacore.com/avatars/user_a.jpg', '2.1');
    serverSimulator.blockUser('user_a', 'user_b');

    // Authoritative API resolution for User B
    const resolvedForB = serverSimulator.resolveAvatarFor('user_b', 'user_a');
    assert.equal(resolvedForB.avatarUrl, null, 'Avatar URL must be null for blocked requester');
    assert.equal(resolvedForB.avatarVersion, null);

    // Normalized conversation object suppresses avatar
    const rawInboxItem = {
      room_id: 'dm_user_a_user_b',
      kind: 'direct',
      is_blocked: true,
      peer: {
        user_id: 'user_a',
        display_name: 'Alice',
        is_blocked: true,
        avatar_url: 'https://cdn.ollacore.com/avatars/user_a.jpg',
        avatar_version: '2.1'
      }
    };
    const normalized = normalizeInboxItem(rawInboxItem);
    assert.equal(normalized.avatarUrl, null);
    assert.equal(normalized.peer.avatarUrl, null);
    assert.equal(normalized.peer.avatarVersion, null);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 4: Other users can still see User A's profile
  // ═══════════════════════════════════════════════════════════════════
  test('4. Other unblocked users can still see User A profile and presence according to privacy rules', () => {
    serverSimulator.setUserAvatar('user_a', 'https://cdn.ollacore.com/avatars/user_a.jpg', '2.1');
    serverSimulator.blockUser('user_a', 'user_b'); // A blocks B, but NOT C
    serverSimulator.setPresence('user_a', true);

    // User C (unblocked) queries User A's avatar
    const resolvedForC = serverSimulator.resolveAvatarFor('user_c', 'user_a');
    assert.equal(resolvedForC.avatarUrl, 'https://cdn.ollacore.com/avatars/user_a.jpg');
    assert.equal(resolvedForC.avatarVersion, '2.1');

    // User A's actual avatar was NOT deleted globally
    assert.ok(serverSimulator.userAvatars.has('user_a'));

    // Normalized item for User C retains avatar URL
    const rawInboxItemForC = {
      room_id: 'dm_user_a_user_c',
      kind: 'direct',
      is_blocked: false,
      peer: {
        user_id: 'user_a',
        display_name: 'Alice',
        is_blocked: false,
        avatar_url: 'https://cdn.ollacore.com/avatars/user_a.jpg',
        avatar_version: '2.1'
      }
    };
    const normC = normalizeInboxItem(rawInboxItemForC);
    assert.equal(normC.avatarUrl, 'https://cdn.ollacore.com/avatars/user_a.jpg');
    assert.equal(normC.peer.avatarUrl, 'https://cdn.ollacore.com/avatars/user_a.jpg');
  });

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 5: User B sends a message; server accepts without delivering to User A
  // ═══════════════════════════════════════════════════════════════════
  test('5. User B sends message: server accepts it with ACK but does not deliver to User A', () => {
    serverSimulator.blockUser('user_a', 'user_b');

    const socketB = new MockWebSocket('wss://ws.ollacore.com');
    const socketA = new MockWebSocket('wss://ws.ollacore.com');
    serverSimulator.connections.set('user_b', socketB);
    serverSimulator.connections.set('user_a', socketA);
    socketB.simulateOpen();
    socketA.simulateOpen();

    const clientMsgId = 'local-user-b-msg-1';
    const reqId = 'req-msg-send-001';
    const frame = {
      v: 1,
      type: 'message.send',
      request_id: reqId,
      room_id: 'dm_user_a_user_b',
      payload: {
        client_message_id: clientMsgId,
        kind: 'text',
        body: { text: 'Hello Alice' }
      }
    };

    const receivedOnB = [];
    const receivedOnA = [];
    socketB.onmessage = (e) => receivedOnB.push(JSON.parse(e.data));
    socketA.onmessage = (e) => receivedOnA.push(JSON.parse(e.data));

    const { storedMsg, isDeliveryBlocked } = serverSimulator.handleIncomingSend('user_b', frame);

    // 1. Server accepted and stored the message
    assert.ok(storedMsg.id);
    assert.equal(storedMsg.clientMessageId, clientMsgId);
    assert.equal(isDeliveryBlocked, true);

    // 2. Sender (User B) received ACK frame
    assert.equal(receivedOnB.length, 1);
    assert.equal(receivedOnB[0].type, 'ack');
    assert.equal(receivedOnB[0].request_id, reqId);
    assert.equal(receivedOnB[0].payload?.message?.clientMessageId, clientMsgId);

    // 3. User A received NO messages (delivery strictly withheld)
    assert.equal(receivedOnA.length, 0);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 6: Sender sees single grey tick after server acceptance
  // ═══════════════════════════════════════════════════════════════════
  test('6. Sender sees single grey tick (✓) after server acceptance', () => {
    const roomState = new RoomMessagesState('user_b');
    roomState.setInitialMessages('dm_user_a_user_b', []);

    const clientMsgId = 'local-msg-tick-test';
    const opt = createOptimisticMessage('dm_user_a_user_b', 'user_b', 'Hello Alice', clientMsgId);
    roomState.addOptimisticMessage(opt);

    // Initial state: sending
    assert.equal(roomState.getStatus(clientMsgId), MESSAGE_STATUS.SENDING);

    // Server accepts message and sends ACK frame
    const serverAckMessageId = 'srv_server_accepted_101';
    roomState.updateReceipt(clientMsgId, MESSAGE_STATUS.SENT, 'dm_user_a_user_b');
    roomState.updateReceipt(serverAckMessageId, MESSAGE_STATUS.SENT, 'dm_user_a_user_b');

    // Status is strictly SENT
    assert.equal(roomState.getStatus(clientMsgId), MESSAGE_STATUS.SENT);

    // Tick descriptor produces single grey tick
    const tickDesc = getTickDescriptor(MESSAGE_STATUS.SENT, true);
    assert.equal(tickDesc.hasTick, true);
    assert.equal(tickDesc.symbol, '✓');
    assert.equal(tickDesc.statusClass, 'status-sent');
    assert.equal(tickDesc.title, 'Sent');
  });

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 7: Message does not enter an endless retry loop
  // ═══════════════════════════════════════════════════════════════════
  test('7. Accepted message is cleared from outbox and does not enter retry loop', async () => {
    const clientMsgId = 'local-msg-no-retry-loop';
    const roomId = 'dm_user_a_user_b';

    // 1. Enqueue to SQLite outbox
    await outbox.enqueue({
      clientMessageId: clientMsgId,
      roomId,
      wirePayload: { client_message_id: clientMsgId, kind: 'text', body: { text: 'Test' } },
      dbBridge: dbService
    });
    let pending = await dbService.getPendingOutbox();
    assert.equal(pending.length, 1);

    // 2. Server ACK arrives: clear outbox item
    await outbox.clear({ clientMessageId: clientMsgId, dbBridge: dbService });

    // 3. Pending queue is now empty
    pending = await dbService.getPendingOutbox();
    assert.equal(pending.length, 0);

    // 4. Flush does not retry any messages
    const retried = await outbox.flush({
      dbBridge: dbService,
      chatBridge: { send: async () => ({ ok: true }) }
    });
    assert.equal(retried, 0);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 8: Duplicate sends do not create duplicate messages
  // ═══════════════════════════════════════════════════════════════════
  test('8. Idempotency: duplicate sends with same client_message_id do not duplicate messages', () => {
    const roomState = new RoomMessagesState('user_b');
    roomState.setInitialMessages('dm_user_a_user_b', []);

    const clientMsgId = 'local-idempotency-key-001';
    const opt = createOptimisticMessage('dm_user_a_user_b', 'user_b', 'Idempotent test', clientMsgId);

    // Initial send
    roomState.addOptimisticMessage(opt);
    assert.equal(roomState.messages.length, 1);

    // Duplicate submission attempt
    roomState.addOptimisticMessage(opt);
    assert.equal(roomState.messages.length, 1, 'Duplicate clientMessageId must not duplicate message entry');

    // Server reconciles with durable server ID
    const serverMessage = {
      id: 'srv_reconciled_999',
      roomId: 'dm_user_a_user_b',
      senderId: 'user_b',
      clientMessageId: clientMsgId,
      client_message_id: clientMsgId,
      body: { text: 'Idempotent test' },
      eventSeq: 42
    };
    roomState.appendIncomingMessage(serverMessage);
    assert.equal(roomState.messages.length, 1, 'Server message reconciliation must maintain exactly 1 message');
  });

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 9: Blocked messages not delivered after WebSocket reconnect
  // ═══════════════════════════════════════════════════════════════════
  test('9. Blocked messages are not delivered after User A disconnects and reconnects', () => {
    serverSimulator.blockUser('user_a', 'user_b');

    // User B sends message while block is active
    const frame = {
      v: 1,
      type: 'message.send',
      request_id: 'req_sync_001',
      room_id: 'dm_user_a_user_b',
      payload: {
        client_message_id: 'local_blocked_sync_msg',
        body: { text: 'You cannot see this' }
      }
    };
    serverSimulator.handleIncomingSend('user_b', frame);

    // User A reconnects and requests sync
    const syncMessagesForA = serverSimulator.getSyncMessages('user_a', 'dm_user_a_user_b');
    assert.equal(syncMessagesForA.length, 0, 'User A sync stream must NOT contain blocked message');
  });

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 10: Unblocking restores expected behavior
  // ═══════════════════════════════════════════════════════════════════
  test('10. Unblocking restores presence, profile photo, and delivery of future messages', () => {
    serverSimulator.setUserAvatar('user_a', 'https://cdn.ollacore.com/avatars/user_a.jpg', '2.1');
    serverSimulator.blockUser('user_a', 'user_b');

    // Initially blocked
    assert.equal(serverSimulator.resolveAvatarFor('user_b', 'user_a').avatarUrl, null);

    // User A unblocks User B
    serverSimulator.unblockUser('user_a', 'user_b');
    assert.equal(serverSimulator.isBlocked('user_a', 'user_b'), false);

    // 1. Profile photo visibility is restored
    const restoredAvatar = serverSimulator.resolveAvatarFor('user_b', 'user_a');
    assert.equal(restoredAvatar.avatarUrl, 'https://cdn.ollacore.com/avatars/user_a.jpg');

    // 2. Presence visibility is restored
    serverSimulator.setPresence('user_a', true);
    assert.equal(serverSimulator.presence.get('user_a'), true);

    // 3. New messages sent after unblocking are delivered to User A
    const socketA = new MockWebSocket('wss://ws.ollacore.com');
    socketA.simulateOpen();
    serverSimulator.connections.set('user_a', socketA);

    let deliveredToA = false;
    socketA.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'message.created') deliveredToA = true;
    };

    const newFrame = {
      v: 1,
      type: 'message.send',
      request_id: 'req_new_unblocked',
      room_id: 'dm_user_a_user_b',
      payload: {
        client_message_id: 'local_msg_after_unblock',
        body: { text: 'Now you see me' }
      }
    };
    const { isDeliveryBlocked } = serverSimulator.handleIncomingSend('user_b', newFrame);
    assert.equal(isDeliveryBlocked, false);
    assert.equal(deliveredToA, true, 'New message after unblock must be delivered to User A');
  });

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 11: Existing delivery and read receipts continue to work
  // ═══════════════════════════════════════════════════════════════════
  test('11. Unblocked conversations progress monotonically from sent to delivered and read', () => {
    const roomState = new RoomMessagesState('user_b');
    roomState.setInitialMessages('dm_user_b_user_c', []);

    const clientMsgId = 'local-unblocked-receipt-test';
    const opt = createOptimisticMessage('dm_user_b_user_c', 'user_b', 'Hello Charlie', clientMsgId);
    roomState.addOptimisticMessage(opt);

    // 1. Server accepts: sent (single tick)
    roomState.updateReceipt(clientMsgId, MESSAGE_STATUS.SENT, 'dm_user_b_user_c');
    assert.equal(roomState.getStatus(clientMsgId), MESSAGE_STATUS.SENT);
    assert.equal(getTickDescriptor(MESSAGE_STATUS.SENT, true).symbol, '✓');

    // 2. Charlie receives: delivered (double grey tick)
    roomState.updateReceipt(clientMsgId, MESSAGE_STATUS.DELIVERED, 'dm_user_b_user_c');
    assert.equal(roomState.getStatus(clientMsgId), MESSAGE_STATUS.DELIVERED);
    assert.equal(getTickDescriptor(MESSAGE_STATUS.DELIVERED, true).symbol, '✓✓');
    assert.equal(getTickDescriptor(MESSAGE_STATUS.DELIVERED, true).statusClass, 'status-delivered');

    // 3. Charlie opens: read (double blue tick)
    roomState.updateReceipt(clientMsgId, MESSAGE_STATUS.READ, 'dm_user_b_user_c');
    assert.equal(roomState.getStatus(clientMsgId), MESSAGE_STATUS.READ);
    assert.equal(getTickDescriptor(MESSAGE_STATUS.READ, true).symbol, '✓✓');
    assert.equal(getTickDescriptor(MESSAGE_STATUS.READ, true).statusClass, 'status-read');
  });

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 12: Server rejection before acceptance is not displayed as sent
  // ═══════════════════════════════════════════════════════════════════
  test('12. Server rejection before acceptance preserves failed state and does not show single tick', () => {
    const roomState = new RoomMessagesState('user_b');
    roomState.setInitialMessages('dm_user_b_user_x', []);

    const clientMsgId = 'local-rejected-msg-001';
    const opt = createOptimisticMessage('dm_user_b_user_x', 'user_b', 'Fails before server acceptance', clientMsgId);
    roomState.addOptimisticMessage(opt);

    // Network or 500 error drops before server accepts
    roomState.updateReceipt(clientMsgId, MESSAGE_STATUS.FAILED, 'dm_user_b_user_x');

    assert.equal(roomState.getStatus(clientMsgId), MESSAGE_STATUS.FAILED);
    const tickDesc = getTickDescriptor(MESSAGE_STATUS.FAILED, true);
    assert.equal(tickDesc.symbol, '⚠️');
    assert.equal(tickDesc.statusClass, 'status-failed');
    assert.equal(tickDesc.title, 'Failed to send');
    assert.notEqual(tickDesc.symbol, '✓', 'Rejected message must NEVER falsely display sent tick');
  });

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 13: Blocker view hides blocked photo/presence, third parties unaffected
  // ═══════════════════════════════════════════════════════════════════
  test('13. Blocker User A sees fallback initials and offline status for User B; User C view unaffected', () => {
    const shellStateA = new ChatShellState();
    shellStateA.currentUser = { userId: 'user_a' };

    // User A blocks User B
    shellStateA.setBlockedUsers([{ userId: 'user_b' }]);

    const convB = {
      roomId: 'dm_user_a_user_b',
      kind: 'direct',
      name: 'Bob Builder',
      peerUserId: 'user_b',
      peer: { userId: 'user_b', displayName: 'Bob Builder', avatarUrl: 'https://cdn.ollacore.com/bob.jpg' }
    };
    shellStateA.setInbox([convB]);

    // 1. User B's photo is suppressed on User A's client
    assert.equal(convB.isBlocked, true);
    assert.equal(convB.avatarUrl, null);
    assert.equal(convB.peer.avatarUrl, null);

    // 2. Fallback avatar initials and color are available
    const initials = getAvatarInitials(getConversationTitle(convB));
    assert.equal(initials, 'BB');

    // 3. User B's presence is strictly offline to User A even if live event claims online
    shellStateA.setPresence('dm_user_a_user_b', 'user_b', true);
    assert.equal(shellStateA.isUserOnline('dm_user_a_user_b', 'user_b'), false);
    shellStateA.setTyping('dm_user_a_user_b', 'user_b', true);
    assert.equal(shellStateA.isUserTyping('dm_user_a_user_b', 'user_b'), false);

    // 4. Third-party User C has NOT blocked User B: User C's view is unaffected
    const shellStateC = new ChatShellState();
    shellStateC.currentUser = { userId: 'user_c' };
    const convBforC = {
      roomId: 'dm_user_c_user_b',
      kind: 'direct',
      name: 'Bob Builder',
      peerUserId: 'user_b',
      avatarUrl: 'https://cdn.ollacore.com/bob.jpg',
      peer: { userId: 'user_b', displayName: 'Bob Builder', avatarUrl: 'https://cdn.ollacore.com/bob.jpg' }
    };
    shellStateC.setInbox([convBforC]);
    assert.equal(Boolean(convBforC.isBlocked), false);
    assert.equal(convBforC.avatarUrl, 'https://cdn.ollacore.com/bob.jpg');

    shellStateC.setPresence('dm_user_c_user_b', 'user_b', true);
    assert.equal(shellStateC.isUserOnline('dm_user_c_user_b', 'user_b'), true);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 14: listBlockedUsers parses user_ids schema and setBlockedUsers purges caches
  // ═══════════════════════════════════════════════════════════════════
  test('14. listBlockedUsers parses user_ids schema and setBlockedUsers purges caches', () => {
    // Test normalizer with user_ids array
    const rawIds = ['user_x', 'user_y'];
    const normalized = rawIds.map(normalizeBlockItem);
    assert.equal(normalized[0].userId, 'user_x');
    assert.equal(normalized[1].userId, 'user_y');

    const shellState = new ChatShellState();
    shellState.currentUser = { userId: 'user_a' };
    const convX = {
      roomId: 'dm_user_a_user_x',
      kind: 'direct',
      name: 'Xavier',
      peerUserId: 'user_x',
      avatarUrl: 'https://cdn.ollacore.com/x.jpg',
      peer: { userId: 'user_x', avatarUrl: 'https://cdn.ollacore.com/x.jpg' }
    };
    shellState.conversations = [convX];

    // Seed cached presence
    shellState.presenceByRoom.set('dm_user_a_user_x', new Map([['user_x', true]]));
    shellState.typingByRoom.set('dm_user_a_user_x', new Set(['user_x']));

    // Applying blocked users clears presence and purges avatarUrl
    shellState.setBlockedUsers(normalized);
    assert.equal(shellState.isUserBlocked('user_x'), true);
    assert.equal(convX.avatarUrl, null);
    assert.equal(convX.isBlocked, true);
    assert.equal(shellState.isUserOnline('dm_user_a_user_x', 'user_x'), false);
    assert.equal(shellState.isUserTyping('dm_user_a_user_x', 'user_x'), false);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 15: Outbox cleanup and single grey tick without Retry button
  // ═══════════════════════════════════════════════════════════════════
  test('15. Server-accepted message receives single tick, removes outbox item, and does not show Retry', async () => {
    const roomState = new RoomMessagesState('user_sender');
    roomState.setInitialMessages('dm_user_sender_user_blocked', []);

    const clientMsgId = 'local-outbox-single-tick-01';
    const optMsg = createOptimisticMessage(
      'dm_user_sender_user_blocked',
      'user_sender',
      'Hello into suppressed void',
      clientMsgId
    );
    roomState.addOptimisticMessage(optMsg);

    // 1. Enqueue outbox item into SQLite using suite's configured dbService
    await outbox.enqueue({
      clientMessageId: clientMsgId,
      roomId: 'dm_user_sender_user_blocked',
      wirePayload: { client_message_id: clientMsgId, body: { text: 'Hello' } },
      optimisticMsg: optMsg,
      dbBridge: dbService
    });

    const pendingBefore = await dbService.getPendingOutbox();
    assert.equal(pendingBefore.length, 1);
    assert.equal(pendingBefore[0].client_message_id, clientMsgId);

    // 2. Server authoritatively accepts with ACK:
    // Transition to sent (single grey tick)
    roomState.updateReceipt(clientMsgId, MESSAGE_STATUS.SENT, 'dm_user_sender_user_blocked');
    assert.equal(roomState.getStatus(clientMsgId), MESSAGE_STATUS.SENT);

    // Tick descriptor confirms single grey tick and no failed status
    const tickDesc = getTickDescriptor(MESSAGE_STATUS.SENT, true);
    assert.equal(tickDesc.symbol, '✓');
    assert.equal(tickDesc.statusClass, 'status-sent');
    assert.notEqual(tickDesc.statusClass, 'status-failed');

    // 3. Authoritative ACK clears outbox record
    await outbox.clear({ clientMessageId: clientMsgId, dbBridge: dbService });
    const pendingAfter = await dbService.getPendingOutbox();
    assert.equal(pendingAfter.length, 0, 'Accepted message MUST be removed from pending outbox');

    // 4. Verify cannot downgrade to failed
    const downgradeAttempt = roomState.updateReceipt(clientMsgId, MESSAGE_STATUS.FAILED, 'dm_user_sender_user_blocked');
    assert.equal(downgradeAttempt, false, 'Accepted sent message cannot downgrade to failed');
    assert.equal(roomState.getStatus(clientMsgId), MESSAGE_STATUS.SENT);
  });
});
