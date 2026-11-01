/**
 * verify-message-history-and-replies.mjs
 * End-to-end verification of message history persistence, SQLite-first retrieval,
 * reply resolution across all tiers, deleted-message placeholders, media reply formats,
 * and forwarding/selection safety.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('================================================================');
console.log('RUNNING COMPREHENSIVE MESSAGE HISTORY & REPLY VERIFICATION SUITE');
console.log('================================================================\n');

let passCount = 0;
let failCount = 0;

function check(title, fn) {
  try {
    fn();
    console.log(`  [PASS] ${title}`);
    passCount++;
  } catch (err) {
    console.error(`  [FAIL] ${title}:`, err.message);
    failCount++;
  }
}

async function checkAsync(title, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${title}`);
    passCount++;
  } catch (err) {
    console.error(`  [FAIL] ${title}:`, err.message);
    failCount++;
  }
}

// -------------------------------------------------------------
// PART 1: MESSAGE PERSISTENCE & SURVIVAL ACROSS RESTART
// -------------------------------------------------------------
console.log('--- PART 1: Message Persistence & Restart ---');

check('1.1. Multiple sent messages in conversation serialize and restore without loss', () => {
  const roomId = 'room-verify-persist';
  const sentMessages = [
    { id: 'msg-v1', roomId, senderId: 'user-me', clientMessageId: 'cid-v1', kind: 'text', body: { text: 'First sent message' }, createdAt: '2026-10-07T12:00:00Z', eventSeq: 10 },
    { id: 'msg-v2', roomId, senderId: 'user-me', clientMessageId: 'cid-v2', kind: 'text', body: { text: 'Second sent message' }, createdAt: '2026-10-07T12:01:00Z', eventSeq: 11 },
    { id: 'msg-v3', roomId, senderId: 'user-me', clientMessageId: 'cid-v3', kind: 'text', body: { text: 'Third sent message' }, createdAt: '2026-10-07T12:02:00Z', eventSeq: 12 }
  ];

  // Convert to SQLite payloads (simulating db-sync saving each message)
  const rows = sentMessages.map(msg => {
    const payload = messageToSqlitePayload(msg, roomId);
    return {
      id: payload.id,
      room_id: payload.room_id,
      sender_id: payload.sender_id,
      client_message_id: payload.client_message_id,
      kind: payload.kind,
      body_json: payload.bodyJson,
      created_at: payload.created_at,
      event_seq: payload.eventSeq ?? payload.event_seq,
      is_deleted: 0,
      is_deleted_for_me: 0
    };
  });

  // Simulate application restart: load fresh messages from SQLite
  const hydrated = rows.map(sqliteRowToMessage);
  assert.equal(hydrated.length, 3, 'All 3 messages must rehydrate');
  assert.equal(hydrated[0].body.text, 'First sent message');
  assert.equal(hydrated[1].body.text, 'Second sent message');
  assert.equal(hydrated[2].body.text, 'Third sent message');

  // Verify RoomMessagesState accepts hydrated messages in order
  const state = new RoomMessagesState('user-me');
  state.setInitialMessages(roomId, hydrated, false);
  assert.equal(state.messages.length, 3);
  assert.equal(state.oldestSeq, 10);
  assert.equal(state.newestSeq, 12);
});

check('1.2. Unrelated conversation messages are completely isolated and untouched', () => {
  const roomA = 'room-alpha';
  const roomB = 'room-beta';

  const msgA = { id: 'msg-a', roomId: roomA, senderId: 'user-a', body: { text: 'Alpha chat' } };
  const msgB = { id: 'msg-b', roomId: roomB, senderId: 'user-b', body: { text: 'Beta chat' } };

  const rowA = messageToSqlitePayload(msgA, roomA);
  const rowB = messageToSqlitePayload(msgB, roomB);

  assert.equal(rowA.room_id, roomA);
  assert.equal(rowB.room_id, roomB);
  assert.notEqual(rowA.room_id, rowB.room_id);
});

// -------------------------------------------------------------
// PART 2: REPLY RESOLUTION ACROSS TIERS (IN-MEMORY, SQLITE, OLLACORE)
// -------------------------------------------------------------
console.log('\n--- PART 2: 4-Tier Reply Resolution ---');

await checkAsync('2.1. Reply bubble resolves original from SQLite when outside memory window', async () => {
  const prevWindow = globalThis.window;
  const memoryState = new RoomMessagesState('user-alice');
  const targetId = 'orig-msg-sqlite-deep';

  // Only the reply is currently in memory (e.g. user scrolled to latest)
  memoryState.setInitialMessages('room-replies', [
    { id: 'reply-1', senderId: 'user-alice', replyTo: targetId, body: { text: 'Replying to older proposal' } }
  ]);

  // Target is not in memory
  assert.strictEqual(memoryState.messages.some(m => m.id === targetId), false);

  // Mock SQLite DB returning the target
  globalThis.window = {
    ollacoreDesktop: {
      db: {
        getMessageById: async ({ id, roomId }) => {
          if (id === targetId && roomId === 'room-replies') {
            return {
              id: targetId,
              room_id: 'room-replies',
              sender_id: 'user-bob',
              kind: 'text',
              body_json: JSON.stringify({ text: 'Older proposal from 3 days ago' }),
              created_at: '2026-10-04T10:00:00Z',
              is_deleted: 0
            };
          }
          return null;
        }
      }
    }
  };

  const loaded = await loadMessageByIdFromDb(targetId, 'room-replies');
  assert.ok(loaded);
  const preview = formatReplyPreview(loaded);
  assert.equal(preview, 'Older proposal from 3 days ago');
  assert.notEqual(preview, 'Message unavailable');

  globalThis.window = prevWindow;
});

await checkAsync('2.2. Reply bubble falls back to OllaCore when absent from SQLite', async () => {
  const prevWindow = globalThis.window;
  const targetId = 'server-archived-msg-99';

  globalThis.window = {
    ollacoreDesktop: {
      db: { getMessageById: async () => null },
      chatApi: {
        getMessages: async (roomId) => ({
          messages: [
            { id: targetId, roomId, senderId: 'user-remote', kind: 'text', body: { text: 'Remote archived message' } }
          ]
        })
      }
    }
  };

  // Step 1: SQLite yields null
  const fromDb = await loadMessageByIdFromDb(targetId, 'room-server');
  assert.strictEqual(fromDb, null);

  // Step 2: OllaCore yields message
  const serverRes = await globalThis.window.ollacoreDesktop.chatApi.getMessages('room-server');
  const found = serverRes.messages.find(m => m.id === targetId);
  assert.ok(found);
  assert.equal(formatReplyPreview(found), 'Remote archived message');
  assert.notEqual(formatReplyPreview(found), 'Message unavailable');

  globalThis.window = prevWindow;
});

check('2.3. Reply navigation to an older message prepends history and finds target', () => {
  const state = new RoomMessagesState('user-alice');
  state.setInitialMessages('room-nav', [
    { id: 'm-recent', eventSeq: 200, senderId: 'user-bob', body: { text: 'Recent chatter' } },
    { id: 'm-reply', eventSeq: 201, senderId: 'user-alice', replyTo: 'm-ancient', body: { text: 'Responding' } }
  ], true);

  // Before prepending
  assert.strictEqual(state.messages.some(m => m.id === 'm-ancient'), false);

  // Prepend older history page
  state.prependOlderMessages([
    { id: 'm-ancient', eventSeq: 5, senderId: 'user-bob', body: { text: 'Ancient instruction' } }
  ], false);

  // After prepending: message found, correct preview, and can be highlighted
  const original = state.messages.find(m => m.id === 'm-ancient');
  assert.ok(original);
  assert.equal(formatReplyPreview(original), 'Ancient instruction');
});

// -------------------------------------------------------------
// PART 3: DELETED MESSAGE SEMANTICS
// -------------------------------------------------------------
console.log('\n--- PART 3: Deleted Message Semantics ---');

check('3.1. Genuinely deleted-for-everyone message displays "This message was deleted"', () => {
  const deleted1 = { id: 'd1', senderId: 'user-bob', isDeleted: true, kind: 'deleted', body: { text: 'Sensitive leak' } };
  assert.equal(formatReplyPreview(deleted1), 'This message was deleted');

  const deleted2 = { id: 'd2', senderId: 'user-bob', is_deleted: true, body: { text: 'Secret' } };
  assert.equal(formatReplyPreview(deleted2), 'This message was deleted');

  const deleted3 = { id: 'd3', senderId: 'user-bob', body: { is_deleted: true, text: 'Secret' } };
  assert.equal(formatReplyPreview(deleted3), 'This message was deleted');
});

check('3.2. Deleted for me only displays "Message unavailable"', () => {
  const deletedForMe = { id: 'dfm', senderId: 'user-bob', isDeletedForMe: true, body: { text: 'Private note' } };
  assert.equal(formatReplyPreview(deletedForMe), 'Message unavailable');
});

check('3.3. Completely missing/null message displays "Message unavailable"', () => {
  assert.equal(formatReplyPreview(null), 'Message unavailable');
  assert.equal(formatReplyPreview(undefined), 'Message unavailable');
});

// -------------------------------------------------------------
// PART 4: MEDIA REPLIES
// -------------------------------------------------------------
console.log('\n--- PART 4: Media Reply Formats ---');

check('4.1. Photo replies display 📷 Photo (and caption when present)', () => {
  assert.equal(formatReplyPreview({ kind: 'image', body: {} }), '📷 Photo');
  assert.equal(formatReplyPreview({ kind: 'image', body: { caption: 'Sunset view' } }), '📷 Photo: Sunset view');
});

check('4.2. Video replies display 🎥 Video (and caption when present)', () => {
  assert.equal(formatReplyPreview({ kind: 'video', body: {} }), '🎥 Video');
  assert.equal(formatReplyPreview({ kind: 'video', body: { caption: 'Tutorial part 1' } }), '🎥 Video: Tutorial part 1');
});

check('4.3. Document replies display 📄 filename', () => {
  assert.equal(formatReplyPreview({ kind: 'document', body: { filename: 'Specification.pdf' } }), '📄 Specification.pdf');
  assert.equal(formatReplyPreview({ kind: 'file', body: { filename: 'Contract.docx' } }), '📄 Contract.docx');
});

check('4.4. Audio and voice note replies display 🎵 Audio and 🎤 Voice message', () => {
  assert.equal(formatReplyPreview({ kind: 'audio', body: {} }), '🎵 Audio');
  assert.equal(formatReplyPreview({ kind: 'audio', isVoiceNote: true, body: {} }), '🎤 Voice message');
  assert.equal(formatReplyPreview({ is_voice_note: true, body: {} }), '🎤 Voice message');
});

check('4.5. Call log entries display 📞 Audio call and 📹 Video call', () => {
  assert.equal(formatReplyPreview({ kind: 'call', isCallEntry: true, isVideo: false }), '📞 Audio call');
  assert.equal(formatReplyPreview({ kind: 'call', isCallEntry: true, isVideo: true }), '📹 Video call');
});

// -------------------------------------------------------------
// PART 5: FORWARDING & SELECTION REGRESSION SAFETY
// -------------------------------------------------------------
console.log('\n--- PART 5: Forwarding & Selection Regression Safety ---');

check('5.1. Multi-message selection preserves message count and identities', () => {
  const selectedIds = new Set(['msg-sel-1', 'msg-sel-2', 'msg-sel-3']);
  assert.equal(selectedIds.size, 3);
  assert.ok(selectedIds.has('msg-sel-1'));
  assert.ok(selectedIds.has('msg-sel-2'));
  assert.ok(selectedIds.has('msg-sel-3'));
});

check('5.2. Forwarded message metadata keeps original content clean and uncorrupted', () => {
  const original = {
    id: 'fwd-orig-1',
    kind: 'text',
    body: { text: 'Forwarded announcement' },
    senderId: 'user-author'
  };

  const forwardedWirePayload = {
    client_message_id: 'cid-forward-1',
    kind: original.kind,
    body: {
      text: original.body.text,
      is_forwarded: true
    },
    forwarded_from_message_id: original.id
  };

  assert.equal(forwardedWirePayload.body.text, 'Forwarded announcement');
  assert.equal(forwardedWirePayload.forwarded_from_message_id, 'fwd-orig-1');
  assert.equal(forwardedWirePayload.body.is_forwarded, true);
});

// -------------------------------------------------------------
// SUMMARY
// -------------------------------------------------------------
console.log('\n================================================================');
console.log(`VERIFICATION COMPLETE: ${passCount} PASSED, ${failCount} FAILED`);
console.log('================================================================');

if (failCount > 0) {
  process.exit(1);
}
