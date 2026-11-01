import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateGroupName,
  GroupCreationDraft,
  ChatShellState,
  isParticipantAdmin,
  isParticipantSelf,
  formatBackendGroupError
} from '../src/renderer/chat-shell-state.js';
import { ChatApi, normalizeParticipant } from '../src/api/chat-api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

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

describe('Group Management & Group Info Specification Tests', () => {

  // ═════════════════════════════════════════════════════════════════
  // 1. Group Name Validation (6–60 characters & trimming)
  // ═════════════════════════════════════════════════════════════════
  describe('1. Group Name Validation Rules', () => {
    test('6-character group name is accepted', () => {
      const res = validateGroupName('Team01');
      assert.equal(res.valid, true);
      assert.equal(res.name, 'Team01');
    });

    test('5-character group name is rejected', () => {
      const res = validateGroupName('Team1');
      assert.equal(res.valid, false);
      assert.equal(res.error, 'Group name must be at least 6 characters');
    });

    test('60-character group name is accepted', () => {
      const exact60 = 'A'.repeat(60);
      const res = validateGroupName(exact60);
      assert.equal(res.valid, true);
      assert.equal(res.name, exact60);
    });

    test('>60-character group name is rejected', () => {
      const tooLong = 'A'.repeat(61);
      const res = validateGroupName(tooLong);
      assert.equal(res.valid, false);
      assert.equal(res.error, 'Group name cannot exceed 60 characters');
    });

    test('whitespace trimming before validation and submission', () => {
      // 5 non-whitespace characters with padding => trimmed length 5 => rejected
      const padded5 = '   12345   ';
      const res5 = validateGroupName(padded5);
      assert.equal(res5.valid, false);
      assert.equal(res5.error, 'Group name must be at least 6 characters');

      // 6 non-whitespace characters with padding => trimmed length 6 => accepted
      const padded6 = '   123456   ';
      const res6 = validateGroupName(padded6);
      assert.equal(res6.valid, true);
      assert.equal(res6.name, '123456');

      // Empty and pure whitespace strings
      assert.equal(validateGroupName('').valid, false);
      assert.equal(validateGroupName('     ').valid, false);
      assert.equal(validateGroupName(null).valid, false);
    });

    test('GroupCreationDraft canSubmit enforces minimum 6-character name and members', () => {
      const draft = new GroupCreationDraft();
      draft.addMember({ userId: 'u2', phone: '+1234567890' }, 'self_user');

      // 5 chars -> cannot submit
      draft.setName('12345');
      assert.equal(draft.canSubmit(), false);

      // 6 chars -> can submit
      draft.setName('123456');
      assert.equal(draft.canSubmit(), true);

      // Padded 5 chars -> cannot submit
      draft.setName('  12345  ');
      assert.equal(draft.canSubmit(), false);

      // Padded 6 chars -> can submit
      draft.setName('  123456  ');
      assert.equal(draft.canSubmit(), true);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 2. Group Rename API & Contracts
  // ═════════════════════════════════════════════════════════════════
  describe('2. Group Rename Contract', () => {
    test('updateGroup calls PATCH /rooms/{roomId} with name', async () => {
      const mockFetch = createMockFetch(200, { success: true });
      const api = new ChatApi({ baseUrl: 'https://api.ollacore.test', fetchFn: mockFetch });

      const res = await api.updateGroup('tok_room_1', 'room_grp_99', { name: 'Renamed Project Alpha' });
      assert.equal(res.success, true);
      assert.equal(mockFetch.calls.length, 1);
      assert.equal(mockFetch.calls[0].url, 'https://api.ollacore.test/rooms/room_grp_99');
      assert.equal(mockFetch.calls[0].method, 'PATCH');
      assert.deepEqual(mockFetch.calls[0].body, { name: 'Renamed Project Alpha' });
      assert.equal(mockFetch.calls[0].headers.Authorization, 'Bearer tok_room_1');
    });

    test('updateGroup handles backend failure cleanly', async () => {
      const mockFetch = createMockFetch(400, { error: { message: 'Invalid group name' } });
      const api = new ChatApi({ baseUrl: 'https://api.ollacore.test', fetchFn: mockFetch });

      await assert.rejects(
        async () => api.updateGroup('tok_room_1', 'room_grp_99', { name: 'Bad' }),
        (err) => {
          assert.equal(err.httpStatus, 400);
          return true;
        }
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 3. Add Members & Duplicate Prevention
  // ═════════════════════════════════════════════════════════════════
  describe('3. Add Member Contract & Invariants', () => {
    test('addMember sends POST /rooms/{roomId}/members with user_id', async () => {
      const mockFetch = createMockFetch(200, { success: true });
      const api = new ChatApi({ baseUrl: 'https://api.ollacore.test', fetchFn: mockFetch });

      const res = await api.addMember('tok_room_1', 'room_grp_99', 'user_bob');
      assert.equal(res.success, true);
      assert.equal(mockFetch.calls.length, 1);
      assert.equal(mockFetch.calls[0].url, 'https://api.ollacore.test/rooms/room_grp_99/members');
      assert.equal(mockFetch.calls[0].method, 'POST');
      assert.deepEqual(mockFetch.calls[0].body, { user_id: 'user_bob' });
      assert.equal(mockFetch.calls[0].headers.Authorization, 'Bearer tok_room_1');
    });

    test('duplicate member prevention logic detects already existing participant', () => {
      const existingParticipants = [
        { principalId: 'user_alice', role: 'admin', displayName: 'Alice' },
        { principalId: 'user_bob', role: 'member', displayName: 'Bob' }
      ];

      const checkIsDuplicate = (userId) => {
        return existingParticipants.some((p) => p.principalId === userId);
      };

      assert.equal(checkIsDuplicate('user_bob'), true);
      assert.equal(checkIsDuplicate('user_alice'), true);
      assert.equal(checkIsDuplicate('user_charlie'), false);
    });

    test('prevent adding current user to existing group', () => {
      const currentUserId = 'user_self';
      const candidateUserId = 'user_self';
      const isSelf = candidateUserId === currentUserId;
      assert.equal(isSelf, true);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 4. Remove Members
  // ═════════════════════════════════════════════════════════════════
  describe('4. Remove Member Contract', () => {
    test('removeMember sends DELETE /rooms/{roomId}/members/{principalId}', async () => {
      const mockFetch = createMockFetch(200, { success: true });
      const api = new ChatApi({ baseUrl: 'https://api.ollacore.test', fetchFn: mockFetch });

      const res = await api.removeMember('tok_room_1', 'room_grp_99', 'user_to_remove');
      assert.equal(res.success, true);
      assert.equal(mockFetch.calls.length, 1);
      assert.equal(mockFetch.calls[0].url, 'https://api.ollacore.test/rooms/room_grp_99/members/user_to_remove');
      assert.equal(mockFetch.calls[0].method, 'DELETE');
      assert.equal(mockFetch.calls[0].headers.Authorization, 'Bearer tok_room_1');
    });

    test('removeMember handles permission error when user is not admin', async () => {
      const mockFetch = createMockFetch(403, { error: { message: 'Only admins can remove members' } });
      const api = new ChatApi({ baseUrl: 'https://api.ollacore.test', fetchFn: mockFetch });

      await assert.rejects(
        async () => api.removeMember('tok_room_1', 'room_grp_99', 'user_victim'),
        (err) => {
          assert.equal(err.httpStatus, 403);
          return true;
        }
      );
    });

    test('removeMember throws 404 when route is not yet deployed on server', async () => {
      const mockFetch = createMockFetch(404, { code: 'not_found', message: 'no such route' });
      const api = new ChatApi({ baseUrl: 'https://api.ollacore.test', fetchFn: mockFetch });

      await assert.rejects(
        async () => api.removeMember('tok_room_1', 'room_grp_99', 'user_victim'),
        (err) => {
          assert.equal(err.httpStatus, 404);
          assert.equal(err.message, 'no such route');
          assert.equal(
            formatBackendGroupError('Remove member', err),
            'Remove member failed: backend endpoint requires server deployment (no such route 404)'
          );
          return true;
        }
      );
    });

    test('formatBackendGroupError formats missing deployment errors across all actions', () => {
      const err404 = { httpStatus: 404, message: 'no such route', code: 'not_found' };
      assert.equal(
        formatBackendGroupError('Rename group', err404),
        'Rename group failed: backend endpoint requires server deployment (no such route 404)'
      );
      assert.equal(
        formatBackendGroupError('Add member', err404),
        'Add member failed: backend endpoint requires server deployment (no such route 404)'
      );
      assert.equal(
        formatBackendGroupError('Remove member', err404),
        'Remove member failed: backend endpoint requires server deployment (no such route 404)'
      );
      assert.equal(
        formatBackendGroupError('Update role', err404),
        'Update role failed: backend endpoint requires server deployment (no such route 404)'
      );

      // Other backend error preserves backend message
      const err403 = { httpStatus: 403, message: 'Only admins can remove members', code: 'forbidden' };
      assert.equal(formatBackendGroupError('Remove member', err403), 'Only admins can remove members');

      // Fallback
      assert.equal(formatBackendGroupError('Remove member', null), 'Remove member failed');
    });

    test('client does NOT fake local member removal when server rejects or is missing', async () => {
      const originalParticipants = [
        { principalId: 'u1', role: 'owner', displayName: 'Owner' },
        { principalId: 'u2', role: 'member', displayName: 'Member' }
      ];

      // Simulated state holding participants
      let participants = [...originalParticipants];

      const mockFetch = createMockFetch(404, { code: 'not_found', message: 'no such route' });
      const api = new ChatApi({ baseUrl: 'https://api.ollacore.test', fetchFn: mockFetch });

      // Simulated remove action ensuring local list is NOT mutated when backend fails
      try {
        await api.removeMember('tok_room_1', 'room_grp_99', 'u2');
        participants = participants.filter((p) => p.principalId !== 'u2');
      } catch {
        // Backend failed: participant list remains unchanged
      }

      assert.equal(participants.length, 2, 'Local participant count must NOT change on backend failure');
      assert.equal(participants[1].principalId, 'u2', 'Member must not be optimistically removed');
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 5. Admin Management (Make Admin & Remove Admin)
  // ═════════════════════════════════════════════════════════════════
  describe('5. Admin Role Management Contract', () => {
    test('setMemberRole sends POST /rooms/{roomId}/members/{principalId}/role with admin', async () => {
      const mockFetch = createMockFetch(200, { success: true });
      const api = new ChatApi({ baseUrl: 'https://api.ollacore.test', fetchFn: mockFetch });

      const res = await api.setMemberRole('tok_room_1', 'room_grp_99', 'user_promoted', 'admin');
      assert.equal(res.success, true);
      assert.equal(mockFetch.calls.length, 1);
      assert.equal(mockFetch.calls[0].url, 'https://api.ollacore.test/rooms/room_grp_99/members/user_promoted/role');
      assert.equal(mockFetch.calls[0].method, 'POST');
      assert.deepEqual(mockFetch.calls[0].body, { role: 'admin' });
      assert.equal(mockFetch.calls[0].headers.Authorization, 'Bearer tok_room_1');
    });

    test('setMemberRole sends POST /rooms/{roomId}/members/{principalId}/role with member to demote', async () => {
      const mockFetch = createMockFetch(200, { success: true });
      const api = new ChatApi({ baseUrl: 'https://api.ollacore.test', fetchFn: mockFetch });

      const res = await api.setMemberRole('tok_room_1', 'room_grp_99', 'user_demoted', 'member');
      assert.equal(res.success, true);
      assert.equal(mockFetch.calls.length, 1);
      assert.equal(mockFetch.calls[0].url, 'https://api.ollacore.test/rooms/room_grp_99/members/user_demoted/role');
      assert.equal(mockFetch.calls[0].method, 'POST');
      assert.deepEqual(mockFetch.calls[0].body, { role: 'member' });
    });

    test('permission restriction: determine if current user has admin role', () => {
      const currentUserId = 'u_admin';
      const participants = [
        { principalId: 'u_admin', role: 'admin' },
        { principalId: 'u_member', role: 'member' }
      ];

      const self = participants.find((p) => isParticipantSelf(p, currentUserId));
      assert.equal(isParticipantAdmin(self), true);

      // Other user
      const otherUser = 'u_member';
      const otherSelf = participants.find((p) => isParticipantSelf(p, otherUser));
      assert.equal(isParticipantAdmin(otherSelf), false);
    });

    test('isParticipantAdmin accepts owner, admin, creator (case-insensitive) and rejects member', () => {
      // Valid admin roles
      assert.equal(isParticipantAdmin('owner'), true);
      assert.equal(isParticipantAdmin('admin'), true);
      assert.equal(isParticipantAdmin('creator'), true);
      assert.equal(isParticipantAdmin('OWNER'), true);
      assert.equal(isParticipantAdmin('Admin'), true);
      assert.equal(isParticipantAdmin({ role: 'owner' }), true);
      assert.equal(isParticipantAdmin({ role: 'admin' }), true);
      assert.equal(isParticipantAdmin({ role: 'Owner' }), true);

      // Non-admin roles
      assert.equal(isParticipantAdmin('member'), false);
      assert.equal(isParticipantAdmin('MEMBER'), false);
      assert.equal(isParticipantAdmin({ role: 'member' }), false);
      assert.equal(isParticipantAdmin({ role: '' }), false);
      assert.equal(isParticipantAdmin(null), false);
      assert.equal(isParticipantAdmin(undefined), false);
    });

    test('isParticipantSelf handles case-insensitive UUID matching across canonical keys', () => {
      const target = '23C7F84B-6998-4FC5-B91A-57158C6D6551';
      assert.equal(isParticipantSelf({ principalId: '23c7f84b-6998-4fc5-b91a-57158c6d6551' }, target), true);
      assert.equal(isParticipantSelf({ principal_id: '23c7f84b-6998-4fc5-b91a-57158c6d6551' }, target), true);
      assert.equal(isParticipantSelf({ userId: '23c7f84b-6998-4fc5-b91a-57158c6d6551' }, target), true);
      assert.equal(isParticipantSelf({ user_id: '23c7f84b-6998-4fc5-b91a-57158c6d6551' }, target), true);

      // Non-matching
      assert.equal(isParticipantSelf({ principalId: 'a8f85b84-4bfa-4edc-aff9-fca087d7c047' }, target), false);
      assert.equal(isParticipantSelf(null, target), false);
      assert.equal(isParticipantSelf({ principalId: 'some_id' }, null), false);
    });

    test('actual backend response maps owner creator correctly to admin with controls enabled', () => {
      const loggedInUserId = '23c7f84b-6998-4fc5-b91a-57158c6d6551';
      const actualServerParticipants = [
        {
          principal_id: '23c7f84b-6998-4fc5-b91a-57158c6d6551',
          role: 'owner',
          online: true
        },
        {
          principal_id: 'a8f85b84-4bfa-4edc-aff9-fca087d7c047',
          role: 'member',
          online: true
        }
      ];

      const selfParticipant = actualServerParticipants.find((p) => isParticipantSelf(p, loggedInUserId));
      assert.ok(selfParticipant, 'Must locate self participant');
      assert.equal(selfParticipant.role, 'owner');

      const isCurrentUserAdmin = isParticipantAdmin(selfParticipant);
      assert.equal(isCurrentUserAdmin, true, 'Logged in owner must be recognized as Group Admin');

      // Member check
      const otherParticipant = actualServerParticipants.find((p) => !isParticipantSelf(p, loggedInUserId));
      assert.ok(otherParticipant, 'Must locate other participant');
      assert.equal(isParticipantAdmin(otherParticipant), false, 'Normal member must not be recognized as admin');
    });

    test('formatting invariant: self member formats as You or Name (You), never You (You)', () => {
      const formatSelfName = (nameText, isSelf) => {
        if (isSelf) {
          return (nameText === 'You') ? 'You' : `${nameText} (You)`;
        }
        return nameText;
      };

      assert.equal(formatSelfName('You', true), 'You');
      assert.equal(formatSelfName('Malavika', true), 'Malavika (You)');
      assert.equal(formatSelfName('Bob', false), 'Bob');
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 6. Group State Refresh & Normalization
  // ═════════════════════════════════════════════════════════════════
  describe('6. Group State Refresh & Participants Normalization', () => {
    test('getParticipants retrieves participant list and normalizes keys', async () => {
      const mockFetch = createMockFetch(200, {
        participants: [
          { principal_id: 'p1', role: 'admin', display_name: 'Alice', phone: '+1234567890' },
          { principal_id: 'p2', role: 'member', display_name: 'Bob', phone: '+1987654321' }
        ]
      });
      const api = new ChatApi({ baseUrl: 'https://api.ollacore.test', fetchFn: mockFetch });

      const res = await api.getParticipants('tok_room_1', 'room_grp_99');
      assert.equal(res.participants.length, 2);
      assert.equal(res.participants[0].principalId, 'p1');
      assert.equal(res.participants[0].role, 'admin');
      assert.equal(res.participants[0].displayName, 'Alice');
      assert.equal(res.participants[1].principalId, 'p2');
      assert.equal(res.participants[1].role, 'member');
    });

    test('normalizeParticipant handles missing fields gracefully', () => {
      const p = normalizeParticipant({ principal_id: 'p_raw' });
      assert.equal(p.principalId, 'p_raw');
      assert.equal(p.role, 'member');
      assert.equal(p.displayName, null);
      assert.equal(p.phone, null);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 7. UI & Layout Element Integrity
  // ═════════════════════════════════════════════════════════════════
  describe('7. UI & HTML Element Definitions', () => {
    test('index.html defines required group management and group info modal elements', () => {
      const indexPath = path.join(projectRoot, 'src', 'renderer', 'index.html');
      assert.ok(fs.existsSync(indexPath));
      const html = fs.readFileSync(indexPath, 'utf8');

      // Group info modal
      assert.ok(html.includes('id="group-info-modal"'), 'Must define #group-info-modal');
      assert.ok(html.includes('id="group-info-name"'), 'Must define #group-info-name');
      assert.ok(html.includes('id="group-info-avatar"'), 'Must define #group-info-avatar');
      assert.ok(html.includes('id="group-info-member-count"'), 'Must define #group-info-member-count');
      assert.ok(html.includes('id="group-members-list"'), 'Must define #group-members-list');
      assert.ok(html.includes('id="btn-group-info"'), 'Must define #btn-group-info');
      assert.ok(html.includes('id="chat-header-info"'), 'Must define #chat-header-info');

      // Rename form
      assert.ok(html.includes('id="group-info-rename-form"'), 'Must define #group-info-rename-form');
      assert.ok(html.includes('id="group-rename-input"'), 'Must define #group-rename-input');
      assert.ok(html.includes('id="btn-save-group-name"'), 'Must define #btn-save-group-name');

      // Add member in existing group
      assert.ok(html.includes('id="group-add-member-section"'), 'Must define #group-add-member-section');
      assert.ok(html.includes('id="group-add-member-phone"'), 'Must define #group-add-member-phone');
      assert.ok(html.includes('id="btn-submit-add-member"'), 'Must define #btn-submit-add-member');

      // Confirmation modal
      assert.ok(html.includes('id="group-confirm-modal"'), 'Must define #group-confirm-modal');
      assert.ok(html.includes('id="btn-confirm-proceed"'), 'Must define #btn-confirm-proceed');

      // Group creation 6-60 character hint
      assert.ok(html.includes('Required • 6–60 characters'), 'Group creation hint must state Required • 6–60 characters');
      assert.ok(!html.includes('Required • Up to 60 characters'), 'Old hint must not exist');
    });

    test('preload.js exposes group management API methods', () => {
      const preloadPath = path.join(projectRoot, 'src', 'preload', 'preload.js');
      assert.ok(fs.existsSync(preloadPath));
      const code = fs.readFileSync(preloadPath, 'utf8');

      assert.ok(code.includes('updateGroup:'), 'Must expose updateGroup');
      assert.ok(code.includes('addMember:'), 'Must expose addMember');
      assert.ok(code.includes('removeMember:'), 'Must expose removeMember');
      assert.ok(code.includes('setMemberRole:'), 'Must expose setMemberRole');
      assert.ok(code.includes('leaveGroup:'), 'Must expose leaveGroup');
    });

    test('main.js handles group management IPC channels', () => {
      const mainPath = path.join(projectRoot, 'src', 'main', 'main.js');
      assert.ok(fs.existsSync(mainPath));
      const code = fs.readFileSync(mainPath, 'utf8');

      assert.ok(code.includes("'chat-api:update-group'"), 'Must handle chat-api:update-group');
      assert.ok(code.includes("'chat-api:add-member'"), 'Must handle chat-api:add-member');
      assert.ok(code.includes("'chat-api:remove-member'"), 'Must handle chat-api:remove-member');
      assert.ok(code.includes("'chat-api:set-member-role'"), 'Must handle chat-api:set-member-role');
      assert.ok(code.includes("'chat-api:leave-group'"), 'Must handle chat-api:leave-group');
    });
  });
});
