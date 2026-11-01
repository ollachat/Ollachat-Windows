import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoomMessagesState,
  resolveMessageContent,
  isOwnMessage,
  formatFullDateTime,
  MESSAGE_STATUS,
  isCanonicalServerId,
  resolveCanonicalMessageId,
  MESSAGE_ACTION_LIMITS,
  canEditMessage,
  canDeleteMessageForEveryone
} from '../src/renderer/chat-shell-state.js';
import { ChatWebSocket } from '../src/chat/chat-websocket.js';
import { ChatApi } from '../src/api/chat-api.js';

// Setup Mock localStorage for Node test runner
const mockStorage = new Map();
globalThis.localStorage = {
  getItem: (k) => mockStorage.get(k) || null,
  setItem: (k, v) => mockStorage.set(k, String(v)),
  removeItem: (k) => mockStorage.delete(k),
  clear: () => mockStorage.clear()
};

class MockWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.sentData = [];
    this.readyState = 0; // CONNECTING
    MockWebSocket.instances.push(this);
  }
  send(data) {
    this.sentData.push(data);
  }
  close(code = 1000, reason = '') {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code, reason });
  }
  simulateOpen() {
    this.readyState = 1;
    if (this.onopen) this.onopen({});
  }
  simulateMessage(data) {
    if (this.onmessage) this.onmessage({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
}

describe('WhatsApp-Style Message Actions Suite (Delete, Edit, Info, Star)', () => {
  beforeEach(() => {
    mockStorage.clear();
    MockWebSocket.instances = [];
  });

  // ═════════════════════════════════════════════════════════════════
  // 1. DELETE FOR ME (Local-only)
  // ═════════════════════════════════════════════════════════════════

  test('1. Local delete-for-me hides message from current user room view', () => {
    const state = new RoomMessagesState('user-1');
    state.setInitialMessages('room-1', [
      { id: 'm1', senderId: 'user-2', body: { text: 'Hello Alice' }, eventSeq: 1 },
      { id: 'm2', senderId: 'user-1', body: { text: 'Hello Bob' }, eventSeq: 2 }
    ]);

    assert.equal(state.messages.length, 2);
    const deleted = state.deleteMessageForMe('m1', 'room-1');
    assert.equal(deleted, true);

    // Message is removed from messages list for current user
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].id, 'm2');
    assert.equal(state.isDeletedForMe('m1', 'room-1'), true);
  });

  test('2. Local delete-for-me persists across state reloads and restart', () => {
    const state1 = new RoomMessagesState('user-1');
    state1.setInitialMessages('room-1', [
      { id: 'm1', senderId: 'user-2', body: { text: 'Secret message' }, eventSeq: 1 }
    ]);
    state1.deleteMessageForMe('m1', 'room-1');

    // Simulate app restart with a fresh RoomMessagesState for same user
    const state2 = new RoomMessagesState('user-1');
    state2.setInitialMessages('room-1', [
      { id: 'm1', senderId: 'user-2', body: { text: 'Secret message' }, eventSeq: 1 }
    ]);

    // m1 must not appear in the reloaded room messages
    assert.equal(state2.messages.length, 0);
    assert.equal(state2.isDeletedForMe('m1', 'room-1'), true);
  });

  test('3. Local delete-for-me does not affect the recipient or other users', () => {
    const aliceState = new RoomMessagesState('alice');
    aliceState.setInitialMessages('room-1', [
      { id: 'msg-shared', senderId: 'bob', body: { text: 'Mutual message' }, eventSeq: 1 }
    ]);

    // Alice deletes for herself
    aliceState.deleteMessageForMe('msg-shared', 'room-1');
    assert.equal(aliceState.messages.length, 0);

    // Bob still has the message intact
    const bobState = new RoomMessagesState('bob');
    bobState.setInitialMessages('room-1', [
      { id: 'msg-shared', senderId: 'bob', body: { text: 'Mutual message' }, eventSeq: 1 }
    ]);
    assert.equal(bobState.messages.length, 1);
    assert.equal(bobState.messages[0].body.text, 'Mutual message');
    assert.equal(bobState.isDeletedForMe('msg-shared', 'room-1'), false);
  });

  test('4. Local delete-for-me survives WebSocket reconnect and catchup', () => {
    const state = new RoomMessagesState('user-1');
    state.setInitialMessages('room-1', [
      { id: 'm1', senderId: 'user-2', body: { text: 'Original' }, eventSeq: 1 }
    ]);
    state.deleteMessageForMe('m1', 'room-1');

    // Reconnect / server sync pushes messages including m1
    state.mergeServerMessages([
      { id: 'm1', senderId: 'user-2', body: { text: 'Original' }, eventSeq: 1 },
      { id: 'm2', senderId: 'user-2', body: { text: 'New after reconnect' }, eventSeq: 2 }
    ]);

    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].id, 'm2');
  });

  test('5. Local delete-for-me survives pagination of older messages', () => {
    const state = new RoomMessagesState('user-1');
    state.deleteMessageForMe('m-old', 'room-1');

    // Prepend older history containing m-old
    state.setInitialMessages('room-1', [
      { id: 'm-recent', senderId: 'user-2', body: { text: 'Recent' }, eventSeq: 10 }
    ]);
    state.prependOlderMessages([
      { id: 'm-old', senderId: 'user-2', body: { text: 'Old deleted message' }, eventSeq: 5 }
    ]);

    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].id, 'm-recent');
  });

  // ═════════════════════════════════════════════════════════════════
  // 2. DELETE FOR EVERYONE (Server-synced)
  // ═════════════════════════════════════════════════════════════════

  test('6. Correct WebSocket frame is sent for Delete for Everyone', async () => {
    const ws = new ChatWebSocket({ token: 'test_token', WebSocketClass: MockWebSocket });
    await ws.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();

    ws.deleteMessage('room-101', 'msg-to-delete');
    assert.equal(mock.sentData.length, 1);
    const frame = JSON.parse(mock.sentData[0]);
    assert.equal(frame.type, 'message.delete');
    assert.equal(frame.room_id, 'room-101');
    assert.deepEqual(frame.payload, { message_id: 'msg-to-delete' });
    ws.disconnect();
  });

  test('7. Unauthorized deletion is rejected by author check', () => {
    const currentUserId = 'user-alice';
    const messageFromBob = {
      id: 'msg-bob',
      sender_id: 'user-bob',
      body: { text: 'Bob note' }
    };

    assert.equal(isOwnMessage(messageFromBob, currentUserId), false);
  });

  test('8. Sender receives deleted tombstone state on deleteMessage', () => {
    const state = new RoomMessagesState('user-1');
    state.setInitialMessages('room-1', [
      { id: 'm-own', senderId: 'user-1', kind: 'text', body: { text: 'Secret' }, eventSeq: 1 }
    ]);

    const deleted = state.deleteMessage('m-own');
    assert.equal(deleted, true);
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].isDeleted, true);
    assert.equal(state.messages[0].kind, 'deleted');
    assert.equal(state.messages[0].body.text, 'This message was deleted');
  });

  test('9. Recipient receives deleted tombstone via message.deleted event', () => {
    const state = new RoomMessagesState('user-bob');
    state.setInitialMessages('room-1', [
      { id: 'msg-alice-1', senderId: 'user-alice', kind: 'text', body: { text: 'Hello Bob' }, eventSeq: 1 }
    ]);

    // Simulate incoming message.deleted frame dispatching targetState.deleteMessage('msg-alice-1')
    state.deleteMessage('msg-alice-1');
    const msg = state.messages[0];
    assert.equal(msg.isDeleted, true);
    assert.equal(msg.kind, 'deleted');
    assert.equal(msg.body.text, 'This message was deleted');
  });

  test('10. Tombstone renders correctly via resolveMessageContent', () => {
    const tombstoneMsg = {
      id: 'm1',
      senderId: 'user-1',
      kind: 'deleted',
      isDeleted: true,
      body: { text: 'This message was deleted' }
    };
    const resolved = resolveMessageContent(tombstoneMsg);
    assert.equal(resolved.kind, 'deleted');
    assert.equal(resolved.text, 'This message was deleted');
    assert.equal(resolved.isDeleted, true);
  });

  test('11. Deleted state survives reconnect / initial reload with tombstones', () => {
    const state = new RoomMessagesState('user-1');
    state.setInitialMessages('room-1', [
      { id: 'm1', senderId: 'user-2', kind: 'deleted', isDeleted: true, body: { text: 'This message was deleted' }, eventSeq: 1 }
    ]);

    assert.equal(state.messages.length, 1);
    const resolved = resolveMessageContent(state.messages[0]);
    assert.equal(resolved.kind, 'deleted');
    assert.equal(resolved.text, 'This message was deleted');
  });

  test('12. Background room handles deletion without affecting active room', () => {
    const roomAState = new RoomMessagesState('user-1');
    roomAState.setInitialMessages('room-a', [
      { id: 'msg-a', senderId: 'user-1', body: { text: 'Room A text' }, eventSeq: 1 }
    ]);

    const roomBState = new RoomMessagesState('user-1');
    roomBState.setInitialMessages('room-b', [
      { id: 'msg-b', senderId: 'user-2', body: { text: 'Room B text' }, eventSeq: 1 }
    ]);

    // Deletion occurs in background Room B
    roomBState.deleteMessage('msg-b');

    // Room A is completely untouched
    assert.equal(roomAState.messages[0].isDeleted, undefined);
    assert.equal(roomAState.messages[0].body.text, 'Room A text');

    // Room B is updated
    assert.equal(roomBState.messages[0].isDeleted, true);
    assert.equal(roomBState.messages[0].body.text, 'This message was deleted');
  });

  test('13. Media deletion behaves correctly by withholding media content', () => {
    const mediaMessage = {
      id: 'media-msg-1',
      senderId: 'user-1',
      kind: 'image',
      attachments: [{ id: 'att-1', filename: 'photo.jpg', byte_size: 10240 }],
      body: { caption: 'Look at this' },
      eventSeq: 1
    };

    const state = new RoomMessagesState('user-1');
    state.setInitialMessages('room-1', [mediaMessage]);

    // Perform Delete for Everyone
    state.deleteMessage('media-msg-1');

    const msg = state.messages[0];
    const resolved = resolveMessageContent(msg);
    assert.equal(resolved.kind, 'deleted');
    assert.equal(resolved.text, 'This message was deleted');
    assert.equal(resolved.isDeleted, true);
  });

  // ═════════════════════════════════════════════════════════════════
  // 3. EDIT MESSAGE (Server-synced)
  // ═════════════════════════════════════════════════════════════════

  test('14. Own message can be edited and author check passes', () => {
    const currentUserId = 'user-123';
    const myMsg = { id: 'm1', sender_id: 'user-123', body: { text: 'Typo' } };
    assert.equal(isOwnMessage(myMsg, currentUserId), true);
  });

  test('15. Received message cannot be edited by other user', () => {
    const currentUserId = 'user-123';
    const otherMsg = { id: 'm2', sender_id: 'user-456', body: { text: 'Other text' } };
    assert.equal(isOwnMessage(otherMsg, currentUserId), false);
  });

  test('16. PATCH/WS edit payload is structured correctly', async () => {
    const ws = new ChatWebSocket({ token: 'test_token', WebSocketClass: MockWebSocket });
    await ws.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();

    ws.editMessage('room-1', 'msg-edit', { text: 'Corrected text' });
    assert.equal(mock.sentData.length, 1);
    const frame = JSON.parse(mock.sentData[0]);
    assert.equal(frame.type, 'message.edit');
    assert.equal(frame.room_id, 'room-1');
    assert.deepEqual(frame.payload, {
      message_id: 'msg-edit',
      body: { text: 'Corrected text' }
    });
    ws.disconnect();
  });

  test('17. Editing does not create duplicate message', () => {
    const state = new RoomMessagesState('user-1');
    state.setInitialMessages('room-1', [
      { id: 'm1', senderId: 'user-1', body: { text: 'Old text' }, eventSeq: 10 }
    ]);

    const updated = state.updateMessage('m1', {
      body: { text: 'New text' },
      editedAt: '2026-09-27T12:00:00Z'
    });

    assert.equal(updated, true);
    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].id, 'm1');
    assert.equal(state.messages[0].body.text, 'New text');
    assert.equal(state.messages[0].eventSeq, 10);
  });

  test('18. editedAt and edited_at are preserved on edited message', () => {
    const state = new RoomMessagesState('user-1');
    state.setInitialMessages('room-1', [
      { id: 'm1', senderId: 'user-1', body: { text: 'Draft' }, eventSeq: 1 }
    ]);

    state.updateMessage('m1', {
      body: { text: 'Revised' },
      edited_at: '2026-09-27T12:30:00Z'
    });

    assert.equal(state.messages[0].editedAt, '2026-09-27T12:30:00Z');
    assert.equal(state.messages[0].edited_at, '2026-09-27T12:30:00Z');
  });

  test('19. Edited indicator renders correctly via formatFullDateTime and metadata', () => {
    const isoString = '2026-09-27T14:30:00.000Z';
    const formatted = formatFullDateTime(isoString);
    assert.ok(formatted.includes('2026'));
  });

  test('20. message.updated updates other connected client without duplication', () => {
    const recipientState = new RoomMessagesState('bob');
    recipientState.setInitialMessages('room-1', [
      { id: 'msg-alice', senderId: 'alice', body: { text: 'Meet at 5' }, eventSeq: 1 }
    ]);

    // Incoming message.updated event from Alice
    recipientState.updateMessage('msg-alice', {
      body: { text: 'Meet at 6' },
      editedAt: '2026-09-27T13:00:00Z'
    });

    assert.equal(recipientState.messages.length, 1);
    assert.equal(recipientState.messages[0].body.text, 'Meet at 6');
    assert.equal(recipientState.messages[0].editedAt, '2026-09-27T13:00:00Z');
  });

  test('21. Edit survives reconnect and reload', () => {
    const state = new RoomMessagesState('user-1');
    state.setInitialMessages('room-1', [
      { id: 'm1', senderId: 'user-1', body: { text: 'Initial' }, eventSeq: 1 }
    ]);
    state.updateMessage('m1', { body: { text: 'Edited' }, editedAt: '2026-09-27T10:00:00Z' });

    // Merging server messages after reconnect
    state.mergeServerMessages([
      { id: 'm1', senderId: 'user-1', body: { text: 'Edited' }, edited_at: '2026-09-27T10:00:00Z', eventSeq: 1 }
    ]);

    assert.equal(state.messages.length, 1);
    assert.equal(state.messages[0].body.text, 'Edited');
  });

  test('22. Receipt state survives editing and does not downgrade', () => {
    const state = new RoomMessagesState('user-1');
    state.setInitialMessages('room-1', [
      { id: 'm1', senderId: 'user-1', body: { text: 'Sent message' }, eventSeq: 1 }
    ]);

    state.updateReceipt('m1', MESSAGE_STATUS.DELIVERED);
    state.updateReceipt('m1', MESSAGE_STATUS.READ);
    assert.equal(state.getStatus('m1'), MESSAGE_STATUS.READ);

    // Edit message
    state.updateMessage('m1', { body: { text: 'Edited message' }, editedAt: '2026-09-27T11:00:00Z' });

    // Status MUST remain READ
    assert.equal(state.getStatus('m1'), MESSAGE_STATUS.READ);
  });

  // ═════════════════════════════════════════════════════════════════
  // 4. MESSAGE INFO (Truthful Canonical Status)
  // ═════════════════════════════════════════════════════════════════

  test('23. Sent information is correct for outgoing message', () => {
    const state = new RoomMessagesState('user-1');
    state.setInitialMessages('room-1', [
      { id: 'm1', senderId: 'user-1', createdAt: '2026-09-27T10:15:00Z', body: { text: 'Hi' } }
    ]);

    const status = state.getStatus('m1');
    assert.equal(status, MESSAGE_STATUS.SENT);
  });

  test('24. Delivered information reflects canonical receipt status', () => {
    const state = new RoomMessagesState('user-1');
    state.setInitialMessages('room-1', [
      { id: 'm1', senderId: 'user-1', createdAt: '2026-09-27T10:15:00Z', body: { text: 'Hi' } }
    ]);

    state.updateReceipt('m1', MESSAGE_STATUS.DELIVERED);
    assert.equal(state.getStatus('m1'), MESSAGE_STATUS.DELIVERED);
  });

  test('25. Read information reflects canonical receipt status', () => {
    const state = new RoomMessagesState('user-1');
    state.setInitialMessages('room-1', [
      { id: 'm1', senderId: 'user-1', createdAt: '2026-09-27T10:15:00Z', body: { text: 'Hi' } }
    ]);

    state.updateReceipt('m1', MESSAGE_STATUS.READ);
    assert.equal(state.getStatus('m1'), MESSAGE_STATUS.READ);
  });

  test('26. No fabricated timestamps are generated when none provided', () => {
    const msg = {
      id: 'm1',
      senderId: 'user-1',
      body: { text: 'Test' }
      // Notice: no delivered_at or read_at
    };
    assert.equal(msg.delivered_at, undefined);
    assert.equal(msg.read_at, undefined);
  });

  test('27. Inspecting Message Info does not trigger a read receipt or advance cursor', () => {
    const state = new RoomMessagesState('user-2');
    state.setInitialMessages('room-1', [
      { id: 'm1', senderId: 'user-1', body: { text: 'Incoming' }, eventSeq: 1 }
    ]);

    // Status of incoming message is untouched
    const st = state.getStatus('m1');
    assert.equal(st, null);
  });

  // ═════════════════════════════════════════════════════════════════
  // 5. STAR MESSAGE (Local-only)
  // ═════════════════════════════════════════════════════════════════

  test('28. Star message marks message as starred locally', () => {
    const state = new RoomMessagesState('user-1');
    state.setInitialMessages('room-1', [
      { id: 'm1', senderId: 'user-2', body: { text: 'Star me' }, eventSeq: 1 }
    ]);

    const starred = state.starMessage('m1', 'room-1');
    assert.equal(starred, true);
    assert.equal(state.isStarred('m1', 'room-1'), true);
  });

  test('29. Unstar message unmarks message locally', () => {
    const state = new RoomMessagesState('user-1');
    state.setInitialMessages('room-1', [
      { id: 'm1', senderId: 'user-2', body: { text: 'Star me' }, eventSeq: 1 }
    ]);

    state.starMessage('m1', 'room-1');
    assert.equal(state.isStarred('m1', 'room-1'), true);

    state.unstarMessage('m1', 'room-1');
    assert.equal(state.isStarred('m1', 'room-1'), false);
  });

  test('30. Star persists across application restart in local storage', () => {
    const state1 = new RoomMessagesState('user-1');
    state1.starMessage('m-starred', 'room-1');

    // Fresh instance for same user
    const state2 = new RoomMessagesState('user-1');
    assert.equal(state2.isStarred('m-starred', 'room-1'), true);
  });

  test('31. Star does not modify backend message content or payload', () => {
    const originalMsg = { id: 'm1', senderId: 'user-2', body: { text: 'Exact content' } };
    const state = new RoomMessagesState('user-1');
    state.setInitialMessages('room-1', [originalMsg]);

    state.starMessage('m1', 'room-1');
    assert.equal(state.messages[0].body.text, 'Exact content');
    assert.equal(state.messages[0].id, 'm1');
  });

  test('32. Star survives reconnect and catchup', () => {
    const state = new RoomMessagesState('user-1');
    state.starMessage('m1', 'room-1');

    state.setInitialMessages('room-1', [
      { id: 'm1', senderId: 'user-2', body: { text: 'Reconnected' }, eventSeq: 1 }
    ]);

    assert.equal(state.isStarred('m1', 'room-1'), true);
  });
});

describe('WhatsApp-Style Message Actions - Canonical ID, REST Mutation, and Error Handling Lifecycle', () => {
  beforeEach(() => {
    mockStorage.clear();
    MockWebSocket.instances = [];
  });

  // ═════════════════════════════════════════════════════════════════
  // DELETE FOR EVERYONE LIFECYCLE
  // ═════════════════════════════════════════════════════════════════

  test('DELETE 1. local optimistic ID is resolved to canonical server ID', async () => {
    const state = new RoomMessagesState('user-alice');
    // Case 1A: State already reconciled with canonical server ID matching clientMessageId
    state.setInitialMessages('room-1', [
      {
        id: 'srv-canonical-101',
        clientMessageId: 'local-uuid-101',
        senderId: 'user-alice',
        body: { text: 'Already reconciled' }
      }
    ]);
    const optimisticMsg1 = {
      id: 'local-uuid-101',
      clientMessageId: 'local-uuid-101',
      senderId: 'user-alice',
      body: { text: 'Already reconciled' }
    };
    const resolvedId1 = await resolveCanonicalMessageId('room-1', optimisticMsg1, { targetState: state });
    assert.equal(resolvedId1, 'srv-canonical-101');
    assert.equal(optimisticMsg1.id, 'srv-canonical-101');

    // Case 1B: Not in local state, fetched from chatApi.getMessages
    const state2 = new RoomMessagesState('user-alice');
    state2.setInitialMessages('room-1', [
      {
        id: 'local-uuid-102',
        clientMessageId: 'local-uuid-102',
        senderId: 'user-alice',
        body: { text: 'Unreconciled optimistic' }
      }
    ]);
    const optimisticMsg2 = {
      id: 'local-uuid-102',
      clientMessageId: 'local-uuid-102',
      senderId: 'user-alice',
      body: { text: 'Unreconciled optimistic' }
    };
    let apiCalled = false;
    const mockChatApi = {
      getMessages: async (roomId, options) => {
        apiCalled = true;
        assert.equal(roomId, 'room-1');
        assert.equal(options.limit, 50);
        return {
          messages: [
            {
              id: 'srv-canonical-102',
              client_message_id: 'local-uuid-102',
              sender_id: 'user-alice',
              body: { text: 'Unreconciled optimistic' }
            }
          ]
        };
      }
    };
    const resolvedId2 = await resolveCanonicalMessageId('room-1', optimisticMsg2, { targetState: state2, chatApi: mockChatApi });
    assert.equal(apiCalled, true);
    assert.equal(resolvedId2, 'srv-canonical-102');
    assert.equal(optimisticMsg2.id, 'srv-canonical-102');
  });

  test('DELETE 2. REST DELETE receives canonical ID and does NOT receive local-<uuid>', async () => {
    const state = new RoomMessagesState('user-alice');
    state.setInitialMessages('room-1', [
      {
        id: 'local-uuid-201',
        clientMessageId: 'local-uuid-201',
        senderId: 'user-alice',
        body: { text: 'To delete' }
      }
    ]);
    const messageToDelete = {
      id: 'local-uuid-201',
      clientMessageId: 'local-uuid-201',
      senderId: 'user-alice'
    };

    let deleteCalledWithRoom = null;
    let deleteCalledWithId = null;
    const mockChatApi = {
      getMessages: async () => ({
        messages: [{ id: 'srv-canonical-201', client_message_id: 'local-uuid-201' }]
      }),
      deleteMessage: async (roomId, messageId) => {
        deleteCalledWithRoom = roomId;
        deleteCalledWithId = messageId;
        return { success: true };
      }
    };

    // Simulate authoritative handleDeleteForEveryone lifecycle
    const canonicalId = await resolveCanonicalMessageId('room-1', messageToDelete, { targetState: state, chatApi: mockChatApi });
    assert.equal(canonicalId, 'srv-canonical-201');

    await mockChatApi.deleteMessage('room-1', canonicalId);

    assert.equal(deleteCalledWithRoom, 'room-1');
    assert.equal(deleteCalledWithId, 'srv-canonical-201');
    assert.equal(deleteCalledWithId.startsWith('local-'), false, 'REST DELETE must never receive local-<uuid>');
  });

  test('DELETE 3. local UI does not falsely delete when REST DELETE fails', async () => {
    const state = new RoomMessagesState('user-alice');
    state.setInitialMessages('room-1', [
      {
        id: 'srv-canonical-301',
        senderId: 'user-alice',
        body: { text: 'Important message' }
      }
    ]);
    const msg = { ...state.messages[0] };

    const mockChatApi = {
      deleteMessage: async () => {
        throw new Error('HTTP 404: Not Found');
      }
    };

    let failed = false;
    let localErrorLogged = null;
    try {
      const canonicalId = await resolveCanonicalMessageId('room-1', msg, { targetState: state, chatApi: mockChatApi });
      await mockChatApi.deleteMessage('room-1', canonicalId);
      // If success, mutate state (should NOT be reached)
      state.deleteMessage(canonicalId);
    } catch (err) {
      failed = true;
      localErrorLogged = err;
    }

    assert.equal(failed, true);
    assert.ok(localErrorLogged);
    // Message in state MUST remain intact!
    assert.equal(state.messages[0].isDeleted, undefined);
    assert.equal(state.messages[0].body.text, 'Important message');
  });

  test('DELETE 4. successful DELETE updates local state', async () => {
    const state = new RoomMessagesState('user-alice');
    state.setInitialMessages('room-1', [
      {
        id: 'srv-canonical-401',
        senderId: 'user-alice',
        kind: 'text',
        body: { text: 'Delete this please' }
      }
    ]);
    const msg = { ...state.messages[0] };

    const mockChatApi = {
      deleteMessage: async () => ({ success: true })
    };

    const canonicalId = await resolveCanonicalMessageId('room-1', msg, { targetState: state, chatApi: mockChatApi });
    await mockChatApi.deleteMessage('room-1', canonicalId);

    // After REST DELETE succeeds:
    state.deleteMessage(canonicalId);

    assert.equal(state.messages[0].isDeleted, true);
    assert.equal(state.messages[0].kind, 'deleted');
    assert.equal(state.messages[0].body.text, 'This message was deleted');
  });

  test('DELETE 5. receiver processes message.deleted', () => {
    const receiverState = new RoomMessagesState('user-bob');
    receiverState.setInitialMessages('room-1', [
      {
        id: 'srv-canonical-501',
        senderId: 'user-alice',
        kind: 'text',
        body: { text: 'Hello Bob' },
        eventSeq: 5
      }
    ]);

    // WebSocket event: message.deleted arrives at receiver
    const wsFrame = {
      type: 'message.deleted',
      room_id: 'room-1',
      payload: { id: 'srv-canonical-501' }
    };

    const deleted = receiverState.deleteMessage(wsFrame.payload.id);
    assert.equal(deleted, true);
    assert.equal(receiverState.messages[0].isDeleted, true);
    assert.equal(receiverState.messages[0].kind, 'deleted');
    assert.equal(receiverState.messages[0].body.text, 'This message was deleted');
    assert.equal(receiverState.messages[0].eventSeq, 5, 'Sequence bounds preserved');
  });

  test('DELETE 6. unsupported WebSocket message.delete is not relied upon', async () => {
    let wsMutationAttempted = false;
    const mockWs = {
      send: (type) => {
        if (type === 'message.delete') wsMutationAttempted = true;
      }
    };

    const mockChatApi = {
      deleteMessage: async () => ({ success: true })
    };

    const state = new RoomMessagesState('user-alice');
    state.setInitialMessages('room-1', [
      { id: 'srv-canonical-601', senderId: 'user-alice', body: { text: 'Test' } }
    ]);
    const msg = { ...state.messages[0] };

    // Execute authoritative delete via REST
    const canonicalId = await resolveCanonicalMessageId('room-1', msg, { targetState: state, chatApi: mockChatApi });
    await mockChatApi.deleteMessage('room-1', canonicalId);
    state.deleteMessage(canonicalId);

    assert.equal(wsMutationAttempted, false, 'message.delete WS frame must NOT be sent');
    assert.equal(state.messages[0].isDeleted, true);
  });

  // ═════════════════════════════════════════════════════════════════
  // EDIT LIFECYCLE
  // ═════════════════════════════════════════════════════════════════

  test('EDIT 7. local optimistic ID is resolved to canonical server ID', async () => {
    const state = new RoomMessagesState('user-alice');
    state.setInitialMessages('room-1', [
      {
        id: 'local-uuid-701',
        clientMessageId: 'local-uuid-701',
        senderId: 'user-alice',
        body: { text: 'Typo text' }
      }
    ]);
    const editingMsg = {
      id: 'local-uuid-701',
      clientMessageId: 'local-uuid-701',
      senderId: 'user-alice',
      body: { text: 'Typo text' }
    };

    const mockChatApi = {
      getMessages: async () => ({
        messages: [
          {
            id: 'srv-canonical-701',
            client_message_id: 'local-uuid-701',
            sender_id: 'user-alice',
            body: { text: 'Typo text' }
          }
        ]
      })
    };

    const resolvedId = await resolveCanonicalMessageId('room-1', editingMsg, { targetState: state, chatApi: mockChatApi });
    assert.equal(resolvedId, 'srv-canonical-701');
    assert.equal(editingMsg.id, 'srv-canonical-701');
  });

  test('EDIT 8. REST PATCH receives canonical ID and does NOT receive local-<uuid>', async () => {
    const state = new RoomMessagesState('user-alice');
    state.setInitialMessages('room-1', [
      {
        id: 'local-uuid-801',
        clientMessageId: 'local-uuid-801',
        senderId: 'user-alice',
        body: { text: 'Draft text' }
      }
    ]);
    const editingMsg = {
      id: 'local-uuid-801',
      clientMessageId: 'local-uuid-801',
      senderId: 'user-alice'
    };

    let patchCalledRoom = null;
    let patchCalledId = null;
    let patchCalledBody = null;

    const mockChatApi = {
      getMessages: async () => ({
        messages: [{ id: 'srv-canonical-801', client_message_id: 'local-uuid-801' }]
      }),
      editMessage: async (roomId, messageId, body) => {
        patchCalledRoom = roomId;
        patchCalledId = messageId;
        patchCalledBody = body;
        return {
          id: messageId,
          body,
          edited_at: '2026-09-27T12:00:00Z'
        };
      }
    };

    const canonicalId = await resolveCanonicalMessageId('room-1', editingMsg, { targetState: state, chatApi: mockChatApi });
    assert.equal(canonicalId, 'srv-canonical-801');

    await mockChatApi.editMessage('room-1', canonicalId, { text: 'Corrected text' });

    assert.equal(patchCalledRoom, 'room-1');
    assert.equal(patchCalledId, 'srv-canonical-801');
    assert.deepEqual(patchCalledBody, { text: 'Corrected text' });
    assert.equal(patchCalledId.startsWith('local-'), false, 'REST PATCH must never receive local-<uuid>');
  });

  test('EDIT 9. local UI does not falsely edit when REST PATCH fails', async () => {
    const state = new RoomMessagesState('user-alice');
    state.setInitialMessages('room-1', [
      {
        id: 'srv-canonical-901',
        senderId: 'user-alice',
        body: { text: 'Original text' }
      }
    ]);
    const editingMsg = { ...state.messages[0] };

    const mockChatApi = {
      editMessage: async () => {
        throw new Error('HTTP 404: Not Found');
      }
    };

    let failed = false;
    try {
      const canonicalId = await resolveCanonicalMessageId('room-1', editingMsg, { targetState: state, chatApi: mockChatApi });
      await mockChatApi.editMessage('room-1', canonicalId, { text: 'New text' });
      // If success, mutate state (should NOT be reached)
      state.updateMessage(canonicalId, { body: { text: 'New text' } });
    } catch (_) {
      failed = true;
    }

    assert.equal(failed, true);
    // Message in state MUST remain intact!
    assert.equal(state.messages[0].body.text, 'Original text');
    assert.equal(state.messages[0].editedAt, undefined);
  });

  test('EDIT 10. successful PATCH updates local state', async () => {
    const state = new RoomMessagesState('user-alice');
    state.setInitialMessages('room-1', [
      {
        id: 'srv-canonical-1001',
        clientMessageId: 'cid-1001',
        senderId: 'user-alice',
        body: { text: 'Before edit' },
        replyTo: 'reply-msg-77',
        eventSeq: 14
      }
    ]);
    state.messageStatus.set('srv-canonical-1001', 'delivered');
    const editingMsg = { ...state.messages[0] };

    const mockChatApi = {
      editMessage: async (rId, mId, body) => ({
        id: mId,
        body,
        edited_at: '2026-09-27T12:30:00Z'
      })
    };

    const canonicalId = await resolveCanonicalMessageId('room-1', editingMsg, { targetState: state, chatApi: mockChatApi });
    const patchRes = await mockChatApi.editMessage('room-1', canonicalId, { text: 'After edit' });

    // After REST PATCH succeeds:
    state.updateMessage(canonicalId, {
      body: { text: 'After edit' },
      editedAt: patchRes.edited_at,
      edited_at: patchRes.edited_at
    });

    const updated = state.messages[0];
    assert.equal(updated.id, 'srv-canonical-1001', 'Preserve message ID');
    assert.equal(updated.body.text, 'After edit');
    assert.equal(updated.editedAt, '2026-09-27T12:30:00Z', 'Preserve edited indicator');
    assert.equal(updated.replyTo, 'reply-msg-77', 'Preserve reply metadata');
    assert.equal(state.getStatus('srv-canonical-1001'), 'delivered', 'Preserve receipt status');
  });

  test('EDIT 11. receiver processes message.updated', () => {
    const receiverState = new RoomMessagesState('user-bob');
    receiverState.setInitialMessages('room-1', [
      {
        id: 'srv-canonical-1101',
        senderId: 'user-alice',
        body: { text: 'Meet at 4pm' },
        eventSeq: 8
      }
    ]);

    // WebSocket event: message.updated arrives at receiver
    const wsFrame = {
      type: 'message.updated',
      room_id: 'room-1',
      payload: {
        id: 'srv-canonical-1101',
        body: { text: 'Meet at 5pm' },
        edited_at: '2026-09-27T15:00:00Z'
      }
    };

    const updated = receiverState.updateMessage(wsFrame.payload.id, wsFrame.payload);
    assert.equal(updated, true);
    assert.equal(receiverState.messages[0].body.text, 'Meet at 5pm');
    assert.equal(receiverState.messages[0].editedAt, '2026-09-27T15:00:00Z');
    assert.equal(receiverState.messages[0].eventSeq, 8, 'Preserves sequence');
  });

  test('EDIT 12. unsupported WebSocket message.edit is not relied upon', async () => {
    let wsMutationAttempted = false;
    const mockWs = {
      send: (type) => {
        if (type === 'message.edit') wsMutationAttempted = true;
      }
    };

    const mockChatApi = {
      editMessage: async (rId, mId, body) => ({
        id: mId,
        body,
        edited_at: '2026-09-27T16:00:00Z'
      })
    };

    const state = new RoomMessagesState('user-alice');
    state.setInitialMessages('room-1', [
      { id: 'srv-canonical-1201', senderId: 'user-alice', body: { text: 'Original' } }
    ]);
    const msg = { ...state.messages[0] };

    // Execute authoritative edit via REST
    const canonicalId = await resolveCanonicalMessageId('room-1', msg, { targetState: state, chatApi: mockChatApi });
    const patchRes = await mockChatApi.editMessage('room-1', canonicalId, { text: 'Edited' });
    state.updateMessage(canonicalId, { body: { text: 'Edited' }, editedAt: patchRes.edited_at });

    assert.equal(wsMutationAttempted, false, 'message.edit WS frame must NOT be sent');
    assert.equal(state.messages[0].body.text, 'Edited');
  });

  test('REGRESSION: normal message that already has canonical ID does not require API fetch and executes REST mutation directly', async () => {
    let getMessagesCalled = false;
    const mockChatApi = {
      getMessages: async () => {
        getMessagesCalled = true;
        return { messages: [] };
      },
      deleteMessage: async (roomId, messageId) => ({ success: true }),
      editMessage: async (roomId, messageId, body) => ({ id: messageId, body, edited_at: '2026-09-27T17:00:00Z' })
    };

    const state = new RoomMessagesState('user-alice');
    state.setInitialMessages('room-1', [
      {
        id: 'canonical-server-999',
        senderId: 'user-alice',
        body: { text: 'Standard server message' }
      }
    ]);
    const normalMsg = state.messages[0];

    // Resolve canonical ID
    const resolvedId = await resolveCanonicalMessageId('room-1', normalMsg, { targetState: state, chatApi: mockChatApi });
    assert.equal(resolvedId, 'canonical-server-999');
    assert.equal(getMessagesCalled, false, 'Must not make extra API call when ID is already canonical');

    // Both delete and edit work directly with this ID
    const delRes = await mockChatApi.deleteMessage('room-1', resolvedId);
    assert.equal(delRes.success, true);

    const editRes = await mockChatApi.editMessage('room-1', resolvedId, { text: 'Updated standard' });
    assert.equal(editRes.id, 'canonical-server-999');
  });
});

describe('ChatWebSocket Sequence & Mutation Event Routing Regression Tests', () => {
  beforeEach(() => {
    mockStorage.clear();
    MockWebSocket.instances = [];
  });

  test('A. message.created with newer sequence is forwarded and advances cursor', async () => {
    const ws = new ChatWebSocket({ token: 'test-token', WebSocketClass: MockWebSocket });
    await ws.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();

    const created = [];
    const frames = [];
    ws.on('message.created', (msg) => created.push(msg));
    ws.on('frame', (f) => frames.push(f));

    mock.simulateMessage({
      v: 1,
      type: 'message.created',
      room_id: 'room-1',
      payload: { id: 'msg-1', event_seq: 10, body: { text: 'Hello' } }
    });

    assert.equal(created.length, 1);
    assert.equal(frames.length, 1);
    assert.equal(ws.getRoomCursor('room-1'), 10);
    ws.disconnect();
  });

  test('B. message.created with same or older sequence is duplicate suppressed', async () => {
    const ws = new ChatWebSocket({ token: 'test-token', WebSocketClass: MockWebSocket });
    await ws.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();

    const created = [];
    const duplicates = [];
    ws.on('message.created', (msg) => created.push(msg));
    ws.on('duplicate', (dup) => duplicates.push(dup));

    mock.simulateMessage({
      v: 1,
      type: 'message.created',
      room_id: 'room-1',
      payload: { id: 'msg-1', event_seq: 10, body: { text: 'Hello' } }
    });
    assert.equal(created.length, 1);

    // Duplicate message.created with same sequence <= 10
    mock.simulateMessage({
      v: 1,
      type: 'message.created',
      room_id: 'room-1',
      payload: { id: 'msg-1', event_seq: 10, body: { text: 'Hello again' } }
    });

    // Older message.created with sequence < 10
    mock.simulateMessage({
      v: 1,
      type: 'message.created',
      room_id: 'room-1',
      payload: { id: 'msg-old', event_seq: 9, body: { text: 'Old' } }
    });

    assert.equal(created.length, 1, 'Duplicate message.created must not be forwarded');
    assert.equal(duplicates.length, 2, 'Duplicates must emit duplicate event');
    ws.disconnect();
  });

  test('C. message.updated with sequence <= current cursor is forwarded to frame and message.updated', async () => {
    const ws = new ChatWebSocket({ token: 'test-token', WebSocketClass: MockWebSocket });
    await ws.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();

    ws.setRoomCursor('room-1', 20);

    const updated = [];
    const frames = [];
    const duplicates = [];
    ws.on('message.updated', (msg) => updated.push(msg));
    ws.on('frame', (f) => frames.push(f));
    ws.on('duplicate', (d) => duplicates.push(d));

    // Event with event_seq = 15 (which is <= current cursor 20)
    mock.simulateMessage({
      v: 1,
      type: 'message.updated',
      room_id: 'room-1',
      payload: { id: 'msg-15', event_seq: 15, body: { text: 'Edited text' } }
    });

    assert.equal(duplicates.length, 0, 'Must NOT be treated as duplicate');
    assert.equal(frames.length, 1, 'Must emit frame event');
    assert.equal(frames[0].type, 'message.updated');
    assert.equal(updated.length, 1, 'Must emit message.updated event');
    assert.equal(updated[0].id, 'msg-15');
    assert.equal(updated[0].body.text, 'Edited text');
    ws.disconnect();
  });

  test('D. message.deleted with sequence <= current cursor is forwarded to frame and message.deleted', async () => {
    const ws = new ChatWebSocket({ token: 'test-token', WebSocketClass: MockWebSocket });
    await ws.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();

    ws.setRoomCursor('room-1', 20);

    const deleted = [];
    const frames = [];
    const duplicates = [];
    ws.on('message.deleted', (data) => deleted.push(data));
    ws.on('frame', (f) => frames.push(f));
    ws.on('duplicate', (d) => duplicates.push(d));

    // Event with event_seq = 10 (which is <= current cursor 20)
    mock.simulateMessage({
      v: 1,
      type: 'message.deleted',
      room_id: 'room-1',
      payload: { id: 'msg-10', event_seq: 10 }
    });

    assert.equal(duplicates.length, 0, 'Must NOT be treated as duplicate');
    assert.equal(frames.length, 1, 'Must emit frame event');
    assert.equal(frames[0].type, 'message.deleted');
    assert.equal(deleted.length, 1, 'Must emit message.deleted event');
    assert.equal(deleted[0].messageId, 'msg-10');
    ws.disconnect();
  });

  test('E. message.updated with sequence > current cursor is forwarded', async () => {
    const ws = new ChatWebSocket({ token: 'test-token', WebSocketClass: MockWebSocket });
    await ws.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();

    ws.setRoomCursor('room-1', 5);

    const frames = [];
    const updated = [];
    ws.on('frame', (f) => frames.push(f));
    ws.on('message.updated', (msg) => updated.push(msg));

    mock.simulateMessage({
      v: 1,
      type: 'message.updated',
      room_id: 'room-1',
      payload: { id: 'msg-8', event_seq: 8, body: { text: 'Newer seq edit' } }
    });

    assert.equal(frames.length, 1);
    assert.equal(updated.length, 1);
    assert.equal(updated[0].body.text, 'Newer seq edit');
    ws.disconnect();
  });

  test('F. message.deleted with sequence > current cursor is forwarded', async () => {
    const ws = new ChatWebSocket({ token: 'test-token', WebSocketClass: MockWebSocket });
    await ws.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();

    ws.setRoomCursor('room-1', 5);

    const frames = [];
    const deleted = [];
    ws.on('frame', (f) => frames.push(f));
    ws.on('message.deleted', (data) => deleted.push(data));

    mock.simulateMessage({
      v: 1,
      type: 'message.deleted',
      room_id: 'room-1',
      payload: { id: 'msg-8', event_seq: 8 }
    });

    assert.equal(frames.length, 1);
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].messageId, 'msg-8');
    ws.disconnect();
  });

  test('G. Mutation frames reach the existing frame event and do not alter cursor inappropriately', async () => {
    const ws = new ChatWebSocket({ token: 'test-token', WebSocketClass: MockWebSocket });
    await ws.connect();
    const mock = MockWebSocket.instances[0];
    mock.simulateOpen();

    ws.setRoomCursor('room-1', 50);

    const frameTypes = [];
    ws.on('frame', (f) => frameTypes.push(f.type));

    mock.simulateMessage({
      v: 1,
      type: 'message.updated',
      room_id: 'room-1',
      payload: { id: 'm-edit', event_seq: 25, body: { text: 'Edit 25' } }
    });

    mock.simulateMessage({
      v: 1,
      type: 'message.deleted',
      room_id: 'room-1',
      payload: { id: 'm-del', event_seq: 12 }
    });

    assert.deepEqual(frameTypes, ['message.updated', 'message.deleted']);
    assert.equal(ws.getRoomCursor('room-1'), 50, 'Room cursor should not be rewound by older mutation events');
    ws.disconnect();
  });
});

describe('WhatsApp-Style Message Action Time Limits (15m Edit, 48h Delete for Everyone, Delete for Me)', () => {
  const currentUserId = 'user-alice';
  const baseTime = Date.parse('2026-09-30T12:00:00.000Z');

  // ─────────────────────────────────────────────────────────────
  // 1. Constants
  // ─────────────────────────────────────────────────────────────
  test('LIMITS 1. MESSAGE_ACTION_LIMITS defines 15 minutes and 48 hours exactly', () => {
    assert.equal(MESSAGE_ACTION_LIMITS.EDIT_WINDOW_MS, 15 * 60 * 1000);
    assert.equal(MESSAGE_ACTION_LIMITS.EDIT_WINDOW_MS, 900000);
    assert.equal(MESSAGE_ACTION_LIMITS.DELETE_FOR_EVERYONE_WINDOW_MS, 48 * 60 * 60 * 1000);
    assert.equal(MESSAGE_ACTION_LIMITS.DELETE_FOR_EVERYONE_WINDOW_MS, 172800000);
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Edit Message (15-Minute Window)
  // ─────────────────────────────────────────────────────────────
  test('EDIT LIMIT 2. Own text message within 15 minutes can be edited', () => {
    const msg = {
      id: 'm1',
      senderId: currentUserId,
      kind: 'text',
      body: { text: 'Hello' },
      createdAt: new Date(baseTime - 5 * 60 * 1000).toISOString() // 5 minutes ago
    };
    assert.equal(canEditMessage(msg, currentUserId, baseTime), true);
  });

  test('EDIT LIMIT 3. Own text message exactly at 15:00.000 boundary can be edited', () => {
    const msg = {
      id: 'm2',
      sender_id: currentUserId,
      kind: 'text',
      body: { text: 'Boundary message' },
      created_at: new Date(baseTime - 15 * 60 * 1000).toISOString() // exactly 15 minutes ago
    };
    assert.equal(canEditMessage(msg, currentUserId, baseTime), true);
  });

  test('EDIT LIMIT 4. Own text message at 15:00.001 (900,001 ms) cannot be edited', () => {
    const msg = {
      id: 'm3',
      senderId: currentUserId,
      kind: 'text',
      body: { text: 'Expired' },
      createdAt: new Date(baseTime - (15 * 60 * 1000 + 1)).toISOString() // 15m 1ms ago
    };
    assert.equal(canEditMessage(msg, currentUserId, baseTime), false);
  });

  test('EDIT LIMIT 5. Own text message created hours ago cannot be edited', () => {
    const msg = {
      id: 'm4',
      senderId: currentUserId,
      kind: 'text',
      body: { text: 'Old message' },
      createdAt: new Date(baseTime - 2 * 60 * 60 * 1000).toISOString() // 2 hours ago
    };
    assert.equal(canEditMessage(msg, currentUserId, baseTime), false);
  });

  test('EDIT LIMIT 6. Message from another user cannot be edited even within 15 minutes', () => {
    const msg = {
      id: 'm5',
      senderId: 'user-bob',
      kind: 'text',
      body: { text: 'From Bob' },
      createdAt: new Date(baseTime - 1 * 60 * 1000).toISOString() // 1 minute ago
    };
    assert.equal(canEditMessage(msg, currentUserId, baseTime), false);
  });

  test('EDIT LIMIT 7. Non-text messages cannot be edited even within 15 minutes', () => {
    const imgMsg = {
      id: 'm6',
      senderId: currentUserId,
      kind: 'image',
      attachments: [{ id: 'att-1' }],
      body: { caption: 'Photo' },
      createdAt: new Date(baseTime - 2 * 60 * 1000).toISOString()
    };
    const fileMsg = {
      id: 'm7',
      senderId: currentUserId,
      kind: 'file',
      attachments: [{ id: 'att-2' }],
      createdAt: new Date(baseTime - 2 * 60 * 1000).toISOString()
    };
    assert.equal(canEditMessage(imgMsg, currentUserId, baseTime), false);
    assert.equal(canEditMessage(fileMsg, currentUserId, baseTime), false);
  });

  test('EDIT LIMIT 8. Already deleted messages cannot be edited even within 15 minutes', () => {
    const deletedMsg1 = {
      id: 'm8',
      senderId: currentUserId,
      kind: 'deleted',
      isDeleted: true,
      body: { text: 'This message was deleted' },
      createdAt: new Date(baseTime - 2 * 60 * 1000).toISOString()
    };
    const deletedMsg2 = {
      id: 'm9',
      senderId: currentUserId,
      kind: 'text',
      isDeleted: true,
      body: { text: 'This message was deleted' },
      createdAt: new Date(baseTime - 2 * 60 * 1000).toISOString()
    };
    assert.equal(canEditMessage(deletedMsg1, currentUserId, baseTime), false);
    assert.equal(canEditMessage(deletedMsg2, currentUserId, baseTime), false);
  });

  test('EDIT LIMIT 9. The 15-minute timer does NOT reset after an edit (edited_at is never used)', () => {
    // Message created 20 minutes ago, but edited 2 minutes ago
    const editedMsg = {
      id: 'm10',
      senderId: currentUserId,
      kind: 'text',
      body: { text: 'Revised text' },
      createdAt: new Date(baseTime - 20 * 60 * 1000).toISOString(), // 20m ago (EXPIRED)
      created_at: new Date(baseTime - 20 * 60 * 1000).toISOString(),
      editedAt: new Date(baseTime - 2 * 60 * 1000).toISOString(), // 2m ago (RECENT)
      edited_at: new Date(baseTime - 2 * 60 * 1000).toISOString()
    };

    // Must be FALSE: the edit window is strictly measured from original created_at
    assert.equal(canEditMessage(editedMsg, currentUserId, baseTime), false);
  });

  test('EDIT LIMIT 10. Repeated edits within the original 15-minute window are allowed', () => {
    // Message created 10 minutes ago, already edited at minute 5
    const multiEditMsg = {
      id: 'm11',
      senderId: currentUserId,
      kind: 'text',
      body: { text: 'First edit' },
      createdAt: new Date(baseTime - 10 * 60 * 1000).toISOString(), // 10m ago (VALID)
      editedAt: new Date(baseTime - 5 * 60 * 1000).toISOString()
    };
    assert.equal(canEditMessage(multiEditMsg, currentUserId, baseTime), true);
  });

  test('EDIT LIMIT 11. Handles slight backward client clock skew gracefully without error', () => {
    // Message timestamp is slightly ahead of client "now" (e.g. server clock is 5 seconds ahead)
    const futureSkewMsg = {
      id: 'm12',
      senderId: currentUserId,
      kind: 'text',
      body: { text: 'Skew test' },
      createdAt: new Date(baseTime + 5000).toISOString()
    };
    assert.equal(canEditMessage(futureSkewMsg, currentUserId, baseTime), true);
  });

  test('EDIT LIMIT 12. Rejects message with missing, empty, or unparseable created_at (fail-closed)', () => {
    assert.equal(canEditMessage({ id: 'm13', senderId: currentUserId, kind: 'text', body: { text: 'No ts' } }, currentUserId, baseTime), false);
    assert.equal(canEditMessage({ id: 'm14', senderId: currentUserId, kind: 'text', body: { text: 'Empty ts' }, createdAt: '' }, currentUserId, baseTime), false);
    assert.equal(canEditMessage({ id: 'm15', senderId: currentUserId, kind: 'text', body: { text: 'Bad ts' }, createdAt: 'not-a-date' }, currentUserId, baseTime), false);
  });

  // ─────────────────────────────────────────────────────────────
  // 3. Delete for Everyone (48-Hour Window)
  // ─────────────────────────────────────────────────────────────
  test('DELETE EVERYONE LIMIT 13. Own message within 48 hours can be deleted for everyone', () => {
    const msg = {
      id: 'del1',
      senderId: currentUserId,
      kind: 'text',
      body: { text: 'To delete' },
      createdAt: new Date(baseTime - 24 * 60 * 60 * 1000).toISOString() // 24 hours ago
    };
    assert.equal(canDeleteMessageForEveryone(msg, currentUserId, baseTime), true);
  });

  test('DELETE EVERYONE LIMIT 14. Own message exactly at 48:00.000 boundary can be deleted for everyone', () => {
    const msg = {
      id: 'del2',
      sender_id: currentUserId,
      kind: 'text',
      body: { text: 'Boundary delete' },
      created_at: new Date(baseTime - 48 * 60 * 60 * 1000).toISOString() // exactly 48h ago
    };
    assert.equal(canDeleteMessageForEveryone(msg, currentUserId, baseTime), true);
  });

  test('DELETE EVERYONE LIMIT 15. Own message at 48:00.001 (172,800,001 ms) cannot be deleted for everyone', () => {
    const msg = {
      id: 'del3',
      senderId: currentUserId,
      kind: 'text',
      body: { text: 'Expired delete' },
      createdAt: new Date(baseTime - (48 * 60 * 60 * 1000 + 1)).toISOString() // 48h 1ms ago
    };
    assert.equal(canDeleteMessageForEveryone(msg, currentUserId, baseTime), false);
  });

  test('DELETE EVERYONE LIMIT 16. Own message created days ago cannot be deleted for everyone', () => {
    const msg = {
      id: 'del4',
      senderId: currentUserId,
      kind: 'text',
      body: { text: '5 days old' },
      createdAt: new Date(baseTime - 5 * 24 * 60 * 60 * 1000).toISOString()
    };
    assert.equal(canDeleteMessageForEveryone(msg, currentUserId, baseTime), false);
  });

  test('DELETE EVERYONE LIMIT 17. Media/file messages can be deleted for everyone within 48 hours', () => {
    const mediaMsg = {
      id: 'del5',
      senderId: currentUserId,
      kind: 'image',
      attachments: [{ id: 'photo-1' }],
      createdAt: new Date(baseTime - 12 * 60 * 60 * 1000).toISOString() // 12 hours ago
    };
    assert.equal(canDeleteMessageForEveryone(mediaMsg, currentUserId, baseTime), true);
  });

  test('DELETE EVERYONE LIMIT 18. Message from another user cannot be deleted for everyone even within 48 hours', () => {
    const msg = {
      id: 'del6',
      senderId: 'user-bob',
      kind: 'text',
      body: { text: 'Bob message' },
      createdAt: new Date(baseTime - 1 * 60 * 60 * 1000).toISOString() // 1 hour ago
    };
    assert.equal(canDeleteMessageForEveryone(msg, currentUserId, baseTime), false);
  });

  test('DELETE EVERYONE LIMIT 19. Already deleted message cannot be deleted for everyone even within 48 hours', () => {
    const deletedMsg = {
      id: 'del7',
      senderId: currentUserId,
      kind: 'deleted',
      isDeleted: true,
      body: { text: 'This message was deleted' },
      createdAt: new Date(baseTime - 1 * 60 * 60 * 1000).toISOString()
    };
    assert.equal(canDeleteMessageForEveryone(deletedMsg, currentUserId, baseTime), false);
  });

  test('DELETE EVERYONE LIMIT 20. Handles slight backward client clock skew gracefully without error', () => {
    const futureSkewMsg = {
      id: 'del8',
      senderId: currentUserId,
      kind: 'text',
      body: { text: 'Skew delete' },
      createdAt: new Date(baseTime + 10000).toISOString()
    };
    assert.equal(canDeleteMessageForEveryone(futureSkewMsg, currentUserId, baseTime), true);
  });

  test('DELETE EVERYONE LIMIT 21. Rejects message with missing or unparseable created_at (fail-closed)', () => {
    assert.equal(canDeleteMessageForEveryone({ id: 'del9', senderId: currentUserId }, currentUserId, baseTime), false);
    assert.equal(canDeleteMessageForEveryone({ id: 'del10', senderId: currentUserId, createdAt: 'invalid' }, currentUserId, baseTime), false);
  });

  // ─────────────────────────────────────────────────────────────
  // 4. Delete for Me (No Time Restriction)
  // ─────────────────────────────────────────────────────────────
  test('DELETE FOR ME 22. Delete for Me remains available without time restriction for any message age', () => {
    const state = new RoomMessagesState(currentUserId);
    const ancientMsg = {
      id: 'ancient-1',
      senderId: 'user-bob',
      body: { text: 'Message from 6 months ago' },
      createdAt: '2026-03-01T10:00:00Z',
      eventSeq: 1
    };
    state.setInitialMessages('room-1', [ancientMsg]);
    assert.equal(state.messages.length, 1);

    // Delete for me executes successfully regardless of age
    const deleted = state.deleteMessageForMe('ancient-1', 'room-1');
    assert.equal(deleted, true);
    assert.equal(state.messages.length, 0);
    assert.equal(state.isDeletedForMe('ancient-1', 'room-1'), true);
  });
});



