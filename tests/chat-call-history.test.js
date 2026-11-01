import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ChatShellState,
  RoomMessagesState,
  isCallSignalMessage,
  formatCallTimelineDuration,
  formatCallDuration,
  getRoomCallRecords,
  saveRoomCallRecord,
  clearRoomCallRecords,
  callRecordToMessage,
  resolveMessageContent,
  isOwnMessage,
  canEditMessage,
  canDeleteMessageForEveryone,
  getConversationPreview
} from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Mock localStorage for test environment
const mockStorage = new Map();
globalThis.localStorage = {
  getItem: (key) => (mockStorage.has(key) ? mockStorage.get(key) : null),
  setItem: (key, val) => mockStorage.set(key, String(val)),
  removeItem: (key) => mockStorage.delete(key),
  clear: () => mockStorage.clear()
};

describe('WhatsApp-Style Room Call History & Chat Timeline Integration', () => {
  const appPath = path.join(projectRoot, 'src', 'renderer', 'app.js');
  const cssPath = path.join(projectRoot, 'src', 'renderer', 'styles.css');
  const appJs = fs.readFileSync(appPath, 'utf8');
  const stylesCss = fs.readFileSync(cssPath, 'utf8');

  beforeEach(() => {
    mockStorage.clear();
  });

  // ══════════════════════════════════════════════════════════════════
  // 1. SIGNAL IDENTIFICATION & FILTERING TESTS
  // ══════════════════════════════════════════════════════════════════
  describe('Call Signal Identification & Filtering', () => {
    test('1. Identifies in-band call signaling messages with body.call_signal', () => {
      assert.equal(isCallSignalMessage({ body: { call_signal: 'invite' } }), true);
      assert.equal(isCallSignalMessage({ body: { call_signal: 'decline' } }), true);
      assert.equal(isCallSignalMessage({ body: { call_signal: 'cancel' } }), true);
    });

    test('2. Identifies in-band call signaling messages with call_sig_ client_message_id', () => {
      assert.equal(isCallSignalMessage({ client_message_id: 'call_sig_123456789' }), true);
      assert.equal(isCallSignalMessage({ clientMessageId: 'call_sig_uuid_abc_def' }), true);
    });

    test('3. Identifies legacy soft-deleted call tombstones with call_sig_ prefix', () => {
      const tombstone = {
        id: 'msg-legacy-tombstone-1',
        kind: 'deleted',
        is_deleted: true,
        client_message_id: 'call_sig_1700000000',
        body: { text: 'This message was deleted' }
      };
      assert.equal(isCallSignalMessage(tombstone), true, 'Must identify legacy call tombstone as call signal');
    });

    test('4. Ordinary user-deleted messages MUST NOT be identified as call signals', () => {
      const userDeletedMessage = {
        id: 'msg-user-deleted-42',
        kind: 'deleted',
        is_deleted: true,
        client_message_id: 'local-uuid-987654',
        sender_id: 'user-bob',
        body: { text: 'This message was deleted' }
      };
      assert.equal(isCallSignalMessage(userDeletedMessage), false, 'Normal user-deleted message must NOT be a call signal');
    });

    test('5. Normal text, image, voice messages and timeline call cards are NOT call signals', () => {
      assert.equal(isCallSignalMessage({ kind: 'text', body: { text: 'Hello!' } }), false);
      assert.equal(isCallSignalMessage({ kind: 'image', body: { caption: 'Photo' } }), false);
      assert.equal(isCallSignalMessage({ kind: 'call', isCallEntry: true, status: 'completed' }), false);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 2. TIMELINE DURATION FORMATTING TESTS
  // ══════════════════════════════════════════════════════════════════
  describe('Call Timeline Duration Formatting', () => {
    test('6. Formats seconds for WhatsApp-style chat timeline', () => {
      assert.equal(formatCallTimelineDuration(0), '0s');
      assert.equal(formatCallTimelineDuration(-5), '0s');
      assert.equal(formatCallTimelineDuration(12), '12s');
      assert.equal(formatCallTimelineDuration(45), '45s');
      assert.equal(formatCallTimelineDuration(60), '1m');
      assert.equal(formatCallTimelineDuration(84), '1m 24s');
      assert.equal(formatCallTimelineDuration(120), '2m');
      assert.equal(formatCallTimelineDuration(3600), '1h');
      assert.equal(formatCallTimelineDuration(3724), '1h 2m 4s');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 3. ROOM CALL HISTORY STORAGE & PERSISTENCE TESTS
  // ══════════════════════════════════════════════════════════════════
  describe('Room Call History Storage & Persistence', () => {
    test('7. Persists and retrieves call record for a room', () => {
      const call = {
        callId: 'call-101',
        roomId: 'room-alpha',
        direction: 'outgoing',
        callType: 'voice',
        status: 'completed',
        startedAt: 1700000000000,
        endedAt: 1700000012000,
        duration: 12,
        participantId: 'user-bob',
        participantName: 'Bob'
      };

      const saved = saveRoomCallRecord('room-alpha', call, 'user-alice');
      assert.ok(saved);
      assert.equal(saved.callId, 'call-101');
      assert.equal(saved.status, 'completed');
      assert.equal(saved.duration, 12);

      const records = getRoomCallRecords('room-alpha', 'user-alice');
      assert.equal(records.length, 1);
      assert.equal(records[0].callId, 'call-101');
      assert.equal(records[0].direction, 'outgoing');
      assert.equal(records[0].callType, 'voice');
    });

    test('8. Room isolation: records from room-alpha do not appear in room-beta', () => {
      saveRoomCallRecord('room-alpha', { callId: 'call-a', callType: 'voice', status: 'completed' }, 'user-alice');
      saveRoomCallRecord('room-beta', { callId: 'call-b', callType: 'video', status: 'missed' }, 'user-alice');

      const alphaRecords = getRoomCallRecords('room-alpha', 'user-alice');
      const betaRecords = getRoomCallRecords('room-beta', 'user-alice');

      assert.equal(alphaRecords.length, 1);
      assert.equal(alphaRecords[0].callId, 'call-a');
      assert.equal(betaRecords.length, 1);
      assert.equal(betaRecords[0].callId, 'call-b');
    });

    test('9. Deduplicates call record when updated with same callId or id', () => {
      saveRoomCallRecord('room-alpha', { id: 'call-same', callId: 'c1', status: 'missed', duration: 0 }, 'user-alice');
      saveRoomCallRecord('room-alpha', { id: 'call-same', callId: 'c1', status: 'completed', duration: 25 }, 'user-alice');

      const records = getRoomCallRecords('room-alpha', 'user-alice');
      assert.equal(records.length, 1);
      assert.equal(records[0].status, 'completed');
      assert.equal(records[0].duration, 25);
    });

    test('10. Clears room call records', () => {
      saveRoomCallRecord('room-alpha', { callId: 'c1', callType: 'voice' }, 'user-alice');
      assert.equal(getRoomCallRecords('room-alpha', 'user-alice').length, 1);

      clearRoomCallRecords('room-alpha', 'user-alice');
      assert.equal(getRoomCallRecords('room-alpha', 'user-alice').length, 0);
    });

    test('11. Converts call record to timeline message object', () => {
      const record = {
        id: 'call-entry-1',
        callId: 'c1',
        roomId: 'room-1',
        direction: 'outgoing',
        callType: 'video',
        isVideo: true,
        status: 'completed',
        duration: 84,
        startedAt: 1700000000000,
        participantId: 'user-bob',
        participantName: 'Bob'
      };

      const msg = callRecordToMessage(record, 'user-alice');
      assert.equal(msg.id, 'call-entry-1');
      assert.equal(msg.kind, 'call');
      assert.equal(msg.isCallEntry, true);
      assert.equal(msg.callType, 'video');
      assert.equal(msg.isVideo, true);
      assert.equal(msg.direction, 'outgoing');
      assert.equal(msg.duration, 84);
      assert.equal(msg.body.text, 'Video call');
      assert.equal(msg.senderId, 'user-alice');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 4. CONTENT RESOLUTION & OWNERSHIP TESTS
  // ══════════════════════════════════════════════════════════════════
  describe('Content Resolution & Direction Verification', () => {
    test('12. resolveMessageContent handles voice and video call cards', () => {
      const audioCall = {
        kind: 'call',
        isCallEntry: true,
        callType: 'voice',
        isVideo: false,
        direction: 'incoming',
        status: 'completed',
        duration: 12
      };
      const resAudio = resolveMessageContent(audioCall);
      assert.equal(resAudio.kind, 'call');
      assert.equal(resAudio.text, 'Audio call');
      assert.equal(resAudio.callType, 'voice');
      assert.equal(resAudio.duration, 12);
      assert.equal(resAudio.isDeleted, false);

      const videoCall = {
        kind: 'call',
        isCallEntry: true,
        callType: 'video',
        isVideo: true,
        direction: 'outgoing',
        status: 'completed',
        duration: 84
      };
      const resVideo = resolveMessageContent(videoCall);
      assert.equal(resVideo.kind, 'call');
      assert.equal(resVideo.text, 'Video call');
      assert.equal(resVideo.isVideo, true);
      assert.equal(resVideo.duration, 84);
      assert.equal(resVideo.isDeleted, false);
    });

    test('13. resolveMessageContent preserves normal deleted messages as "This message was deleted"', () => {
      const deletedMsg = {
        kind: 'deleted',
        isDeleted: true,
        body: { text: 'This message was deleted' }
      };
      const res = resolveMessageContent(deletedMsg);
      assert.equal(res.kind, 'deleted');
      assert.equal(res.text, 'This message was deleted');
      assert.equal(res.isDeleted, true);
    });

    test('14. isOwnMessage returns true for outgoing calls, false for incoming calls', () => {
      const outgoingCall = { kind: 'call', isCallEntry: true, direction: 'outgoing' };
      const incomingCall = { kind: 'call', isCallEntry: true, direction: 'incoming' };

      assert.equal(isOwnMessage(outgoingCall, 'user-alice'), true, 'Outgoing call must be own message');
      assert.equal(isOwnMessage(incomingCall, 'user-alice'), false, 'Incoming call must NOT be own message');
    });

    test('15. canEditMessage and canDeleteMessageForEveryone reject call entries', () => {
      const call = { kind: 'call', isCallEntry: true, direction: 'outgoing', createdAt: new Date().toISOString() };
      assert.equal(canEditMessage(call, 'user-alice'), false, 'Call cards cannot be edited');
      assert.equal(canDeleteMessageForEveryone(call, 'user-alice'), false, 'Call cards cannot be deleted for everyone');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 5. ROOM MESSAGES STATE & HISTORY LOADING TESTS
  // ══════════════════════════════════════════════════════════════════
  describe('RoomMessagesState History Loading & Timeline Merge', () => {
    test('16. setInitialMessages filters out call signaling tombstones and merges persisted room call entries', () => {
      const state = new RoomMessagesState('user-alice');
      const roomId = 'room-101';

      // Persist local room call records
      saveRoomCallRecord(roomId, {
        id: 'call-local-1',
        callId: 'c1',
        callType: 'voice',
        direction: 'outgoing',
        status: 'completed',
        duration: 12,
        startedAt: 1700000005000
      }, 'user-alice');

      saveRoomCallRecord(roomId, {
        id: 'call-local-2',
        callId: 'c2',
        callType: 'video',
        direction: 'incoming',
        status: 'completed',
        duration: 84,
        startedAt: 1700000020000
      }, 'user-alice');

      // Server messages include normal messages, a legacy call signaling tombstone, and an ordinary user-deleted message
      const serverMessages = [
        {
          id: 'msg-1',
          kind: 'text',
          sender_id: 'user-bob',
          created_at: new Date(1700000000000).toISOString(),
          body: { text: 'Are you free for a call?' }
        },
        // Old implementation call tombstone (with call_sig_ client_message_id)
        {
          id: 'msg-sig-tombstone',
          kind: 'deleted',
          is_deleted: true,
          client_message_id: 'call_sig_old_uuid',
          sender_id: 'user-alice',
          created_at: new Date(1700000004000).toISOString(),
          body: { text: 'This message was deleted' }
        },
        // Ordinary user-deleted message
        {
          id: 'msg-user-deleted',
          kind: 'deleted',
          is_deleted: true,
          client_message_id: 'normal-client-id-1',
          sender_id: 'user-bob',
          created_at: new Date(1700000010000).toISOString(),
          body: { text: 'This message was deleted' }
        },
        {
          id: 'msg-2',
          kind: 'text',
          sender_id: 'user-bob',
          created_at: new Date(1700000025000).toISOString(),
          body: { text: 'Thanks for the video call!' }
        }
      ];

      state.setInitialMessages(roomId, serverMessages, false);

      // Verify that the legacy call signaling tombstone was filtered out!
      const tombstone = state.messages.find((m) => m.id === 'msg-sig-tombstone');
      assert.equal(tombstone, undefined, 'Legacy call signaling tombstone must be filtered out');

      // Verify that ordinary user-deleted message remains in history!
      const userDeleted = state.messages.find((m) => m.id === 'msg-user-deleted');
      assert.ok(userDeleted, 'Ordinary user-deleted message must remain in history');
      const resolvedDeleted = resolveMessageContent(userDeleted);
      assert.equal(resolvedDeleted.kind, 'deleted');
      assert.equal(resolvedDeleted.text, 'This message was deleted');

      // Verify both call entries are in timeline!
      const call1 = state.messages.find((m) => m.id === 'call-local-1');
      assert.ok(call1, 'Voice call entry must be present in timeline');
      assert.equal(call1.kind, 'call');
      assert.equal(call1.duration, 12);
      assert.equal(call1.direction, 'outgoing');

      const call2 = state.messages.find((m) => m.id === 'call-local-2');
      assert.ok(call2, 'Video call entry must be present in timeline');
      assert.equal(call2.kind, 'call');
      assert.equal(call2.duration, 84);
      assert.equal(call2.direction, 'incoming');

      // Verify correct chronological order
      // Order should be: msg-1 (00s) -> call-1 (05s) -> msg-user-deleted (10s) -> call-2 (20s) -> msg-2 (25s)
      const messageIds = state.messages.map((m) => m.id);
      assert.deepEqual(messageIds, [
        'msg-1',
        'call-local-1',
        'msg-user-deleted',
        'call-local-2',
        'msg-2'
      ]);
    });

    test('17. mergeServerMessages filters out call signaling messages', () => {
      const state = new RoomMessagesState('user-alice');
      state.roomId = 'room-1';
      state.messages = [{ id: 'm1', kind: 'text', body: { text: 'Hey' } }];

      state.mergeServerMessages([
        { id: 'm-sig', body: { call_signal: 'invite' } },
        { id: 'm2', kind: 'text', body: { text: 'Hello' } }
      ]);

      assert.equal(state.messages.length, 2);
      assert.equal(state.messages.some((m) => m.id === 'm-sig'), false);
      assert.equal(state.messages.some((m) => m.id === 'm2'), true);
    });

    test('18. addCallMessage adds and reconciles call entry in active room state', () => {
      const state = new RoomMessagesState('user-alice');
      state.roomId = 'room-1';

      const entry = {
        id: 'call-now',
        callId: 'call-session-abc',
        callType: 'voice',
        direction: 'outgoing',
        status: 'completed',
        duration: 45,
        startedAt: Date.now()
      };

      state.addCallMessage(entry);
      assert.equal(state.messages.length, 1);
      assert.equal(state.messages[0].id, 'call-now');
      assert.equal(state.messages[0].kind, 'call');
      assert.equal(state.messages[0].duration, 45);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 6. CALL DIRECTION & STATUS COVERAGE (A <-> B, ALL STATES)
  // ══════════════════════════════════════════════════════════════════
  describe('Call Direction & Status Matrix (A -> B, B -> A, Audio & Video, All States)', () => {
    test('19. A -> B audio call completed: caller sees outgoing completed, callee sees incoming completed', () => {
      const callerRecord = {
        id: 'c-ab-audio',
        callId: 'sess-1',
        roomId: 'room-ab',
        direction: 'outgoing',
        callType: 'voice',
        status: 'completed',
        duration: 12,
        startedAt: Date.now()
      };
      const calleeRecord = {
        id: 'c-ab-audio',
        callId: 'sess-1',
        roomId: 'room-ab',
        direction: 'incoming',
        callType: 'voice',
        status: 'completed',
        duration: 12,
        startedAt: Date.now()
      };

      const callerMsg = callRecordToMessage(callerRecord, 'user-a');
      const calleeMsg = callRecordToMessage(calleeRecord, 'user-b');

      assert.equal(callerMsg.direction, 'outgoing');
      assert.equal(callerMsg.status, 'completed');
      assert.equal(callerMsg.duration, 12);
      assert.equal(isOwnMessage(callerMsg, 'user-a'), true);

      assert.equal(calleeMsg.direction, 'incoming');
      assert.equal(calleeMsg.status, 'completed');
      assert.equal(calleeMsg.duration, 12);
      assert.equal(isOwnMessage(calleeMsg, 'user-b'), false);
    });

    test('20. B -> A audio call completed: caller B sees outgoing, callee A sees incoming', () => {
      const record = {
        callId: 'sess-2',
        roomId: 'room-ab',
        direction: 'incoming',
        callType: 'voice',
        status: 'completed',
        duration: 35,
        startedAt: Date.now(),
        participantId: 'user-b'
      };
      const msgAtA = callRecordToMessage(record, 'user-a');
      assert.equal(msgAtA.direction, 'incoming');
      assert.equal(msgAtA.status, 'completed');
      assert.equal(msgAtA.duration, 35);
      assert.equal(isOwnMessage(msgAtA, 'user-a'), false);
    });

    test('21. A -> B video call completed: 84s duration with Video call title', () => {
      const record = {
        callId: 'sess-3',
        roomId: 'room-ab',
        direction: 'outgoing',
        callType: 'video',
        isVideo: true,
        status: 'completed',
        duration: 84,
        startedAt: Date.now()
      };
      const msg = callRecordToMessage(record, 'user-a');
      const resolved = resolveMessageContent(msg);
      assert.equal(resolved.kind, 'call');
      assert.equal(resolved.text, 'Video call');
      assert.equal(resolved.duration, 84);
      assert.equal(formatCallTimelineDuration(resolved.duration), '1m 24s');
    });

    test('22. B -> A video call completed: 60s duration', () => {
      const record = {
        callId: 'sess-4',
        roomId: 'room-ab',
        direction: 'incoming',
        callType: 'video',
        isVideo: true,
        status: 'completed',
        duration: 60,
        startedAt: Date.now()
      };
      const msg = callRecordToMessage(record, 'user-a');
      const resolved = resolveMessageContent(msg);
      assert.equal(resolved.kind, 'call');
      assert.equal(resolved.text, 'Video call');
      assert.equal(formatCallTimelineDuration(resolved.duration), '1m');
    });

    test('23. Missed call: callee sees incoming missed', () => {
      const record = {
        callId: 'sess-missed',
        roomId: 'room-ab',
        direction: 'incoming',
        callType: 'voice',
        status: 'missed',
        duration: 0,
        startedAt: Date.now()
      };
      const msg = callRecordToMessage(record, 'user-b');
      const resolved = resolveMessageContent(msg);
      assert.equal(resolved.kind, 'call');
      assert.equal(resolved.status, 'missed');
      assert.equal(resolved.text, 'Audio call');
    });

    test('24. Cancelled call: caller sees outgoing cancelled', () => {
      const record = {
        callId: 'sess-cancelled',
        roomId: 'room-ab',
        direction: 'outgoing',
        callType: 'video',
        isVideo: true,
        status: 'cancelled',
        duration: 0,
        startedAt: Date.now()
      };
      const msg = callRecordToMessage(record, 'user-a');
      const resolved = resolveMessageContent(msg);
      assert.equal(resolved.kind, 'call');
      assert.equal(resolved.status, 'cancelled');
      assert.equal(resolved.text, 'Video call');
    });

    test('25. Declined call: callee and caller see declined status', () => {
      const record = {
        callId: 'sess-declined',
        roomId: 'room-ab',
        direction: 'incoming',
        callType: 'voice',
        status: 'declined',
        duration: 0,
        startedAt: Date.now()
      };
      const msg = callRecordToMessage(record, 'user-b');
      const resolved = resolveMessageContent(msg);
      assert.equal(resolved.kind, 'call');
      assert.equal(resolved.status, 'declined');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 7. SIDEBAR PREVIEWS & UNREAD COUNT INVARIANCE
  // ══════════════════════════════════════════════════════════════════
  describe('Sidebar Previews & Unread Count Invariance', () => {
    test('26. getConversationPreview formats call entries properly', () => {
      assert.equal(getConversationPreview({ lastMessage: { kind: 'call', callType: 'voice' } }), '📞 Audio call');
      assert.equal(getConversationPreview({ lastMessage: { kind: 'call', callType: 'video', isVideo: true } }), '📹 Video call');
      assert.equal(getConversationPreview({ lastMessage: { kind: 'call', preview: '📹 Video call' } }), '📹 Video call');
      assert.equal(getConversationPreview({ lastMessage: { kind: 'call', preview: '📞 Audio call' } }), '📞 Audio call');
    });

    test('27. Call entries in setInbox reconcile preview but DO NOT increment unreadCount', () => {
      const shellState = new ChatShellState();
      shellState.setCurrentUser({ userId: 'user-alice' });

      // Persist a call in room-1
      saveRoomCallRecord('room-1', {
        id: 'call-latest',
        callId: 'c1',
        callType: 'voice',
        direction: 'incoming',
        status: 'completed',
        duration: 12,
        startedAt: Date.now()
      }, 'user-alice');

      // Server inbox item with unreadCount 0
      const inbox = [
        {
          roomId: 'room-1',
          unreadCount: 0,
          lastMessage: {
            preview: 'Old text',
            createdAt: new Date(Date.now() - 50000).toISOString()
          }
        }
      ];

      shellState.setInbox(inbox);

      const conv = shellState.conversations[0];
      assert.equal(conv.unreadCount, 0, 'Unread count must NOT increment because of call entries');
      assert.equal(conv.lastMessage.preview, '📞 Audio call', 'Preview must reflect latest call');
      assert.equal(conv.lastMessage.kind, 'call');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 8. CODEBASE IMPLEMENTATION VERIFICATION
  // ══════════════════════════════════════════════════════════════════
  describe('Codebase Implementation Invariants', () => {
    test('28. sendCallSignal in app.js uses call_sig_ prefix for client_message_id', () => {
      assert.ok(
        appJs.includes("rawId.startsWith('call_sig_') ? rawId : `call_sig_${rawId}`"),
        'sendCallSignal must prefix clientMessageId with call_sig_'
      );
    });

    test('29. handleRealtimeChatEvent does NOT send message.delete for call signals', () => {
      // Find the signaling block in app.js
      const signalBlockMatch = appJs.match(/Intercept in-band call signaling messages[\s\S]*?return;\s*\/\/\s*Do NOT update sidebar/);
      assert.ok(signalBlockMatch, 'Must find signaling block in app.js');
      const signalBlock = signalBlockMatch[0];
      assert.ok(
        !signalBlock.includes("chat.send('message.delete'"),
        'Must NOT call message.delete for temporary call signaling messages'
      );
    });

    test('30. styles.css defines WhatsApp-style .message-call-card and elements', () => {
      assert.ok(stylesCss.includes('.message-call-card'), 'Must define .message-call-card');
      assert.ok(stylesCss.includes('.call-card-icon-wrapper'), 'Must define .call-card-icon-wrapper');
      assert.ok(stylesCss.includes('.call-card-title'), 'Must define .call-card-title');
      assert.ok(stylesCss.includes('.call-card-details'), 'Must define .call-card-details');
      assert.ok(stylesCss.includes('.call-card-missed'), 'Must define .call-card-missed');
    });
  });
});
