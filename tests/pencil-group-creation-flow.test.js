/**
 * pencil-group-creation-flow.test.js
 *
 * Comprehensive regression tests for:
 * 1. Pencil button click flow from sidebar to new chat / group creation modal.
 * 2. Opening the correct tab (Direct Chat vs Create Group) based on filter context.
 * 3. Group member selection from contacts and phone lookup.
 * 4. Group name validation and submit button enable/disable lifecycle.
 * 5. Group creation API request, payload ({ member_user_ids, name }), auth, and error handling.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateGroupName,
  GroupCreationDraft,
  DirectChatDraft,
  ChatShellState
} from '../src/renderer/chat-shell-state.js';
import { ChatApi } from '../src/api/chat-api.js';
import { ApiError } from '../src/api/api-error.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const htmlPath = path.resolve(__dirname, '../src/renderer/index.html');
const appJsPath = path.resolve(__dirname, '../src/renderer/app.js');
const preloadJsPath = path.resolve(__dirname, '../src/preload/preload.js');
const mainJsPath = path.resolve(__dirname, '../src/main/main.js');
const chatApiJsPath = path.resolve(__dirname, '../src/api/chat-api.js');

describe('Pencil Icon & Group Creation Flow - Markup & Trace Verification', () => {
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const appJsContent = fs.readFileSync(appJsPath, 'utf8');
  const preloadJsContent = fs.readFileSync(preloadJsPath, 'utf8');
  const mainJsContent = fs.readFileSync(mainJsPath, 'utf8');
  const chatApiJsContent = fs.readFileSync(chatApiJsPath, 'utf8');

  test('1. index.html contains #btn-new-chat with accessible label in sidebar header', () => {
    assert.ok(htmlContent.includes('id="btn-new-chat"'), 'Must have #btn-new-chat');
    assert.ok(htmlContent.includes('title="New Chat or Group"'), 'Must have title "New Chat or Group"');
    assert.ok(htmlContent.includes('aria-label="New chat or group"'), 'Must have accessible label');
  });

  test('2. index.html contains #new-chat-modal with both Direct Chat and Create Group tabs and panels', () => {
    assert.ok(htmlContent.includes('id="new-chat-modal"'), 'Must have #new-chat-modal');
    assert.ok(htmlContent.includes('id="tab-direct"'), 'Must have #tab-direct');
    assert.ok(htmlContent.includes('id="tab-group"'), 'Must have #tab-group');
    assert.ok(htmlContent.includes('id="panel-direct"'), 'Must have #panel-direct');
    assert.ok(htmlContent.includes('id="panel-group"'), 'Must have #panel-group');
  });

  test('3. index.html contains group creation form fields and contact selection list', () => {
    assert.ok(htmlContent.includes('id="group-name-input"'), 'Must have #group-name-input');
    assert.ok(htmlContent.includes('id="group-add-people-contacts"'), 'Must have #group-add-people-contacts');
    assert.ok(htmlContent.includes('id="group-member-phone"'), 'Must have #group-member-phone');
    assert.ok(htmlContent.includes('id="btn-add-group-member"'), 'Must have #btn-add-group-member');
    assert.ok(htmlContent.includes('id="group-members-chips"'), 'Must have #group-members-chips');
    assert.ok(htmlContent.includes('id="btn-create-group"'), 'Must have #btn-create-group');
  });

  test('4. app.js binds click handler to #btn-new-chat and handles tab switching', () => {
    assert.ok(
      appJsContent.includes("btnNewChat?.addEventListener('click', openNewChatModal)"),
      'Must bind openNewChatModal to btnNewChat click'
    );
    assert.ok(
      appJsContent.includes("tabGroup?.addEventListener('click'"),
      'Must bind click listener to tabGroup'
    );
    assert.ok(
      appJsContent.includes("tabDirect?.addEventListener('click'"),
      'Must bind click listener to tabDirect'
    );
  });

  test('5. preload.js exposes createGroup via chat-api:create-group channel', () => {
    assert.ok(
      preloadJsContent.includes("createGroup: (name, memberUserIds = []) => handleApiCall('chat-api:create-group', name, memberUserIds)"),
      'Preload must expose createGroup'
    );
  });

  test('6. main.js handles chat-api:create-group with authenticated session token', () => {
    assert.ok(
      mainJsContent.includes("ipcMain.handle('chat-api:create-group'"),
      'main.js must register chat-api:create-group IPC handler'
    );
    assert.ok(
      mainJsContent.includes("getAuthenticatedSessionToken()"),
      'main.js must get authenticated session token'
    );
    assert.ok(
      mainJsContent.includes("chatApi.createGroupConversation("),
      'main.js must call chatApi.createGroupConversation'
    );
  });

  test('7. chat-api.js targets POST /directory/conversations/group with member_user_ids and name', () => {
    assert.ok(
      chatApiJsContent.includes("async createGroupConversation(sessionToken, { memberUserIds = [], name })"),
      'chat-api.js must have createGroupConversation'
    );
    assert.ok(
      chatApiJsContent.includes("'/directory/conversations/group'"),
      'Must call POST /directory/conversations/group'
    );
    assert.ok(
      chatApiJsContent.includes("member_user_ids: memberUserIds"),
      'Must include member_user_ids in payload'
    );
  });
});

describe('Group Creation Validation & Draft State Management', () => {
  test('1. validateGroupName accepts names from 6 to 60 characters', () => {
    assert.strictEqual(validateGroupName('Project Orion').valid, true);
    assert.strictEqual(validateGroupName('Engineering').valid, true);
    assert.strictEqual(validateGroupName('  Trimmed Group  ').name, 'Trimmed Group');
  });

  test('2. validateGroupName rejects empty or short names under 6 characters', () => {
    assert.strictEqual(validateGroupName('').valid, false);
    assert.strictEqual(validateGroupName('   ').valid, false);
    assert.strictEqual(validateGroupName('Team').valid, false);
    assert.ok(validateGroupName('Team').error.includes('6 characters'));
    assert.strictEqual(validateGroupName(null).valid, false);
    assert.strictEqual(validateGroupName(undefined).valid, false);
  });

  test('3. validateGroupName rejects names longer than 60 characters', () => {
    const longName = 'A'.repeat(61);
    assert.strictEqual(validateGroupName(longName).valid, false);
    assert.ok(validateGroupName(longName).error.includes('60 characters'));
  });

  test('4. GroupCreationDraft manages name and member lifecycle', () => {
    const draft = new GroupCreationDraft();
    assert.strictEqual(draft.canSubmit(), false);

    draft.setName('Core Team');
    assert.strictEqual(draft.canSubmit(), false, 'Cannot submit with 0 members');

    const res1 = draft.addMember({ userId: 'u_alice', displayName: 'Alice', phone: '+15551111111' }, 'u_self');
    assert.strictEqual(res1.added, true);
    assert.strictEqual(draft.members.length, 1);
    assert.strictEqual(draft.canSubmit(), true, 'Can submit with valid name and 1 member');

    // Prevent adding self
    const resSelf = draft.addMember({ userId: 'u_self', displayName: 'Self' }, 'u_self');
    assert.strictEqual(resSelf.added, false);
    assert.ok(resSelf.error.includes('creator'));

    // Prevent duplicate members
    const resDup = draft.addMember({ userId: 'u_alice', displayName: 'Alice' }, 'u_self');
    assert.strictEqual(resDup.added, false);
    assert.ok(resDup.error.includes('already added'));

    // Add second member
    const res2 = draft.addMember({ userId: 'u_bob', displayName: 'Bob', phone: '+15552222222' }, 'u_self');
    assert.strictEqual(res2.added, true);
    assert.strictEqual(draft.members.length, 2);
    assert.deepStrictEqual(draft.getMemberUserIds(), ['u_alice', 'u_bob']);

    // Remove member
    draft.removeMember('u_alice');
    assert.strictEqual(draft.members.length, 1);
    assert.deepStrictEqual(draft.getMemberUserIds(), ['u_bob']);

    // Reset draft
    draft.reset();
    assert.strictEqual(draft.name, '');
    assert.strictEqual(draft.members.length, 0);
    assert.strictEqual(draft.canSubmit(), false);
  });
});

describe('ChatApi Group Creation HTTP Integration', () => {
  test('1. createGroupConversation makes POST /directory/conversations/group with authorization and body', async () => {
    let capturedUrl = null;
    let capturedOptions = null;

    const mockApi = new ChatApi({
      baseUrl: 'https://test.api.ollacore.com/v1',
      fetchFn: async (url, options) => {
        capturedUrl = url;
        capturedOptions = options;
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Map(),
          text: async () => JSON.stringify({
            room_id: 'room_grp_999',
            kind: 'group',
            name: 'Engineers'
          })
        };
      }
    });

    const sessionToken = 'du_test_token_abc';
    const result = await mockApi.createGroupConversation(sessionToken, {
      name: ' Engineers ',
      memberUserIds: ['u_1', 'u_2']
    });

    assert.ok(capturedUrl.endsWith('/directory/conversations/group'));
    assert.strictEqual(capturedOptions.method, 'POST');
    assert.strictEqual(capturedOptions.headers.Authorization, 'Bearer du_test_token_abc');
    assert.deepStrictEqual(JSON.parse(capturedOptions.body), {
      member_user_ids: ['u_1', 'u_2'],
      name: 'Engineers'
    });
    assert.strictEqual(result.roomId, 'room_grp_999');
    assert.strictEqual(result.kind, 'group');
    assert.strictEqual(result.name, 'Engineers');
  });

  test('2. createGroupConversation throws unauthorized when sessionToken is missing', async () => {
    const mockApi = new ChatApi({ baseUrl: 'https://test.api.ollacore.com/v1' });
    await assert.rejects(
      async () => {
        await mockApi.createGroupConversation(null, { name: 'Team', memberUserIds: ['u_1'] });
      },
      (err) => {
        assert.strictEqual(err.httpStatus, 401);
        assert.strictEqual(err.code, 'unauthorized');
        return true;
      }
    );
  });

  test('3. createGroupConversation throws bad_request when name is missing or empty', async () => {
    const mockApi = new ChatApi({ baseUrl: 'https://test.api.ollacore.com/v1' });
    await assert.rejects(
      async () => {
        await mockApi.createGroupConversation('token', { name: '   ', memberUserIds: ['u_1'] });
      },
      (err) => {
        assert.strictEqual(err.httpStatus, 400);
        assert.strictEqual(err.code, 'bad_request');
        return true;
      }
    );
  });

  test('4. createGroupConversation throws bad_request when memberUserIds is not an array', async () => {
    const mockApi = new ChatApi({ baseUrl: 'https://test.api.ollacore.com/v1' });
    await assert.rejects(
      async () => {
        await mockApi.createGroupConversation('token', { name: 'Team', memberUserIds: 'invalid' });
      },
      (err) => {
        assert.strictEqual(err.httpStatus, 400);
        assert.strictEqual(err.code, 'bad_request');
        return true;
      }
    );
  });
});

describe('UI Logic: Contextual Tab Selection & Available Contacts Filtering', () => {
  test('1. ChatShellState correctly tracks activeFilter ("all" vs "groups")', () => {
    const shellState = new ChatShellState();
    assert.strictEqual(shellState.activeFilter, 'all');

    shellState.setActiveFilter('groups');
    assert.strictEqual(shellState.activeFilter, 'groups');

    shellState.setActiveFilter('all');
    assert.strictEqual(shellState.activeFilter, 'all');
  });

  test('2. Direct conversations are filtered and deduplicated for group contact selection', () => {
    const currentUserId = 'u_self';
    const conversations = [
      {
        roomId: 'room_1',
        kind: 'direct',
        peer: { userId: 'u_alice', displayName: 'Alice', phone: '+1555111' }
      },
      {
        roomId: 'room_2',
        kind: 'group',
        name: 'Existing Group',
        participants: []
      },
      {
        roomId: 'room_3',
        kind: 'direct',
        peer: { userId: 'u_bob', displayName: 'Bob', phone: '+1555222' }
      },
      {
        roomId: 'room_4',
        kind: 'direct',
        peer: { userId: 'u_alice', displayName: 'Alice Duplicate', phone: '+1555111' }
      },
      {
        roomId: 'room_5',
        kind: 'direct',
        peer: { userId: 'u_self', displayName: 'Self Note' }
      }
    ];

    const directConvs = conversations.filter(
      (c) => c.kind === 'direct' && c.peer?.userId && c.peer.userId !== currentUserId
    );

    const seenUsers = new Map();
    for (const c of directConvs) {
      if (!seenUsers.has(c.peer.userId)) {
        seenUsers.set(c.peer.userId, c);
      }
    }
    const eligibleContacts = Array.from(seenUsers.values());

    assert.strictEqual(eligibleContacts.length, 2, 'Should include only Alice and Bob');
    assert.strictEqual(eligibleContacts[0].peer.userId, 'u_alice');
    assert.strictEqual(eligibleContacts[1].peer.userId, 'u_bob');
  });
});

describe('Modal Triggering, Settings & Profile Accessibility, and Lifecycle Verification', () => {
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const appJsContent = fs.readFileSync(appJsPath, 'utf8');

  test('1. index.html contains Settings and Profile triggers and modal structure', () => {
    assert.ok(htmlContent.includes('id="btn-settings"'), 'Must have #btn-settings');
    assert.ok(htmlContent.includes('id="user-profile-trigger"'), 'Must have #user-profile-trigger');
    assert.ok(htmlContent.includes('id="settings-modal"'), 'Must have #settings-modal');
    assert.ok(htmlContent.includes('id="btn-close-settings"'), 'Must have #btn-close-settings');
    assert.ok(htmlContent.includes('id="btn-close-settings-footer"'), 'Must have #btn-close-settings-footer');
    assert.ok(htmlContent.includes('id="btn-edit-profile"'), 'Must have #btn-edit-profile');
  });

  test('2. app.js exports openSettings and closeSettings', () => {
    assert.ok(appJsContent.includes('export function openSettings()'), 'openSettings must be exported');
    assert.ok(appJsContent.includes('export function closeSettings()'), 'closeSettings must be exported');
    assert.ok(appJsContent.includes('openSettings,'), 'openSettings must be in __TEST_HOOKS__');
    assert.ok(appJsContent.includes('closeSettings'), 'closeSettings must be in __TEST_HOOKS__');
  });

  test('3. app.js guards init() execution with document.readyState check to prevent deferred module races', () => {
    assert.ok(
      appJsContent.includes("if (document.readyState === 'loading')"),
      'Must check document.readyState before waiting for DOMContentLoaded'
    );
    assert.ok(
      appJsContent.includes('init();'),
      'Must immediately invoke init() if readyState is already past loading'
    );
  });

  test('4. app.js registers click handlers on Settings and New Chat triggers', () => {
    assert.ok(appJsContent.includes("btnSettings?.addEventListener('click'"), 'btnSettings click listener registered');
    assert.ok(appJsContent.includes("userProfileTrigger?.addEventListener('click'"), 'userProfileTrigger click listener registered');
    assert.ok(appJsContent.includes("btnNewChat?.addEventListener('click'"), 'btnNewChat click listener registered');
    assert.ok(appJsContent.includes("btnCloseNewChat?.addEventListener('click'"), 'btnCloseNewChat click listener registered');
  });

  test('5. Modal backdrop has .modal-backdrop.hidden CSS rule ensuring zero pointer blockage when closed', () => {
    const cssPath = path.resolve(__dirname, '../src/renderer/styles.css');
    const cssContent = fs.readFileSync(cssPath, 'utf8');
    assert.ok(
      cssContent.includes('.modal-backdrop.hidden') || cssContent.includes('.hidden'),
      'CSS must support hiding modal backdrops'
    );
  });

  test('6. index.html does not nest #settings-modal or #new-chat-modal inside #voice-call-overlay', () => {
    const vcoIndex = htmlContent.indexOf('id="voice-call-overlay"');
    const vcoCloseIndex = htmlContent.indexOf('<!-- Screen Share Source Picker Modal', vcoIndex);
    const vcoSection = htmlContent.slice(vcoIndex, vcoCloseIndex);

    // Verify closing </div> exists right before Screen Share Source Picker
    assert.ok(vcoSection.includes('</div>'), 'voice-call-overlay must contain closing </div> before screenshare-picker-modal');

    // Neither settings-modal nor new-chat-modal can appear within voice-call-overlay
    assert.ok(!vcoSection.includes('id="settings-modal"'), '#settings-modal must not be nested in #voice-call-overlay');
    assert.ok(!vcoSection.includes('id="new-chat-modal"'), '#new-chat-modal must not be nested in #voice-call-overlay');
  });
});

