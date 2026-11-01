import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { DatabaseManager } from '../src/storage/db/database-manager.js';
import { DatabaseService } from '../src/storage/db/database-service.js';
import {
  sqliteRowToConversation,
  conversationToSqlitePayload,
  sqliteRowToMessage,
  messageToSqlitePayload
} from '../src/renderer/db-sync.js';
import { ChatShellState, RoomMessagesState } from '../src/renderer/chat-shell-state.js';

describe('Phase 4A: SQLite Persistence Integration Tests', () => {
  let tmpDir;
  let mockSessionStore;
  let dbService;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'ollachat-phase4a-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    await fs.mkdir(tmpDir, { recursive: true });

    mockSessionStore = {
      currentSession: {
        userId: 'user_alice',
        sessionToken: 'token_secret_123',
        phone: '+15550001'
      },
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

  // 1. Conversation Persistence
  test('1. conversation persistence: saves conversation and restores all attributes', async () => {
    const conv = {
      roomId: 'room_general',
      title: 'General Chat',
      kind: 'group',
      unreadCount: 3,
      isPinned: true,
      pinnedAt: '2026-10-06T10:00:00.000Z',
      isFavourite: true,
      isMarkedUnread: true,
      isArchived: false,
      lastMessage: {
        id: 'msg_100',
        preview: 'Hello everyone!',
        senderId: 'user_bob',
        createdAt: '2026-10-06T10:05:00.000Z',
        kind: 'text'
      }
    };

    await dbService.saveConversation(conv);
    const rawRows = await dbService.getConversations();

    assert.equal(rawRows.length, 1);
    const raw = rawRows[0];
    assert.equal(raw.room_id, 'room_general');
    assert.equal(raw.room_name, 'General Chat');
    assert.equal(raw.kind, 'group');
    assert.equal(raw.unread_count, 3);
    assert.equal(raw.is_pinned, 1);
    assert.equal(raw.is_favourite, 1);
    assert.equal(raw.is_marked_unread, 1);
    assert.equal(raw.is_archived, 0);
    assert.equal(raw.last_message_preview, 'Hello everyone!');

    // Test conversion through adapter
    const domain = sqliteRowToConversation(raw);
    assert.equal(domain.roomId, 'room_general');
    assert.equal(domain.title, 'General Chat');
    assert.equal(domain.isPinned, true);
    assert.equal(domain.isFavourite, true);
    assert.equal(domain.isMarkedUnread, true);
    assert.equal(domain.unreadCount, 3);
    assert.equal(domain.lastMessage.preview, 'Hello everyone!');
  });

  // 2. Message Persistence
  test('2. message persistence: stores sent, received, and media messages with receipts', async () => {
    const sentMsg = {
      id: 'msg_sent_1',
      roomId: 'room_1',
      clientMessageId: 'client_local_1',
      senderId: 'user_alice',
      kind: 'text',
      body: { text: 'How are you?' },
      deliveryStatus: 'sent',
      createdAt: '2026-10-06T11:00:00.000Z'
    };

    const receivedMediaMsg = {
      id: 'msg_recv_2',
      roomId: 'room_1',
      senderId: 'user_bob',
      kind: 'image',
      body: {
        text: 'photo.png',
        filename: 'photo.png',
        mime: 'image/png',
        byte_size: 1048576,
        url: 'https://example.com/photo.png'
      },
      deliveryStatus: 'delivered',
      createdAt: '2026-10-06T11:01:00.000Z'
    };

    await dbService.saveMessage(sentMsg);
    await dbService.saveMessage(receivedMediaMsg);

    const rawMsgs = await dbService.getMessages({ roomId: 'room_1' });
    assert.equal(rawMsgs.length, 2);

    const msgs = rawMsgs.map(sqliteRowToMessage);
    const m1 = msgs.find(m => m.id === 'msg_sent_1');
    assert.ok(m1);
    assert.equal(m1.clientMessageId, 'client_local_1');
    assert.equal(m1.body.text, 'How are you?');
    assert.equal(m1.deliveryStatus, 'sent');

    const m2 = msgs.find(m => m.id === 'msg_recv_2');
    assert.ok(m2);
    assert.equal(m2.kind, 'image');
    assert.equal(m2.body.filename, 'photo.png');
    assert.equal(m2.deliveryStatus, 'delivered');
  });

  // 3. Restart / Reload Persistence
  test('3. restart/reload persistence: data survives closing and re-opening SQLite database', async () => {
    await dbService.saveConversation({
      roomId: 'room_persist',
      title: 'Persistent Room',
      isPinned: true
    });

    await dbService.saveMessage({
      id: 'msg_survive',
      roomId: 'room_persist',
      senderId: 'user_alice',
      kind: 'text',
      body: { text: 'Survives restart' },
      createdAt: '2026-10-06T12:00:00.000Z'
    });

    // Close database
    await dbService.databaseManager.close();
    assert.equal(dbService.databaseManager.isOpen, false);

    // Create a new DatabaseService pointing to the same storageDir (simulating app restart)
    const restartedDbService = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });

    const rawConvs = await restartedDbService.getConversations();
    assert.equal(rawConvs.length, 1);
    const domainConv = sqliteRowToConversation(rawConvs[0]);
    assert.equal(domainConv.roomId, 'room_persist');
    assert.equal(domainConv.title, 'Persistent Room');
    assert.equal(domainConv.isPinned, true);

    const rawMsgs = await restartedDbService.getMessages({ roomId: 'room_persist' });
    assert.equal(rawMsgs.length, 1);
    const domainMsg = sqliteRowToMessage(rawMsgs[0]);
    assert.equal(domainMsg.id, 'msg_survive');
    assert.equal(domainMsg.body.text, 'Survives restart');

    await restartedDbService.databaseManager.close();
  });

  // 4. Message Edit Persistence
  test('4. message edit persistence: updates body and sets is_edited and edited_at', async () => {
    await dbService.saveMessage({
      id: 'msg_edit_me',
      roomId: 'room_edit',
      senderId: 'user_alice',
      kind: 'text',
      body: { text: 'Original message text' },
      createdAt: '2026-10-06T12:00:00.000Z'
    });

    const editTimestamp = '2026-10-06T12:05:00.000Z';
    await dbService.updateMessageEdit({
      id: 'msg_edit_me',
      body: { text: 'Edited text from user' },
      editedAt: editTimestamp
    });

    const rawMsgs = await dbService.getMessages({ roomId: 'room_edit' });
    assert.equal(rawMsgs.length, 1);
    const edited = sqliteRowToMessage(rawMsgs[0]);
    assert.equal(edited.body.text, 'Edited text from user');
    assert.equal(edited.editedAt, editTimestamp);
  });

  // 5. Message Deletion Persistence
  test('5. message deletion persistence: handles delete for everyone and delete for me', async () => {
    await dbService.saveMessage({
      id: 'msg_del_all',
      roomId: 'room_del',
      senderId: 'user_alice',
      kind: 'text',
      body: { text: 'Will be deleted for everyone' },
      createdAt: '2026-10-06T13:00:00.000Z'
    });

    await dbService.saveMessage({
      id: 'msg_del_me',
      roomId: 'room_del',
      senderId: 'user_bob',
      kind: 'text',
      body: { text: 'Will be deleted for me only' },
      createdAt: '2026-10-06T13:01:00.000Z'
    });

    // Delete for everyone
    await dbService.markMessageDeleted({ id: 'msg_del_all' });

    // Delete for me
    await dbService.markMessageDeletedForMe({ id: 'msg_del_me' });

    // With excludeDeletedForMe = true
    const msgsExcluding = await dbService.getMessages({ roomId: 'room_del', excludeDeletedForMe: true });
    assert.equal(msgsExcluding.length, 1);
    const domainExcluding = sqliteRowToMessage(msgsExcluding[0]);
    assert.equal(domainExcluding.id, 'msg_del_all');
    assert.equal(domainExcluding.isDeleted, true);
    assert.equal(domainExcluding.body.text, 'This message was deleted');

    // Without excluding delete-for-me
    const allRawMsgs = await dbService.getMessages({ roomId: 'room_del', excludeDeletedForMe: false });
    assert.equal(allRawMsgs.length, 2);
    const allMsgs = allRawMsgs.map(sqliteRowToMessage);
    const delMe = allMsgs.find(m => m.id === 'msg_del_me');
    assert.equal(delMe.isDeletedForMe, true);
  });

  // 6. Read / Delivery Status Persistence
  test('6. read/delivery status persistence: monotonic progression (sent -> delivered -> read)', async () => {
    await dbService.saveMessage({
      id: 'msg_receipt_prog',
      roomId: 'room_receipts',
      senderId: 'user_alice',
      kind: 'text',
      body: { text: 'Receipt progression check' },
      status: 'sending',
      createdAt: '2026-10-06T14:00:00.000Z'
    });

    // Update to sent
    await dbService.updateMessageStatus({ id: 'msg_receipt_prog', status: 'sent' });
    let msgs = (await dbService.getMessages({ roomId: 'room_receipts' })).map(sqliteRowToMessage);
    assert.equal(msgs[0].deliveryStatus, 'sent');

    // Update to delivered
    await dbService.updateMessageStatus({ id: 'msg_receipt_prog', status: 'delivered' });
    msgs = (await dbService.getMessages({ roomId: 'room_receipts' })).map(sqliteRowToMessage);
    assert.equal(msgs[0].deliveryStatus, 'delivered');

    // Update to read
    await dbService.updateMessageStatus({ id: 'msg_receipt_prog', status: 'read' });
    msgs = (await dbService.getMessages({ roomId: 'room_receipts' })).map(sqliteRowToMessage);
    assert.equal(msgs[0].deliveryStatus, 'read');

    // Attempting to downgrade back to delivered must NOT overwrite read
    await dbService.updateMessageStatus({ id: 'msg_receipt_prog', status: 'delivered' });
    msgs = (await dbService.getMessages({ roomId: 'room_receipts' })).map(sqliteRowToMessage);
    assert.equal(msgs[0].deliveryStatus, 'read');
  });

  // 7. Duplicate Prevention & Optimistic Reconciliation
  test('7. duplicate prevention: deduplicates message upserts and reconciles optimistic clientMessageId', async () => {
    const optimisticId = 'local-abc-123';
    const serverCanonicalId = 'msg-server-789';

    // 1. Optimistic message saved locally with clientMessageId
    await dbService.saveMessage({
      id: optimisticId,
      roomId: 'room_reconcile',
      clientMessageId: optimisticId,
      senderId: 'user_alice',
      kind: 'text',
      body: { text: 'Hello optimistic world' },
      status: 'sending',
      createdAt: '2026-10-06T15:00:00.000Z'
    });

    let msgs = (await dbService.getMessages({ roomId: 'room_reconcile' })).map(sqliteRowToMessage);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].id, optimisticId);

    // 2. Server ACK arrives with canonical server ID and original clientMessageId
    await dbService.saveMessage({
      id: serverCanonicalId,
      roomId: 'room_reconcile',
      clientMessageId: optimisticId,
      senderId: 'user_alice',
      kind: 'text',
      body: { text: 'Hello optimistic world' },
      status: 'sent',
      createdAt: '2026-10-06T15:00:01.000Z'
    });

    // Must reconcile the temporary row, resulting in exactly ONE row with canonical server ID
    msgs = (await dbService.getMessages({ roomId: 'room_reconcile' })).map(sqliteRowToMessage);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].id, serverCanonicalId);
    assert.equal(msgs[0].clientMessageId, optimisticId);
    assert.equal(msgs[0].deliveryStatus, 'sent');

    // 3. Saving canonical message a second time (e.g. from inbox sync) does not duplicate
    await dbService.saveMessage({
      id: serverCanonicalId,
      roomId: 'room_reconcile',
      clientMessageId: optimisticId,
      senderId: 'user_alice',
      kind: 'text',
      body: { text: 'Hello optimistic world' },
      status: 'delivered',
      createdAt: '2026-10-06T15:00:01.000Z'
    });

    msgs = (await dbService.getMessages({ roomId: 'room_reconcile' })).map(sqliteRowToMessage);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].deliveryStatus, 'delivered');
  });

  // 8. Server-Sync Merge
  test('8. server-sync merge: preserves local-only flags (pinned, favourite, custom lists) during server refresh', async () => {
    // 1. User pinned and favorited a conversation locally
    await dbService.saveConversation({
      roomId: 'room_merge_test',
      title: 'Local Group',
      isPinned: true,
      pinnedAt: '2026-10-06T10:00:00.000Z',
      isFavourite: true,
      isMarkedUnread: false
    });

    // 2. Server sends updated inbox entry WITHOUT isPinned or isFavourite
    const serverInboxConv = {
      roomId: 'room_merge_test',
      title: 'Renamed Server Group',
      unreadCount: 5,
      lastMessage: {
        id: 'msg_new',
        preview: 'New server message',
        senderId: 'user_charlie',
        createdAt: '2026-10-06T15:30:00.000Z'
      }
    };

    await dbService.saveConversation(serverInboxConv);

    const rawConvs = await dbService.getConversations();
    assert.equal(rawConvs.length, 1);
    const merged = sqliteRowToConversation(rawConvs[0]);
    // Server updates applied:
    assert.equal(merged.title, 'Renamed Server Group');
    assert.equal(merged.unreadCount, 5);
    assert.equal(merged.lastMessage.preview, 'New server message');
    // Local-only fields safely preserved:
    assert.equal(merged.isPinned, true);
    assert.equal(merged.isFavourite, true);
  });

  // 9. Local-First Startup
  test('9. local-first startup: SQLite adapter converts rows to ChatShellState format immediately', async () => {
    await dbService.saveConversation({
      roomId: 'room_startup',
      title: 'Startup Chat',
      isPinned: true,
      isFavourite: false,
      unreadCount: 2,
      lastMessage: {
        id: 'msg_start_1',
        preview: 'Saved from previous session',
        senderId: 'user_bob',
        createdAt: '2026-10-06T09:00:00.000Z'
      }
    });

    await dbService.saveMessage({
      id: 'msg_start_1',
      roomId: 'room_startup',
      senderId: 'user_bob',
      kind: 'text',
      body: { text: 'Saved from previous session' },
      createdAt: '2026-10-06T09:00:00.000Z',
      status: 'read'
    });

    // Simulate startup retrieval
    const sqliteConvs = await dbService.getConversations();
    const domainConvs = sqliteConvs.map(sqliteRowToConversation);

    const shellState = new ChatShellState();
    shellState.setInbox(domainConvs);

    assert.equal(shellState.conversations.length, 1);
    const shellConv = shellState.conversations[0];
    assert.equal(shellConv.roomId, 'room_startup');
    assert.equal(shellConv.title, 'Startup Chat');
    assert.equal(shellConv.lastMessage.preview, 'Saved from previous session');

    // Simulate opening room local-first
    const sqliteMsgs = await dbService.getMessages({ roomId: 'room_startup' });
    const domainMsgs = sqliteMsgs.map(sqliteRowToMessage);

    const roomState = new RoomMessagesState('user_alice');
    roomState.setInitialMessages('room_startup', domainMsgs, false);

    assert.equal(roomState.messages.length, 1);
    assert.equal(roomState.messages[0].id, 'msg_start_1');
    assert.equal(roomState.messages[0].body.text, 'Saved from previous session');
    assert.equal(roomState.messages[0].deliveryStatus, 'read');
  });

  // 10. Existing Unread Behavior
  test('10. existing unread behavior: unread count and markedUnread state are accurately tracked', async () => {
    await dbService.saveConversation({
      roomId: 'room_unread_test',
      title: 'Unread Chat',
      unreadCount: 4,
      isMarkedUnread: true
    });

    let convs = (await dbService.getConversations()).map(sqliteRowToConversation);
    assert.equal(convs[0].unreadCount, 4);
    assert.equal(convs[0].isMarkedUnread, true);

    // Reading the room clears unreadCount and isMarkedUnread
    await dbService.saveConversation({
      roomId: 'room_unread_test',
      unreadCount: 0,
      isMarkedUnread: false
    });

    convs = (await dbService.getConversations()).map(sqliteRowToConversation);
    assert.equal(convs[0].unreadCount, 0);
    assert.equal(convs[0].isMarkedUnread, false);
  });
});
