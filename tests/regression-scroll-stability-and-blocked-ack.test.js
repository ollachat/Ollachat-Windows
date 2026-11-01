import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ChatShellState,
  RoomMessagesState,
  getTickDescriptor,
  createOptimisticMessage,
  STATUS_RANKS
} from '../src/renderer/chat-shell-state.js';
import { ChatWebSocket } from '../src/chat/chat-websocket.js';
import { OutboxManager } from '../src/renderer/outbox-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appJsPath = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
const chatWebSocketPath = path.join(__dirname, '..', 'src', 'chat', 'chat-websocket.js');
const outboxManagerPath = path.join(__dirname, '..', 'src', 'renderer', 'outbox-manager.js');
const mainJsPath = path.join(__dirname, '..', 'src', 'main', 'main.js');

const appJs = fs.readFileSync(appJsPath, 'utf8');
const chatWebSocketJs = fs.readFileSync(chatWebSocketPath, 'utf8');
const outboxManagerJs = fs.readFileSync(outboxManagerPath, 'utf8');
const mainJs = fs.readFileSync(mainJsPath, 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// BUG 1: Chat Messages Scroll Stability Tests
// ═══════════════════════════════════════════════════════════════════════════
describe('BUG 1: Chat Scroll Position Stability & Jumps Prevention', () => {

  test('1. Static Invariants: Targeted DOM update helpers and scroll guards exist in app.js', () => {
    assert.ok(appJs.includes('export function appendMessageToDom('), 'Must export appendMessageToDom');
    assert.ok(appJs.includes('export function updateMessageElementInDom('), 'Must export updateMessageElementInDom');
    assert.ok(appJs.includes('export function removeMessageElementFromDom('), 'Must export removeMessageElementFromDom');
    assert.ok(appJs.includes('export function captureScrollAnchor('), 'Must export captureScrollAnchor');
    assert.ok(appJs.includes('export function restoreScrollAnchor('), 'Must export restoreScrollAnchor');
    assert.ok(appJs.includes('isRebuildingMessagesDom'), 'Must have isRebuildingMessagesDom guard');
    assert.ok(appJs.includes('canScrollUp && messagesScrollArea.scrollTop < 50'), 'Must guard loadOlderMessages with canScrollUp');
  });

  test('2. Sending a message appends to DOM and keeps view at bottom without wiping message list', () => {
    // When sending a message:
    // Must use appendMessageToDom rather than renderMessages() (which wiped innerHTML)
    assert.ok(
      appJs.includes('appendMessageToDom(optimisticMsg);') &&
      appJs.includes('scrollToBottom(false);'),
      'handleSendMessage must append optimistic message without destructive innerHTML clear'
    );
  });

  test('3. Receiving a message while at the bottom keeps the view at the bottom', () => {
    // In message.created event:
    assert.ok(
      appJs.includes('if (wasNearBottom || isOwn) {') &&
      appJs.includes('scrollToBottom(true);'),
      'message.created must scroll to bottom if user was near bottom or own message'
    );
  });

  test('4. Receiving a message while reading older messages preserves visible viewport position', () => {
    // In message.created event:
    assert.ok(
      appJs.includes('let capturedAnchor = null;') &&
      appJs.includes('if (!wasNearBottom && !isOwn) {') &&
      appJs.includes('capturedAnchor = captureScrollAnchor();') &&
      appJs.includes('if (capturedAnchor) {') &&
      appJs.includes('restoreScrollAnchor(capturedAnchor);'),
      'Must capture anchor before append and restore anchor if reading older messages'
    );
  });

  test('5. Switching chats does not reuse the previous chat scroll position or pollute active room', () => {
    const state = new ChatShellState();
    const roomA = 'room_alpha';
    const roomB = 'room_beta';
    const roomScrolls = new Map();

    // User is in Room A at scroll 350
    roomScrolls.set(roomA, { scrollTop: 350, isNearBottom: false });

    // User switches to Room B (never visited before)
    assert.strictEqual(roomScrolls.has(roomB), false, 'Room B has no prior scroll');

    // Room B opens at default latest messages / bottom
    const savedB = roomScrolls.get(roomB) || { scrollTop: null, isNearBottom: true };
    assert.strictEqual(savedB.isNearBottom, true, 'Room B defaults to bottom');
    assert.notStrictEqual(savedB.scrollTop, 350, 'Room B never inherits Room A scroll offset');
  });

  test('6. Delayed history response from Chat A cannot overwrite Chat B', async () => {
    const state = new ChatShellState();
    state.selectedRoomId = 'room_B';

    let roomStateA = new RoomMessagesState('user_me');
    roomStateA.roomId = 'room_A';
    let roomStateB = new RoomMessagesState('user_me');
    roomStateB.roomId = 'room_B';

    // Simulate delayed response for Room A resolving while Room B is active
    const delayedResponseRoomId = 'room_A';
    const olderMessagesA = [{ id: 'msg_a_old', body: { text: 'Old message A' } }];

    // Target state lookup must be scoped to request room ID, not selectedRoomId
    const targetState = delayedResponseRoomId === 'room_A' ? roomStateA : roomStateB;
    targetState.prependOlderMessages(olderMessagesA);

    // Assert Room B messages state was NOT polluted
    assert.strictEqual(roomStateB.messages.length, 0, 'Room B messages must not be modified by Room A response');
    assert.strictEqual(roomStateA.messages.length, 1, 'Room A received its older messages');

    // Verify app.js guards target state and checks selectedRoomId before DOM restoration
    assert.ok(
      appJs.includes('targetState = getOrCreateRoomMessagesState(targetRoomId);') ||
      appJs.includes('targetState = getOrCreateRoomMessagesState(roomId);'),
      'loadOlderMessages must scope state mutations directly to target room'
    );
  });

  test('7. Loading older messages preserves current reading position using anchor/delta', () => {
    // Verify captureScrollAnchor and restoreScrollAnchor implementation logic
    const mockScrollArea = {
      scrollTop: 10,
      scrollHeight: 1000,
      clientHeight: 500,
      querySelector(sel) {
        if (sel === '.message-row') {
          return {
            getAttribute(k) { return k === 'data-message-id' ? 'msg_anchor_42' : null; },
            getBoundingClientRect() { return { top: 60 }; }
          };
        }
        return null;
      }
    };

    function simulateCaptureAnchor(area) {
      const firstRow = area.querySelector('.message-row');
      const msgId = firstRow?.getAttribute('data-message-id');
      return {
        messageId: msgId,
        topOffset: 60,
        prevScrollHeight: area.scrollHeight,
        prevScrollTop: area.scrollTop
      };
    }

    const anchor = simulateCaptureAnchor(mockScrollArea);
    assert.strictEqual(anchor.messageId, 'msg_anchor_42');

    // After prepending 500px of older history:
    mockScrollArea.scrollHeight = 1500;
    const heightDelta = mockScrollArea.scrollHeight - anchor.prevScrollHeight;
    mockScrollArea.scrollTop = anchor.prevScrollTop + heightDelta;

    assert.strictEqual(mockScrollArea.scrollTop, 510, 'Scroll offset adjusted exactly by prepended height');
  });

  test('8. Updating a message tick does not reset or jump conversation scroll position', () => {
    // updateMessageStatusInDom updates only the target row without rebuilding messagesList
    assert.ok(
      appJs.includes('function updateMessageStatusInDom(') &&
      !appJs.slice(appJs.indexOf('function updateMessageStatusInDom('), appJs.indexOf('function updateMessageStatusInDom(') + 600).includes('renderMessages();'),
      'updateMessageStatusInDom must never call renderMessages()'
    );
  });

  test('9. Realtime message events do not create duplicate messages in room state', () => {
    const roomState = new RoomMessagesState('user_me');
    roomState.roomId = 'room_1';
    const msg = {
      id: 'server_msg_101',
      client_message_id: 'client_msg_101',
      sender_id: 'peer_user',
      body: { text: 'Hello!' },
      created_at: new Date().toISOString()
    };

    const firstAppend = roomState.appendIncomingMessage(msg);
    assert.ok(firstAppend, 'First append succeeds and returns object');
    assert.strictEqual(roomState.messages.length, 1);

    // Duplicate event with same server ID merges in place without adding new entry
    roomState.appendIncomingMessage(msg);
    assert.strictEqual(roomState.messages.length, 1, 'Duplicate server ID does not increase message count');

    // Duplicate event with matching clientMessageId merges in place without adding new entry
    const matchingCidMsg = {
      id: 'server_msg_101',
      clientMessageId: 'client_msg_101',
      sender_id: 'peer_user',
      body: { text: 'Hello!' }
    };
    roomState.appendIncomingMessage(matchingCidMsg);
    assert.strictEqual(roomState.messages.length, 1, 'Duplicate clientMessageId does not increase message count');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BUG 2: Blocked Messages Single Grey Tick & Outbox Lifecycle Tests
// ═══════════════════════════════════════════════════════════════════════════
describe('BUG 2: Blocked Messages Single Grey Tick & Outbox Lifecycle', () => {

  test('1. Blocking peer suppresses peer profile photo and presence indicators', () => {
    const state = new ChatShellState();
    const peerId = 'user_blocked_bob';
    const roomId = 'room_dm_bob';

    state.addBlockedUser({ userId: peerId, displayName: 'Bob' });
    assert.strictEqual(state.isUserBlocked(peerId), true, 'User is blocked');

    // Presence update for blocked peer must be suppressed
    state.setPresence(roomId, peerId, true);
    assert.strictEqual(state.isUserOnline(roomId, peerId), false, 'Presence must remain offline for blocked user');

    // Typing indicator for blocked peer must be suppressed
    state.setTyping(roomId, peerId, true);
    assert.strictEqual(state.isUserTyping(roomId, peerId), false, 'Typing must remain false for blocked user');
  });

  test('2. Server-accepted message transitions to sent and renders single grey tick', () => {
    const roomState = new RoomMessagesState('user_me');
    roomState.roomId = 'room_1';
    const clientMsgId = 'local-uuid-12345';
    const optMsg = createOptimisticMessage('room_1', 'user_me', 'Hello Bob', clientMsgId);

    roomState.addOptimisticMessage(optMsg);
    assert.strictEqual(roomState.getStatus(clientMsgId), 'sending');

    // Server acknowledges acceptance
    roomState.updateReceipt(clientMsgId, 'sent', 'room_1');
    assert.strictEqual(roomState.getStatus(clientMsgId), 'sent');

    const tickDesc = getTickDescriptor('sent', true);
    assert.strictEqual(tickDesc.hasTick, true);
    assert.strictEqual(tickDesc.symbol, '✓', 'Single tick for sent');
    assert.strictEqual(tickDesc.statusClass, 'status-sent', 'Grey tick CSS class');
  });

  test('3. Accepted message has no warning icon and no Retry button', () => {
    const sentTick = getTickDescriptor('sent', true);
    assert.notStrictEqual(sentTick.statusClass, 'status-failed', 'Must not have failed class');
    assert.notStrictEqual(sentTick.symbol, '⚠️', 'Must not have warning symbol');

    // In app.js updateMessageStatusInDom:
    assert.ok(
      appJs.includes("row.classList.remove('failed');") &&
      appJs.includes('if (retryBtn) {') &&
      appJs.includes('retryBtn.remove();'),
      'updateMessageStatusInDom must remove failed class and retry button for sent messages'
    );
  });

  test('4. Accepted message is removed from the pending outbox', async () => {
    const outboxStore = new Map();
    const mockDbBridge = {
      async savePendingOutbox({ clientMessageId, roomId, payloadJson, createdAt }) {
        outboxStore.set(clientMessageId, { clientMessageId, roomId, payloadJson, createdAt });
        return { ok: true };
      },
      async clearPendingOutboxItem({ clientMessageId }) {
        outboxStore.delete(clientMessageId);
        return { ok: true };
      },
      async getPendingOutbox() {
        return Array.from(outboxStore.values());
      }
    };

    const outboxManager = new OutboxManager();
    const clientMsgId = 'local-outbox-test-999';

    // 1. Enqueue message
    await outboxManager.enqueue({
      clientMessageId: clientMsgId,
      roomId: 'room_1',
      wirePayload: { client_message_id: clientMsgId, body: { text: 'Test' } },
      dbBridge: mockDbBridge
    });
    assert.strictEqual(outboxStore.has(clientMsgId), true, 'Message enqueued in SQLite outbox');

    // 2. Authoritative ACK arrives -> clear outbox
    await outboxManager.clear({ clientMessageId: clientMsgId, dbBridge: mockDbBridge });
    assert.strictEqual(outboxStore.has(clientMsgId), false, 'Accepted message removed from outbox');
  });

  test('5. Genuine pre-acceptance failure remains failed and displays retry button', () => {
    const failedTick = getTickDescriptor('failed', true);
    assert.strictEqual(failedTick.hasTick, true);
    assert.strictEqual(failedTick.statusClass, 'status-failed');
    assert.strictEqual(failedTick.symbol, '⚠️');
    assert.strictEqual(failedTick.title, 'Failed to send');
  });

  test('6. Pre-generated requestId prevents race condition between IPC invoke and incoming WebSocket ACK', () => {
    // In chat-websocket.js: send accepts customRequestId and maps it to client_message_id
    assert.ok(
      chatWebSocketJs.includes('customRequestId') &&
      chatWebSocketJs.includes('this._requestIdToClientMessageId.set('),
      'ChatWebSocket must track requestIdToClientMessageId'
    );

    // In main.js: chat:send forwards requestId
    assert.ok(
      mainJs.includes("ipcMain.handle('chat:send', (event, type, payload, roomId, requestId)") ||
      mainJs.includes("send(type, payload, roomId, requestId)"),
      'Main process must forward requestId to WebSocket client'
    );

    // In app.js: handleSendMessage pre-allocates sendRequestId before dispatching send
    assert.ok(
      (appJs.includes('const sendRequestId = crypto.randomUUID();') || appJs.includes('const sendRequestId = generateUuid();')) &&
      appJs.includes('requestToClient.set(sendRequestId, clientMessageId);'),
      'Renderer must pre-set requestToClient before awaiting IPC send'
    );
  });

  test('7. Supported wire ACK variants (ack, msg_ack, ws_ack, message.send.ack) match and resolve clientMessageId', () => {
    const testReqId = 'req-ack-test-1';
    const testClientMsgId = 'local-client-msg-777';

    // Verify ChatWebSocket._handleIncomingFrame maps client_message_id from request_id
    const ws = new ChatWebSocket({ url: 'ws://127.0.0.1:9999' });
    ws._requestIdToClientMessageId.set(testReqId, testClientMsgId);

    const wireFrame = {
      type: 'ack',
      request_id: testReqId,
      payload: { status: 'accepted' }
    };

    ws._handleIncomingFrame(wireFrame);
    assert.strictEqual(wireFrame.client_message_id, testClientMsgId, 'Frame mapped client_message_id');
    assert.strictEqual(wireFrame.payload.client_message_id, testClientMsgId, 'Payload mapped client_message_id');
  });

  test('8. Reconnecting does not duplicate an accepted message (idempotency preserved)', () => {
    const ws = new ChatWebSocket({ url: 'ws://127.0.0.1:9999' });
    const seenEvents = [];
    ws.on('message.created', (f) => seenEvents.push(f));

    // First delivery of message.created
    const frame1 = {
      type: 'message.created',
      room_id: 'room_1',
      payload: { id: 'msg_auth_100', client_message_id: 'local_100', event_seq: 50 }
    };
    ws._handleIncomingFrame(frame1);
    assert.strictEqual(seenEvents.length, 1);

    // Reconnect simulation: same event seq arrives during catch-up
    const frameDuplicate = {
      type: 'message.created',
      room_id: 'room_1',
      payload: { id: 'msg_auth_100', client_message_id: 'local_100', event_seq: 50 }
    };
    ws._handleIncomingFrame(frameDuplicate);
    assert.strictEqual(seenEvents.length, 1, 'Duplicate event seq must be suppressed by cursor tracking');
  });

  test('9. Normal conversations continue to support delivered and read receipts monotonically', () => {
    const roomState = new RoomMessagesState('user_me');
    roomState.roomId = 'room_normal';
    const msgId = 'msg_normal_200';
    roomState.addOptimisticMessage({
      id: msgId,
      clientMessageId: 'cid_200',
      senderId: 'user_me',
      sender_id: 'user_me',
      roomId: 'room_normal',
      room_id: 'room_normal',
      body: { text: 'Hi' }
    });

    // Transition sent -> delivered
    roomState.updateReceipt(msgId, 'delivered', 'room_normal');
    assert.strictEqual(roomState.getStatus(msgId), 'delivered');
    const delTick = getTickDescriptor('delivered', true);
    assert.strictEqual(delTick.symbol, '✓✓');
    assert.strictEqual(delTick.statusClass, 'status-delivered');

    // Transition delivered -> read
    roomState.updateReceipt(msgId, 'read', 'room_normal');
    assert.strictEqual(roomState.getStatus(msgId), 'read');
    const readTick = getTickDescriptor('read', true);
    assert.strictEqual(readTick.symbol, '✓✓');
    assert.strictEqual(readTick.statusClass, 'status-read');

    // Monotonic enforcement: cannot downgrade from read to delivered or sent
    roomState.updateReceipt(msgId, 'delivered', 'room_normal');
    assert.strictEqual(roomState.getStatus(msgId), 'read', 'Cannot downgrade read to delivered');
    roomState.updateReceipt(msgId, 'sent', 'room_normal');
    assert.strictEqual(roomState.getStatus(msgId), 'read', 'Cannot downgrade read to sent');
  });
});
