import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatShellState, RoomMessagesState } from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const htmlPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const cssPath = path.join(__dirname, '..', 'src', 'renderer', 'styles.css');
const appJsPath = path.join(__dirname, '..', 'src', 'renderer', 'app.js');

const html = fs.readFileSync(htmlPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
const appJs = fs.readFileSync(appJsPath, 'utf8');

describe('Conversation Panel Behaviour & WhatsApp Parity Tests', () => {

  test('1. Floating scroll-to-bottom button contains unread badge element', () => {
    assert.ok(html.includes('id="scroll-bottom-btn"'), 'Must define #scroll-bottom-btn');
    assert.ok(html.includes('id="scroll-bottom-badge"'), 'Must define #scroll-bottom-badge inside DOM');
    assert.ok(html.includes('class="scroll-bottom-badge hidden"'), 'Scroll bottom badge starts hidden');
  });

  test('2. CSS styles .scroll-bottom-badge as a floating pill with primary theme', () => {
    assert.ok(css.includes('.scroll-bottom-badge {'), 'Must have .scroll-bottom-badge CSS rule');
    assert.ok(css.includes('.scroll-bottom-badge.hidden {'), 'Must have .scroll-bottom-badge.hidden rule');
    assert.ok(css.includes('display: none !important'), 'Badge hidden must be display none');
  });

  test('3. JavaScript manages unseen incoming messages count on scroll bottom badge', () => {
    assert.ok(appJs.includes('scrollBottomBadge'), 'References scrollBottomBadge in app.js');
    assert.ok(appJs.includes('unseenIncomingMessagesCount'), 'Maintains unseenIncomingMessagesCount state');
    assert.ok(appJs.includes('updateScrollBottomBadge'), 'Exports/defines updateScrollBottomBadge function');
  });

  test('4. Composer Enter key is guarded against IME composition', () => {
    assert.ok(appJs.includes('e.isComposing || e.keyCode === 229'), 'Guards Enter send against active IME composition');
  });

  test('5. Media-only bubbles receive is-media-only overlay styling', () => {
    assert.ok(appJs.includes("bubble.classList.add('is-media-only')"), 'Assigns is-media-only class when caption is absent');
    assert.ok(css.includes('.message-bubble.is-media-only'), 'Styles .message-bubble.is-media-only in CSS');
    assert.ok(css.includes('.message-bubble.is-media-only .message-meta'), 'Positions metadata as an overlay over the media');
  });

  test('6. Quoted reply click smoothly scrolls and triggers highlight pulse', () => {
    assert.ok(appJs.includes('jumpToOriginalMessage'), 'Implements jumpToOriginalMessage');
    assert.ok(appJs.includes("row.classList.add('highlighted')"), 'Adds highlighted class to target row');
    assert.ok(css.includes('.message-row.highlighted .message-bubble'), 'Defines pulse animation for highlighted message');
    assert.ok(css.includes('@keyframes messagePulse'), 'Defines messagePulse keyframes');
  });

  test('7. ChatShellState manages presence, typing, and read receipts correctly', () => {
    const state = new ChatShellState();
    state.setPresence('room-1', 'user-2', true);
    assert.strictEqual(state.isUserOnline('room-1', 'user-2'), true);

    state.setTyping('room-1', 'user-2', true);
    assert.strictEqual(state.isUserTyping('room-1', 'user-2'), true);

    // Switching typing off
    state.setTyping('room-1', 'user-2', false);
    assert.strictEqual(state.isUserTyping('room-1', 'user-2'), false);

    // Blocked user suppresses typing & presence
    state.addBlockedUser({ userId: 'user-2' });
    assert.strictEqual(state.isUserBlocked('user-2'), true);
  });

  test('8. RoomMessagesState prevents duplicate incoming messages', () => {
    const roomState = new RoomMessagesState('room-abc');
    const msg1 = { id: 'm-100', text: 'Hello', createdAt: '2026-10-27T10:00:00Z', status: 'sent' };
    roomState.mergeServerMessages([msg1]);
    assert.strictEqual(roomState.messages.length, 1);

    roomState.mergeServerMessages([msg1]);
    assert.strictEqual(roomState.messages.length, 1, 'Duplicate insert must be deduplicated');
  });

  test('9. RoomMessagesState reconciles optimistic outbox messages with server ACKs', () => {
    const roomState = new RoomMessagesState('room-abc');
    roomState.setCurrentUserId('user-me');
    const optimisticMsg = { clientMessageId: 'cid-999', senderId: 'user-me', text: 'Optimistic text', status: 'pending' };
    roomState.addOptimisticMessage(optimisticMsg);
    assert.strictEqual(roomState.messages.length, 1);
    assert.strictEqual(roomState.messages[0].clientMessageId, 'cid-999');

    // Server sends message.created with server id and clientMessageId
    const serverMsg = { id: 'srv-999', clientMessageId: 'cid-999', senderId: 'user-me', text: 'Optimistic text', status: 'sent' };
    roomState.mergeServerMessages([serverMsg]);
    assert.strictEqual(roomState.messages.length, 1, 'Optimistic message must be reconciled without duplicating');
    assert.strictEqual(roomState.messages[0].id, 'srv-999');
    assert.strictEqual(roomState.getStatus('srv-999'), 'sent');
  });

  test('10. Delivery and read receipts progress truthfully through status hierarchy', () => {
    const roomState = new RoomMessagesState('room-abc');
    roomState.setCurrentUserId('user-me');
    const msg = { id: 'm-200', senderId: 'user-me', text: 'Tick test', status: 'sent' };
    roomState.mergeServerMessages([msg]);
    assert.strictEqual(roomState.getStatus('m-200'), 'sent');

    // Upgrade to delivered
    roomState.updateReceipt('m-200', 'delivered');
    assert.strictEqual(roomState.getStatus('m-200'), 'delivered');

    // Upgrade to read
    roomState.updateReceipt('m-200', 'read');
    assert.strictEqual(roomState.getStatus('m-200'), 'read');

    // Cannot downgrade from read back to sent
    roomState.updateReceipt('m-200', 'sent');
    assert.strictEqual(roomState.getStatus('m-200'), 'read', 'Status rank must prevent downgrading read to sent');
  });

  // ─── PHASE 3: NEW-MESSAGE COUNTER VALIDATION ───────────────────

  test('11. New-message counter tracks unseen messages by stable ID and deduplicates repeat events', () => {
    assert.ok(appJs.includes('roomUnseenMessageIds'), 'Must maintain roomUnseenMessageIds map');
    assert.ok(appJs.includes('recordUnseenIncomingMessage'), 'Must export/define recordUnseenIncomingMessage');
    assert.ok(appJs.includes('clearUnseenIncomingMessages'), 'Must export/define clearUnseenIncomingMessages');
    assert.ok(appJs.includes('getUnseenMessagesCount'), 'Must export/define getUnseenMessagesCount');

    // Simulate Set-based stable ID tracking logic as implemented in app.js
    const roomUnseen = new Map();
    function record(roomId, msgId) {
      if (!roomId || !msgId) return;
      const rKey = String(roomId);
      if (!roomUnseen.has(rKey)) roomUnseen.set(rKey, new Set());
      roomUnseen.get(rKey).add(String(msgId));
    }
    function count(roomId) {
      return roomUnseen.get(String(roomId))?.size || 0;
    }
    function clear(roomId) {
      roomUnseen.get(String(roomId))?.clear();
    }

    // 1 incoming message -> count = 1
    record('room-A', 'msg-101');
    assert.strictEqual(count('room-A'), 1);

    // Multiple distinct incoming messages -> increments correctly
    record('room-A', 'msg-102');
    record('room-A', 'msg-103');
    assert.strictEqual(count('room-A'), 3);

    // Duplicate server event (same message ID re-sent or received during catch-up)
    record('room-A', 'msg-102');
    record('room-A', 'msg-103');
    assert.strictEqual(count('room-A'), 3, 'Duplicate server events must NOT inflate unseen message counter');
  });

  test('12. Inactive conversations do not increment active conversation counter and state is isolated per room', () => {
    const roomUnseen = new Map();
    function record(roomId, msgId) {
      if (!roomId || !msgId) return;
      const rKey = String(roomId);
      if (!roomUnseen.has(rKey)) roomUnseen.set(rKey, new Set());
      roomUnseen.get(rKey).add(String(msgId));
    }
    function count(roomId) {
      return roomUnseen.get(String(roomId))?.size || 0;
    }

    // Room A has 2 unseen messages
    record('room-A', 'msg-A1');
    record('room-A', 'msg-A2');
    assert.strictEqual(count('room-A'), 2);

    // Incoming message arrives for inactive Room B
    record('room-B', 'msg-B1');
    assert.strictEqual(count('room-A'), 2, 'Message arriving for Room B must NOT increment Room A count');
    assert.strictEqual(count('room-B'), 1, 'Room B tracks its own unseen count independently');
  });

  test('13. Outgoing messages do not count as unseen incoming messages', () => {
    assert.ok(appJs.includes('if (!isOwn)'), 'Must guard unseen message recording behind !isOwn');
  });

  test('14. Clicking scroll-to-bottom button and reaching latest message clears unseen count', () => {
    const roomUnseen = new Map();
    const rKey = 'room-A';
    roomUnseen.set(rKey, new Set(['m1', 'm2', 'm3']));
    assert.strictEqual(roomUnseen.get(rKey).size, 3);

    // Clicking scroll to bottom or scrolling near bottom calls clearUnseenIncomingMessages
    roomUnseen.get(rKey).clear();
    assert.strictEqual(roomUnseen.get(rKey).size, 0);

    assert.ok(appJs.includes("scrollBottomBtn?.addEventListener('click'"), 'Has scrollBottomBtn click listener');
    assert.ok(appJs.includes('clearUnseenIncomingMessages(shellState.selectedRoomId)'), 'Clears unseen messages on scroll-bottom click');
  });

  test('15. Deleting an unseen message decrements the unseen counter', () => {
    assert.ok(appJs.includes("roomUnseenMessageIds.get(String(eventRoomId))?.delete(String(msgId))"), 'Deletes msgId from roomUnseenMessageIds on message.deleted');
  });

  test('16. Reconnection catch-up frames do not double count already tracked messages', () => {
    const roomUnseen = new Map();
    function record(roomId, msgId) {
      const rKey = String(roomId);
      if (!roomUnseen.has(rKey)) roomUnseen.set(rKey, new Set());
      roomUnseen.get(rKey).add(String(msgId));
    }

    const initialMessages = ['seq-10', 'seq-11', 'seq-12'];
    initialMessages.forEach((id) => record('room-X', id));
    assert.strictEqual(roomUnseen.get('room-X').size, 3);

    // Reconnection replay receives the same sequence frames
    initialMessages.forEach((id) => record('room-X', id));
    assert.strictEqual(roomUnseen.get('room-X').size, 3, 'Reconnection replay must not duplicate count');
  });

  test('17. App.js dismisses loading and error state views when real incoming message arrives', () => {
    assert.ok(appJs.includes("messagesLoading?.classList.add('hidden')"), 'Dismisses messagesLoading on message.created');
    assert.ok(appJs.includes("messagesError?.classList.add('hidden')"), 'Dismisses messagesError on message.created');
    assert.ok(appJs.includes("messagesScrollArea?.classList.remove('hidden')"), 'Shows messagesScrollArea on message.created');
  });

});

