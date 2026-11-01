import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatShellState,
  resolveGroupSenderName,
  isInternalIdOrUuid,
  getReplySenderName,
  RoomMessagesState,
  isOwnMessage
} from '../src/renderer/chat-shell-state.js';
import { sqliteRowToMessage } from '../src/renderer/db-sync.js';

describe('Group Message Sender Name Resolution & WhatsApp-Style Group UI', () => {
  let shellState;
  const currentUserId = 'user-alice-123';
  const groupId = 'group-room-456';
  const malavikaPrincipalId = '23c7f84b-6d3a-4982-b765-a8109bf12345';
  const ashritaPrincipalId = '7890abcd-ef12-3456-7890-abcdef123456';

  beforeEach(() => {
    shellState = new ChatShellState();
    shellState.setCurrentUser({ userId: currentUserId, displayName: 'Alice' });
  });

  test('1. Group message resolves sender display name from room participant map', () => {
    shellState.setRoomParticipants(groupId, [
      { principalId: malavikaPrincipalId, displayName: 'Malavika', role: 'member' },
      { principalId: ashritaPrincipalId, displayName: 'Ashrita', role: 'member' }
    ], false);

    const msg = {
      id: 'msg-1',
      roomId: groupId,
      senderId: malavikaPrincipalId,
      body: { text: 'hyy' }
    };

    const name = shellState.resolveSenderDisplayName(msg, groupId);
    assert.equal(name, 'Malavika');
  });

  test('2. UUID is never displayed as visible sender name', () => {
    // Both full UUID, partial UUID, and raw hex ID must be rejected as sender names
    assert.equal(isInternalIdOrUuid('23c7f84b-6d3a-4982-b765-a8109bf12345'), true);
    assert.equal(isInternalIdOrUuid('23c7f84b-6...'), true);
    assert.equal(isInternalIdOrUuid('23c7f84b-6'), true);
    assert.equal(isInternalIdOrUuid('local-abc-123'), true);
    assert.equal(isInternalIdOrUuid('Malavika'), false);

    const msgWithUuidAsName = {
      id: 'msg-uuid-name',
      roomId: groupId,
      senderId: malavikaPrincipalId,
      senderName: '23c7f84b-6d3a-4982-b765-a8109bf12345',
      sender_name: '23c7f84b-6d3a-4982-b765-a8109bf12345',
      body: { text: 'hyy' }
    };

    // Even though senderName was populated with a UUID, resolution rejects it and falls back safely
    const resolved = resolveGroupSenderName(msgWithUuidAsName, currentUserId, {
      roomParticipants: new Map([[malavikaPrincipalId, { displayName: 'Malavika' }]])
    });
    assert.equal(resolved, 'Malavika');

    // Without participant cache, it falls back to 'Contact', NEVER the UUID
    const fallback = resolveGroupSenderName(msgWithUuidAsName, currentUserId);
    assert.equal(fallback, 'Contact');
    assert.notEqual(fallback, malavikaPrincipalId);
    assert.notEqual(fallback, malavikaPrincipalId.slice(0, 10));
  });

  test('3. Existing valid sender_name on message is preferred (if not UUID)', () => {
    const msg = {
      id: 'msg-sender-name',
      roomId: groupId,
      senderId: malavikaPrincipalId,
      senderName: 'Malavika M',
      body: { text: 'test' }
    };

    const resolved = resolveGroupSenderName(msg, currentUserId);
    assert.equal(resolved, 'Malavika M');
  });

  test('4. Participant map resolves principal_id correctly', () => {
    const pMap = new Map([
      [malavikaPrincipalId, { displayName: 'Malavika', phone: '+123456789' }]
    ]);

    const msg = {
      id: 'msg-2',
      roomId: groupId,
      sender_id: malavikaPrincipalId,
      body: { text: 'hyy' }
    };

    const resolved = resolveGroupSenderName(msg, currentUserId, { roomParticipants: pMap });
    assert.equal(resolved, 'Malavika');
  });

  test('5. Unknown participant uses safe fallback "Contact"', () => {
    const unknownId = '99999999-9999-9999-9999-999999999999';
    const msg = {
      id: 'msg-unknown',
      roomId: groupId,
      senderId: unknownId,
      body: { text: 'hello stranger' }
    };

    const resolved = resolveGroupSenderName(msg, currentUserId, { roomParticipants: new Map() });
    assert.equal(resolved, 'Contact');
    assert.notEqual(resolved, unknownId);
    assert.notEqual(resolved, unknownId.slice(0, 10));
  });

  test('6. Historical SQLite message resolves correctly with canonical sender_id', () => {
    shellState.setRoomParticipants(groupId, [
      { principalId: malavikaPrincipalId, displayName: 'Malavika' }
    ], false);

    // Simulate SQLite row loaded from database
    const sqliteRow = {
      id: 'sqlite-msg-1',
      room_id: groupId,
      sender_id: malavikaPrincipalId,
      kind: 'text',
      body_json: JSON.stringify({ text: 'historical message' }),
      reply_to_id: null,
      event_seq: 10,
      status: 'sent',
      is_deleted: 0,
      created_at: new Date().toISOString()
    };
    const loadedMsg = sqliteRowToMessage(sqliteRow);

    // SQLite preserves canonical UUID
    assert.equal(loadedMsg.senderId, malavikaPrincipalId);
    assert.equal(loadedMsg.sender_id, malavikaPrincipalId);

    // UI resolution resolves display name
    const resolved = shellState.resolveSenderDisplayName(loadedMsg, groupId);
    assert.equal(resolved, 'Malavika');
  });

  test('7. Realtime WebSocket message without sender_name resolves correctly via participant map', () => {
    shellState.setRoomParticipants(groupId, [
      { principalId: ashritaPrincipalId, displayName: 'Ashrita' }
    ], false);

    // OllaCore WebSocket wire message (only sender_id is provided)
    const wsFrame = {
      id: 'ws-msg-100',
      room_id: groupId,
      sender_id: ashritaPrincipalId,
      kind: 'text',
      body: { text: 'realtime update' },
      event_seq: 25
    };

    const resolved = shellState.resolveSenderDisplayName(wsFrame, groupId);
    assert.equal(resolved, 'Ashrita');
  });

  test('8. Multiple group participants resolve to different human-readable names', () => {
    shellState.setRoomParticipants(groupId, [
      { principalId: malavikaPrincipalId, displayName: 'Malavika' },
      { principalId: ashritaPrincipalId, displayName: 'Ashrita' }
    ], false);

    const msg1 = { id: 'm1', roomId: groupId, senderId: malavikaPrincipalId };
    const msg2 = { id: 'm2', roomId: groupId, senderId: ashritaPrincipalId };

    assert.equal(shellState.resolveSenderDisplayName(msg1, groupId), 'Malavika');
    assert.equal(shellState.resolveSenderDisplayName(msg2, groupId), 'Ashrita');
  });

  test('9. Current user outgoing group message resolves as You', () => {
    const ownMsg = {
      id: 'msg-own',
      roomId: groupId,
      senderId: currentUserId,
      body: { text: 'my outgoing message' }
    };

    const resolved = resolveGroupSenderName(ownMsg, currentUserId);
    assert.equal(resolved, 'You');
    assert.equal(isOwnMessage(ownMsg, currentUserId), true);
  });

  test('10. Group message after restart resolves correctly from cached participants', () => {
    // Set up mock localStorage with cached participants
    const mockStorage = new Map();
    const storageKey = `ollachat_cached_participants_${currentUserId}`;
    mockStorage.set(storageKey, JSON.stringify({
      [groupId]: [
        { principalId: malavikaPrincipalId, displayName: 'Malavika', role: 'member' }
      ]
    }));

    global.localStorage = {
      getItem: (k) => mockStorage.get(k) || null,
      setItem: (k, v) => mockStorage.set(k, String(v)),
      removeItem: (k) => mockStorage.delete(k)
    };

    // Simulate fresh app launch
    const restartedShellState = new ChatShellState();
    restartedShellState.setCurrentUser({ userId: currentUserId });

    const msg = {
      id: 'restarted-msg-1',
      roomId: groupId,
      senderId: malavikaPrincipalId,
      body: { text: 'message after app restart' }
    };

    const resolved = restartedShellState.resolveSenderDisplayName(msg, groupId);
    assert.equal(resolved, 'Malavika');
  });

  test('11. Paginated group messages resolve correctly using room participant map', () => {
    shellState.setRoomParticipants(groupId, [
      { principalId: malavikaPrincipalId, displayName: 'Malavika' }
    ], false);

    const rState = new RoomMessagesState(currentUserId);
    rState.setInitialMessages(groupId, [
      { id: 'page-msg-1', roomId: groupId, senderId: malavikaPrincipalId, body: { text: 'page 1' } }
    ]);
    rState.prependOlderMessages([
      { id: 'page-msg-0', roomId: groupId, senderId: malavikaPrincipalId, body: { text: 'older page' } }
    ]);

    assert.equal(rState.messages.length, 2);
    for (const m of rState.messages) {
      assert.equal(shellState.resolveSenderDisplayName(m, groupId), 'Malavika');
    }
  });

  test('12. Offline-synced group message with sender_id resolves correctly', () => {
    shellState.setRoomParticipants(groupId, [
      { principalId: ashritaPrincipalId, displayName: 'Ashrita' }
    ], false);

    const syncedMsg = {
      id: 'synced-msg-99',
      roomId: groupId,
      sender_id: ashritaPrincipalId,
      body: { text: 'synced after coming back online' }
    };

    const resolved = shellState.resolveSenderDisplayName(syncedMsg, groupId);
    assert.equal(resolved, 'Ashrita');
  });

  test('13. Group reply preview shows human sender name, NOT UUID', () => {
    const originalGroupMsg = {
      id: 'orig-group-1',
      roomId: groupId,
      senderId: malavikaPrincipalId,
      body: { text: 'Yes, I will check it.' }
    };

    const replySender = getReplySenderName(
      originalGroupMsg,
      currentUserId,
      null,
      {
        roomId: groupId,
        roomParticipants: new Map([[malavikaPrincipalId, { displayName: 'Malavika' }]])
      }
    );

    assert.equal(replySender, 'Malavika');
    assert.notEqual(replySender, malavikaPrincipalId);
    assert.notEqual(replySender, malavikaPrincipalId.slice(0, 10));
  });

  test('14. Reply preview and click-to-jump retain original message ID reference', () => {
    const originalGroupMsg = {
      id: 'orig-target-123',
      roomId: groupId,
      senderId: malavikaPrincipalId,
      body: { text: 'Original question' }
    };
    const replyMsg = {
      id: 'reply-msg-456',
      roomId: groupId,
      senderId: ashritaPrincipalId,
      replyTo: 'orig-target-123',
      reply_to: 'orig-target-123',
      body: { text: 'My answer' }
    };

    const rState = new RoomMessagesState(currentUserId);
    rState.setInitialMessages(groupId, [originalGroupMsg, replyMsg]);

    const target = rState.messages.find(m => m.id === replyMsg.replyTo);
    assert.ok(target);
    assert.equal(target.id, 'orig-target-123');
    assert.equal(target.body.text, 'Original question');
  });

  test('15. 1-to-1 sender rendering remains unchanged and peer name is preserved', () => {
    const directRoomId = 'direct-room-789';
    const peerUserId = 'peer-bob-uuid';
    shellState.conversations = [
      {
        roomId: directRoomId,
        kind: 'direct',
        name: 'Bob Builder',
        peer: { userId: peerUserId, displayName: 'Bob Builder' }
      }
    ];

    const directMsg = {
      id: 'direct-msg-1',
      roomId: directRoomId,
      senderId: peerUserId,
      body: { text: 'Hey there' }
    };

    // 1-to-1 sender resolves peer conversation display name
    const resolved = resolveGroupSenderName(directMsg, currentUserId, {
      conversations: shellState.conversations
    });
    assert.equal(resolved, 'Bob Builder');
  });
});
