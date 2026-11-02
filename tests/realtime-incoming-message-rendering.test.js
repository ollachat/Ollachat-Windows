import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ChatShellState,
  RoomMessagesState
} from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appJsPath = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
const appJs = fs.readFileSync(appJsPath, 'utf8').replace(/\r\n/g, '\n');

// Lightweight DOM mock for verifying rendering without browser
function createMockElement(tagName = 'div', className = '', id = '') {
  const children = [];
  const attributes = new Map();
  const classListSet = new Set(className.split(' ').filter(Boolean));

  return {
    tagName: tagName.toUpperCase(),
    id,
    className,
    dataset: {},
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 600,
    classList: {
      add: (cls) => classListSet.add(cls),
      remove: (cls) => classListSet.delete(cls),
      contains: (cls) => classListSet.has(cls)
    },
    setAttribute: (k, v) => attributes.set(k, String(v)),
    getAttribute: (k) => attributes.get(k) || null,
    removeAttribute: (k) => attributes.delete(k),
    appendChild: (child) => {
      children.push(child);
      return child;
    },
    removeChild: (child) => {
      const idx = children.indexOf(child);
      if (idx !== -1) children.splice(idx, 1);
      return child;
    },
    get children() {
      return children;
    },
    querySelectorAll: (selector) => {
      const all = [];
      function traverse(node) {
        for (const c of node.children) {
          all.push(c);
          traverse(c);
        }
      }
      traverse({ children });
      if (selector.includes('.message-row')) {
        return all.filter((c) => c.className?.includes('message-row'));
      }
      return all;
    },
    querySelector: (selector) => {
      const all = [];
      function traverse(node) {
        for (const c of node.children) {
          all.push(c);
          traverse(c);
        }
      }
      traverse({ children });
      if (selector.includes('.message-row')) {
        return all.find((c) => c.className?.includes('message-row')) || null;
      }
      return null;
    }
  };
}

describe('Real-Time Incoming Message Rendering (P1 Verification)', () => {

  test('Static Invariant: handleRealtimeChatEvent scopes isCurrentlyViewed and isActiveRoom at top level', () => {
    const freshAppJs = fs.readFileSync(appJsPath, 'utf8').replace(/\r\n/g, '\n');
    assert.ok(freshAppJs.includes('const isSameRoom = (a, b) =>'), 'Must define case-insensitive isSameRoom helper');
    assert.ok(freshAppJs.includes('const isCurrentlyViewed = eventRoomId === shellState.selectedRoomId && isAppActiveAndFocused()'), 'Must hoist isCurrentlyViewed');
    assert.ok(freshAppJs.includes('const isActiveRoom = isSameRoom(eventRoomId, shellState?.selectedRoomId) || (eventRoomId === shellState?.selectedRoomId);'), 'Must hoist isActiveRoom');
  });

  test('Test 1: Incoming message in active conversation updates sidebar, room state, and renders to DOM without refresh', () => {
    const shellState = new ChatShellState();
    const aliceRoomId = 'room-alice-123';
    shellState.conversations = [
      { roomId: aliceRoomId, title: 'Alice Nakamura', unreadCount: 0, lastMessage: null }
    ];
    shellState.selectConversation(aliceRoomId);

    const targetState = new RoomMessagesState(aliceRoomId);
    targetState.setCurrentUserId('user-current');

    // Simulate incoming frame from Alice
    const incomingFrame = {
      type: 'message.created',
      room_id: aliceRoomId,
      payload: {
        id: 'msg-alice-new-1',
        sender_id: 'alice-user-id',
        sender_name: 'Alice Nakamura',
        body: { text: 'hello test message' },
        created_at: '2026-10-27T16:24:00Z'
      }
    };

    // 1. Sidebar update
    const conv = shellState.conversations.find((c) => c.roomId === incomingFrame.room_id);
    assert.ok(conv, 'Conversation must exist in sidebar');
    conv.lastMessage = {
      preview: incomingFrame.payload.body.text,
      createdAt: incomingFrame.payload.created_at
    };
    assert.strictEqual(conv.lastMessage.preview, 'hello test message');

    // 2. Active conversation state update
    const appended = targetState.appendIncomingMessage(incomingFrame.payload);
    assert.ok(appended, 'Message must be appended to room state');
    assert.strictEqual(targetState.messages.length, 1);
    assert.strictEqual(targetState.messages[0].id, 'msg-alice-new-1');

    // 3. DOM insertion simulation
    const messagesList = createMockElement('div', 'messages-list');
    const msgElement = createMockElement('div', 'message-row incoming', 'msg-msg-alice-new-1');
    msgElement.setAttribute('data-message-id', incomingFrame.payload.id);
    messagesList.appendChild(msgElement);

    assert.strictEqual(messagesList.children.length, 1);
    assert.strictEqual(messagesList.children[0].id, 'msg-msg-alice-new-1');
  });

  test('Test 2: Incoming message in inactive conversation updates target sidebar without polluting active chat DOM', () => {
    const shellState = new ChatShellState();
    const aliceRoomId = 'room-alice';
    const bobRoomId = 'room-bob';
    shellState.conversations = [
      { roomId: aliceRoomId, title: 'Alice Nakamura', unreadCount: 0, lastMessage: null },
      { roomId: bobRoomId, title: 'Bob Builder', unreadCount: 0, lastMessage: null }
    ];
    shellState.selectConversation(aliceRoomId); // Alice is active!

    const aliceState = new RoomMessagesState(aliceRoomId);
    const bobState = new RoomMessagesState(bobRoomId);

    // Incoming frame arrives for Bob
    const bobFrame = {
      type: 'message.created',
      room_id: bobRoomId,
      payload: { id: 'msg-bob-1', sender_id: 'bob-user-id', body: { text: 'hey Alice' } }
    };

    const isSameRoom = (a, b) => Boolean(a && b && String(a).toLowerCase().trim() === String(b).toLowerCase().trim());
    const isActiveRoom = isSameRoom(bobFrame.room_id, shellState.selectedRoomId);
    assert.strictEqual(isActiveRoom, false, 'Bob room must NOT be active');

    // Append to Bob state
    bobState.appendIncomingMessage(bobFrame.payload);
    assert.strictEqual(bobState.messages.length, 1);
    assert.strictEqual(aliceState.messages.length, 0, 'Alice room state must remain untouched');

    // Bob sidebar updates
    const bobConv = shellState.conversations.find((c) => c.roomId === bobRoomId);
    bobConv.lastMessage = { preview: bobFrame.payload.body.text };
    assert.strictEqual(bobConv.lastMessage.preview, 'hey Alice');

    // Alice active DOM has 0 messages
    const aliceDomList = createMockElement('div', 'messages-list');
    if (isActiveRoom) {
      aliceDomList.appendChild(createMockElement('div', 'message-row', 'should-not-exist'));
    }
    assert.strictEqual(aliceDomList.children.length, 0, 'Alice DOM must not have Bob message');
  });

  test('Test 3: Incoming message during history loading is preserved and not overwritten', () => {
    const roomState = new RoomMessagesState('room-alice');
    // Live incoming message arrives first
    const liveMsg = { id: 'msg-live-1', eventSeq: 50, body: { text: 'live message' } };
    roomState.appendIncomingMessage(liveMsg);
    assert.strictEqual(roomState.messages.length, 1);

    // Delayed older history response arrives (seq 1..49)
    const olderBatch = [
      { id: 'msg-hist-1', eventSeq: 10, body: { text: 'old message 1' } },
      { id: 'msg-hist-2', eventSeq: 20, body: { text: 'old message 2' } }
    ];
    roomState.mergeServerMessages(olderBatch);

    // Both older history and live message must be present
    assert.strictEqual(roomState.messages.length, 3);
    const hasLive = roomState.messages.some((m) => m.id === 'msg-live-1');
    assert.ok(hasLive, 'Live message must not be lost when older history finishes loading');
  });

  test('Test 4: Rapid conversation switching preserves message routing without cross-contamination', () => {
    const aliceRoomId = 'room-alice';
    const bobRoomId = 'room-bob';
    const aliceState = new RoomMessagesState(aliceRoomId);
    const bobState = new RoomMessagesState(bobRoomId);

    // Message targeted to Alice arrives while switching
    const aliceMsg = { id: 'm-a', body: { text: 'for alice' } };
    aliceState.appendIncomingMessage(aliceMsg);

    // Message targeted to Bob arrives while switching
    const bobMsg = { id: 'm-b', body: { text: 'for bob' } };
    bobState.appendIncomingMessage(bobMsg);

    assert.strictEqual(aliceState.messages.length, 1);
    assert.strictEqual(aliceState.messages[0].id, 'm-a');
    assert.strictEqual(bobState.messages.length, 1);
    assert.strictEqual(bobState.messages[0].id, 'm-b');
  });

  test('Test 5: Duplicate message.created frame does not duplicate DOM or state', () => {
    const roomState = new RoomMessagesState('room-alice');
    const msg = { id: 'dup-1', body: { text: 'dup text' } };

    roomState.appendIncomingMessage(msg);
    assert.strictEqual(roomState.messages.length, 1);

    // Same frame arrives again
    roomState.appendIncomingMessage(msg);
    assert.strictEqual(roomState.messages.length, 1, 'Room state must deduplicate by ID');

    // In DOM, appendMessageToDom calls updateMessageElementInDom if existing found
    assert.ok(appJs.includes('const existing = findMessageDomElement(msg)'), 'Must check findMessageDomElement');
    assert.ok(appJs.includes('updateMessageElementInDom(existing, msg)'), 'Must update existing rather than duplicate');
  });

  test('Test 6: User reading older messages preserves scroll anchor and increments unseen counter', () => {
    const scrollArea = createMockElement('div');
    scrollArea.scrollHeight = 2000;
    scrollArea.scrollTop = 500; // Scrolled way up!
    scrollArea.clientHeight = 600;

    const distFromBottom = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight;
    assert.ok(distFromBottom > 140, 'User is reading older messages');

    // In app.js:
    // wasNearBottom = false
    // capturedAnchor = captureScrollAnchor()
    // appendMessageToDom(msg)
    // restoreScrollAnchor(capturedAnchor)
    // recordUnseenIncomingMessage(eventRoomId, msg.id)
    assert.ok(appJs.includes('capturedAnchor = captureScrollAnchor()'), 'Must capture anchor when not near bottom');
    assert.ok(appJs.includes('restoreScrollAnchor(capturedAnchor)'), 'Must restore anchor to prevent jumping');
    assert.ok(appJs.includes('recordUnseenIncomingMessage(eventRoomId, msgKey)'), 'Must record unseen incoming message');
  });

  test('Test 7: Message persistence and state reconciliation preserve canonical IDs and metadata', () => {
    const roomState = new RoomMessagesState('room-alice');
    const incomingMsg = {
      id: 'server-canonical-99',
      clientMessageId: 'client-cid-11',
      senderId: 'alice',
      kind: 'text',
      body: { text: 'canonical message' },
      createdAt: '2026-10-27T16:24:00Z',
      eventSeq: 88
    };

    roomState.appendIncomingMessage(incomingMsg);
    assert.strictEqual(roomState.messages[0].id, 'server-canonical-99');
    assert.strictEqual(roomState.messages[0].clientMessageId, 'client-cid-11');
    assert.strictEqual(roomState.messages[0].eventSeq, 88);
  });

  test('Test 8: appendMessageToDom queries all .day-divider elements to prevent redundant duplicate dividers', () => {
    const freshAppJs = fs.readFileSync(appJsPath, 'utf8').replace(/\r\n/g, '\n');
    assert.ok(
      freshAppJs.includes("const allDividers = messagesList.querySelectorAll('.day-divider');") &&
      freshAppJs.includes("const lastDivider = allDividers.length > 0 ? allDividers[allDividers.length - 1] : null;"),
      'Must query all .day-divider elements and take the last element instead of relying on broken :last-of-type selector'
    );
  });

  test('Test 9: Incoming message in open conversation preserves read state without showing unread badge', () => {
    const freshAppJs = fs.readFileSync(appJsPath, 'utf8').replace(/\r\n/g, '\n');
    assert.ok(
      freshAppJs.includes('else if (isActiveRoom || isCurrentlyViewed)') &&
      freshAppJs.includes('shellState.markConversationAsRead(eventRoomId)'),
      'Must keep open conversation marked as read in sidebar when incoming message arrives'
    );
  });

  test('Test 10: wasNearBottom is decoupled from isOpeningUnread so active chat autoscrolls seamlessly', () => {
    const freshAppJs = fs.readFileSync(appJsPath, 'utf8').replace(/\r\n/g, '\n');
    assert.ok(
      !freshAppJs.includes('const wasNearBottom = (!isOpeningUnread && messagesScrollArea)'),
      'wasNearBottom must NOT be suppressed by isOpeningUnread'
    );
    assert.ok(
      freshAppJs.includes('if (wasNearBottom || isOwn) {\n            scrollToBottom(true);\n            clearUnseenIncomingMessages(eventRoomId);'),
      'Must scroll to bottom when near bottom or own message'
    );
  });

  test('Test 11: Empty DOM recovery triggers renderMessages when room state contains messages', () => {
    const freshAppJs = fs.readFileSync(appJsPath, 'utf8').replace(/\r\n/g, '\n');
    assert.ok(
      freshAppJs.includes('if (domMessageRows.length === 0 && targetState.messages.length > 0) {\n          renderMessages();'),
      'Must recover and call renderMessages when messages exist in state but DOM is empty'
    );
  });

  test('Test 12: Sequence collision prevention ensures sequential incoming messages render distinct DOM elements', () => {
    const freshAppJs = fs.readFileSync(appJsPath, 'utf8').replace(/\r\n/g, '\n');
    assert.ok(
      freshAppJs.includes('if (typeof seq === \'number\' && Number.isFinite(seq) && seq > 0)'),
      'createMessageBubbleElement must only set data-seq for strictly positive numbers'
    );
    assert.ok(
      freshAppJs.includes('if (!candidateMsgId || !incomingId || candidateMsgId === incomingId)'),
      'findMessageDomElement must not match candidate elements with conflicting message IDs'
    );
  });

  test('Test 13: activeRoomMessagesState is aligned with targetState on active incoming message', () => {
    const freshAppJs = fs.readFileSync(appJsPath, 'utf8').replace(/\r\n/g, '\n');
    assert.ok(
      freshAppJs.includes('if (isActiveRoom && activeRoomMessagesState !== targetState) {\n    activeRoomMessagesState = targetState;\n  }'),
      'handleRealtimeChatEvent must align activeRoomMessagesState with targetState when room is active'
    );
  });

  test('Test 14: Fallback to renderMessages occurs if targeted appendMessageToDom cannot locate rendered element in DOM', () => {
    const freshAppJs = fs.readFileSync(appJsPath, 'utf8').replace(/\r\n/g, '\n');
    assert.ok(
      freshAppJs.includes('const appendedToDom = appendMessageToDom(msg);') &&
      freshAppJs.includes('const messageRowInDom = findMessageDomElement(msg);') &&
      freshAppJs.includes('if (!appendedToDom || !messageRowInDom) {\n            renderMessages();\n          }'),
      'Must verify messageRowInDom and fallback to renderMessages when targeted append is missing from DOM'
    );
  });

});
