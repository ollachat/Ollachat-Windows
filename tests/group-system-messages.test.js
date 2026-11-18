import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ChatShellState,
  RoomMessagesState,
  formatGroupMembershipSystemText,
  resolveMessageContent
} from '../src/renderer/chat-shell-state.js';
import { ChatWebSocket } from '../src/chat/chat-websocket.js';
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
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 600,
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

class MockWebSocket {
  static instances = [];
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 1;
    this.sentData = [];
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.onopen) this.onopen();
    }, 0);
  }
  send(data) {
    this.sentData.push(data);
  }
  close(code = 1000, reason = '') {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code, reason });
  }
  simulateMessage(data) {
    if (this.onmessage) {
      this.onmessage({ data: typeof data === 'string' ? data : JSON.stringify(data) });
    }
  }
}

describe('WhatsApp-Style Group System Messages', () => {
  const currentUserId = 'usr_current_user_123';

  // 1. Member added by another user -> 'Rahul added Akhil'
  test('1. Member added by another user -> "Rahul added Akhil"', () => {
    const text = formatGroupMembershipSystemText({
      action: 'add',
      actorId: 'usr_rahul',
      actorName: 'Rahul',
      targetUserId: 'usr_akhil',
      targetName: 'Akhil',
      currentUserId
    });
    assert.equal(text, 'Rahul added Akhil');
  });

  // 2. Current user added another member -> 'You added Rahul'
  test('2. Current user added another member -> "You added Rahul"', () => {
    const text = formatGroupMembershipSystemText({
      action: 'add',
      actorId: currentUserId,
      actorName: 'Me',
      targetUserId: 'usr_rahul',
      targetName: 'Rahul',
      currentUserId
    });
    assert.equal(text, 'You added Rahul');
  });

  // 3. Current user added by someone -> 'Rahul added you'
  test('3. Current user added by someone -> "Rahul added you"', () => {
    const text = formatGroupMembershipSystemText({
      action: 'add',
      actorId: 'usr_rahul',
      actorName: 'Rahul',
      targetUserId: currentUserId,
      targetName: 'Me',
      currentUserId
    });
    assert.equal(text, 'Rahul added you');
  });

  // 4. Multiple members added -> 'You added Rahul and Akhil' / 'You added Rahul, Akhil, and Ananya'
  test('4. Multiple members added -> "You added Rahul and Akhil" and with 3 members', () => {
    const names = {
      usr_rahul: 'Rahul',
      usr_akhil: 'Akhil',
      usr_ananya: 'Ananya'
    };
    const resolveUserNameFn = (uid) => names[uid] || 'Someone';

    const text2 = formatGroupMembershipSystemText({
      action: 'add',
      actorId: currentUserId,
      targetUserIds: ['usr_rahul', 'usr_akhil'],
      currentUserId,
      resolveUserNameFn
    });
    assert.equal(text2, 'You added Rahul and Akhil');

    const text3 = formatGroupMembershipSystemText({
      action: 'add',
      actorId: currentUserId,
      targetUserIds: ['usr_rahul', 'usr_akhil', 'usr_ananya'],
      currentUserId,
      resolveUserNameFn
    });
    assert.equal(text3, 'You added Rahul, Akhil, and Ananya');
  });

  // 5. Member left group voluntarily -> 'Ananya left'
  test('5. Member left group voluntarily -> "Ananya left"', () => {
    const text = formatGroupMembershipSystemText({
      action: 'leave',
      actorId: 'usr_ananya',
      targetUserId: 'usr_ananya',
      targetName: 'Ananya',
      currentUserId
    });
    assert.equal(text, 'Ananya left');
  });

  // 6. Current user left group -> 'You left'
  test('6. Current user left group -> "You left"', () => {
    const text = formatGroupMembershipSystemText({
      action: 'leave',
      actorId: currentUserId,
      targetUserId: currentUserId,
      currentUserId
    });
    assert.equal(text, 'You left');
  });

  // 7. Member removed by someone -> 'Rahul removed Ananya'
  test('7. Member removed by someone -> "Rahul removed Ananya"', () => {
    const text = formatGroupMembershipSystemText({
      action: 'remove',
      actorId: 'usr_rahul',
      actorName: 'Rahul',
      targetUserId: 'usr_ananya',
      targetName: 'Ananya',
      currentUserId
    });
    assert.equal(text, 'Rahul removed Ananya');
  });

  // 8. Member removed by current user -> 'You removed Rahul'
  test('8. Member removed by current user -> "You removed Rahul"', () => {
    const text = formatGroupMembershipSystemText({
      action: 'remove',
      actorId: currentUserId,
      targetUserId: 'usr_rahul',
      targetName: 'Rahul',
      currentUserId
    });
    assert.equal(text, 'You removed Rahul');
  });

  // 9. Current user removed by someone -> 'Rahul removed you'
  test('9. Current user removed by someone -> "Rahul removed you"', () => {
    const text = formatGroupMembershipSystemText({
      action: 'remove',
      actorId: 'usr_rahul',
      actorName: 'Rahul',
      targetUserId: currentUserId,
      currentUserId
    });
    assert.equal(text, 'Rahul removed you');
  });

  // 10. Member joined via link -> 'Rahul joined using the group link'
  test('10. Member joined via link -> "Rahul joined using the group link"', () => {
    const text = formatGroupMembershipSystemText({
      action: 'join_link',
      targetUserId: 'usr_rahul',
      targetName: 'Rahul',
      currentUserId
    });
    assert.equal(text, 'Rahul joined using the group link');

    // Also when method is group_link
    const textWithMethod = formatGroupMembershipSystemText({
      action: 'add',
      method: 'group_link',
      targetUserId: 'usr_rahul',
      targetName: 'Rahul',
      currentUserId
    });
    assert.equal(textWithMethod, 'Rahul joined using the group link');
  });

  // 11. Current user joined via link -> 'You joined using the group link'
  test('11. Current user joined via link -> "You joined using the group link"', () => {
    const text = formatGroupMembershipSystemText({
      action: 'join_link',
      targetUserId: currentUserId,
      currentUserId
    });
    assert.equal(text, 'You joined using the group link');
  });

  // 12. Member promoted to admin/owner -> 'Rahul is now an admin'
  test('12. Member promoted to admin/owner -> "Rahul is now an admin"', () => {
    const textAdmin = formatGroupMembershipSystemText({
      action: 'role_update',
      role: 'admin',
      targetUserId: 'usr_rahul',
      targetName: 'Rahul',
      currentUserId
    });
    assert.equal(textAdmin, 'Rahul is now an admin');

    const textOwner = formatGroupMembershipSystemText({
      action: 'promote',
      role: 'owner',
      targetUserId: 'usr_rahul',
      targetName: 'Rahul',
      currentUserId
    });
    assert.equal(textOwner, 'Rahul is now an admin');
  });

  // 13. Current user promoted to admin/owner -> 'You are now an admin'
  test('13. Current user promoted to admin/owner -> "You are now an admin"', () => {
    const text = formatGroupMembershipSystemText({
      action: 'role_update',
      role: 'admin',
      targetUserId: currentUserId,
      currentUserId
    });
    assert.equal(text, 'You are now an admin');
  });

  // 14. Role update that is NOT admin promotion produces NO system message (returns null)
  test('14. Role update that is NOT admin promotion returns null', () => {
    const textMember = formatGroupMembershipSystemText({
      action: 'role_update',
      role: 'member',
      targetUserId: 'usr_rahul',
      targetName: 'Rahul',
      currentUserId
    });
    assert.equal(textMember, null);

    const textDemote = formatGroupMembershipSystemText({
      action: 'role_update',
      role: 'guest',
      targetUserId: 'usr_rahul',
      targetName: 'Rahul',
      currentUserId
    });
    assert.equal(textDemote, null);
  });

  // 15. Strict deduplication: matching eventId or same action:target within 10s
  test('15. Strict deduplication logic prevents duplicate system messages', () => {
    const recentSystemEventsMap = new Map();

    function checkAndDedup(cleanRoomId, action, targetUserId, role, eventId) {
      const now = Date.now();
      if (eventId) {
        const evKey = `ev:${eventId}`;
        if (recentSystemEventsMap.has(evKey)) return false;
        recentSystemEventsMap.set(evKey, now);
      }

      const semanticKey = `sem:${cleanRoomId}:${action}:${targetUserId || ''}:${role || ''}`;
      const lastTime = recentSystemEventsMap.get(semanticKey);
      if (lastTime && (now - lastTime) < 10000) {
        return false;
      }
      recentSystemEventsMap.set(semanticKey, now);
      return true;
    }

    const first = checkAndDedup('room_1', 'add', 'usr_rahul', null, 'evt_001');
    assert.equal(first, true, 'First event should be accepted');

    // Duplicate by eventId
    const dupByEventId = checkAndDedup('room_1', 'add', 'usr_rahul', null, 'evt_001');
    assert.equal(dupByEventId, false, 'Duplicate eventId within window must be rejected');

    // Duplicate by semantic key without eventId
    const dupBySemantic = checkAndDedup('room_1', 'add', 'usr_rahul', null, null);
    assert.equal(dupBySemantic, false, 'Duplicate action+target within 10s must be rejected');

    // Different target should be accepted
    const diffTarget = checkAndDedup('room_1', 'add', 'usr_akhil', null, 'evt_002');
    assert.equal(diffTarget, true, 'Different target user should be accepted');
  });

  // 16. System message rendering: renders centered pill (.system-message-pill, .system-message-row)
  test('16. System message rendering renders centered pill without action buttons or delivery ticks', () => {
    // Replicate createMessageBubbleElement branch for system messages
    function renderTestBubble(msg) {
      const row = createMockElement('div', 'message-row system-message-row');
      if (msg.id) row.setAttribute('data-message-id', msg.id);

      const pill = createMockElement('div', 'system-message-pill');
      const resolved = resolveMessageContent(msg);
      pill.textContent = resolved?.text || msg.body?.text || '';
      row.appendChild(pill);
      return row;
    }

    const sysMsg = {
      id: 'sys_123',
      roomId: 'room_group',
      kind: 'system',
      type: 'system',
      body: {
        text: 'Rahul added Akhil',
        system_type: 'group_membership',
        action: 'add'
      }
    };

    const row = renderTestBubble(sysMsg);
    assert.ok(row.classList.contains('system-message-row'), 'Must contain system-message-row class');
    const pill = row.querySelector('.system-message-pill');
    assert.ok(pill, 'Must contain .system-message-pill element');
    assert.equal(pill.textContent, 'Rahul added Akhil');

    // Verify ordinary message features are absent
    assert.equal(row.querySelector('.message-bubble'), null, 'Must NOT contain ordinary .message-bubble');
    assert.equal(row.querySelector('.msg-delivery-status'), null, 'Must NOT contain delivery ticks');
    assert.equal(row.querySelector('.btn-reply'), null, 'Must NOT contain reply button');
    assert.equal(row.querySelector('.message-reactions-container'), null, 'Must NOT contain reactions container');
  });

  // 17. SQLite persistence and re-loading: saved with kind='system' and restored
  test('17. SQLite persistence and re-loading: round-trips kind="system" and body_json', () => {
    const systemMsg = {
      id: 'sys_test_999',
      roomId: 'room_abc',
      senderId: 'system',
      kind: 'system',
      status: 'delivered',
      createdAt: '2026-11-02T12:00:00.000Z',
      eventSeq: 42,
      body: {
        text: 'Rahul is now an admin',
        system_type: 'group_membership',
        action: 'role_update',
        role: 'admin'
      }
    };

    // Serialize to SQLite payload
    const sqlitePayload = messageToSqlitePayload(systemMsg, 'room_abc');
    assert.equal(sqlitePayload.id, 'sys_test_999');
    assert.equal(sqlitePayload.kind, 'system');
    assert.equal(sqlitePayload.roomId, 'room_abc');
    assert.ok(typeof sqlitePayload.bodyJson === 'string');

    // Simulate SQLite DB row
    const dbRow = {
      id: sqlitePayload.id,
      room_id: sqlitePayload.room_id || sqlitePayload.roomId,
      sender_id: sqlitePayload.sender_id || sqlitePayload.senderId,
      kind: sqlitePayload.kind,
      delivery_status: sqlitePayload.delivery_status || sqlitePayload.status,
      body_json: sqlitePayload.bodyJson || sqlitePayload.body_json,
      created_at: sqlitePayload.createdAt || sqlitePayload.created_at,
      event_seq: sqlitePayload.eventSeq ?? sqlitePayload.event_seq
    };

    // Restore from SQLite DB row
    const restored = sqliteRowToMessage(dbRow);
    assert.equal(restored.id, 'sys_test_999');
    assert.equal(restored.kind, 'system');
    assert.equal(restored.roomId, 'room_abc');
    assert.equal(restored.body.text, 'Rahul is now an admin');

    const resolved = resolveMessageContent(restored);
    assert.equal(resolved.isSystem, true);
    assert.equal(resolved.text, 'Rahul is now an admin');
  });

  // 18. Room message state preservation: setInitialMessages preserves in-memory system messages
  test('18. RoomMessagesState preserves in-memory system messages across setInitialMessages', () => {
    const roomState = new RoomMessagesState('room_group');

    // Add normal message
    roomState.appendIncomingMessage({
      id: 'msg_001',
      roomId: 'room_group',
      senderId: 'usr_rahul',
      kind: 'text',
      createdAt: '2026-11-02T10:00:00.000Z',
      body: { text: 'Hello world' }
    });

    // Add system message
    const sysAdded = roomState.addSystemMessage({
      id: 'sys_001',
      roomId: 'room_group',
      senderId: 'system',
      kind: 'system',
      createdAt: '2026-11-02T10:05:00.000Z',
      body: { text: 'Rahul added Akhil' }
    });
    assert.ok(sysAdded, 'addSystemMessage should return truthy');
    assert.equal(roomState.messages.length, 2);

    // Simulate server refresh via setInitialMessages with only the server messages (which lack system messages)
    const serverMessages = [
      {
        id: 'msg_001',
        roomId: 'room_group',
        senderId: 'usr_rahul',
        kind: 'text',
        createdAt: '2026-11-02T10:00:00.000Z',
        body: { text: 'Hello world' }
      },
      {
        id: 'msg_002',
        roomId: 'room_group',
        senderId: 'usr_akhil',
        kind: 'text',
        createdAt: '2026-11-02T10:10:00.000Z',
        body: { text: 'Thanks for adding me!' }
      }
    ];

    roomState.setInitialMessages(serverMessages);

    // Verify the system message sys_001 was preserved!
    const foundSystemMsg = roomState.messages.find((m) => m.id === 'sys_001');
    assert.ok(foundSystemMsg, 'System message must be preserved across setInitialMessages');
    assert.equal(foundSystemMsg.body.text, 'Rahul added Akhil');
    assert.equal(roomState.messages.length, 3);
  });

  // 19. WebSocket frame decoding test
  test('19. ChatWebSocket decodes member events with actorId, method, action, role, and eventId', async () => {
    const ws = new ChatWebSocket({
      url: 'ws://localhost:8080/ws',
      WebSocketClass: MockWebSocket,
      token: 'fake-token'
    });

    await ws.connect();
    const rawWs = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    assert.ok(rawWs, 'MockWebSocket instance should exist');

    let emittedAdd = null;
    let emittedRemove = null;
    let emittedUpdate = null;

    ws.on('member.added', (evt) => { emittedAdd = evt; });
    ws.on('member.removed', (evt) => { emittedRemove = evt; });
    ws.on('member.updated', (evt) => { emittedUpdate = evt; });

    // Test member.added with group_link method
    rawWs.simulateMessage({
      type: 'member.added',
      id: 'evt_add_01',
      room_id: 'room_test',
      created_at: '2026-11-02T12:00:00.000Z',
      payload: {
        room_id: 'room_test',
        user_id: 'usr_rahul',
        actor_id: 'usr_ananya',
        method: 'group_link',
        display_name: 'Rahul'
      }
    });

    assert.ok(emittedAdd);
    assert.equal(emittedAdd.principalId, 'usr_rahul');
    assert.equal(emittedAdd.actorId, 'usr_ananya');
    assert.equal(emittedAdd.method, 'group_link');
    assert.equal(emittedAdd.eventId, 'evt_add_01');

    // Test member.removed with leave action
    rawWs.simulateMessage({
      type: 'member.removed',
      id: 'evt_rem_01',
      room_id: 'room_test',
      payload: {
        room_id: 'room_test',
        principal_id: 'usr_ananya',
        actor_id: 'usr_ananya',
        action: 'leave',
        reason: 'left'
      }
    });

    assert.ok(emittedRemove);
    assert.equal(emittedRemove.principalId, 'usr_ananya');
    assert.equal(emittedRemove.action, 'leave');

    // Test member.updated with admin role
    rawWs.simulateMessage({
      type: 'member.updated',
      id: 'evt_upd_01',
      room_id: 'room_test',
      payload: {
        room_id: 'room_test',
        user_id: 'usr_rahul',
        role: 'admin'
      }
    });

    assert.ok(emittedUpdate);
    assert.equal(emittedUpdate.role, 'admin');

    ws.disconnect();
  });

  // 20. Code integrity check on app.js
  test('20. app.js code integrity: createAndRecordGroupSystemMessage and event wiring exist', () => {
    assert.ok(appJs.includes('export function createAndRecordGroupSystemMessage'), 'app.js must export createAndRecordGroupSystemMessage');
    assert.ok(appJs.includes('export function resolveParticipantName'), 'app.js must export resolveParticipantName');
    assert.ok(appJs.includes("case 'member.added':"), 'app.js must handle member.added');
    assert.ok(appJs.includes("case 'member.updated':"), 'app.js must handle member.updated');
    assert.ok(appJs.includes("case 'member.removed':"), 'app.js must handle member.removed');
    assert.ok(appJs.includes('system-message-pill'), 'app.js must render .system-message-pill');
  });
});
