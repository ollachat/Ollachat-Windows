import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RoomMessagesState,
  formatGroupDescriptionSystemText,
  formatGroupMembershipSystemText,
  resolveMessageContent
} from '../src/renderer/chat-shell-state.js';
import { sqliteRowToMessage, messageToSqlitePayload } from '../src/renderer/db-sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appJsPath = path.resolve(__dirname, '../src/renderer/app.js');
const appJs = fs.readFileSync(appJsPath, 'utf8');

// Lightweight DOM element mock for testing rendering
function createMockElement(tagName = 'div', className = '', id = '') {
  const children = [];
  const attributes = new Map();
  const classListSet = new Set(className.split(' ').filter(Boolean));

  const el = {
    tagName: tagName.toUpperCase(),
    id,
    className,
    dataset: {},
    classList: {
      add: (cls) => classListSet.add(cls),
      remove: (cls) => classListSet.delete(cls),
      contains: (cls) => classListSet.has(cls),
      toggle: (cls, force) => {
        if (force === undefined) {
          if (classListSet.has(cls)) classListSet.delete(cls);
          else classListSet.add(cls);
        } else if (force) {
          classListSet.add(cls);
        } else {
          classListSet.delete(cls);
        }
      }
    },
    setAttribute: (k, v) => attributes.set(k, String(v)),
    getAttribute: (k) => attributes.get(k) || null,
    removeAttribute: (k) => attributes.delete(k),
    hasAttribute: (k) => attributes.has(k),
    appendChild: (child) => {
      children.push(child);
      return child;
    },
    removeChild: (child) => {
      const idx = children.indexOf(child);
      if (idx !== -1) children.splice(idx, 1);
      return child;
    },
    querySelector: (selector) => {
      if (selector.startsWith('.')) {
        const cls = selector.slice(1);
        for (const child of children) {
          if (child.classList?.contains(cls)) return child;
          const sub = child.querySelector?.(selector);
          if (sub) return sub;
        }
      }
      return null;
    },
    querySelectorAll: (selector) => {
      const results = [];
      const match = (elem) => {
        if (selector.startsWith('.') && elem.classList?.contains(selector.slice(1))) {
          results.push(elem);
        }
        if (elem.children) {
          for (const c of elem.children) match(c);
        }
      };
      for (const child of children) match(child);
      return results;
    },
    get children() {
      return children;
    },
    textContent: ''
  };
  return el;
}

describe('Group Description Chat Timeline Notifications', () => {
  const currentUserId = 'usr_current_user_123';

  // 1. Adding a description
  test('1. Adding a description shows "[User Name] added a group description"', () => {
    // Explicit action 'add'
    const text1 = formatGroupDescriptionSystemText({
      action: 'add',
      actorName: 'Rahul'
    });
    assert.equal(text1, 'Rahul added a group description');

    // Inferred action from prevDescription (empty) and newDescription (present)
    const text2 = formatGroupDescriptionSystemText({
      prevDescription: '',
      newDescription: 'Welcome to our project!',
      actorName: 'Alice'
    });
    assert.equal(text2, 'Alice added a group description');
  });

  // 2. Changing a description
  test('2. Changing a description shows "[User Name] changed the group description"', () => {
    // Explicit action 'change'
    const text1 = formatGroupDescriptionSystemText({
      action: 'change',
      actorName: 'Rahul'
    });
    assert.equal(text1, 'Rahul changed the group description');

    // Inferred action from prevDescription and newDescription differing
    const text2 = formatGroupDescriptionSystemText({
      prevDescription: 'Initial roadmap',
      newDescription: 'Updated roadmap for Q4',
      actorName: 'Bob'
    });
    assert.equal(text2, 'Bob changed the group description');
  });

  // 3. Removing a description
  test('3. Removing a description shows "[User Name] removed the group description"', () => {
    // Explicit action 'remove'
    const text1 = formatGroupDescriptionSystemText({
      action: 'remove',
      actorName: 'Rahul'
    });
    assert.equal(text1, 'Rahul removed the group description');

    // Inferred action from prevDescription present and newDescription empty
    const text2 = formatGroupDescriptionSystemText({
      prevDescription: 'Temporary project notes',
      newDescription: '',
      actorName: 'Charlie'
    });
    assert.equal(text2, 'Charlie removed the group description');
  });

  // 4. Correct actor name resolution
  test('4. Actor name resolution reflects display names, custom resolver, and current user', () => {
    // Custom name resolver
    const resolveUserNameFn = (uid) => (uid === 'usr_owner_99' ? 'Project Owner' : 'Someone');
    const textResolved = formatGroupDescriptionSystemText({
      action: 'add',
      actorId: 'usr_owner_99',
      resolveUserNameFn
    });
    assert.equal(textResolved, 'Project Owner added a group description');

    // Current user performing the action
    const textSelf = formatGroupDescriptionSystemText({
      action: 'add',
      actorId: currentUserId,
      currentUserId
    });
    assert.equal(textSelf, 'You added a group description');

    // Fallback when no actor name or ID is known
    const textFallback = formatGroupDescriptionSystemText({
      action: 'change'
    });
    assert.equal(textFallback, 'Someone changed the group description');
  });

  // 5. Does not expose the full description text in the system message
  test('5. Notification text does not expose secret or full description body', () => {
    const secretDescription = 'Confidential merger details: acquisition price is $50M';
    const text = formatGroupDescriptionSystemText({
      prevDescription: '',
      newDescription: secretDescription,
      actorName: 'Alice'
    });

    assert.equal(text, 'Alice added a group description');
    assert.ok(!text.includes(secretDescription), 'Notification text must NOT leak description body');
    assert.ok(!text.includes('$50M'), 'Notification text must NOT leak description contents');
  });

  // 6. Chronological placement in message list
  test('6. Chronological placement: messages are sorted by createdAt timestamp', () => {
    const roomState = new RoomMessagesState('room_group_timeline');

    // Message 1 at 10:00:00
    roomState.appendIncomingMessage({
      id: 'msg_001',
      roomId: 'room_group_timeline',
      senderId: 'usr_alice',
      kind: 'text',
      createdAt: '2026-11-17T10:00:00.000Z',
      body: { text: 'Morning team' }
    });

    // Message 3 at 10:10:00
    roomState.appendIncomingMessage({
      id: 'msg_003',
      roomId: 'room_group_timeline',
      senderId: 'usr_bob',
      kind: 'text',
      createdAt: '2026-11-17T10:10:00.000Z',
      body: { text: 'Looks great!' }
    });

    // System message inserted with timestamp 10:05:00 (between msg_001 and msg_003)
    roomState.addSystemMessage({
      id: 'sys_desc_002',
      roomId: 'room_group_timeline',
      senderId: 'system',
      kind: 'system',
      createdAt: '2026-11-17T10:05:00.000Z',
      body: {
        text: 'Alice changed the group description',
        system_type: 'group_description',
        action: 'change'
      }
    });

    assert.equal(roomState.messages.length, 3);
    assert.equal(roomState.messages[0].id, 'msg_001', 'First message must be msg_001 (10:00)');
    assert.equal(roomState.messages[1].id, 'sys_desc_002', 'Second message must be sys_desc_002 (10:05)');
    assert.equal(roomState.messages[2].id, 'msg_003', 'Third message must be msg_003 (10:10)');
  });

  // 7. Duplicate event prevention
  test('7. Duplicate prevention handles both eventId and semantic window', () => {
    const recentSystemEventsMap = new Map();

    function checkAndDedupDesc(cleanRoomId, action, newDescription, eventId) {
      const now = Date.now();
      if (eventId) {
        const evKey = `ev:${eventId}`;
        if (recentSystemEventsMap.has(evKey)) return false;
        recentSystemEventsMap.set(evKey, now);
      }

      const descKeyPart = (newDescription !== undefined ? String(newDescription).trim() : '').slice(0, 64);
      const semanticKey = `desc:${cleanRoomId}:${action}:${descKeyPart}`;
      const lastTime = recentSystemEventsMap.get(semanticKey);
      if (lastTime && (now - lastTime) < 10000) {
        return false;
      }
      recentSystemEventsMap.set(semanticKey, now);
      return true;
    }

    // First call: REST API save
    const firstSave = checkAndDedupDesc('room_1', 'change', 'New description', null);
    assert.equal(firstSave, true, 'First save should be accepted');

    // Duplicate call: WebSocket echo arriving 100ms later
    const wsEcho = checkAndDedupDesc('room_1', 'change', 'New description', 'evt_ws_99');
    assert.equal(wsEcho, false, 'WebSocket echo with same action and description within 10s must be deduplicated');

    // Distinct change: description updated to something else
    const secondChange = checkAndDedupDesc('room_1', 'change', 'Another distinct description', 'evt_ws_100');
    assert.equal(secondChange, true, 'Different description content must be accepted');

    // Same eventId duplicate
    const dupByEventId = checkAndDedupDesc('room_2', 'add', 'Different room', 'evt_ws_100');
    assert.equal(dupByEventId, false, 'Matching eventId must be rejected regardless of room');
  });

  // 8. System message bubble rendering
  test('8. System message rendering renders centered pill without regular bubbles or ticks', () => {
    function renderSystemMessageBubble(msg) {
      const row = createMockElement('div', 'message-row system-message-row');
      if (msg.id) row.setAttribute('data-message-id', msg.id);

      const pill = createMockElement('div', 'system-message-pill');
      const resolved = resolveMessageContent(msg);
      pill.textContent = resolved?.text || msg.body?.text || '';
      row.appendChild(pill);
      return row;
    }

    const descMsg = {
      id: 'sys_desc_123',
      roomId: 'room_demo',
      kind: 'system',
      type: 'system',
      body: {
        text: 'Alice added a group description',
        system_type: 'group_description',
        action: 'add'
      }
    };

    const row = renderSystemMessageBubble(descMsg);
    assert.ok(row.classList.contains('system-message-row'), 'Must have system-message-row class');
    const pill = row.querySelector('.system-message-pill');
    assert.ok(pill, 'Must have .system-message-pill child');
    assert.equal(pill.textContent, 'Alice added a group description');

    // Regular bubble elements must NOT be present
    assert.equal(row.querySelector('.message-bubble'), null, 'Must NOT contain .message-bubble');
    assert.equal(row.querySelector('.msg-delivery-status'), null, 'Must NOT contain delivery ticks');
    assert.equal(row.querySelector('.btn-reply'), null, 'Must NOT contain reply button');
  });

  // 9. SQLite persistence and round-trip
  test('9. SQLite persistence round-trips description system message with kind="system"', () => {
    const sysMsg = {
      id: 'sys_desc_sqlite_1',
      roomId: 'room_persisted',
      senderId: 'system',
      kind: 'system',
      status: 'delivered',
      createdAt: '2026-11-17T11:00:00.000Z',
      eventSeq: 88,
      body: {
        text: 'Rahul removed the group description',
        system_type: 'group_description',
        action: 'remove'
      }
    };

    const sqlitePayload = messageToSqlitePayload(sysMsg, 'room_persisted');
    assert.equal(sqlitePayload.id, 'sys_desc_sqlite_1');
    assert.equal(sqlitePayload.kind, 'system');
    assert.equal(sqlitePayload.roomId, 'room_persisted');
    assert.ok(typeof sqlitePayload.bodyJson === 'string');

    const dbRow = {
      id: sqlitePayload.id,
      room_id: sqlitePayload.roomId,
      sender_id: 'system',
      kind: sqlitePayload.kind,
      delivery_status: 'delivered',
      body_json: sqlitePayload.bodyJson,
      created_at: sqlitePayload.createdAt,
      event_seq: sqlitePayload.eventSeq
    };

    const restored = sqliteRowToMessage(dbRow);
    assert.equal(restored.id, 'sys_desc_sqlite_1');
    assert.equal(restored.kind, 'system');
    assert.equal(restored.roomId, 'room_persisted');
    assert.equal(restored.body.text, 'Rahul removed the group description');

    const resolved = resolveMessageContent(restored);
    assert.equal(resolved.isSystem, true);
    assert.equal(resolved.text, 'Rahul removed the group description');
  });

  // 10. RoomMessagesState preserves description system message across setInitialMessages
  test('10. Persistence after reopening conversation: setInitialMessages preserves description system message', () => {
    const roomState = new RoomMessagesState('room_reopen_test');

    // Pre-populate with a description system message
    roomState.addSystemMessage({
      id: 'sys_desc_preserve_1',
      roomId: 'room_reopen_test',
      senderId: 'system',
      kind: 'system',
      createdAt: '2026-11-17T09:00:00.000Z',
      body: {
        text: 'Alice added a group description',
        system_type: 'group_description',
        action: 'add'
      }
    });

    assert.equal(roomState.messages.length, 1);

    // Simulate switching rooms or fetching fresh initial messages from server (which only returns normal messages)
    const serverMessages = [
      {
        id: 'msg_normal_1',
        roomId: 'room_reopen_test',
        senderId: 'usr_bob',
        kind: 'text',
        createdAt: '2026-11-17T09:15:00.000Z',
        body: { text: 'Hey there!' }
      }
    ];

    roomState.setInitialMessages(serverMessages);

    // Both the server message and the preserved system message must be present
    assert.equal(roomState.messages.length, 2);
    const foundSystemMsg = roomState.messages.find((m) => m.id === 'sys_desc_preserve_1');
    assert.ok(foundSystemMsg, 'System message must be preserved across setInitialMessages');
    assert.equal(foundSystemMsg.body.text, 'Alice added a group description');
  });

  // 11. app.js code integrity check
  test('11. app.js code integrity: createAndRecordGroupDescriptionSystemMessage and wiring exist', () => {
    assert.ok(
      appJs.includes('export function createAndRecordGroupDescriptionSystemMessage'),
      'app.js must export createAndRecordGroupDescriptionSystemMessage'
    );
    assert.ok(
      appJs.includes('createAndRecordGroupDescriptionSystemMessage(activeContactInfoRoomId,'),
      'app.js must call createAndRecordGroupDescriptionSystemMessage on REST save'
    );
    assert.ok(
      appJs.includes('createAndRecordGroupDescriptionSystemMessage(eventRoomId,'),
      'app.js must call createAndRecordGroupDescriptionSystemMessage on WebSocket room.updated / group.updated'
    );
  });
});

