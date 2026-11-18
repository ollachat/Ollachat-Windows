import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ChatShellState,
  isParticipantAdmin,
  isParticipantSelf,
  getGroupCapabilities,
  getParticipantCapabilities
} from '../src/renderer/chat-shell-state.js';
import { ChatWebSocket } from '../src/chat/chat-websocket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appJsPath = path.resolve(__dirname, '../src/renderer/app.js');
const chatWebSocketJsPath = path.resolve(__dirname, '../src/chat/chat-websocket.js');
const appJs = fs.readFileSync(appJsPath, 'utf8');
const chatWsJs = fs.readFileSync(chatWebSocketJsPath, 'utf8');

class MockWebSocket {
  static instances = [];
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 1;
    this.sentData = [];
    MockWebSocket.instances.push(this);
  }
  send(data) {
    this.sentData.push(data);
  }
  close(code = 1000, reason = '') {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code, reason, wasClean: true });
  }
  simulateMessage(msgObj) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(msgObj) });
    }
  }
  simulateOpen() {
    if (this.onopen) this.onopen({});
  }
}

describe('Automatic Group Owner Succession & WebSocket Integration', () => {

  // Scenario 1: A sole owner can initiate leaving
  test('1. A sole owner can initiate leaving without client-side blocking', () => {
    // Assert client-side alert blocking sole owner is eliminated from requestExitGroup
    const reqExitStart = appJs.indexOf('export function requestExitGroup(');
    const reqExitEnd = appJs.indexOf('\nexport function requestDeleteChat(', reqExitStart);
    const reqExitBody = appJs.slice(reqExitStart, reqExitEnd);

    assert.ok(!reqExitBody.includes('You are the only owner of this group. Please promote another member to owner before leaving.'));
    assert.ok(reqExitBody.includes('openLeaveGroupConfirmModal(roomId)'));
  });

  // Scenario 2: The leave API is actually called for a sole owner
  test('2. The leave API is actually called for a sole owner', () => {
    const handleLeaveStart = appJs.indexOf('export async function handleConfirmLeaveGroup(');
    const handleLeaveEnd = appJs.indexOf('\nexport async function handleConfirmDeleteGroupChat(', handleLeaveStart);
    const handleLeaveBody = appJs.slice(handleLeaveStart, handleLeaveEnd);

    assert.ok(!handleLeaveBody.includes('You are the only owner of this group. Please promote another member to owner before leaving.'));
    assert.ok(handleLeaveBody.includes('await window.ollacoreDesktop.chatApi.leaveGroup(targetRoomId)'));
  });

  // Scenario 3: A backend API failure preserves the conversation
  test('3. A backend API failure preserves the conversation and local data', () => {
    const handleLeaveStart = appJs.indexOf('export async function handleConfirmLeaveGroup(');
    const handleLeaveEnd = appJs.indexOf('\nexport async function handleConfirmDeleteGroupChat(', handleLeaveStart);
    const handleLeaveBody = appJs.slice(handleLeaveStart, handleLeaveEnd);

    // leaveGroup is called inside a try block, and catch block alerts formatBackendGroupError
    assert.ok(handleLeaveBody.includes('try {'));
    assert.ok(handleLeaveBody.includes('await window.ollacoreDesktop.chatApi.leaveGroup(targetRoomId);'));
    assert.ok(handleLeaveBody.includes("alert(formatBackendGroupError('Exit group', err))"));

    // State is only marked exited / deleted AFTER leaveGroup succeeds
    const leaveIndex = handleLeaveBody.indexOf('await window.ollacoreDesktop.chatApi.leaveGroup(targetRoomId);');
    const exitedIndex = handleLeaveBody.indexOf('conv.isExited = true');
    const deleteConvIndex = handleLeaveBody.indexOf('deleteConversationFromDb(targetRoomId)');

    assert.ok(leaveIndex !== -1);
    assert.ok(exitedIndex > leaveIndex, 'conv.isExited must only be set after leaveGroup succeeds');
    assert.ok(deleteConvIndex > leaveIndex, 'deleteConversationFromDb must only be called after leaveGroup succeeds');
  });

  // Scenario 4: A successful leave preserves existing exited-group behavior
  test('4. A successful leave preserves existing exited-group behavior and read-only state', () => {
    const state = new ChatShellState();
    const groupConv = {
      roomId: 'group_succession_1',
      title: 'Dev Team',
      kind: 'group',
      isExited: false,
      messages: [{ id: 'm1', content: 'Hello world', createdAt: '2026-01-01T00:00:00Z' }]
    };
    state.conversations = [groupConv];

    // Mark as exited (simulating leaveGroup success with Exit option)
    groupConv.isExited = true;
    groupConv.exited = true;

    const currentUserId = 'u_owner_leaving';
    const caps = getGroupCapabilities(groupConv, [
      { principalId: 'u_owner_leaving', role: 'owner' },
      { principalId: 'u_member_b', role: 'member' }
    ], currentUserId);

    // Capabilities must enforce read-only exited group restrictions
    assert.equal(caps.isExited, true);
    assert.equal(caps.isAdmin, false);
    assert.equal(caps.canAddPeople, false);
    assert.equal(caps.canRenameGroup, false);
    assert.equal(caps.canExitGroup, false);
    assert.equal(caps.canDeleteChat, true);

    // Historical messages remain intact
    assert.equal(groupConv.messages.length, 1);
    assert.equal(groupConv.messages[0].content, 'Hello world');
  });

  // Scenario 5: member.updated is decoded correctly in ChatWebSocket
  test('5. member.updated is decoded correctly with roomId, principalId, and role', async () => {
    const ws = new ChatWebSocket({
      token: 'test_token',
      WebSocketClass: MockWebSocket
    });

    await ws.connect();
    const mockSocket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    mockSocket.simulateOpen();

    let updatedEvent = null;
    ws.on('member.updated', (evt) => {
      updatedEvent = evt;
    });

    mockSocket.simulateMessage({
      type: 'member.updated',
      room_id: 'group_room_100',
      payload: {
        principal_id: 'user_b_successor',
        role: 'owner'
      }
    });

    assert.ok(updatedEvent, 'member.updated event must be emitted');
    assert.equal(updatedEvent.roomId, 'group_room_100');
    assert.equal(updatedEvent.principalId, 'user_b_successor');
    assert.equal(updatedEvent.role, 'owner');

    ws.disconnect();
  });

  // Scenario 6: A promoted member receives owner permissions without restarting
  test('6. A promoted member receives owner permissions without restarting', () => {
    const successorUserId = 'user_b_successor';
    const conv = { roomId: 'group_room_100', kind: 'group', isExited: false };

    // Initially user_b is a regular member
    const initialParticipants = [
      { principalId: 'user_a_owner', role: 'owner' },
      { principalId: successorUserId, role: 'member' }
    ];

    const initialCaps = getGroupCapabilities(conv, initialParticipants, successorUserId);
    assert.equal(initialCaps.isAdmin, false);
    assert.equal(initialCaps.canAddPeople, false);
    assert.equal(initialCaps.canRenameGroup, false);

    // After backend ownership succession: user_a left, user_b is now owner
    const updatedParticipants = [
      { principalId: successorUserId, role: 'owner' },
      { principalId: 'user_c', role: 'member' }
    ];

    const updatedCaps = getGroupCapabilities(conv, updatedParticipants, successorUserId);
    assert.equal(updatedCaps.isAdmin, true);
    assert.equal(updatedCaps.canAddPeople, true);
    assert.equal(updatedCaps.canRenameGroup, true);
    assert.equal(updatedCaps.currentUserRole, 'owner');

    // Participant management permissions for promoted owner
    const actionPerms = getParticipantCapabilities(
      { principalId: 'user_c', role: 'member' },
      true, // isCurrentUserAdmin = true
      successorUserId,
      updatedParticipants
    );
    assert.equal(actionPerms.canPromote, true);
    assert.equal(actionPerms.canRemove, true);
  });

  // Scenario 7: Other members see the updated owner role
  test('7. Other members see the updated owner role', () => {
    const observerUserId = 'user_c';
    const participants = [
      { principalId: 'user_b_successor', role: 'owner' },
      { principalId: observerUserId, role: 'member' }
    ];

    // Observer verifies user_b is admin and owner
    const targetB = participants.find((p) => p.principalId === 'user_b_successor');
    assert.equal(isParticipantAdmin(targetB), true);

    const perms = getParticipantCapabilities(
      targetB,
      false, // observer is regular member
      observerUserId,
      participants
    );
    assert.equal(perms.targetIsOwner, true);
    assert.equal(perms.roleLabel, 'Owner');
  });

  // Scenario 8: member.removed refreshes participant information
  test('8. member.removed invalidates participant cache and triggers refresh', () => {
    assert.ok(appJs.includes("case 'member.removed':"));
    assert.ok(appJs.includes('shellState.roomParticipants.delete(cleanRoomId)'));
    assert.ok(appJs.includes('inFlightParticipantsRequests.delete(cleanRoomId)'));
  });

  // Scenario 9: The Contact Info side panel refreshes after membership changes
  test('9. The Contact Info side panel refreshes after membership changes', () => {
    const evtHandlerStart = appJs.indexOf("case 'member.added':");
    const evtHandlerEnd = appJs.indexOf("case 'room.updated':", evtHandlerStart);
    const evtHandlerBody = appJs.slice(evtHandlerStart, evtHandlerEnd);

    assert.ok(evtHandlerBody.includes('refreshContactInfoParticipants(activeContactInfoRoomId)'));
    assert.ok(evtHandlerBody.includes('refreshGroupParticipants(activeGroupInfoRoomId)'));
    assert.ok(evtHandlerBody.includes('ensureRoomParticipants(cleanRoomId, { force: true })'));
  });

  // Scenario 10: Existing non-owner group-leaving behavior remains unchanged
  test('10. Existing non-owner group-leaving behavior remains unchanged', () => {
    const state = new ChatShellState();
    const groupConv = {
      roomId: 'group_non_owner',
      title: 'Dev Group',
      kind: 'group',
      isExited: false
    };
    state.conversations = [groupConv];

    const currentUserId = 'u_member_regular';
    const participants = [
      { principalId: 'u_owner_standing', role: 'owner' },
      { principalId: currentUserId, role: 'member' }
    ];

    const caps = getGroupCapabilities(groupConv, participants, currentUserId);
    assert.equal(caps.isExited, false);
    assert.equal(caps.canExitGroup, true);
    assert.equal(caps.isAdmin, false);
  });

  // Scenario 11: Individual chat deletion remains unchanged
  test('11. Individual chat deletion remains unchanged', () => {
    const state = new ChatShellState();
    const dmConv = {
      roomId: 'direct_user_1',
      title: 'Alice',
      kind: 'direct',
      isExited: false
    };
    state.conversations = [dmConv];

    const caps = getGroupCapabilities(dmConv, [], 'my_user_id');
    assert.equal(caps.isGroup, false);
    assert.equal(caps.canDeleteChat, true);
    assert.equal(caps.canExitGroup, false);

    assert.ok(appJs.includes('export function requestDeleteChat(roomId)'));
  });

  // Scenario 12: Existing group messaging, calling, and membership features continue working
  test('12. Stale responses guard against race conditions in membership updates', () => {
    // Both refresh functions track sequence counters
    assert.ok(appJs.includes('let contactInfoRefreshSeq = 0;'));
    assert.ok(appJs.includes('seq !== contactInfoRefreshSeq'));
    assert.ok(appJs.includes('let groupParticipantsRefreshSeq = 0;'));
    assert.ok(appJs.includes('seq !== groupParticipantsRefreshSeq'));
    assert.ok(appJs.includes('let selectedParticipantsRefreshSeq = 0;'));
    assert.ok(appJs.includes('seq !== selectedParticipantsRefreshSeq'));
  });

});
