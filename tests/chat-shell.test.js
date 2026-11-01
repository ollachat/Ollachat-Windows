import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ChatShellState,
  getConversationTitle,
  getConversationSubtitle,
  getAvatarInitials,
  getAvatarColor,
  formatConversationTime,
  getConversationPreview,
  filterConversations,
  validatePhone,
  validateGroupName,
  DirectChatDraft,
  GroupCreationDraft
} from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

describe('Phase 4A & 4B: Chat Application Shell, Direct Chat & Group Creation', () => {

  describe('1. Authenticated Shell DOM Structure', () => {
    test('index.html defines required layout elements and containers', () => {
      const indexPath = path.join(projectRoot, 'src', 'renderer', 'index.html');
      assert.ok(fs.existsSync(indexPath), 'index.html must exist');

      const html = fs.readFileSync(indexPath, 'utf8');

      // Top app bar & WebSocket indicator
      assert.ok(html.includes('id="screen-authenticated"'), 'Must define #screen-authenticated');
      assert.ok(html.includes('id="ws-indicator"'), 'Must define #ws-indicator');
      assert.ok(html.includes('id="ws-status-label"'), 'Must define #ws-status-label');

      // Sidebar elements
      assert.ok(html.includes('id="btn-new-chat"'), 'Must define #btn-new-chat');
      assert.ok(html.includes('id="conversation-search"'), 'Must define #conversation-search');
      assert.ok(html.includes('id="conversation-list-container"'), 'Must define #conversation-list-container');
      assert.ok(html.includes('id="conversation-list"'), 'Must define #conversation-list');
      assert.ok(html.includes('id="inbox-loading"'), 'Must define #inbox-loading');
      assert.ok(html.includes('id="inbox-empty"'), 'Must define #inbox-empty');
      assert.ok(html.includes('id="inbox-error"'), 'Must define #inbox-error');
      assert.ok(html.includes('id="inbox-no-search"'), 'Must define #inbox-no-search');

      // Profile & settings area in sidebar
      assert.ok(html.includes('id="current-user-avatar"'), 'Must define #current-user-avatar');
      assert.ok(html.includes('id="current-user-name"'), 'Must define #current-user-name');
      assert.ok(html.includes('id="current-user-phone"'), 'Must define #current-user-phone');
      assert.ok(html.includes('id="btn-settings"'), 'Must define #btn-settings');
      assert.ok(html.includes('id="btn-logout"'), 'Must define #btn-logout');

      // Main chat area panels
      assert.ok(html.includes('id="chat-empty-panel"'), 'Must define #chat-empty-panel');
      assert.ok(html.includes('id="chat-selected-panel"'), 'Must define #chat-selected-panel');
      assert.ok(html.includes('id="selected-chat-name"'), 'Must define #selected-chat-name');
      assert.ok(html.includes('id="selected-chat-subtitle"'), 'Must define #selected-chat-subtitle');
      assert.ok(html.includes('id="selected-chat-avatar"'), 'Must define #selected-chat-avatar');
      assert.ok(html.includes('id="chat-messages-container"'), 'Must define #chat-messages-container');
      assert.ok(html.includes('id="chat-composer-container"'), 'Must define #chat-composer-container');

      // Phase 4B: New Chat & Create Group Modal
      assert.ok(html.includes('id="new-chat-modal"'), 'Must define #new-chat-modal');
      assert.ok(html.includes('id="btn-close-new-chat"'), 'Must define #btn-close-new-chat');
      assert.ok(html.includes('id="tab-direct"'), 'Must define #tab-direct');
      assert.ok(html.includes('id="tab-group"'), 'Must define #tab-group');
      assert.ok(html.includes('id="panel-direct"'), 'Must define #panel-direct');
      assert.ok(html.includes('id="panel-group"'), 'Must define #panel-group');
      assert.ok(html.includes('id="direct-phone-input"'), 'Must define #direct-phone-input');
      assert.ok(html.includes('id="btn-lookup-direct"'), 'Must define #btn-lookup-direct');
      assert.ok(html.includes('id="direct-matched-contact"'), 'Must define #direct-matched-contact');
      assert.ok(html.includes('id="btn-start-direct-chat"'), 'Must define #btn-start-direct-chat');
      assert.ok(html.includes('id="group-name-input"'), 'Must define #group-name-input');
      assert.ok(html.includes('id="group-member-phone"'), 'Must define #group-member-phone');
      assert.ok(html.includes('id="btn-add-group-member"'), 'Must define #btn-add-group-member');
      assert.ok(html.includes('id="group-members-chips"'), 'Must define #group-members-chips');
      assert.ok(html.includes('id="btn-create-group"'), 'Must define #btn-create-group');

      // Phase 4C: Message History & Rendering DOM elements
      assert.ok(html.includes('id="messages-loading"'), 'Must define #messages-loading');
      assert.ok(html.includes('id="messages-error"'), 'Must define #messages-error');
      assert.ok(html.includes('id="btn-retry-messages"'), 'Must define #btn-retry-messages');
      assert.ok(html.includes('id="messages-empty"'), 'Must define #messages-empty');
      assert.ok(html.includes('id="messages-scroll-area"'), 'Must define #messages-scroll-area');
      assert.ok(html.includes('id="older-messages-loader"'), 'Must define #older-messages-loader');
      assert.ok(html.includes('id="messages-list"'), 'Must define #messages-list');
      assert.ok(html.includes('id="scroll-bottom-btn"'), 'Must define #scroll-bottom-btn');
    });
  });

  describe('2. ChatShellState State Transitions', () => {
    test('initial state contains expected defaults', () => {
      const state = new ChatShellState();
      assert.deepEqual(state.conversations, []);
      assert.equal(state.searchQuery, '');
      assert.equal(state.selectedRoomId, null);
      assert.equal(state.isLoadingInbox, false);
      assert.equal(state.inboxError, null);
      assert.equal(state.wsState, 'disconnected');
      assert.equal(state.wsDetails, null);
      assert.equal(state.currentUser, null);
    });

    test('inbox loading state sets isLoadingInbox and clears errors', () => {
      const state = new ChatShellState();
      state.setInboxError('Previous error');
      assert.equal(state.inboxError, 'Previous error');

      state.setInboxLoading(true);
      assert.equal(state.isLoadingInbox, true);
      assert.equal(state.inboxError, null);

      state.setInboxLoading(false);
      assert.equal(state.isLoadingInbox, false);
    });

    test('inbox success state stores normalized conversations', () => {
      const state = new ChatShellState();
      state.setInboxLoading(true);

      const mockConversations = [
        {
          roomId: 'room-1',
          kind: 'direct',
          name: null,
          peer: { displayName: 'Bob Martin', phone: '+15551234567', userId: 'user-b' },
          lastMessage: { preview: 'Hello there', createdAt: '2026-09-21T10:00:00Z', kind: 'text' },
          unreadCount: 1
        },
        {
          roomId: 'room-2',
          kind: 'group',
          name: 'Engineering Team',
          peer: null,
          lastMessage: { preview: 'Deployment ready', createdAt: '2026-09-21T10:30:00Z', kind: 'text' },
          unreadCount: 0
        }
      ];

      state.setInbox(mockConversations);
      assert.equal(state.isLoadingInbox, false);
      assert.equal(state.inboxError, null);
      assert.equal(state.conversations.length, 2);
      assert.equal(state.conversations[0].roomId, 'room-1');
      assert.equal(state.conversations[1].roomId, 'room-2');
    });

    test('empty inbox state handling', () => {
      const state = new ChatShellState();
      state.setInboxLoading(true);
      state.setInbox([]);

      assert.equal(state.isLoadingInbox, false);
      assert.deepEqual(state.conversations, []);
      assert.equal(state.inboxError, null);
    });

    test('inbox API error state handling', () => {
      const state = new ChatShellState();
      state.setInboxLoading(true);
      state.setInboxError('Failed to fetch conversations: Network error');

      assert.equal(state.isLoadingInbox, false);
      assert.equal(state.inboxError, 'Failed to fetch conversations: Network error');

      // Also accepts error object
      state.setInboxError(new Error('500 Server error'));
      assert.equal(state.inboxError, '500 Server error');
    });

    test('conversation selection stores selectedRoomId and returns matching item', () => {
      const state = new ChatShellState();
      state.setInbox([
        { roomId: 'room-101', name: 'General Chat', kind: 'group' },
        { roomId: 'room-102', name: 'Private Chat', kind: 'direct' }
      ]);

      assert.equal(state.getSelectedConversation(), null);

      state.selectConversation('room-101');
      assert.equal(state.selectedRoomId, 'room-101');
      const selected = state.getSelectedConversation();
      assert.ok(selected);
      assert.equal(selected.name, 'General Chat');

      state.selectConversation('non-existent');
      assert.equal(state.selectedRoomId, 'non-existent');
      assert.equal(state.getSelectedConversation(), null);

      state.selectConversation(null);
      assert.equal(state.selectedRoomId, null);
    });

    test('logout clear resets all chat state', () => {
      const state = new ChatShellState();
      state.setCurrentUser({ displayName: 'Alice', phone: '+15550001111' });
      state.setInbox([{ roomId: 'room-1', name: 'Test' }]);
      state.selectConversation('room-1');
      state.setSearchQuery('test');
      state.setWsState('connected');

      state.clear();

      assert.deepEqual(state.conversations, []);
      assert.equal(state.searchQuery, '');
      assert.equal(state.selectedRoomId, null);
      assert.equal(state.isLoadingInbox, false);
      assert.equal(state.inboxError, null);
      assert.equal(state.wsState, 'disconnected');
      assert.equal(state.currentUser, null);
    });
  });

  describe('3. WebSocket Connection State Display', () => {
    test('setWsState normalizes and tracks connection states', () => {
      const state = new ChatShellState();

      state.setWsState('CONNECTED');
      assert.equal(state.wsState, 'connected');

      state.setWsState('CONNECTING');
      assert.equal(state.wsState, 'connecting');

      state.setWsState('RECONNECTING');
      assert.equal(state.wsState, 'reconnecting');

      state.setWsState('ERROR', { message: 'Connection timeout' });
      assert.equal(state.wsState, 'error');
      assert.equal(state.wsDetails.message, 'Connection timeout');

      state.setWsState('DISCONNECTED');
      assert.equal(state.wsState, 'disconnected');
    });
  });

  describe('4. Search & Filter Behavior', () => {
    const items = [
      {
        roomId: 'room-1',
        kind: 'direct',
        name: null,
        peer: { displayName: 'John Doe', phone: '+15551112222' },
        lastMessage: { preview: 'See you tomorrow' }
      },
      {
        roomId: 'room-2',
        kind: 'direct',
        name: null,
        peer: { displayName: 'Jane Smith', phone: '+15553334444' },
        lastMessage: { preview: 'Coffee meeting' }
      },
      {
        roomId: 'room-3',
        kind: 'group',
        name: 'Project Orion',
        peer: null,
        lastMessage: { preview: 'Pull request approved' }
      }
    ];

    test('returns all conversations when query is empty', () => {
      assert.equal(filterConversations(items, '').length, 3);
      assert.equal(filterConversations(items, '   ').length, 3);
      assert.equal(filterConversations(items, null).length, 3);
    });

    test('filters by peer display name case-insensitively', () => {
      const results = filterConversations(items, 'jane');
      assert.equal(results.length, 1);
      assert.equal(results[0].roomId, 'room-2');
    });

    test('filters by group name', () => {
      const results = filterConversations(items, 'orion');
      assert.equal(results.length, 1);
      assert.equal(results[0].roomId, 'room-3');
    });

    test('filters by phone number', () => {
      const results = filterConversations(items, '1112222');
      assert.equal(results.length, 1);
      assert.equal(results[0].roomId, 'room-1');
    });

    test('filters by last message preview text', () => {
      const results = filterConversations(items, 'pull request');
      assert.equal(results.length, 1);
      assert.equal(results[0].roomId, 'room-3');
    });

    test('returns empty array when no conversations match', () => {
      const results = filterConversations(items, 'xyz-nonexistent');
      assert.equal(results.length, 0);
    });
  });

  describe('5. Formatting & Presentation Helpers', () => {
    test('getConversationTitle resolves group name, peer name, phone, or default', () => {
      // Group with name
      assert.equal(getConversationTitle({ kind: 'group', name: 'Olla Team' }), 'Olla Team');

      // Direct with peer displayName
      assert.equal(
        getConversationTitle({ kind: 'direct', peer: { displayName: 'Sarah Connor' } }),
        'Sarah Connor'
      );

      // Direct with peer phone
      assert.equal(
        getConversationTitle({ kind: 'direct', peer: { phone: '+15559876543' } }),
        '+15559876543'
      );

      // Direct with peer userId
      assert.equal(
        getConversationTitle({ kind: 'direct', peer: { userId: 'user_123' } }),
        'user_123'
      );

      // Fallbacks
      assert.equal(getConversationTitle({ kind: 'group' }), 'Group Conversation');
      assert.equal(getConversationTitle({ kind: 'direct' }), 'Direct Conversation');
      assert.equal(getConversationTitle(null), 'Conversation');
    });

    test('getConversationSubtitle formats appropriate info string', () => {
      assert.equal(getConversationSubtitle({ kind: 'group' }), 'Group conversation');
      assert.equal(
        getConversationSubtitle({ kind: 'direct', peer: { phone: '+1234567890' } }),
        '+1234567890'
      );
      assert.equal(getConversationSubtitle({ kind: 'direct' }), 'Direct chat');
    });

    test('getAvatarInitials generates clean 1-2 letter initials', () => {
      assert.equal(getAvatarInitials('Alice Smith'), 'AS');
      assert.equal(getAvatarInitials('Alice'), 'AL');
      assert.equal(getAvatarInitials('+15551234567'), '67');
      assert.equal(getAvatarInitials(''), 'OC');
      assert.equal(getAvatarInitials(null), 'OC');
    });

    test('getAvatarColor returns deterministic HSL color', () => {
      const color1 = getAvatarColor('Alice');
      const color2 = getAvatarColor('Alice');
      const color3 = getAvatarColor('Bob');

      assert.equal(color1, color2, 'Same input must produce same color');
      assert.ok(color1.startsWith('hsl('), 'Must be HSL format');
      assert.notEqual(color1, color3, 'Different inputs should generally produce different hues');
    });

    test('formatConversationTime handles today, yesterday, recent days, and older dates', () => {
      const baseNow = new Date('2026-09-21T15:00:00.000Z');

      // Today
      const todayDate = new Date('2026-09-21T10:30:00.000Z');
      const todayFormatted = formatConversationTime(todayDate, baseNow);
      assert.ok(todayFormatted.includes(':'), 'Today format must include colon time');

      // Yesterday
      const yesterdayDate = new Date('2026-09-20T12:00:00.000Z');
      assert.equal(formatConversationTime(yesterdayDate, baseNow), 'Yesterday');

      // 3 days ago (within 6 days)
      const recentDate = new Date('2026-09-18T12:00:00.000Z');
      const recentFormatted = formatConversationTime(recentDate, baseNow);
      assert.ok(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].includes(recentFormatted));

      // Older date
      const olderDate = new Date('2026-08-10T12:00:00.000Z');
      const olderFormatted = formatConversationTime(olderDate, baseNow);
      assert.equal(olderFormatted, '10/08/26');

      // Null or invalid
      assert.equal(formatConversationTime(null), '');
      assert.equal(formatConversationTime('invalid-date'), '');
    });

    test('getConversationPreview handles text, media types, and missing messages', () => {
      assert.equal(
        getConversationPreview({ lastMessage: { preview: 'Hey there!' } }),
        'Hey there!'
      );
      assert.equal(
        getConversationPreview({ lastMessage: { preview: '', kind: 'image' } }),
        '📷 Photo'
      );
      assert.equal(
        getConversationPreview({ lastMessage: { preview: '', kind: 'video' } }),
        '🎥 Video'
      );
      assert.equal(
        getConversationPreview({ lastMessage: { preview: '', kind: 'audio' } }),
        '🎵 Voice message'
      );
      assert.equal(
        getConversationPreview({ lastMessage: { preview: '', kind: 'file' } }),
        '📎 Attachment'
      );
      assert.equal(getConversationPreview({ lastMessage: null }), 'No messages yet');
      assert.equal(getConversationPreview(null), 'No messages yet');
    });
  });

  describe('6. Direct Chat Validation & Draft State', () => {
    test('validatePhone validates international and local phone numbers', () => {
      // Valid cases
      assert.equal(validatePhone('+15551234567').valid, true);
      assert.equal(validatePhone('+15551234567').cleaned, '+15551234567');
      assert.equal(validatePhone('+91 98765 43210').valid, true);
      assert.equal(validatePhone('+91 98765 43210').cleaned, '+919876543210');
      assert.equal(validatePhone('9876-543-210').valid, true);
      assert.equal(validatePhone('9876-543-210').cleaned, '9876543210');

      // Invalid cases
      assert.equal(validatePhone('').valid, false);
      assert.equal(validatePhone('   ').valid, false);
      assert.equal(validatePhone(null).valid, false);
      assert.equal(validatePhone('12').valid, false);
      assert.equal(validatePhone('abcdef').valid, false);
    });

    test('DirectChatDraft lifecycle: lookup, matched contact, and start state', () => {
      const draft = new DirectChatDraft();
      assert.equal(draft.canStart(), false);

      draft.setPhone('+15551112222');
      assert.equal(draft.phone, '+15551112222');
      assert.equal(draft.canStart(), false);

      // Contact matched
      draft.setMatchedContact({
        userId: 'user-alice-123',
        phone: '+15551112222',
        displayName: 'Alice Smith'
      });
      assert.equal(draft.canStart(), true);
      assert.equal(draft.matchedContact.userId, 'user-alice-123');

      // Submitting state blocks starting
      draft.isSubmitting = true;
      assert.equal(draft.canStart(), false);
      draft.isSubmitting = false;
      assert.equal(draft.canStart(), true);

      // Reset
      draft.reset();
      assert.equal(draft.phone, '');
      assert.equal(draft.matchedContact, null);
      assert.equal(draft.canStart(), false);
    });
  });

  describe('7. Group Creation Validation & Member Management', () => {
    test('validateGroupName enforces 6 to 60 characters and whitespace trimming', () => {
      assert.equal(validateGroupName('Project Orion').valid, true);
      assert.equal(validateGroupName('Project Orion').name, 'Project Orion');
      assert.equal(validateGroupName('   Family Chat   ').valid, true);
      assert.equal(validateGroupName('   Family Chat   ').name, 'Family Chat');
      assert.equal(validateGroupName('123456').valid, true);
      assert.equal(validateGroupName('a'.repeat(60)).valid, true);

      // Invalid
      assert.equal(validateGroupName('').valid, false);
      assert.equal(validateGroupName('   ').valid, false);
      assert.equal(validateGroupName(null).valid, false);
      assert.equal(validateGroupName('12345').valid, false);
      assert.equal(validateGroupName('  abc  ').valid, false);
      assert.equal(validateGroupName('a'.repeat(61)).valid, false);
    });

    test('GroupCreationDraft manages name, members, duplicate prevention, and user exclusion', () => {
      const draft = new GroupCreationDraft();
      assert.equal(draft.canSubmit(), false);

      draft.setName('Frontend Devs');
      assert.equal(draft.canSubmit(), false, 'Cannot submit without at least 1 member');

      // Adding creator is blocked
      const creatorRes = draft.addMember({ userId: 'current-user-id', phone: '+1000' }, 'current-user-id');
      assert.equal(creatorRes.added, false);
      assert.equal(draft.members.length, 0);

      // Add valid member
      const member1 = { userId: 'user-bob', phone: '+15552223333', displayName: 'Bob' };
      const addRes1 = draft.addMember(member1, 'current-user-id');
      assert.equal(addRes1.added, true);
      assert.equal(draft.members.length, 1);
      assert.equal(draft.canSubmit(), true);

      // Duplicate member is blocked
      const dupRes = draft.addMember(member1, 'current-user-id');
      assert.equal(dupRes.added, false);
      assert.equal(draft.members.length, 1);

      // Add second member
      const member2 = { userId: 'user-carol', phone: '+15554445555', displayName: 'Carol' };
      draft.addMember(member2, 'current-user-id');
      assert.equal(draft.members.length, 2);

      // Verify getMemberUserIds returns array of user IDs (never phones)
      const ids = draft.getMemberUserIds();
      assert.deepEqual(ids, ['user-bob', 'user-carol']);

      // Remove member
      draft.removeMember('user-bob');
      assert.equal(draft.members.length, 1);
      assert.deepEqual(draft.getMemberUserIds(), ['user-carol']);

      // Reset
      draft.reset();
      assert.equal(draft.name, '');
      assert.deepEqual(draft.members, []);
      assert.equal(draft.canSubmit(), false);
    });
  });

  describe('8. Shell Integration after Creation Flow', () => {
    test('new conversation can be added and selected in ChatShellState', () => {
      const state = new ChatShellState();
      state.setInbox([
        { roomId: 'room-1', name: 'Existing Chat', kind: 'direct' }
      ]);

      assert.equal(state.conversations.length, 1);
      assert.equal(state.selectedRoomId, null);

      // Simulate new direct conversation opened
      const newDirect = {
        roomId: 'room-2',
        kind: 'direct',
        name: null,
        peer: { userId: 'user-david', displayName: 'David Miller', phone: '+15557778888' },
        lastMessage: null,
        unreadCount: 0
      };

      state.setInbox([newDirect, ...state.conversations]);
      state.selectConversation('room-2');

      assert.equal(state.conversations.length, 2);
      assert.equal(state.selectedRoomId, 'room-2');
      const selected = state.getSelectedConversation();
      assert.ok(selected);
      assert.equal(selected.roomId, 'room-2');
      assert.equal(getConversationTitle(selected), 'David Miller');
    });

    test('new group conversation can be added and selected in ChatShellState', () => {
      const state = new ChatShellState();

      const newGroup = {
        roomId: 'room-group-99',
        kind: 'group',
        name: 'Architecture Board',
        peer: null,
        lastMessage: null,
        unreadCount: 0
      };

      state.setInbox([newGroup]);
      state.selectConversation('room-group-99');

      assert.equal(state.selectedRoomId, 'room-group-99');
      const selected = state.getSelectedConversation();
      assert.ok(selected);
      assert.equal(getConversationTitle(selected), 'Architecture Board');
      assert.equal(getConversationSubtitle(selected), 'Group conversation');
    });
  });

});
