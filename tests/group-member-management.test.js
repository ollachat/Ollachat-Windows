import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ChatApi,
  normalizeGroupMember,
  normalizeParticipant
} from '../src/api/chat-api.js';
import {
  ChatShellState,
  getParticipantCapabilities,
  getGroupCapabilities,
  isParticipantAdmin,
  isParticipantSelf,
  formatBackendGroupError
} from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const htmlPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const appJsPath = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
const preloadJsPath = path.join(__dirname, '..', 'src', 'preload', 'preload.js');
const mainJsPath = path.join(__dirname, '..', 'src', 'main', 'main.js');

const html = fs.readFileSync(htmlPath, 'utf8');
const appJs = fs.readFileSync(appJsPath, 'utf8').replace(/\r\n/g, '\n');
const preloadJs = fs.readFileSync(preloadJsPath, 'utf8');
const mainJs = fs.readFileSync(mainJsPath, 'utf8');

function createMockFetch(status = 200, responseBody = {}) {
  const calls = [];
  const mock = async (url, options = {}) => {
    let parsedBody = null;
    if (options.body) {
      try {
        parsedBody = JSON.parse(options.body);
      } catch {
        parsedBody = options.body;
      }
    }
    calls.push({
      url,
      method: options.method || 'GET',
      headers: options.headers || {},
      body: parsedBody
    });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
      headers: new Map([['content-type', 'application/json']])
    };
  };
  mock.calls = calls;
  return mock;
}

describe('OllaChat Windows — Group Member Management (Phase 4 Full Spec)', () => {

  const MOCK_SESSION_TOKEN = 'du_test_session_token_xyz123';
  const MOCK_ROOM_ID = 'grp_room_42';

  // ═════════════════════════════════════════════════════════════════
  // 1. Directory Plane API Endpoints, Methods, Headers & Payloads
  // ═════════════════════════════════════════════════════════════════
  describe('1. Directory API Contract & Authentication Flow', () => {

    test('getGroupMembers sends GET /directory/conversations/{roomId}/members with Bearer du_ token', async () => {
      const mockFetch = createMockFetch(200, {
        members: [
          { user_id: 'u_alice', role: 'owner', display_name: 'Alice', phone: '+15551111' },
          { user_id: 'u_bob', role: 'member', display_name: 'Bob', phone: '+15552222' }
        ]
      });
      const api = new ChatApi({ baseUrl: 'https://api.ollacore.com/v1', fetchFn: mockFetch });

      const res = await api.getGroupMembers(MOCK_SESSION_TOKEN, MOCK_ROOM_ID);

      assert.equal(mockFetch.calls.length, 1);
      const call = mockFetch.calls[0];
      assert.equal(call.method, 'GET');
      assert.equal(call.url, `https://api.ollacore.com/v1/directory/conversations/${MOCK_ROOM_ID}/members`);
      assert.equal(call.headers.Authorization, `Bearer ${MOCK_SESSION_TOKEN}`);
      assert.equal(res.members.length, 2);
      assert.equal(res.members[0].userId, 'u_alice');
      assert.equal(res.members[0].role, 'owner');
      assert.equal(res.members[1].userId, 'u_bob');
      assert.equal(res.members[1].role, 'member');
    });

    test('addGroupMembers sends POST /directory/conversations/{roomId}/members with member_user_ids array', async () => {
      const mockFetch = createMockFetch(200, { success: true });
      const api = new ChatApi({ baseUrl: 'https://api.ollacore.com/v1', fetchFn: mockFetch });

      await api.addGroupMembers(MOCK_SESSION_TOKEN, MOCK_ROOM_ID, ['u_bob', 'u_charlie']);

      assert.equal(mockFetch.calls.length, 1);
      const call = mockFetch.calls[0];
      assert.equal(call.method, 'POST');
      assert.equal(call.url, `https://api.ollacore.com/v1/directory/conversations/${MOCK_ROOM_ID}/members`);
      assert.equal(call.headers.Authorization, `Bearer ${MOCK_SESSION_TOKEN}`);
      assert.deepEqual(call.body.member_user_ids, ['u_bob', 'u_charlie']);
    });

    test('addGroupMembers supports single user ID parameter', async () => {
      const mockFetch = createMockFetch(200, { success: true });
      const api = new ChatApi({ baseUrl: 'https://api.ollacore.com/v1', fetchFn: mockFetch });

      await api.addGroupMembers(MOCK_SESSION_TOKEN, MOCK_ROOM_ID, 'u_dave');

      assert.equal(mockFetch.calls.length, 1);
      const call = mockFetch.calls[0];
      assert.equal(call.method, 'POST');
      assert.deepEqual(call.body.member_user_ids, ['u_dave']);
      assert.equal(call.body.user_id, 'u_dave');
    });

    test('updateMemberRole sends PUT /directory/conversations/{roomId}/members/{userId} with role=owner', async () => {
      const mockFetch = createMockFetch(200, { success: true });
      const api = new ChatApi({ baseUrl: 'https://api.ollacore.com/v1', fetchFn: mockFetch });

      await api.updateMemberRole(MOCK_SESSION_TOKEN, MOCK_ROOM_ID, 'u_bob', 'owner');

      assert.equal(mockFetch.calls.length, 1);
      const call = mockFetch.calls[0];
      assert.equal(call.method, 'PUT');
      assert.equal(call.url, `https://api.ollacore.com/v1/directory/conversations/${MOCK_ROOM_ID}/members/u_bob`);
      assert.equal(call.headers.Authorization, `Bearer ${MOCK_SESSION_TOKEN}`);
      assert.deepEqual(call.body, { role: 'owner' });
    });

    test('updateMemberRole sends PUT /directory/conversations/{roomId}/members/{userId} with role=member', async () => {
      const mockFetch = createMockFetch(200, { success: true });
      const api = new ChatApi({ baseUrl: 'https://api.ollacore.com/v1', fetchFn: mockFetch });

      await api.updateMemberRole(MOCK_SESSION_TOKEN, MOCK_ROOM_ID, 'u_alice', 'member');

      assert.equal(mockFetch.calls.length, 1);
      const call = mockFetch.calls[0];
      assert.equal(call.method, 'PUT');
      assert.equal(call.url, `https://api.ollacore.com/v1/directory/conversations/${MOCK_ROOM_ID}/members/u_alice`);
      assert.deepEqual(call.body, { role: 'member' });
    });

    test('removeGroupMember sends DELETE /directory/conversations/{roomId}/members/{userId}', async () => {
      const mockFetch = createMockFetch(200, { success: true });
      const api = new ChatApi({ baseUrl: 'https://api.ollacore.com/v1', fetchFn: mockFetch });

      await api.removeGroupMember(MOCK_SESSION_TOKEN, MOCK_ROOM_ID, 'u_bob');

      assert.equal(mockFetch.calls.length, 1);
      const call = mockFetch.calls[0];
      assert.equal(call.method, 'DELETE');
      assert.equal(call.url, `https://api.ollacore.com/v1/directory/conversations/${MOCK_ROOM_ID}/members/u_bob`);
      assert.equal(call.headers.Authorization, `Bearer ${MOCK_SESSION_TOKEN}`);
    });

    test('leaveGroupConversation sends POST /directory/conversations/{roomId}/leave', async () => {
      const mockFetch = createMockFetch(200, { success: true });
      const api = new ChatApi({ baseUrl: 'https://api.ollacore.com/v1', fetchFn: mockFetch });

      await api.leaveGroupConversation(MOCK_SESSION_TOKEN, MOCK_ROOM_ID);

      assert.equal(mockFetch.calls.length, 1);
      const call = mockFetch.calls[0];
      assert.equal(call.method, 'POST');
      assert.equal(call.url, `https://api.ollacore.com/v1/directory/conversations/${MOCK_ROOM_ID}/leave`);
      assert.equal(call.headers.Authorization, `Bearer ${MOCK_SESSION_TOKEN}`);
    });

    test('Directory methods throw 401 unauthorized when session token is missing', async () => {
      const api = new ChatApi();
      await assert.rejects(async () => api.getGroupMembers('', MOCK_ROOM_ID), /Session token required/);
      await assert.rejects(async () => api.addGroupMembers(null, MOCK_ROOM_ID, ['u_1']), /Session token required/);
      await assert.rejects(async () => api.updateMemberRole(undefined, MOCK_ROOM_ID, 'u_1', 'owner'), /Session token required/);
      await assert.rejects(async () => api.removeGroupMember('', MOCK_ROOM_ID, 'u_1'), /Session token required/);
      await assert.rejects(async () => api.leaveGroupConversation(null, MOCK_ROOM_ID), /Session token required/);
    });

    test('updateMemberRole rejects invalid roles with 400 bad_request', async () => {
      const api = new ChatApi();
      await assert.rejects(
        async () => api.updateMemberRole(MOCK_SESSION_TOKEN, MOCK_ROOM_ID, 'u_1', 'superadmin'),
        /Role must be 'owner' or 'member'/
      );
      await assert.rejects(
        async () => api.updateMemberRole(MOCK_SESSION_TOKEN, MOCK_ROOM_ID, 'u_1', ''),
        /Role must be 'owner' or 'member'/
      );
    });

    test('addGroupMembers rejects empty userIds array', async () => {
      const api = new ChatApi();
      await assert.rejects(
        async () => api.addGroupMembers(MOCK_SESSION_TOKEN, MOCK_ROOM_ID, []),
        /At least one user ID is required/
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 2. Member Normalization and Role Resolution
  // ═════════════════════════════════════════════════════════════════
  describe('2. Normalization & Role Verification', () => {

    test('normalizeGroupMember normalizes user_id, principalId, role, display_name, phone', () => {
      const raw = {
        user_id: 'usr_abc_123',
        role: 'owner',
        display_name: 'Alice Cooper',
        phone: '+15551234567',
        avatar_url: 'https://example.com/avatar.jpg'
      };

      const norm = normalizeGroupMember(raw);
      assert.equal(norm.userId, 'usr_abc_123');
      assert.equal(norm.user_id, 'usr_abc_123');
      assert.equal(norm.principalId, 'usr_abc_123');
      assert.equal(norm.principal_id, 'usr_abc_123');
      assert.equal(norm.role, 'owner');
      assert.equal(norm.displayName, 'Alice Cooper');
      assert.equal(norm.display_name, 'Alice Cooper');
      assert.equal(norm.phone, '+15551234567');
      assert.equal(norm.avatarUrl, 'https://example.com/avatar.jpg');
    });

    test('normalizeGroupMember defaults role to member if omitted', () => {
      const norm = normalizeGroupMember({ user_id: 'usr_xyz' });
      assert.equal(norm.role, 'member');
      assert.equal(norm.userId, 'usr_xyz');
    });

    test('normalizeGroupMember handles null or empty safely', () => {
      assert.equal(normalizeGroupMember(null), null);
      assert.equal(normalizeGroupMember(undefined), undefined);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 3. Capabilities, Permissions & Role Transitions
  // ═════════════════════════════════════════════════════════════════
  describe('3. Capabilities & Role Transition Rules', () => {

    test('Owner user can promote regular member to owner', () => {
      const target = { principalId: 'u_bob', role: 'member' };
      const caps = getParticipantCapabilities(target, true, 'u_alice');
      assert.equal(caps.canPromote, true);
      assert.equal(caps.canDemote, false);
      assert.equal(caps.canRemove, true);
      assert.equal(caps.roleLabel, 'Member');
    });

    test('Owner user can demote an owner when multiple owners exist', () => {
      const target = { principalId: 'u_charlie', role: 'owner' };
      const allParticipants = [
        { principalId: 'u_alice', role: 'owner' },
        { principalId: 'u_charlie', role: 'owner' },
        { principalId: 'u_bob', role: 'member' }
      ];
      const caps = getParticipantCapabilities(target, true, 'u_alice', allParticipants);
      assert.equal(caps.canPromote, false);
      assert.equal(caps.canDemote, true, 'Can demote owner when multiple owners exist');
      assert.equal(caps.canRemove, true, 'Can remove non-final owner');
      assert.equal(caps.isFinalOwner, false);
      assert.equal(caps.roleLabel, 'Owner');
    });

    test('Sole owner cannot be demoted or removed (final owner protection)', () => {
      const soleOwner = { principalId: 'u_alice', role: 'owner' };
      const allParticipants = [
        soleOwner,
        { principalId: 'u_bob', role: 'member' }
      ];
      const caps = getParticipantCapabilities(soleOwner, true, 'u_other_admin', allParticipants);
      assert.equal(caps.isFinalOwner, true);
      assert.equal(caps.canDemote, false, 'Final owner must not be demoted');
      assert.equal(caps.canRemove, false, 'Final owner must not be removed');
    });

    test('Current user cannot promote, demote, or remove themselves', () => {
      const selfOwner = { principalId: 'u_alice', role: 'owner' };
      const caps = getParticipantCapabilities(selfOwner, true, 'u_alice', [selfOwner]);
      assert.equal(caps.isSelf, true);
      assert.equal(caps.canPromote, false);
      assert.equal(caps.canDemote, false);
      assert.equal(caps.canRemove, false);
    });

    test('Regular member user sees no management actions on other participants', () => {
      const target = { principalId: 'u_bob', role: 'member' };
      const caps = getParticipantCapabilities(target, false, 'u_charlie');
      assert.equal(caps.canPromote, false);
      assert.equal(caps.canDemote, false);
      assert.equal(caps.canRemove, false);
      assert.equal(caps.canViewContact, true);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 4. Preload & Main IPC Integration
  // ═════════════════════════════════════════════════════════════════
  describe('4. IPC Architecture & Preload Exposure', () => {

    test('preload.js exposes getMembers, addMembers, updateMemberRole, and leaveGroupConversation', () => {
      assert.ok(preloadJs.includes("getMembers: (roomId) => handleApiCall('chat-api:get-members', roomId)"));
      assert.ok(preloadJs.includes("addMembers: (roomId, userIds) => handleApiCall('chat-api:add-members', roomId, userIds)"));
      assert.ok(preloadJs.includes("updateMemberRole: (roomId, userId, role) => handleApiCall('chat-api:set-member-role', roomId, userId, role)"));
      assert.ok(preloadJs.includes("leaveGroupConversation: (roomId) => handleApiCall('chat-api:leave-group', roomId)"));
    });

    test('main.js registers chat-api:get-members using getAuthenticatedSessionToken', () => {
      assert.ok(mainJs.includes("ipcMain.handle('chat-api:get-members', async (_event, roomId) => {"));
      assert.ok(mainJs.includes("await chatApi.getGroupMembers(token, roomId)"));
    });

    test('main.js registers chat-api:add-members using getAuthenticatedSessionToken', () => {
      assert.ok(mainJs.includes("ipcMain.handle('chat-api:add-members', async (_event, roomId, userIds) => {"));
      assert.ok(mainJs.includes("await chatApi.addGroupMembers(token, roomId, userIds)"));
    });

    test('main.js registers chat-api:set-member-role using getAuthenticatedSessionToken', () => {
      assert.ok(mainJs.includes("ipcMain.handle('chat-api:set-member-role', async (_event, roomId, principalId, role) => {"));
      assert.ok(mainJs.includes("await chatApi.updateMemberRole(token, roomId, principalId, role)"));
    });

    test('main.js registers chat-api:remove-member using getAuthenticatedSessionToken', () => {
      assert.ok(mainJs.includes("ipcMain.handle('chat-api:remove-member', async (_event, roomId, principalId) => {"));
      assert.ok(mainJs.includes("await chatApi.removeGroupMember(token, roomId, principalId)"));
    });

    test('main.js registers chat-api:leave-group using getAuthenticatedSessionToken', () => {
      assert.ok(mainJs.includes("ipcMain.handle('chat-api:leave-group', async (_event, roomId) => {"));
      assert.ok(mainJs.includes("await chatApi.leaveGroupConversation(token, roomId)"));
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 5. UI Integration, Confirmation Modals & Error Handling
  // ═════════════════════════════════════════════════════════════════
  describe('5. UI Integration & Usability Safeguards', () => {

    test('index.html contains participant action menu and add people modal elements', () => {
      assert.ok(html.includes('id="participant-action-menu"'));
      assert.ok(html.includes('id="part-menu-make-admin"'));
      assert.ok(html.includes('id="part-menu-make-admin-text"'));
      assert.ok(html.includes('id="part-menu-dismiss-admin"'));
      assert.ok(html.includes('id="part-menu-dismiss-admin-text"'));
      assert.ok(html.includes('id="part-menu-remove"'));
      assert.ok(html.includes('id="group-add-people-modal"'));
      assert.ok(html.includes('id="btn-group-add-people"'));
      assert.ok(html.includes('id="btn-confirm-group-add-people"'));
      assert.ok(html.includes('id="btn-select-matched-contact"'));
    });

    test('app.js supports multi-contact selection and dynamic button counter', () => {
      assert.ok(appJs.includes('selectedAddContactUserIds'));
      assert.ok(appJs.includes('updateAddPeopleConfirmButton'));
      assert.ok(appJs.includes('Add (${count}) to group'));
    });

    test('app.js prompts confirmation before promoting member to owner', () => {
      assert.ok(appJs.includes("openConfirmModal(\n      'Promote to Owner',"));
      assert.ok(appJs.includes("setMemberRole(roomId, mId, 'owner')"));
    });

    test('app.js prompts confirmation before demoting owner to member', () => {
      assert.ok(appJs.includes("openConfirmModal(\n      'Demote to Member',"));
      assert.ok(appJs.includes("setMemberRole(roomId, mId, 'member')"));
    });

    test('app.js prompts confirmation before removing member from group', () => {
      assert.ok(appJs.includes("openConfirmModal(\n      'Remove from group',"));
      assert.ok(appJs.includes('removeMember(roomId, mId)'));
    });

    test('app.js disables confirm button and sets loading state during add submission', () => {
      assert.ok(appJs.includes('setButtonLoading(btnConfirmGroupAddPeople, true)'));
      assert.ok(appJs.includes('setButtonLoading(btnConfirmGroupAddPeople, false)'));
    });

    test('app.js prevents adding self or existing members to group', () => {
      assert.ok(appJs.includes('You are already a member of this group'));
      assert.ok(appJs.includes('This user is already a member of the group'));
    });

    test('app.js refreshes participant list after successful mutations', () => {
      assert.ok(appJs.includes('await refreshContactInfoParticipants(roomId)'));
    });

    test('app.js displays server authorization failure using formatBackendGroupError', () => {
      assert.ok(appJs.includes("formatBackendGroupError('Promote to Owner', err)"));
      assert.ok(appJs.includes("formatBackendGroupError('Demote to Member', err)"));
      assert.ok(appJs.includes("formatBackendGroupError('Remove member', err)"));
      assert.ok(appJs.includes("formatBackendGroupError('Add member', err)"));
    });

    test('app.js allows sole owner to exit group delegating succession to backend leaveGroup API', () => {
      assert.ok(!appJs.includes('You are the only owner of this group. Please promote another member to owner before leaving.'));
      assert.ok(appJs.includes('window.ollacoreDesktop.chatApi.leaveGroup(targetRoomId)'));
    });

    test('ChatShellState setRoomParticipants replaces stale cache when a member is removed', () => {
      const state = new ChatShellState();
      state.setRoomParticipants('r_1', [
        { principalId: 'u_1', role: 'owner' },
        { principalId: 'u_2', role: 'member' }
      ], false);
      assert.equal(state.getRoomParticipants('r_1').size, 2);

      // When u_2 is removed, setRoomParticipants with new list must not retain u_2
      state.setRoomParticipants('r_1', [
        { principalId: 'u_1', role: 'owner' }
      ], false);
      const updated = state.getRoomParticipants('r_1');
      assert.equal(updated.has('u_2'), false, 'Removed member u_2 must be evicted from room participant map');
      assert.equal(updated.has('u_1'), true, 'Remaining member u_1 must still exist');
    });
  });
});
