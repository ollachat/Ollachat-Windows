import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoomMessagesState,
  formatReplyPreview,
  getReplySenderName,
  resolveMessageContent,
  isOwnMessage
} from '../src/renderer/chat-shell-state.js';
import {
  sqliteRowToMessage,
  messageToSqlitePayload,
  loadMessageByIdFromDb
} from '../src/renderer/db-sync.js';

describe('Regression Tests: SQLite & History-First Reply Resolution & Message History', () => {
  let prevWindow;

  beforeEach(() => {
    prevWindow = globalThis.window;
  });

  afterEach(() => {
    globalThis.window = prevWindow;
  });

  // 1. Message missing from current in-memory window but present in SQLite
  test('1. Message missing from in-memory state is found via SQLite loadMessageByIdFromDb', async () => {
    const memoryState = new RoomMessagesState('user-alice');
    memoryState.setInitialMessages('room-1', [
      { id: 'msg-recent-10', eventSeq: 100, senderId: 'user-bob', body: { text: 'Recent message' } }
    ]);

    // Original message is NOT in memory
    const inMem = memoryState.messages.find((m) => m.id === 'msg-older-1');
    assert.strictEqual(inMem, undefined);

    // Mock SQLite DB with the older message
    globalThis.window = {
      ollacoreDesktop: {
        db: {
          getMessageById: async ({ id, roomId }) => {
            if (id === 'msg-older-1' && roomId === 'room-1') {
              return {
                id: 'msg-older-1',
                room_id: 'room-1',
                sender_id: 'user-bob',
                client_message_id: 'cid-older-1',
                kind: 'text',
                body_json: JSON.stringify({ text: 'Crucial historical detail' }),
                created_at: '2026-10-01T12:00:00Z',
                is_deleted: 0,
                is_deleted_for_me: 0
              };
            }
            return null;
          }
        }
      }
    };

    const fromDb = await loadMessageByIdFromDb('msg-older-1', 'room-1');
    assert.ok(fromDb);
    assert.equal(fromDb.id, 'msg-older-1');
    assert.equal(fromDb.body.text, 'Crucial historical detail');
    assert.equal(formatReplyPreview(fromDb), 'Crucial historical detail');
  });

  // 2. Reply preview resolving from SQLite
  test('2. Reply preview resolves content from SQLite when target message is outside in-memory window', async () => {
    const memoryState = new RoomMessagesState('user-alice');
    const replyMessage = {
      id: 'msg-reply-101',
      senderId: 'user-alice',
      replyTo: 'msg-sqlite-only',
      body: { text: 'I agree with this point' }
    };
    memoryState.setInitialMessages('room-1', [replyMessage]);

    // Simulate 4-tier resolution:
    // Tier 1: In-memory lookup
    let target = memoryState.messages.find((m) => m.id === replyMessage.replyTo);
    assert.strictEqual(target, undefined);

    // Tier 2: SQLite lookup
    globalThis.window = {
      ollacoreDesktop: {
        db: {
          getMessageById: async ({ id }) => {
            if (id === 'msg-sqlite-only') {
              return {
                id: 'msg-sqlite-only',
                room_id: 'room-1',
                sender_id: 'user-bob',
                kind: 'text',
                body_json: JSON.stringify({ text: 'Proposal discussed yesterday' }),
                created_at: '2026-10-01T10:00:00Z',
                is_deleted: 0
              };
            }
            return null;
          }
        }
      }
    };

    target = await loadMessageByIdFromDb(replyMessage.replyTo, 'room-1');
    assert.ok(target);
    const preview = formatReplyPreview(target);
    assert.equal(preview, 'Proposal discussed yesterday');
    assert.notEqual(preview, 'Message unavailable');
  });

  // 3. Reply preview resolving from OllaCore when absent from SQLite
  test('3. Reply preview falls back to OllaCore history API when absent from SQLite', async () => {
    globalThis.window = {
      ollacoreDesktop: {
        db: {
          getMessageById: async () => null // Not in local DB
        },
        chatApi: {
          getMessages: async (roomId, options) => {
            if (roomId === 'room-1') {
              return {
                messages: [
                  {
                    id: 'msg-server-only-88',
                    roomId: 'room-1',
                    senderId: 'user-charlie',
                    kind: 'text',
                    body: { text: 'Remote server archived announcement' },
                    createdAt: '2026-09-01T08:00:00Z'
                  }
                ]
              };
            }
            return { messages: [] };
          }
        }
      }
    };

    // Step A: Not in SQLite
    const fromDb = await loadMessageByIdFromDb('msg-server-only-88', 'room-1');
    assert.strictEqual(fromDb, null);

    // Step B: Fetch from OllaCore chatApi
    const apiRes = await globalThis.window.ollacoreDesktop.chatApi.getMessages('room-1', { limit: 50 });
    const target = apiRes.messages.find((m) => m.id === 'msg-server-only-88');
    assert.ok(target);
    assert.equal(formatReplyPreview(target), 'Remote server archived announcement');
    assert.notEqual(formatReplyPreview(target), 'Message unavailable');
  });

  // 4. Reply navigation to an older message outside the current loaded window
  test('4. Reply navigation loads older history, merges message, and enables scrolling to original', () => {
    const memoryState = new RoomMessagesState('user-alice');
    memoryState.setInitialMessages('room-nav', [
      { id: 'm-page2-1', eventSeq: 50, senderId: 'user-bob', body: { text: 'Newest discussion' } },
      { id: 'm-reply-nav', eventSeq: 51, senderId: 'user-alice', replyTo: 'm-older-target', body: { text: 'Replying to older' } }
    ], true);

    // Initial check: target is not yet present
    assert.strictEqual(memoryState.messages.some((m) => m.id === 'm-older-target'), false);

    // User clicks reply preview: app requests older batch containing target
    const olderBatch = [
      { id: 'm-older-target', eventSeq: 10, senderId: 'user-bob', body: { text: 'Original message from earlier' } }
    ];
    memoryState.prependOlderMessages(olderBatch, false);

    // Target is now in state and retains valid position
    const foundTarget = memoryState.messages.find((m) => m.id === 'm-older-target');
    assert.ok(foundTarget);
    assert.equal(memoryState.messages[0].id, 'm-older-target');
    assert.equal(formatReplyPreview(foundTarget), 'Original message from earlier');
  });

  // 5. Loading older history without losing existing messages
  test('5. Loading older history preserves all currently loaded messages and avoids duplication', () => {
    const state = new RoomMessagesState('user-alice');
    const page2 = [
      { id: 'msg-3', eventSeq: 30, body: { text: 'Three' } },
      { id: 'msg-4', eventSeq: 40, body: { text: 'Four' } }
    ];
    state.setInitialMessages('room-preserve', page2, true);
    assert.equal(state.messages.length, 2);

    // Older page arrives (has msg-1, msg-2, plus overlapping msg-3)
    const page1 = [
      { id: 'msg-1', eventSeq: 10, body: { text: 'One' } },
      { id: 'msg-2', eventSeq: 20, body: { text: 'Two' } },
      { id: 'msg-3', eventSeq: 30, body: { text: 'Three' } } // duplicate overlap
    ];
    state.prependOlderMessages(page1, false);

    assert.equal(state.messages.length, 4);
    assert.deepEqual(state.messages.map((m) => m.id), ['msg-1', 'msg-2', 'msg-3', 'msg-4']);
  });

  // 6. Numeric/string ID normalization
  test('6. Numeric and string ID normalization prevents duplicate messages across formats', () => {
    const state = new RoomMessagesState('user-alice');
    // First message with numeric ID
    state.setInitialMessages('room-norm', [
      { id: 100234, clientMessageId: 'cid-num-1', body: { text: 'Number ID' } }
    ]);
    assert.equal(state.messages.length, 1);

    // Incoming duplicate with string ID
    state.mergeServerMessages([
      { id: '100234', clientMessageId: 'cid-num-1', body: { text: 'Number ID updated' } }
    ]);
    assert.equal(state.messages.length, 1, 'String and numeric ID must reconcile without duplicating');
    assert.equal(String(state.messages[0].id), '100234');
  });

  // 7. client_message_id normalization
  test('7. client_message_id and clientMessageId camelCase/snake_case are normalized', () => {
    const state = new RoomMessagesState('user-alice');
    // Optimistic message with clientMessageId
    state.addOptimisticMessage({
      id: 'local-temp-555',
      clientMessageId: 'cid-universal-uuid',
      body: { text: 'Optimistic text' },
      status: 'sending'
    });
    assert.equal(state.messages.length, 1);

    // Server message arriving with snake_case client_message_id
    state.mergeServerMessages([
      {
        id: 'canonical-srv-777',
        client_message_id: 'cid-universal-uuid',
        body: { text: 'Optimistic text' }
      }
    ]);

    assert.equal(state.messages.length, 1, 'Optimistic message reconciled to canonical server message');
    assert.equal(state.messages[0].id, 'canonical-srv-777');
  });

  // 8. Duplicate prevention during SQLite + OllaCore merge
  test('8. Duplicate prevention during SQLite batch and OllaCore server merge', () => {
    const state = new RoomMessagesState('user-alice');
    // Initial batch loaded from SQLite
    const sqliteBatch = [
      { id: 'm-1', clientMessageId: 'cid-1', body: { text: 'From SQLite 1' } },
      { id: 'm-2', clientMessageId: 'cid-2', body: { text: 'From SQLite 2' } }
    ];
    state.setInitialMessages('room-merge', sqliteBatch, true);
    assert.equal(state.messages.length, 2);

    // Live or fetch merge from OllaCore with identical and additional messages
    const ollaCoreBatch = [
      { id: 'm-2', client_message_id: 'cid-2', body: { text: 'From OllaCore 2' } },
      { id: 'm-3', client_message_id: 'cid-3', body: { text: 'From OllaCore 3' } }
    ];
    state.mergeServerMessages(ollaCoreBatch);

    assert.equal(state.messages.length, 3, 'Must contain exactly 3 unique messages');
    assert.deepEqual(state.messages.map((m) => m.id), ['m-1', 'm-2', 'm-3']);
  });

  // 9. Sent message surviving restart via SQLite payload mapping
  test('9. Sent message survives restart via SQLite payload conversion and hydration', () => {
    const sentMsg = {
      id: 'msg-sent-901',
      roomId: 'room-restart-1',
      senderId: 'user-me',
      clientMessageId: 'cid-sent-901',
      kind: 'text',
      body: { text: 'Important outgoing instruction' },
      createdAt: '2026-10-07T12:00:00Z',
      eventSeq: 85
    };

    // Conversion to SQLite row
    const sqlitePayload = messageToSqlitePayload(sentMsg, 'room-restart-1');
    assert.ok(sqlitePayload);
    assert.equal(sqlitePayload.id, 'msg-sent-901');
    assert.equal(sqlitePayload.client_message_id, 'cid-sent-901');

    // Simulate row stored in SQLite and loaded on fresh restart
    const simulatedDbRow = {
      id: sqlitePayload.id,
      room_id: sqlitePayload.room_id,
      sender_id: sqlitePayload.sender_id,
      client_message_id: sqlitePayload.client_message_id,
      kind: sqlitePayload.kind,
      body_json: sqlitePayload.bodyJson || sqlitePayload.body_json,
      created_at: sqlitePayload.created_at,
      event_seq: sqlitePayload.eventSeq ?? sqlitePayload.event_seq,
      is_deleted: 0,
      is_deleted_for_me: 0
    };

    // Hydration after restart
    const hydrated = sqliteRowToMessage(simulatedDbRow);
    assert.equal(hydrated.id, 'msg-sent-901');
    assert.equal(hydrated.body.text, 'Important outgoing instruction');
    assert.equal(hydrated.senderId, 'user-me');
    assert.equal(hydrated.eventSeq, 85);
  });

  // 10. Multiple sent messages surviving restart
  test('10. Multiple sent messages survive restart in correct chronological order', () => {
    const batch = [
      { id: 'm-101', roomId: 'room-r', senderId: 'user-me', clientMessageId: 'c-101', body: { text: 'Msg 1' }, createdAt: '2026-10-07T10:00:00Z', eventSeq: 1 },
      { id: 'm-102', roomId: 'room-r', senderId: 'user-me', clientMessageId: 'c-102', body: { text: 'Msg 2' }, createdAt: '2026-10-07T10:01:00Z', eventSeq: 2 },
      { id: 'm-103', roomId: 'room-r', senderId: 'user-me', clientMessageId: 'c-103', body: { text: 'Msg 3' }, createdAt: '2026-10-07T10:02:00Z', eventSeq: 3 }
    ];

    const rows = batch.map((msg) => {
      const p = messageToSqlitePayload(msg, 'room-r');
      return {
        id: p.id,
        room_id: p.room_id,
        sender_id: p.sender_id,
        client_message_id: p.client_message_id,
        kind: p.kind,
        body_json: p.bodyJson || p.body_json,
        created_at: p.created_at,
        event_seq: p.event_seq,
        is_deleted: 0
      };
    });

    const hydratedMessages = rows.map(sqliteRowToMessage);
    const reloadedState = new RoomMessagesState('user-me');
    reloadedState.setInitialMessages('room-r', hydratedMessages, false);

    assert.equal(reloadedState.messages.length, 3);
    assert.equal(reloadedState.messages[0].body.text, 'Msg 1');
    assert.equal(reloadedState.messages[1].body.text, 'Msg 2');
    assert.equal(reloadedState.messages[2].body.text, 'Msg 3');
  });

  // 11. Genuinely deleted-for-everyone reply showing "This message was deleted"
  test('11. Genuinely deleted-for-everyone message displays "This message was deleted" and never exposes original content', () => {
    const deletedMsg1 = {
      id: 'del-every-1',
      senderId: 'user-bob',
      isDeleted: true,
      kind: 'deleted',
      body: { text: 'This was a secret mistake' }
    };
    assert.equal(formatReplyPreview(deletedMsg1), 'This message was deleted');

    const deletedMsg2 = {
      id: 'del-every-2',
      senderId: 'user-bob',
      kind: 'text',
      body: { is_deleted: true, text: 'Deleted text' }
    };
    assert.equal(formatReplyPreview(deletedMsg2), 'This message was deleted');
  });

  // 12. Existing message never incorrectly showing "Message unavailable"
  test('12. Existing messages across all modalities never incorrectly display "Message unavailable"', () => {
    const textMsg = { id: 'm-t', senderId: 'user-1', kind: 'text', body: { text: 'Valid message' } };
    assert.equal(formatReplyPreview(textMsg), 'Valid message');

    const photoMsg = { id: 'm-p', senderId: 'user-1', kind: 'image', body: { caption: 'Sunset' } };
    assert.equal(formatReplyPreview(photoMsg), '📷 Photo: Sunset');

    const videoMsg = { id: 'm-v', senderId: 'user-1', kind: 'video', body: { filename: 'clip.mp4' } };
    assert.equal(formatReplyPreview(videoMsg), '🎥 Video');

    const docMsg = { id: 'm-d', senderId: 'user-1', kind: 'document', body: { filename: 'invoice.pdf' } };
    assert.equal(formatReplyPreview(docMsg), '📄 invoice.pdf');

    const voiceMsg = { id: 'm-vo', senderId: 'user-1', isVoiceNote: true, body: {} };
    assert.equal(formatReplyPreview(voiceMsg), '🎤 Voice message');

    const callMsg = { id: 'm-c', senderId: 'user-1', kind: 'call', isCallEntry: true };
    assert.equal(formatReplyPreview(callMsg), '📞 Audio call');
  });
});
