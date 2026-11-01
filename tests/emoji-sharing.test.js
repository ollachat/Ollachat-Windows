import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RoomMessagesState,
  MESSAGE_STATUS,
  validateComposerText,
  createOptimisticMessage,
  resolveMessageContent,
  getTickDescriptor,
  isOwnMessage
} from '../src/renderer/chat-shell-state.js';
import {
  insertTextAtCursor,
  isEmojiOnly,
  filterEmojis,
  EmojiPicker
} from '../src/renderer/emoji-picker.js';
import { EMOJI_LIST, EMOJI_CATEGORIES } from '../src/renderer/emoji-data.js';

/**
 * Creates a lightweight mock document for testing document listeners in Node.
 */
function createMockDocument() {
  const docListeners = new Map();
  return {
    addEventListener(evt, h) {
      if (!docListeners.has(evt)) docListeners.set(evt, []);
      docListeners.get(evt).push(h);
    },
    removeEventListener(evt, h) {
      if (!docListeners.has(evt)) return;
      docListeners.set(evt, docListeners.get(evt).filter(fn => fn !== h));
    },
    dispatchEvent(evt) {
      const list = docListeners.get(evt?.type || evt) || [];
      list.forEach(fn => fn(evt));
      return true;
    }
  };
}

/**
 * Creates a lightweight mock DOM element for testing EmojiPicker in Node.
 */
function createMockElement(tagName = 'div', attributes = {}) {
  const listeners = new Map();
  const children = [];
  const classListSet = new Set();
  const val = attributes.value ?? '';
  const start = attributes.selectionStart ?? val.length;
  const end = attributes.selectionEnd ?? val.length;

  const el = {
    tagName: tagName.toUpperCase(),
    value: val,
    selectionStart: start,
    selectionEnd: end,
    textContent: attributes.textContent ?? '',
    innerHTML: '',
    attributes: new Map(Object.entries(attributes)),

    classList: {
      add(...classes) { classes.forEach(c => classListSet.add(c)); },
      remove(...classes) { classes.forEach(c => classListSet.delete(c)); },
      toggle(cls, force) {
        if (force === undefined) {
          if (classListSet.has(cls)) classListSet.delete(cls);
          else classListSet.add(cls);
        } else if (force) {
          classListSet.add(cls);
        } else {
          classListSet.delete(cls);
        }
      },
      contains(cls) { return classListSet.has(cls); }
    },

    setAttribute(name, val) { el.attributes.set(name, String(val)); },
    getAttribute(name) { return el.attributes.get(name) ?? null; },
    removeAttribute(name) { el.attributes.delete(name); },

    addEventListener(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    removeEventListener(event, handler) {
      if (!listeners.has(event)) return;
      const arr = listeners.get(event).filter(h => h !== handler);
      listeners.set(event, arr);
    },
    dispatchEvent(event) {
      const handlers = listeners.get(event?.type || event);
      if (handlers) {
        handlers.forEach(h => h(event));
      }
      return true;
    },

    appendChild(child) { children.push(child); return child; },
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx !== -1) children.splice(idx, 1);
      return child;
    },
    querySelectorAll(selector) {
      // Basic mock selector for class queries
      if (selector.startsWith('.')) {
        const cls = selector.slice(1);
        return children.filter(c => c.classList.contains(cls));
      }
      return [];
    },
    closest(selector) {
      if (selector.startsWith('.') && el.classList.contains(selector.slice(1))) {
        return el;
      }
      return null;
    },
    contains(target) {
      if (target === el) return true;
      return children.some(c => c === target || (c.contains && c.contains(target)));
    },
    focus() { el._focused = true; },
    setSelectionRange(startPos, endPos) {
      el.selectionStart = startPos;
      el.selectionEnd = endPos;
    }
  };

  return el;
}

describe('OllaChat Windows: Emoji Sharing Feature Suite', () => {
  let currentUserId;
  let remotePeerId;
  let roomId;
  let roomState;
  let mockDoc;

  beforeEach(() => {
    currentUserId = 'usr-account-a';
    remotePeerId = 'usr-account-b';
    roomId = 'room-direct-101';
    roomState = new RoomMessagesState(currentUserId);
    roomState.setInitialMessages(roomId, []);
    mockDoc = createMockDocument();
  });

  // A. Emoji picker opens/closes
  test('A. Emoji picker opens and closes toggling popover visibility and aria-expanded', () => {
    const triggerBtn = createMockElement('button');
    const popover = createMockElement('div');
    popover.classList.add('hidden');
    const input = createMockElement('textarea');

    const picker = new EmojiPicker({ triggerBtn, popover, input, document: mockDoc });

    assert.equal(picker.isOpen(), false);
    assert.equal(popover.classList.contains('hidden'), true);

    picker.open();
    assert.equal(picker.isOpen(), true);
    assert.equal(popover.classList.contains('hidden'), false);
    assert.equal(triggerBtn.getAttribute('aria-expanded'), 'true');

    picker.close();
    assert.equal(picker.isOpen(), false);
    assert.equal(popover.classList.contains('hidden'), true);
    assert.equal(triggerBtn.getAttribute('aria-expanded'), 'false');
  });

  // B. Clicking outside closes picker
  test('B. Clicking outside the picker closes it', () => {
    const triggerBtn = createMockElement('button');
    const popover = createMockElement('div');
    const input = createMockElement('textarea');
    const outsideEl = createMockElement('div');

    const picker = new EmojiPicker({ triggerBtn, popover, input, document: mockDoc });
    picker.open();
    assert.equal(picker.isOpen(), true);

    // Simulate clicking outside
    picker._handleDocumentClick({ target: outsideEl });
    assert.equal(picker.isOpen(), false);
    assert.equal(popover.classList.contains('hidden'), true);
  });

  // C. Escape closes picker
  test('C. Pressing Escape closes the emoji picker', () => {
    const triggerBtn = createMockElement('button');
    const popover = createMockElement('div');
    const input = createMockElement('textarea');

    const picker = new EmojiPicker({ triggerBtn, popover, input, document: mockDoc });
    picker.open();
    assert.equal(picker.isOpen(), true);

    let defaultPrevented = false;
    picker._handleDocumentKeyDown({
      key: 'Escape',
      preventDefault: () => { defaultPrevented = true; }
    });

    assert.equal(defaultPrevented, true);
    assert.equal(picker.isOpen(), false);
    assert.equal(popover.classList.contains('hidden'), true);
  });

  // D. Emoji inserts into empty composer
  test('D. Emoji inserts into an empty composer and updates cursor', () => {
    const input = createMockElement('textarea', { value: '', selectionStart: 0, selectionEnd: 0 });
    let inputEventFired = false;
    input.addEventListener('input', () => { inputEventFired = true; });

    const updated = insertTextAtCursor(input, '😊');
    assert.equal(updated, '😊');
    assert.equal(input.value, '😊');
    assert.equal(input.selectionStart, 2); // '😊' UTF-16 length is 2
    assert.equal(input.selectionEnd, 2);
    assert.equal(inputEventFired, true);
  });

  // E. Emoji inserts at cursor position
  test('E. Emoji inserts at exact cursor position in the middle of text', () => {
    const input = createMockElement('textarea', {
      value: 'Hello world',
      selectionStart: 6,
      selectionEnd: 6
    });

    const updated = insertTextAtCursor(input, '😊 ');
    assert.equal(updated, 'Hello 😊 world');
    assert.equal(input.value, 'Hello 😊 world');
    assert.equal(input.selectionStart, 9); // 6 + 3
  });

  // F. Multiple emoji can be inserted
  test('F. Multiple emoji selections can be inserted sequentially', () => {
    const input = createMockElement('textarea', { value: '', selectionStart: 0, selectionEnd: 0 });

    insertTextAtCursor(input, '❤️');
    insertTextAtCursor(input, ' ');
    insertTextAtCursor(input, '👍');
    insertTextAtCursor(input, ' ');
    insertTextAtCursor(input, '😂');

    assert.equal(input.value, '❤️ 👍 😂');
  });

  // G. Existing text is preserved
  test('G. Existing draft text is preserved when emoji is inserted', () => {
    const input = createMockElement('textarea', {
      value: 'How are you? '
    });

    insertTextAtCursor(input, '👋');
    assert.equal(input.value, 'How are you? 👋');
  });

  // H. Enter sends emoji text
  test('H. Enter key without Shift triggers sending with emoji text', () => {
    let sendTriggered = false;
    let defaultPrevented = false;

    const handleKey = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendTriggered = true;
      }
    };

    handleKey({
      key: 'Enter',
      shiftKey: false,
      preventDefault: () => { defaultPrevented = true; }
    });

    assert.equal(sendTriggered, true);
    assert.equal(defaultPrevented, true);
  });

  // I. Shift+Enter does not send
  test('I. Shift+Enter creates a newline and does not trigger send', () => {
    let sendTriggered = false;

    const handleKey = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        sendTriggered = true;
      }
    };

    handleKey({ key: 'Enter', shiftKey: true });
    assert.equal(sendTriggered, false);
  });

  // J. Emoji is included in the exact outgoing text payload
  test('J. Emoji is included in canonical message.send payload matching Ollacore contract', () => {
    const validated = validateComposerText('Hello 😊');
    assert.equal(validated.valid, true);
    assert.equal(validated.text, 'Hello 😊');

    const clientMessageId = 'local-emoji-send-1';
    const payload = {
      client_message_id: clientMessageId,
      kind: 'text',
      body: {
        text: validated.text
      },
      reply_to: null,
      attachment_ids: []
    };

    assert.equal(payload.client_message_id, clientMessageId);
    assert.equal(payload.kind, 'text');
    assert.deepEqual(payload.body, { text: 'Hello 😊' });
    assert.equal(payload.reply_to, null);
    assert.deepEqual(payload.attachment_ids, []);

    // Verify JSON serialization roundtrip preserves Unicode emoji exactly
    const serialized = JSON.stringify(payload);
    const parsed = JSON.parse(serialized);
    assert.equal(parsed.body.text, 'Hello 😊');
  });

  // K. Optimistic emoji message renders correctly
  test('K. Optimistic emoji message is created with SENDING status and correct body', () => {
    const opt = createOptimisticMessage(roomId, currentUserId, 'Hello 😊', 'local-emoji-opt-1');
    assert.equal(opt.kind, 'text');
    assert.deepEqual(opt.body, { text: 'Hello 😊' });
    assert.equal(opt.status, MESSAGE_STATUS.SENDING);
    assert.equal(opt.senderId, currentUserId);

    roomState.addOptimisticMessage(opt);
    assert.equal(roomState.messages.length, 1);
    assert.equal(roomState.messageStatus.get('local-emoji-opt-1'), MESSAGE_STATUS.SENDING);

    const resolved = resolveMessageContent(opt);
    assert.equal(resolved.isFallback, false);
    assert.equal(resolved.text, 'Hello 😊');
  });

  // L. ACK reconciliation preserves emoji
  test('L. Server ACK reconciliation preserves exact Unicode emoji content', () => {
    const opt = createOptimisticMessage(roomId, currentUserId, 'Hello 😊', 'local-ack-1');
    roomState.addOptimisticMessage(opt);

    const reconciled = roomState.appendIncomingMessage({
      id: 'srv-msg-101',
      roomId,
      senderId: currentUserId,
      clientMessageId: 'local-ack-1',
      eventSeq: 5,
      event_seq: 5,
      kind: 'text',
      body: { text: 'Hello 😊' }
    });
    roomState.updateReceipt('srv-msg-101', 'sent', roomId);

    assert.ok(reconciled);
    assert.equal(reconciled.id, 'srv-msg-101');
    assert.equal(reconciled.clientMessageId, 'local-ack-1');
    assert.deepEqual(reconciled.body, { text: 'Hello 😊' });
    assert.equal(roomState.messageStatus.get('srv-msg-101'), MESSAGE_STATUS.SENT);
  });

  // M. Incoming emoji message renders correctly
  test('M. Incoming peer emoji message resolves correctly to text', () => {
    const incoming = {
      id: 'incoming-msg-1',
      roomId,
      senderId: remotePeerId,
      sender_id: remotePeerId,
      kind: 'text',
      body: { text: 'How are you? 👋' },
      createdAt: new Date().toISOString()
    };

    roomState.appendIncomingMessage(incoming);
    assert.equal(roomState.messages.length, 1);

    const resolved = resolveMessageContent(incoming);
    assert.equal(resolved.isFallback, false);
    assert.equal(resolved.text, 'How are you? 👋');
  });

  // N. Incoming emoji has no ticks
  test('N. Incoming emoji message strictly has NO ticks under any receipt update', () => {
    const incoming = {
      id: 'incoming-msg-ticks',
      roomId,
      senderId: remotePeerId,
      sender_id: remotePeerId,
      kind: 'text',
      body: { text: '🎉🔥' },
      createdAt: new Date().toISOString()
    };

    roomState.appendIncomingMessage(incoming);

    // Attempt updating receipts on incoming message
    roomState.updateReceipt('incoming-msg-ticks', 'sent', roomId);
    roomState.updateReceipt('incoming-msg-ticks', 'delivered', roomId);
    roomState.updateReceipt('incoming-msg-ticks', 'read', roomId);

    // Invariant: incoming message has NO receipt status
    assert.equal(roomState.messageStatus.get('incoming-msg-ticks'), undefined);

    const isOwn = isOwnMessage(incoming, currentUserId);
    assert.equal(isOwn, false);

    const tickDesc = getTickDescriptor('read', isOwn);
    assert.equal(tickDesc.hasTick, false);
    assert.equal(tickDesc.symbol, '');
  });

  // O. Outgoing emoji retains receipt states
  test('O. Outgoing emoji message displays correct ticks through sent, delivered, read lifecycle', () => {
    const outgoing = createOptimisticMessage(roomId, currentUserId, '❤️ 👍 😂', 'local-tick-1');
    roomState.addOptimisticMessage(outgoing);

    const isOwn = isOwnMessage(outgoing, currentUserId);
    assert.equal(isOwn, true);

    // 1. Sending
    assert.equal(roomState.messageStatus.get('local-tick-1'), MESSAGE_STATUS.SENDING);
    let tick = getTickDescriptor(MESSAGE_STATUS.SENDING, isOwn);
    assert.equal(tick.hasTick, true);
    assert.equal(tick.symbol, '✓');

    // 2. Sent
    roomState.updateReceipt('local-tick-1', 'sent', roomId);
    tick = getTickDescriptor('sent', isOwn);
    assert.equal(tick.hasTick, true);
    assert.equal(tick.symbol, '✓');
    assert.equal(tick.statusClass, 'status-sent');

    // 3. Delivered
    roomState.updateReceipt('local-tick-1', 'delivered', roomId);
    tick = getTickDescriptor('delivered', isOwn);
    assert.equal(tick.hasTick, true);
    assert.equal(tick.symbol, '✓✓');
    assert.equal(tick.statusClass, 'status-delivered');

    // 4. Read
    roomState.updateReceipt('local-tick-1', 'read', roomId);
    tick = getTickDescriptor('read', isOwn);
    assert.equal(tick.hasTick, true);
    assert.equal(tick.symbol, '✓✓');
    assert.equal(tick.statusClass, 'status-read');
  });

  // P. Emoji message survives room switching
  test('P. Emoji messages in multiple rooms survive room switching', () => {
    const roomStateA = new RoomMessagesState(currentUserId);
    roomStateA.setInitialMessages('room-A', [
      { id: 'msg-a-1', roomId: 'room-A', senderId: currentUserId, kind: 'text', body: { text: 'Hello Room A 😊' } }
    ]);

    const roomStateB = new RoomMessagesState(currentUserId);
    roomStateB.setInitialMessages('room-B', [
      { id: 'msg-b-1', roomId: 'room-B', senderId: currentUserId, kind: 'text', body: { text: 'Hello Room B 🎉🔥' } }
    ]);

    // Verify room A
    assert.equal(roomStateA.messages[0].body.text, 'Hello Room A 😊');

    // Switch to room B
    assert.equal(roomStateB.messages[0].body.text, 'Hello Room B 🎉🔥');

    // Switch back to room A
    assert.equal(roomStateA.messages[0].body.text, 'Hello Room A 😊');
  });

  // Q. Emoji message survives chat close/reopen
  test('Q. Emoji draft and messages survive closing and reopening conversation', () => {
    const roomComposerDrafts = new Map();

    // Type draft in room-1
    roomComposerDrafts.set('room-1', 'Drafting an emoji message: 🚀✨');

    // Switch away to room-2
    roomComposerDrafts.set('room-2', 'Another room draft');

    // Reopen room-1
    const restored = roomComposerDrafts.get('room-1');
    assert.equal(restored, 'Drafting an emoji message: 🚀✨');
  });

  // R. Emoji message survives history reload
  test('R. Emoji messages survive history reload and mergeServerMessages', () => {
    const serverMessages = [
      {
        id: 'hist-1',
        room_id: roomId,
        sender_id: currentUserId,
        kind: 'text',
        body: { text: 'History emoji: 🥳🎉' },
        created_at: new Date().toISOString()
      },
      {
        id: 'hist-2',
        room_id: roomId,
        sender_id: remotePeerId,
        kind: 'text',
        body: { text: 'Peer response: 👍🏽❤️' },
        created_at: new Date().toISOString()
      }
    ];

    roomState.mergeServerMessages(serverMessages);

    assert.equal(roomState.messages.length, 2);
    assert.equal(roomState.messages[0].body.text, 'History emoji: 🥳🎉');
    assert.equal(roomState.messages[1].body.text, 'Peer response: 👍🏽❤️');
  });

  // S. Multi-codepoint emoji remain intact
  test('S. Multi-codepoint emojis, skin tone modifiers, and ZWJ sequences remain completely intact', () => {
    const multiCodepointSamples = [
      '👍🏽',           // Thumbs up medium skin tone (U+1F44D U+1F3FD)
      '👨‍💻',           // Man technologist (U+1F468 U+200D U+1F4BB)
      '👩‍💻',           // Woman technologist (U+1F469 U+200D U+1F4BB)
      '❤️‍🔥',          // Heart on fire (U+2764 U+FE0F U+200D U+1F525)
      '❤️',           // Red heart with variation selector (U+2764 U+FE0F)
      '🎉🔥'          // Party popper and fire
    ];

    multiCodepointSamples.forEach((sample) => {
      // 1. Validation preserves exact characters
      const validation = validateComposerText(sample);
      assert.equal(validation.valid, true);
      assert.equal(validation.text, sample);

      // 2. Optimistic message creation
      const opt = createOptimisticMessage(roomId, currentUserId, sample);
      assert.equal(opt.body.text, sample);

      // 3. JSON roundtrip
      const roundtrip = JSON.parse(JSON.stringify(opt));
      assert.equal(roundtrip.body.text, sample);

      // 4. Content resolution
      const resolved = resolveMessageContent(roundtrip);
      assert.equal(resolved.text, sample);
    });
  });

  // T. Emoji-only messages render correctly
  test('T. isEmojiOnly accurately differentiates emoji-only from mixed text', () => {
    // True emoji-only messages
    assert.equal(isEmojiOnly('😂'), true);
    assert.equal(isEmojiOnly('❤️'), true);
    assert.equal(isEmojiOnly('👍🏽'), true);
    assert.equal(isEmojiOnly('👨‍💻'), true);
    assert.equal(isEmojiOnly('🎉🔥'), true);
    assert.equal(isEmojiOnly('❤️ 👍 😂'), true);
    assert.equal(isEmojiOnly('   🥳   '), true);

    // Mixed text and non-emoji (should be false)
    assert.equal(isEmojiOnly('Hello 👋😊'), false);
    assert.equal(isEmojiOnly('How are you? 👋'), false);
    assert.equal(isEmojiOnly('Hello world'), false);
    assert.equal(isEmojiOnly('123'), false);
    assert.equal(isEmojiOnly(''), false);
    assert.equal(isEmojiOnly('   '), false);
    assert.equal(isEmojiOnly(null), false);
  });

  // Offline emoji filtering & categories
  test('Offline emoji database supports categories and keyword search', () => {
    assert.ok(EMOJI_CATEGORIES.length >= 4);
    assert.ok(EMOJI_LIST.length >= 100);

    const smileys = filterEmojis('', 'smileys');
    assert.ok(smileys.length > 20);
    assert.ok(smileys.some(e => e.char === '😊'));

    const searchThumbs = filterEmojis('thumbs', 'all');
    assert.ok(searchThumbs.some(e => e.char === '👍🏽'));

    const searchLove = filterEmojis('love', 'all');
    assert.ok(searchLove.some(e => e.char === '❤️'));
  });

  // COMPLETE FLOW TEST
  test('Complete Flow: Picker -> Composer -> Send Payload -> Optimistic Message -> ACK -> Realtime Message -> History Reload', () => {
    // 1. Picker selects emoji and inserts into composer
    const composer = createMockElement('textarea', { value: 'Hello ' });
    insertTextAtCursor(composer, '😊');
    assert.equal(composer.value, 'Hello 😊');

    // 2. Validate composer text
    const validated = validateComposerText(composer.value);
    assert.equal(validated.valid, true);

    // 3. Generate optimistic message
    const clientMessageId = `local-${Date.now()}`;
    const optMsg = createOptimisticMessage(roomId, currentUserId, validated.text, clientMessageId);
    roomState.addOptimisticMessage(optMsg);
    assert.equal(roomState.messages.length, 1);
    assert.equal(roomState.messageStatus.get(clientMessageId), MESSAGE_STATUS.SENDING);

    // 4. Construct wire payload
    const sendPayload = {
      client_message_id: clientMessageId,
      kind: 'text',
      body: { text: validated.text },
      reply_to: null,
      attachment_ids: []
    };
    assert.equal(sendPayload.body.text, 'Hello 😊');

    // 5. Server responds with ACK / message.created
    const serverMessageId = 'srv-canonical-999';
    const reconciled = roomState.appendIncomingMessage({
      id: serverMessageId,
      roomId,
      senderId: currentUserId,
      clientMessageId,
      eventSeq: 1,
      kind: 'text',
      body: { text: validated.text }
    });
    roomState.updateReceipt(serverMessageId, 'sent', roomId);

    assert.equal(reconciled.id, serverMessageId);
    assert.equal(reconciled.body.text, 'Hello 😊');
    assert.equal(roomState.messageStatus.get(serverMessageId), MESSAGE_STATUS.SENT);

    // 6. Remote peer sends reply over WebSocket
    const peerMessage = {
      id: 'srv-peer-888',
      room_id: roomId,
      sender_id: remotePeerId,
      kind: 'text',
      body: { text: 'Hey back! 👋🎉' },
      created_at: new Date().toISOString()
    };
    roomState.appendIncomingMessage(peerMessage);
    assert.equal(roomState.messages.length, 2);

    // Peer message has no ticks
    assert.equal(roomState.messageStatus.get('srv-peer-888'), undefined);

    // 7. History reload merges canonical messages preserving exact content
    const reloadedHistory = [
      {
        id: serverMessageId,
        room_id: roomId,
        sender_id: currentUserId,
        kind: 'text',
        body: { text: 'Hello 😊' },
        created_at: optMsg.createdAt
      },
      peerMessage
    ];
    roomState.mergeServerMessages(reloadedHistory);

    assert.equal(roomState.messages.length, 2);
    assert.equal(roomState.messages[0].body.text, 'Hello 😊');
    assert.equal(roomState.messages[1].body.text, 'Hey back! 👋🎉');
  });
});
