import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

import { DatabaseService } from '../src/storage/db/database-service.js';
import {
  RoomMessagesState,
  getTickDescriptor,
  getHighestStatus,
  isOwnMessage,
  loadPersistentReceiptStore,
  savePersistentReceipt
} from '../src/renderer/chat-shell-state.js';

describe('OllaCore Read Receipt Synchronization & Restart Recovery', () => {
  let tmpDir;
  let dbService;
  let mockSessionStore;
  const currentUserId = 'user-alice';
  const peerUserId = 'user-bob';
  const roomId = 'room-101';

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'ollachat-sync-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    await fs.mkdir(tmpDir, { recursive: true });
    mockSessionStore = {
      currentSession: { userId: currentUserId },
      getSession() {
        return this.currentSession;
      }
    };
    dbService = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });
  });

  afterEach(async () => {
    if (dbService && dbService.databaseManager?.isOpen) {
      await dbService.databaseManager.close();
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('1. WebSocket receipt with OllaCore payload.seq format updates peer read sequence and marks messages read', async () => {
    const state = new RoomMessagesState(currentUserId);
    state.setInitialMessages(roomId, [
      { id: 'msg-1', eventSeq: 10, senderId: currentUserId, status: 'sent', body: { text: 'Hello' } },
      { id: 'msg-2', eventSeq: 11, senderId: currentUserId, status: 'sent', body: { text: 'How are you?' } },
      { id: 'msg-3', eventSeq: 12, senderId: currentUserId, status: 'sent', body: { text: 'Are you there?' } }
    ]);

    // Simulate OllaCore WebSocket frame for receipt.read with seq: 11
    const frame = {
      v: 1,
      event_id: 0,
      type: 'receipt.read',
      room_id: roomId,
      payload: {
        principal_id: peerUserId,
        message_id: 'msg-2',
        seq: 11
      }
    };

    const effectiveSeq = frame.payload?.seq ?? frame.payload?.event_seq ?? frame.seq ?? null;
    assert.equal(effectiveSeq, 11, 'Should extract sequence from payload.seq');

    state.updateReceipt(frame.payload.message_id, 'read', roomId);
    state.setPeerLastReadSeq(effectiveSeq);

    assert.equal(state.messages[0].status, 'read', 'msg-1 should be read');
    assert.equal(state.messages[1].status, 'read', 'msg-2 should be read');
    assert.equal(state.messages[2].status, 'sent', 'msg-3 (seq 12) should remain sent');
  });

  test('2. Server unread cursor (GET /rooms/{roomId}/unread) reconciles offline read receipts after app restart', async () => {
    // 1. Save messages in SQLite as sent
    await dbService.saveMessage({
      id: 'msg-cold-1',
      roomId,
      senderId: currentUserId,
      eventSeq: 5,
      status: 'sent',
      body: { text: 'Message 1' }
    });
    await dbService.saveMessage({
      id: 'msg-cold-2',
      roomId,
      senderId: currentUserId,
      eventSeq: 6,
      status: 'sent',
      body: { text: 'Message 2' }
    });

    // 2. Simulate server unread cursor arriving from GET /rooms/{roomId}/unread
    const serverUnreadResponse = {
      unread_count: 0,
      last_read_seq: 6
    };

    // Store peer_read_seq into app_metadata
    await dbService.setMetadata(`peer_read_seq:${roomId}`, String(serverUnreadResponse.last_read_seq));

    // 3. Re-query SQLite as on cold restart
    const loadedMessages = await dbService.getMessages({ roomId });
    assert.equal(loadedMessages.length, 2);
    assert.equal(loadedMessages[0].status, 'read', 'msg-cold-1 status should be resolved as read from SQLite');
    assert.equal(loadedMessages[1].status, 'read', 'msg-cold-2 status should be resolved as read from SQLite');
  });

  test('3. Server pagination never downgrades existing read status in SQLite', async () => {
    // Message already read
    await dbService.saveMessage({
      id: 'msg-preserved-1',
      roomId,
      senderId: currentUserId,
      eventSeq: 20,
      status: 'read',
      body: { text: 'Preserved' }
    });

    // Incoming server pagination where status is undefined or 'sent'
    await dbService.saveMessage({
      id: 'msg-preserved-1',
      roomId,
      senderId: currentUserId,
      eventSeq: 20,
      status: 'sent',
      body: { text: 'Preserved' }
    });

    const rows = await dbService.getMessages({ roomId });
    const msg = rows.find(m => m.id === 'msg-preserved-1');
    assert.equal(msg.status, 'read', 'Read message must not be downgraded to sent');
  });

  test('4. Receipt.read batch-updates all messages in room up to effectiveSeq to read in SQLite and app_metadata', async () => {
    // Save outgoing messages sent after peer's last message
    await dbService.saveMessage({
      id: 'msg-out-1',
      roomId,
      senderId: currentUserId,
      eventSeq: 50,
      status: 'sent',
      body: { text: 'hi' }
    });
    await dbService.saveMessage({
      id: 'msg-out-2',
      roomId,
      senderId: currentUserId,
      eventSeq: 51,
      status: 'sent',
      body: { text: 'hi again' }
    });

    // Peer reads up to seq 51 without sending a reply message
    await dbService.updateMessageStatus({
      id: 'msg-out-2',
      status: 'read',
      eventSeq: 51,
      roomId
    });

    // Check app_metadata
    const meta = await dbService.getMetadata(`peer_read_seq:${roomId}`);
    assert.equal(meta?.value, '51', 'app_metadata peer_read_seq must be 51');

    // On cold restart, verify both post-reply messages remain 'read'
    const rows = await dbService.getMessages({ roomId });
    const m1 = rows.find(m => m.id === 'msg-out-1');
    const m2 = rows.find(m => m.id === 'msg-out-2');
    assert.equal(m1.status, 'read', 'Earlier outgoing message msg-out-1 must be read');
    assert.equal(m2.status, 'read', 'Latest outgoing message msg-out-2 must be read');
  });

  test('5. Optimistic message reconciliation with server ACK transitions ID and eventSeq, preserving read status', async () => {
    const clientMsgId = 'local-uuid-999';
    const serverCanonicalId = 'msg-canonical-999';

    // 1. Initial optimistic send saved to SQLite
    await dbService.saveMessage({
      id: clientMsgId,
      clientMessageId: clientMsgId,
      roomId,
      senderId: currentUserId,
      eventSeq: 0,
      status: 'sending',
      body: { text: 'optimistic text' }
    });

    // 2. Receipt arrives early before canonical ACK
    await dbService.updateMessageStatus({
      id: serverCanonicalId,
      status: 'read',
      eventSeq: 105,
      roomId
    });

    // 3. ACK arrives from server reconciling canonical ID and eventSeq
    await dbService.saveMessage({
      id: serverCanonicalId,
      clientMessageId: clientMsgId,
      roomId,
      senderId: currentUserId,
      eventSeq: 105,
      status: 'sent',
      body: { text: 'optimistic text' }
    });

    // 4. Query DB - old optimistic row must be cleaned up and canonical row must be 'read'
    const rows = await dbService.getMessages({ roomId });
    assert.equal(rows.some(m => m.id === clientMsgId), false, 'Old optimistic ID must be deleted');
    const canonicalRow = rows.find(m => m.id === serverCanonicalId);
    assert.ok(canonicalRow, 'Canonical message row must exist');
    assert.equal(canonicalRow.event_seq, 105, 'Canonical event_seq must be 105');
    assert.equal(canonicalRow.status, 'read', 'Status must be upgraded to read via staged receipt');
  });

  test('6. Persistent receipt store retains read status for post-reply messages across simulated app restart', async () => {
    // Mock global localStorage
    const storageMap = new Map();
    globalThis.localStorage = {
      getItem(k) { return storageMap.get(k) || null; },
      setItem(k, v) { storageMap.set(k, String(v)); },
      removeItem(k) { storageMap.delete(k); },
      clear() { storageMap.clear(); }
    };

    const targetRoom = 'room-post-reply';
    const postReplyMsgId = 'msg-post-reply-1';

    // 1. Initial live session: peer sends read receipt for post-reply message
    savePersistentReceipt(targetRoom, postReplyMsgId, 'read');

    // 2. Simulated app restart: brand new memory heap with fresh store
    const freshSharedStore = new Map();
    loadPersistentReceiptStore(freshSharedStore);

    const reloadedState = new RoomMessagesState(currentUserId, freshSharedStore);
    reloadedState.roomId = targetRoom;
    reloadedState.messages = [
      {
        id: postReplyMsgId,
        roomId: targetRoom,
        senderId: currentUserId,
        status: 'sent', // Raw message loaded from server without read receipt
        eventSeq: 6641
      }
    ];

    // Even if server unread cursor is stuck at 6640 (before post-reply message):
    reloadedState.setPeerLastReadSeq(6640);

    // Verify status resolution on restart
    const resolvedStatus = reloadedState.getStatus(postReplyMsgId);
    assert.equal(resolvedStatus, 'read', 'Post-reply message must resolve as read from persistent receipt store');
    const tickDesc = getTickDescriptor(resolvedStatus, true);
    assert.equal(tickDesc.statusClass, 'status-read', 'Must render double blue ticks');
  });
});
