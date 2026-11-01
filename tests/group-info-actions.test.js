import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChatShellState,
  RoomMessagesState,
  getGroupCapabilities,
  getParticipantCapabilities
} from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const htmlPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const cssPath = path.join(__dirname, '..', 'src', 'renderer', 'styles.css');
const appJsPath = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
const shellStateJsPath = path.join(__dirname, '..', 'src', 'renderer', 'chat-shell-state.js');

const html = fs.readFileSync(htmlPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
const appJs = fs.readFileSync(appJsPath, 'utf8');
const shellStateJs = fs.readFileSync(shellStateJsPath, 'utf8');

describe('WhatsApp-Style Group Info & Contact Info Action System (42 Invariants)', () => {
  // 1. Direct contact shows Contact Info
  test('1. Direct contact shows Contact Info', () => {
    const directConv = { roomId: 'dm_1', kind: 'direct', peerDisplayName: 'Alice' };
    const caps = getGroupCapabilities(directConv, [], 'my_id');
    assert.strictEqual(caps.isGroup, false);
    assert.strictEqual(caps.title, 'Contact info');
    assert.strictEqual(caps.canExitGroup, false);
  });

  // 2. Direct contact does not show Exit group
  test('2. Direct contact does not show Exit group', () => {
    const directConv = { roomId: 'dm_1', kind: 'direct' };
    const caps = getGroupCapabilities(directConv, [], 'my_id');
    assert.strictEqual(caps.canExitGroup, false);
    assert.ok(appJs.includes("contactInfoExitGroupRow?.classList.toggle('hidden', !caps.canExitGroup)"));
  });

  // 3. Direct contact does not show Add member
  test('3. Direct contact does not show Add member', () => {
    const directConv = { roomId: 'dm_1', kind: 'direct' };
    const caps = getGroupCapabilities(directConv, [], 'my_id');
    assert.strictEqual(caps.canAddPeople, false);
    assert.strictEqual(caps.showParticipants, false);
    assert.ok(appJs.includes("btnGroupAddPeople?.classList.add('hidden')"));
  });

  // 4. Direct contact does not show Report
  test('4. Direct contact does not show Report', () => {
    assert.ok(!html.includes('id="btn-report"'), 'No report button in HTML');
    assert.ok(!html.includes('id="contact-info-report"'), 'No contact info report button');
    assert.ok(!html.includes('>Report<'), 'No Report text in HTML');
  });

  // 5. Group member sees Group Info
  test('5. Group member sees Group Info', () => {
    const groupConv = { roomId: 'grp_1', kind: 'group', name: 'Dev Team' };
    const caps = getGroupCapabilities(groupConv, [{ principalId: 'my_id', role: 'member' }], 'my_id');
    assert.strictEqual(caps.isGroup, true);
    assert.strictEqual(caps.title, 'Group info');
    assert.strictEqual(caps.showParticipants, true);
  });

  // 6. Group member sees Exit group
  test('6. Group member sees Exit group', () => {
    const groupConv = { roomId: 'grp_1', kind: 'group', name: 'Dev Team' };
    const caps = getGroupCapabilities(groupConv, [{ principalId: 'my_id', role: 'member' }], 'my_id');
    assert.strictEqual(caps.canExitGroup, true);
  });

  // 7. Group member does not see unauthorized admin controls
  test('7. Group member does not see unauthorized admin controls', () => {
    const groupConv = { roomId: 'grp_1', kind: 'group', name: 'Dev Team' };
    const participants = [
      { principalId: 'admin_1', role: 'admin' },
      { principalId: 'my_id', role: 'member' }
    ];
    const caps = getGroupCapabilities(groupConv, participants, 'my_id');
    assert.strictEqual(caps.isCurrentUserAdmin, false);
    assert.strictEqual(caps.canAddPeople, false);
    assert.strictEqual(caps.canRenameGroup, false);

    // Participant capabilities when viewed by normal member
    const targetCaps = getParticipantCapabilities(participants[0], caps.isCurrentUserAdmin, 'my_id');
    assert.strictEqual(targetCaps.canRemove, false);
    assert.strictEqual(targetCaps.canPromote, false);
    assert.strictEqual(targetCaps.canDemote, false);
  });

  // 8. Admin sees authorized controls
  test('8. Admin sees authorized controls', () => {
    const groupConv = { roomId: 'grp_1', kind: 'group', name: 'Dev Team' };
    const participants = [
      { principalId: 'my_id', role: 'admin' },
      { principalId: 'user_2', role: 'member' }
    ];
    const caps = getGroupCapabilities(groupConv, participants, 'my_id');
    assert.strictEqual(caps.isCurrentUserAdmin, true);
    assert.strictEqual(caps.canAddPeople, true);
    assert.strictEqual(caps.canRenameGroup, true);

    const targetCaps = getParticipantCapabilities(participants[1], caps.isCurrentUserAdmin, 'my_id');
    assert.strictEqual(targetCaps.canRemove, true);
    assert.strictEqual(targetCaps.canPromote, true);
    assert.strictEqual(targetCaps.canDemote, false);
  });

  // 9. Participant admin indicators render correctly
  test('9. Participant admin indicators render correctly', () => {
    const adminParticipant = { principalId: 'p_1', role: 'admin' };
    const targetCaps = getParticipantCapabilities(adminParticipant, false, 'my_id');
    assert.strictEqual(targetCaps.isAdmin, true);
    assert.strictEqual(targetCaps.roleLabel, 'Admin');
    assert.ok(appJs.includes("adminBadge.className = 'badge-role admin'"));
    assert.ok(appJs.includes("adminBadge.textContent = 'Group Admin'"));
  });

  // 10. Current user role is calculated correctly
  test('10. Current user role is calculated correctly across aliases (creator, owner, admin, member)', () => {
    const groupConv = { roomId: 'grp_1', kind: 'group', name: 'Dev Team' };
    
    // Test owner alias
    let caps = getGroupCapabilities(groupConv, [{ principalId: 'my_id', role: 'owner' }], 'my_id');
    assert.strictEqual(caps.currentUserRole, 'owner');
    assert.strictEqual(caps.isCurrentUserAdmin, true);

    // Test creator alias
    caps = getGroupCapabilities(groupConv, [{ principalId: 'my_id', role: 'creator' }], 'my_id');
    assert.strictEqual(caps.currentUserRole, 'creator');
    assert.strictEqual(caps.isCurrentUserAdmin, true);

    // Test normal admin
    caps = getGroupCapabilities(groupConv, [{ principalId: 'my_id', role: 'admin' }], 'my_id');
    assert.strictEqual(caps.currentUserRole, 'admin');
    assert.strictEqual(caps.isCurrentUserAdmin, true);

    // Test normal member
    caps = getGroupCapabilities(groupConv, [{ principalId: 'my_id', role: 'member' }], 'my_id');
    assert.strictEqual(caps.currentUserRole, 'member');
    assert.strictEqual(caps.isCurrentUserAdmin, false);
  });

  // 11. Add people UI opens
  test('11. Add people UI opens with modal and direct contacts', () => {
    assert.ok(html.includes('id="group-add-people-modal"'));
    assert.ok(html.includes('id="btn-group-add-people"'));
    assert.ok(html.includes('id="btn-confirm-group-add-people"'));
    assert.ok(appJs.includes('openGroupAddPeopleModal('));
    assert.ok(appJs.includes('closeGroupAddPeopleModal('));
  });

  // 12. Contact selection works
  test('12. Contact selection works in add people dialog', () => {
    assert.ok(appJs.includes('groupAddPeopleContactsList'));
    assert.ok(appJs.includes('.group-add-contact-item'));
    assert.ok(appJs.includes('groupAddPeopleInput'));
  });

  // 13. Successful supported add-member operation refreshes participants
  test('13. Successful supported add-member operation refreshes participants', () => {
    assert.ok(appJs.includes('await window.ollacoreDesktop.chatApi.addMember(roomId, selectedAddContactUserId)'));
    assert.ok(appJs.includes('await refreshContactInfoParticipants(roomId)'));
  });

  // 14. Unsupported add-member operation is not falsely reported as successful
  test('14. Unsupported add-member operation is not falsely reported as successful', () => {
    assert.ok(appJs.includes("formatBackendGroupError('Add member', err)"));
  });

  // 15. Remove member authorization
  test('15. Remove member authorization strictly permits admins only', () => {
    const memberTarget = { principalId: 'target_id', role: 'member' };
    const memberView = getParticipantCapabilities(memberTarget, false, 'my_id');
    assert.strictEqual(memberView.canRemove, false);

    const adminView = getParticipantCapabilities(memberTarget, true, 'my_id');
    assert.strictEqual(adminView.canRemove, true);
  });

  // 16. Remove member confirmation
  test('16. Remove member confirmation dialog is prompted before removal', () => {
    assert.ok(appJs.includes("openConfirmModal(\n      'Remove from group',"));
  });

  // 17. Successful removal refreshes participant list
  test('17. Successful removal refreshes participant list', () => {
    assert.ok(appJs.includes('await window.ollacoreDesktop.chatApi.removeMember(roomId, mId)'));
    assert.ok(appJs.includes('await refreshContactInfoParticipants(roomId)'));
  });

  // 18. Unsupported removal is not faked
  test('18. Unsupported removal is not faked', () => {
    assert.ok(appJs.includes("formatBackendGroupError('Remove member', err)"));
  });

  // 19. Promote admin behavior if supported
  test('19. Promote admin behavior calls client-safe setMemberRole with admin', () => {
    const memberTarget = { principalId: 'target_id', role: 'member' };
    const adminView = getParticipantCapabilities(memberTarget, true, 'my_id');
    assert.strictEqual(adminView.canPromote, true);
    assert.strictEqual(adminView.canDemote, false);
    assert.ok(appJs.includes("await window.ollacoreDesktop.chatApi.setMemberRole(roomId, mId, 'admin')"));
  });

  // 20. Demote admin behavior if supported
  test('20. Demote admin behavior calls client-safe setMemberRole with member', () => {
    const adminTarget = { principalId: 'target_id', role: 'admin' };
    const adminView = getParticipantCapabilities(adminTarget, true, 'my_id');
    assert.strictEqual(adminView.canPromote, false);
    assert.strictEqual(adminView.canDemote, true);
    assert.ok(appJs.includes("await window.ollacoreDesktop.chatApi.setMemberRole(roomId, mId, 'member')"));
  });

  // 21. Rename behavior if supported
  test('21. Rename behavior updates group name server-side via updateGroup', () => {
    assert.ok(html.includes('id="btn-contact-info-edit-name"'));
    assert.ok(html.includes('id="contact-info-rename-form"'));
    assert.ok(html.includes('id="contact-info-rename-input"'));
    assert.ok(appJs.includes('await window.ollacoreDesktop.chatApi.updateGroup(activeContactInfoRoomId, { name: val.name })'));
  });

  // 22. Unsupported role/name operations are not falsely exposed
  test('22. Unsupported role/name operations are not falsely exposed to non-admins', () => {
    const groupConv = { roomId: 'grp_1', kind: 'group' };
    const normalMemberCaps = getGroupCapabilities(groupConv, [{ principalId: 'my_id', role: 'member' }], 'my_id');
    assert.strictEqual(normalMemberCaps.canRenameGroup, false);
    assert.ok(appJs.includes("btnContactInfoEditName?.classList.toggle('hidden', !caps.canRenameGroup)"));
  });

  // 23. Exit group confirmation
  test('23. Exit group confirmation informs user of membership termination', () => {
    assert.ok(appJs.includes("openConfirmModal(\n    'Exit group',"));
  });

  // 24. Successful exit clears selected room safely
  test('24. Successful exit clears selected room safely', () => {
    assert.ok(appJs.includes('await window.ollacoreDesktop.chatApi.leaveGroup(roomId)'));
    assert.ok(appJs.includes('closeContactInfo()'));
    assert.ok(appJs.includes('shellState.selectedRoomId = null'));
  });

  // 25. Successful exit removes/updates conversation correctly
  test('25. Successful exit removes conversation from active list and updates filters', () => {
    const state = new ChatShellState();
    state.conversations = [
      { roomId: 'r1', kind: 'group', unreadCount: 2 },
      { roomId: 'r2', kind: 'direct', unreadCount: 0 }
    ];
    state.pinChat('r1');
    state.favouriteChat('r1');
    state.selectedRoomId = 'r1';
    state.activeContactInfoRoomId = 'r1';

    const removed = state.removeConversation('r1');
    assert.strictEqual(removed, true);
    assert.strictEqual(state.conversations.length, 1);
    assert.strictEqual(state.conversations[0].roomId, 'r2');
    assert.strictEqual(state.isPinned('r1'), false);
    assert.strictEqual(state.isFavourite('r1'), false);
    assert.strictEqual(state.selectedRoomId, null);
    assert.strictEqual(state.activeContactInfoRoomId, null);
  });

  // 26. Delete-chat-after-exit behavior
  test('26. Delete-chat-after-exit behavior performs local cleanup without claiming group destruction', () => {
    const state = new ChatShellState();
    const msgState = new RoomMessagesState();
    state.conversations = [{ roomId: 'r1', kind: 'group' }];
    msgState.roomId = 'r1';
    msgState.messages = [{ id: 'm1', text: 'Hello' }];

    // User can delete conversation locally
    state.removeConversation('r1');
    msgState.clearMessages('r1');

    assert.strictEqual(state.conversations.length, 0);
    assert.strictEqual(msgState.messages.length, 0);
  });

  // 27. Clear chat remains separate from Exit group
  test('27. Clear chat remains separate from Exit group', () => {
    assert.ok(html.includes('id="contact-info-clear-chat-row"'));
    assert.ok(html.includes('id="contact-info-exit-group-row"'));
    assert.ok(appJs.includes('function requestClearChat(roomId)'));
    assert.ok(appJs.includes('function requestExitGroup(roomId)'));
    assert.ok(appJs.includes('function requestDeleteChat(roomId)'));
    assert.notStrictEqual(
      appJs.indexOf('function requestClearChat'),
      appJs.indexOf('function requestExitGroup')
    );
  });

  // 28. Direct contact Block behavior only if supported
  test('28. Direct contact Block behavior is capability-driven and never shows fake functionality', () => {
    const directConv = { roomId: 'dm_1', kind: 'direct' };
    const caps = getGroupCapabilities(directConv, [], 'my_id');
    assert.strictEqual(caps.canBlock, true);
    const groupConv = { roomId: 'grp_1', kind: 'group' };
    const groupCaps = getGroupCapabilities(groupConv, [], 'my_id');
    assert.strictEqual(groupCaps.canBlock, false);
  });

  // 29. No Report anywhere
  test('29. No Report anywhere in Contact Info, Group Info, or menus', () => {
    assert.ok(!html.includes('id="btn-report"'));
    assert.ok(!html.includes('contact-info-report'));
    assert.ok(!html.includes('menu-item-report'));
    assert.ok(!html.toLowerCase().includes('>report<'));
  });

  // 30. Switching direct <-> group refreshes actions
  test('30. Switching direct <-> group refreshes actions and prevents leakage', () => {
    const directConv = { roomId: 'dm_1', kind: 'direct' };
    const groupConv = { roomId: 'grp_1', kind: 'group' };

    const directCaps = getGroupCapabilities(directConv, [], 'my_id');
    const groupCaps = getGroupCapabilities(groupConv, [{ principalId: 'my_id', role: 'member' }], 'my_id');

    // Direct chat has no exit group or add people
    assert.strictEqual(directCaps.canExitGroup, false);
    assert.strictEqual(directCaps.canAddPeople, false);
    assert.strictEqual(directCaps.canDeleteChat, true);

    // Group chat has exit group and participants
    assert.strictEqual(groupCaps.canExitGroup, true);
    assert.strictEqual(groupCaps.showParticipants, true);
    assert.strictEqual(groupCaps.canDeleteChat, false);
  });

  // 31. Switching admin <-> member refreshes actions
  test('31. Switching admin <-> member refreshes actions without restart', () => {
    const groupConv = { roomId: 'grp_1', kind: 'group' };
    const memberParticipants = [{ principalId: 'my_id', role: 'member' }];
    const adminParticipants = [{ principalId: 'my_id', role: 'admin' }];

    const memberCaps = getGroupCapabilities(groupConv, memberParticipants, 'my_id');
    const adminCaps = getGroupCapabilities(groupConv, adminParticipants, 'my_id');

    assert.strictEqual(memberCaps.isCurrentUserAdmin, false);
    assert.strictEqual(memberCaps.canAddPeople, false);
    assert.strictEqual(memberCaps.canRenameGroup, false);

    assert.strictEqual(adminCaps.isCurrentUserAdmin, true);
    assert.strictEqual(adminCaps.canAddPeople, true);
    assert.strictEqual(adminCaps.canRenameGroup, true);
  });

  // 32. Group Info refreshes after participant changes
  test('32. Group Info refreshes after participant changes', () => {
    assert.ok(appJs.includes('async function refreshContactInfoParticipants(roomId)'));
    assert.ok(appJs.includes('renderContactInfoParticipantsList(participants, currentUserId)'));
  });

  // 33. Current user cannot accidentally remove themselves through admin removal
  test('33. Current user cannot accidentally remove themselves through admin removal', () => {
    const selfAdminParticipant = { principalId: 'my_id', role: 'admin' };
    const caps = getParticipantCapabilities(selfAdminParticipant, true, 'my_id');
    assert.strictEqual(caps.isSelf, true);
    assert.strictEqual(caps.canRemove, false); // Invariant: Self cannot be removed via participant menu
    assert.strictEqual(caps.canPromote, false); // Invariant: Self cannot promote self
    assert.strictEqual(caps.canDemote, false);  // Invariant: Self cannot demote self
  });

  // 34. Active call exits correctly when current user leaves group
  test('34. Active call exits correctly when current user leaves group', () => {
    assert.ok(appJs.includes('voiceCallManager.currentRoomId === roomId'));
    assert.ok(appJs.includes('voiceCallManager.endCall(true)'));
  });

  // 35. Existing messaging remains functional
  test('35. Existing messaging remains functional', () => {
    assert.ok(appJs.includes('handleSendMessage()'));
    assert.ok(appJs.includes('renderMessages()'));
    assert.ok(html.includes('id="composer-input"'));
    assert.ok(html.includes('id="btn-send-message"'));
  });

  // 36. Existing calls remain functional
  test('36. Existing calls remain functional', () => {
    assert.ok(html.includes('id="btn-start-voice-call"'));
    assert.ok(html.includes('id="btn-start-video-call"'));
    assert.ok(appJs.includes('voiceCallManager'));
  });

  // 37. Existing Contact Info remains functional
  test('37. Existing Contact Info remains functional with header trigger and drawer', () => {
    assert.ok(html.includes('id="contact-info-panel"'));
    assert.ok(html.includes('id="btn-close-contact-info"'));
    assert.ok(appJs.includes('openContactInfo('));
    assert.ok(appJs.includes('closeContactInfo('));
  });

  // 38. Media/Links/Docs remain functional
  test('38. Media/Links/Docs navigation row remains functional', () => {
    assert.ok(html.includes('id="contact-info-media-row"'));
    assert.ok(appJs.includes('openMediaBrowser'));
  });

  // 39. Starred Messages remain functional
  test('39. Starred Messages navigation row remains functional', () => {
    assert.ok(html.includes('id="contact-info-starred-row"'));
    assert.ok(appJs.includes('openStarredMessages'));
  });

  // 40. Themes remain functional
  test('40. Themes remain functional with variables and CSS rules', () => {
    assert.ok(css.includes('--bg-surface'));
    assert.ok(css.includes('.contact-info-panel'));
    assert.ok(css.includes('.contact-info-nav-row'));
    assert.ok(css.includes('.badge-role.admin'));
  });

  // 41. Custom lists remain functional
  test('41. Custom lists remain functional with modal and filters', () => {
    assert.ok(html.includes('id="custom-list-modal"'));
    assert.ok(html.includes('id="contact-info-lists-row"'));
    assert.ok(shellStateJs.includes('createCustomList'));
  });

  // 42. Favourites/pins remain functional
  test('42. Favourites/pins remain functional in state and Contact Info toggle', () => {
    const state = new ChatShellState();
    state.toggleFavouriteChat('room_fav');
    assert.strictEqual(state.isFavourite('room_fav'), true);
    state.togglePinChat('room_pin');
    assert.strictEqual(state.isPinned('room_pin'), true);
    assert.ok(html.includes('id="contact-info-fav-row"'));
    assert.ok(html.includes('id="contact-info-fav-label"'));
  });

  // ═══════════════════════════════════════════════════════════════════
  // REGRESSION TESTS: Contact Info & Group Info Opening & Lifecycle
  // ═══════════════════════════════════════════════════════════════════
  describe('Regression: Contact Info & Group Info Opening & Room Lifecycle', () => {
    test('Regression 1: No undeclared contactInfoParticipantsCache in renderer codebase', () => {
      assert.ok(
        !appJs.includes('contactInfoParticipantsCache'),
        'app.js must not reference undeclared contactInfoParticipantsCache'
      );
      assert.ok(
        !html.includes('contactInfoParticipantsCache'),
        'index.html must not reference contactInfoParticipantsCache'
      );
      assert.ok(
        !shellStateJs.includes('contactInfoParticipantsCache'),
        'chat-shell-state.js must not reference contactInfoParticipantsCache'
      );
    });

    test('Regression 2: Direct Contact Info opening capability evaluation does not throw', () => {
      const state = new ChatShellState();
      state.setCurrentUser({ userId: 'u_alice', name: 'Alice' });
      const directConv = {
        roomId: 'dm_bob',
        kind: 'direct',
        peer: { userId: 'u_bob', displayName: 'Bob' }
      };
      assert.doesNotThrow(() => {
        const caps = getGroupCapabilities(directConv, [], state.currentUser.userId);
        assert.strictEqual(caps.isGroup, false);
        assert.strictEqual(caps.title, 'Contact info');
        assert.strictEqual(caps.canExitGroup, false);
        assert.strictEqual(caps.canAddPeople, false);
        assert.strictEqual(caps.canDeleteChat, true);
      });
    });

    test('Regression 3: Group Info opening capability evaluation does not throw', () => {
      const state = new ChatShellState();
      state.setCurrentUser({ userId: 'u_alice', name: 'Alice' });
      const groupConv = {
        roomId: 'grp_alpha',
        kind: 'group',
        name: 'Alpha Team'
      };
      assert.doesNotThrow(() => {
        const caps = getGroupCapabilities(groupConv, [], state.currentUser.userId);
        assert.strictEqual(caps.isGroup, true);
        assert.strictEqual(caps.title, 'Group info');
        assert.strictEqual(caps.showParticipants, true);
        assert.strictEqual(caps.canExitGroup, true);
      });
    });

    test('Regression 4: Participant data loads and assigns activeGroupParticipants cleanly', () => {
      assert.ok(appJs.includes('activeGroupParticipants = participants;'));
      assert.ok(appJs.includes('isSwitchingRoom'));
      assert.ok(appJs.includes('activeGroupParticipants = [];'));
    });

    test('Regression 5: Admin role is calculated correctly for group admin/creator', () => {
      const groupConv = { roomId: 'grp_1', kind: 'group', name: 'Dev' };
      const participants = [
        { principalId: 'u_alice', role: 'admin' },
        { principalId: 'u_bob', role: 'member' }
      ];
      const caps = getGroupCapabilities(groupConv, participants, 'u_alice');
      assert.strictEqual(caps.isAdmin, true);
      assert.strictEqual(caps.isCurrentUserAdmin, true);
      assert.strictEqual(caps.canAddPeople, true);
      assert.strictEqual(caps.canRenameGroup, true);
    });

    test('Regression 6: Normal member role is calculated correctly', () => {
      const groupConv = { roomId: 'grp_1', kind: 'group', name: 'Dev' };
      const participants = [
        { principalId: 'u_alice', role: 'member' },
        { principalId: 'u_bob', role: 'admin' }
      ];
      const caps = getGroupCapabilities(groupConv, participants, 'u_alice');
      assert.strictEqual(caps.isAdmin, false);
      assert.strictEqual(caps.isCurrentUserAdmin, false);
      assert.strictEqual(caps.canAddPeople, false);
      assert.strictEqual(caps.canRenameGroup, false);
      assert.strictEqual(caps.canExitGroup, true);
    });

    test('Regression 7: Existing Contact Info actions still render in HTML and app.js', () => {
      assert.ok(html.includes('id="btn-contact-action-voice"'));
      assert.ok(html.includes('id="btn-contact-action-video"'));
      assert.ok(html.includes('id="btn-contact-action-search"'));
      assert.ok(html.includes('id="contact-info-media-row"'));
      assert.ok(html.includes('id="contact-info-starred-row"'));
      assert.ok(html.includes('id="contact-info-fav-row"'));
      assert.ok(html.includes('id="contact-info-lists-row"'));
      assert.ok(html.includes('id="contact-info-clear-chat-row"'));
      assert.ok(html.includes('id="contact-info-delete-chat-row"'));
    });

    test('Regression 8: Existing Group Info actions still render in HTML and app.js', () => {
      assert.ok(html.includes('id="btn-group-add-people"'));
      assert.ok(html.includes('id="btn-contact-info-edit-name"'));
      assert.ok(html.includes('id="contact-info-exit-group-row"'));
      assert.ok(html.includes('id="participant-action-menu"'));
      assert.ok(html.includes('id="group-add-people-modal"'));
    });

    test('Regression 9: No stale participant cache is used after switching rooms', () => {
      // In app.js, when opening a different room, activeGroupParticipants is cleared:
      assert.ok(appJs.includes("const isSwitchingRoom = activeContactInfoRoomId !== roomId;"));
      assert.ok(appJs.includes("if (isSwitchingRoom) {\n    activeGroupParticipants = [];\n  }"));
      // And in closeContactInfo:
      assert.ok(appJs.includes("export function closeContactInfo() {\n  activeContactInfoRoomId = null;\n  activeGroupParticipants = [];\n  isCurrentUserAdmin = false;"));
    });

    test('Regression 10: Direct -> Group -> Direct transition maintains clean action sets', () => {
      const directConv = { roomId: 'dm_1', kind: 'direct' };
      const groupConv = { roomId: 'grp_1', kind: 'group' };
      const currentUserId = 'user_me';

      // 1. Direct chat
      let caps = getGroupCapabilities(directConv, [], currentUserId);
      assert.strictEqual(caps.isGroup, false);
      assert.strictEqual(caps.canExitGroup, false);
      assert.strictEqual(caps.canDeleteChat, true);

      // 2. Switch to Group chat
      caps = getGroupCapabilities(groupConv, [{ principalId: 'user_me', role: 'member' }], currentUserId);
      assert.strictEqual(caps.isGroup, true);
      assert.strictEqual(caps.canExitGroup, true);
      assert.strictEqual(caps.canDeleteChat, false);

      // 3. Switch back to Direct chat
      caps = getGroupCapabilities(directConv, [], currentUserId);
      assert.strictEqual(caps.isGroup, false);
      assert.strictEqual(caps.canExitGroup, false);
      assert.strictEqual(caps.canDeleteChat, true);
    });
  });
});
