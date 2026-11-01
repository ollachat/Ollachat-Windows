import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ChatShellState,
  getConversationTitle,
  filterConversations,
  setDefaultNicknameResolver
} from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// In-memory mock localStorage
const mockStorage = new Map();
globalThis.localStorage = {
  getItem: (key) => (mockStorage.has(key) ? mockStorage.get(key) : null),
  setItem: (key, val) => mockStorage.set(key, String(val)),
  removeItem: (key) => mockStorage.delete(key),
  clear: () => mockStorage.clear()
};

describe('WhatsApp-Style Personal Contact Nickname / Alias Feature', () => {
  beforeEach(() => {
    mockStorage.clear();
    setDefaultNicknameResolver(null);
  });

  describe('1. Basic Nickname Operations (Add, Edit, Remove)', () => {
    test('1. Add nickname to contact sets and returns clean nickname', () => {
      const state = new ChatShellState();
      state.setCurrentUser({ userId: 'user_me', displayName: 'Me' });

      const nick = state.setContactNickname('contact_1', 'Rahul');
      assert.equal(nick, 'Rahul');
      assert.equal(state.getContactNickname('contact_1'), 'Rahul');
      assert.equal(state.hasContactNickname('contact_1'), true);
    });

    test('2. Nickname persists to localStorage under user-scoped key', () => {
      const state = new ChatShellState();
      state.setCurrentUser({ userId: 'user_me', displayName: 'Me' });

      state.setContactNickname('contact_1', 'Rahul');

      const raw = globalThis.localStorage.getItem('ollachat_contact_nicknames_user_me');
      assert.ok(raw, 'Must save to ollachat_contact_nicknames_user_me');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.contact_1, 'Rahul');
    });

    test('3. Edit nickname updates the stored value', () => {
      const state = new ChatShellState();
      state.setCurrentUser({ userId: 'user_me', displayName: 'Me' });

      state.setContactNickname('contact_1', 'Rahul');
      assert.equal(state.getContactNickname('contact_1'), 'Rahul');

      state.setContactNickname('contact_1', 'Rahul Sharma');
      assert.equal(state.getContactNickname('contact_1'), 'Rahul Sharma');

      const parsed = JSON.parse(globalThis.localStorage.getItem('ollachat_contact_nicknames_user_me'));
      assert.equal(parsed.contact_1, 'Rahul Sharma');
    });

    test('4. Remove nickname deletes entry and updates storage', () => {
      const state = new ChatShellState();
      state.setCurrentUser({ userId: 'user_me', displayName: 'Me' });

      state.setContactNickname('contact_1', 'Rahul');
      assert.equal(state.hasContactNickname('contact_1'), true);

      const removed = state.removeContactNickname('contact_1');
      assert.equal(removed, true);
      assert.equal(state.getContactNickname('contact_1'), null);
      assert.equal(state.hasContactNickname('contact_1'), false);

      const parsed = JSON.parse(globalThis.localStorage.getItem('ollachat_contact_nicknames_user_me'));
      assert.equal(parsed.contact_1, undefined);
    });

    test('5. Empty or whitespace-only nickname removes nickname and restores original name', () => {
      const state = new ChatShellState();
      state.setCurrentUser({ userId: 'user_me', displayName: 'Me' });

      state.setContactNickname('contact_1', 'Rahul');
      assert.equal(state.getContactNickname('contact_1'), 'Rahul');

      // Empty string
      const res1 = state.setContactNickname('contact_1', '');
      assert.equal(res1, null);
      assert.equal(state.getContactNickname('contact_1'), null);

      // Whitespace only
      state.setContactNickname('contact_1', 'Rahul');
      const res2 = state.setContactNickname('contact_1', '     ');
      assert.equal(res2, null);
      assert.equal(state.getContactNickname('contact_1'), null);
    });
  });

  describe('2. User Scoping & Account Isolation', () => {
    test('6. Nickname is isolated to logged-in user and does not leak to another user', () => {
      // User A logs in and sets nickname for contact_1
      const stateA = new ChatShellState();
      stateA.setCurrentUser({ userId: 'user_A', displayName: 'Alice' });
      stateA.setContactNickname('contact_1', 'My Best Friend');
      assert.equal(stateA.getContactNickname('contact_1'), 'My Best Friend');

      // User B logs in on same desktop client
      const stateB = new ChatShellState();
      stateB.setCurrentUser({ userId: 'user_B', displayName: 'Bob' });
      assert.equal(stateB.getContactNickname('contact_1'), null, 'User B must not see User A nickname');

      // User A logs back in
      const stateA2 = new ChatShellState();
      stateA2.setCurrentUser({ userId: 'user_A', displayName: 'Alice' });
      assert.equal(stateA2.getContactNickname('contact_1'), 'My Best Friend', 'User A nickname must still be intact');
    });

    test('7. Different users can have different nicknames for the same contact', () => {
      const stateA = new ChatShellState();
      stateA.setCurrentUser({ userId: 'user_A', displayName: 'Alice' });
      stateA.setContactNickname('contact_shared', 'Rahul from Work');

      const stateB = new ChatShellState();
      stateB.setCurrentUser({ userId: 'user_B', displayName: 'Bob' });
      stateB.setContactNickname('contact_shared', 'Rahul Gym Buddy');

      assert.equal(stateA.getContactNickname('contact_shared'), 'Rahul from Work');
      assert.equal(stateB.getContactNickname('contact_shared'), 'Rahul Gym Buddy');
    });

    test('8. Logout clears in-memory nicknames', () => {
      const state = new ChatShellState();
      state.setCurrentUser({ userId: 'user_A', displayName: 'Alice' });
      state.setContactNickname('contact_1', 'Buddy');
      assert.equal(state.getContactNickname('contact_1'), 'Buddy');

      state.clear();
      assert.equal(state.contactNicknames.size, 0);
      assert.equal(state.getContactNickname('contact_1'), null);
    });

    test('9. Nickname survives application restart (reloading preferences)', () => {
      // Session 1
      const state1 = new ChatShellState();
      state1.setCurrentUser({ userId: 'user_1', displayName: 'One' });
      state1.setContactNickname('c123', 'My Contact');

      // Session 2 (simulate client restart by creating new state with same user)
      const state2 = new ChatShellState();
      state2.setCurrentUser({ userId: 'user_1', displayName: 'One' });
      assert.equal(state2.getContactNickname('c123'), 'My Contact');
    });
  });

  describe('3. Display Precedence & Conversation Resolution', () => {
    test('10. Precedence: Personal Nickname -> Server Profile Name -> Phone -> Fallback', () => {
      const state = new ChatShellState();
      state.setCurrentUser({ userId: 'user_me', displayName: 'Me' });

      const conv = {
        kind: 'direct',
        peer: {
          userId: 'u_target',
          displayName: 'r contact',
          phone: '+15550002222'
        }
      };

      // No nickname: displays server profile name
      assert.equal(state.getConversationTitle(conv), 'r contact');

      // Nickname set: displays nickname
      state.setContactNickname('u_target', 'Rahul');
      assert.equal(state.getConversationTitle(conv), 'Rahul');

      // Remove nickname: restores server profile name
      state.removeContactNickname('u_target');
      assert.equal(state.getConversationTitle(conv), 'r contact');

      // When server profile name is empty: falls back to phone
      const convNoName = {
        kind: 'direct',
        peer: {
          userId: 'u_target2',
          phone: '+15550002222'
        }
      };
      assert.equal(state.getConversationTitle(convNoName), '+15550002222');

      // With nickname on no-name contact: displays nickname
      state.setContactNickname('u_target2', 'Vikram');
      assert.equal(state.getConversationTitle(convNoName), 'Vikram');
    });

    test('11. Real OllaCore profile name remains untouched on peer object', () => {
      const state = new ChatShellState();
      state.setCurrentUser({ userId: 'user_me', displayName: 'Me' });

      const conv = {
        kind: 'direct',
        peer: {
          userId: 'u_target',
          displayName: 'r contact',
          phone: '+15550002222'
        }
      };

      state.setContactNickname('u_target', 'Rahul');
      assert.equal(state.getConversationTitle(conv), 'Rahul');
      // Server name must not be mutated
      assert.equal(conv.peer.displayName, 'r contact');
    });

    test('12. Group conversation titles are never replaced by a contact nickname', () => {
      const state = new ChatShellState();
      state.setCurrentUser({ userId: 'user_me', displayName: 'Me' });

      state.setContactNickname('group_123', 'My Nickname');

      const groupConv = {
        kind: 'group',
        roomId: 'group_123',
        name: 'Project Alpha'
      };

      assert.equal(state.getConversationTitle(groupConv), 'Project Alpha');
    });

    test('13. Contact without nickname continues displaying normal profile name', () => {
      const state = new ChatShellState();
      state.setCurrentUser({ userId: 'user_me', displayName: 'Me' });

      const conv = {
        kind: 'direct',
        peer: {
          userId: 'u_other',
          displayName: 'Jane Doe',
          phone: '+1234567890'
        }
      };

      assert.equal(state.getConversationTitle(conv), 'Jane Doe');
    });
  });

  describe('4. Search & Filter Integration', () => {
    test('14. filterConversations matches personal nickname, server displayName, and phone', () => {
      const state = new ChatShellState();
      state.setCurrentUser({ userId: 'user_me', displayName: 'Me' });
      state.setContactNickname('u_target', 'Rahul');

      const conversations = [
        {
          roomId: 'r1',
          kind: 'direct',
          peer: { userId: 'u_target', displayName: 'r contact', phone: '+15550002222' },
          lastMessage: { preview: 'Hey there' }
        },
        {
          roomId: 'r2',
          kind: 'direct',
          peer: { userId: 'u_bob', displayName: 'Bob Builder', phone: '+15551234567' },
          lastMessage: { preview: 'Can we fix it?' }
        }
      ];

      // 1. Search by nickname "Rahul"
      const res1 = filterConversations(conversations, 'Rahul', (id) => state.getContactNickname(id));
      assert.equal(res1.length, 1);
      assert.equal(res1[0].roomId, 'r1');

      // 2. Search by real server name "r contact"
      const res2 = filterConversations(conversations, 'r contact', (id) => state.getContactNickname(id));
      assert.equal(res2.length, 1);
      assert.equal(res2[0].roomId, 'r1');

      // 3. Search by phone number
      const res3 = filterConversations(conversations, '5550002222', (id) => state.getContactNickname(id));
      assert.equal(res3.length, 1);
      assert.equal(res3[0].roomId, 'r1');

      // 4. Search by message preview
      const res4 = filterConversations(conversations, 'fix it', (id) => state.getContactNickname(id));
      assert.equal(res4.length, 1);
      assert.equal(res4[0].roomId, 'r2');
    });

    test('15. getFilteredConversations resolves nickname during search', () => {
      const state = new ChatShellState();
      state.setCurrentUser({ userId: 'user_me', displayName: 'Me' });
      state.setContactNickname('u_target', 'Rahul');

      state.setInbox([
        {
          roomId: 'r1',
          kind: 'direct',
          peer: { userId: 'u_target', displayName: 'r contact', phone: '+15550002222' }
        },
        {
          roomId: 'r2',
          kind: 'direct',
          peer: { userId: 'u_bob', displayName: 'Bob Builder', phone: '+15551234567' }
        }
      ]);

      state.setSearchQuery('Rahul');
      const filtered = state.getFilteredConversations();
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].roomId, 'r1');
    });
  });

  describe('5. Edge Cases & Safety', () => {
    test('16. Null/undefined/empty userId fails safely', () => {
      const state = new ChatShellState();
      state.setCurrentUser({ userId: 'user_me', displayName: 'Me' });

      assert.equal(state.getContactNickname(null), null);
      assert.equal(state.getContactNickname(''), null);
      assert.equal(state.setContactNickname(null, 'Test'), null);
      assert.equal(state.setContactNickname('', 'Test'), null);
      assert.equal(state.removeContactNickname(null), false);
      assert.equal(state.hasContactNickname(null), false);
    });

    test('17. Unicode characters and emojis are supported in nicknames', () => {
      const state = new ChatShellState();
      state.setCurrentUser({ userId: 'user_me', displayName: 'Me' });

      const emojiNick = 'Rahul 🚀 (भाई)';
      state.setContactNickname('u_emoji', emojiNick);
      assert.equal(state.getContactNickname('u_emoji'), emojiNick);

      const conv = {
        kind: 'direct',
        peer: { userId: 'u_emoji', displayName: 'r contact' }
      };
      assert.equal(state.getConversationTitle(conv), emojiNick);
    });

    test('18. Extremely long nicknames are trimmed safely', () => {
      const state = new ChatShellState();
      state.setCurrentUser({ userId: 'user_me', displayName: 'Me' });

      const veryLong = 'A'.repeat(100);
      const saved = state.setContactNickname('u_long', veryLong);
      assert.ok(saved.length <= 60, 'Nickname must be capped to max length');
      assert.equal(state.getContactNickname('u_long'), veryLong.slice(0, 60));
    });
  });

  describe('6. DOM & UI Structure Verification', () => {
    test('19. index.html contains required nickname elements in Contact Info panel', () => {
      const indexPath = path.join(projectRoot, 'src', 'renderer', 'index.html');
      const html = fs.readFileSync(indexPath, 'utf8');

      // Nickname action button & form
      assert.ok(html.includes('id="btn-contact-info-nickname-action"'), 'Must define #btn-contact-info-nickname-action');
      assert.ok(html.includes('id="contact-info-nickname-action-label"'), 'Must define #contact-info-nickname-action-label');
      assert.ok(html.includes('id="contact-info-nickname-form"'), 'Must define #contact-info-nickname-form');
      assert.ok(html.includes('id="contact-info-nickname-input"'), 'Must define #contact-info-nickname-input');
      assert.ok(html.includes('id="btn-contact-info-save-nickname"'), 'Must define #btn-contact-info-save-nickname');
      assert.ok(html.includes('id="btn-contact-info-cancel-nickname"'), 'Must define #btn-contact-info-cancel-nickname');
      assert.ok(html.includes('id="btn-contact-info-remove-nickname"'), 'Must define #btn-contact-info-remove-nickname');

      // Server profile name detail row
      assert.ok(html.includes('id="contact-info-server-name-row"'), 'Must define #contact-info-server-name-row');
      assert.ok(html.includes('id="contact-info-server-name-value"'), 'Must define #contact-info-server-name-value');
    });

    test('20. styles.css contains .contact-info-nickname-btn styles', () => {
      const cssPath = path.join(projectRoot, 'src', 'renderer', 'styles.css');
      const css = fs.readFileSync(cssPath, 'utf8');

      assert.ok(css.includes('.contact-info-nickname-btn'), 'Must style .contact-info-nickname-btn');
    });

    test('21. app.js binds contact nickname elements and event handlers', () => {
      const appPath = path.join(projectRoot, 'src', 'renderer', 'app.js');
      const appJs = fs.readFileSync(appPath, 'utf8');

      assert.ok(appJs.includes('btnContactInfoNicknameAction'), 'Must reference btnContactInfoNicknameAction');
      assert.ok(appJs.includes('handleSaveContactNickname'), 'Must implement handleSaveContactNickname');
      assert.ok(appJs.includes('btnContactInfoRemoveNickname'), 'Must handle btnContactInfoRemoveNickname');
      assert.ok(appJs.includes('contactInfoServerNameRow'), 'Must manage contactInfoServerNameRow');
    });
  });

  describe('7. Security & Privacy Guarantees', () => {
    test('22. Nickname data is strictly local and never sent to OllaCore backend or WebSocket', () => {
      const apiPath = path.join(projectRoot, 'src', 'api', 'ollacore-api.js');
      const wsPath = path.join(projectRoot, 'src', 'chat', 'chat-websocket.js');

      const apiCode = fs.readFileSync(apiPath, 'utf8');
      const wsCode = fs.readFileSync(wsPath, 'utf8');

      // Ensure no contact nickname endpoints or payload fields were added
      assert.ok(!apiCode.includes('contactNickname'), 'API client must not transmit contact nicknames');
      assert.ok(!apiCode.includes('contact-nickname'), 'API client must not have nickname endpoints');
      assert.ok(!wsCode.includes('contactNickname'), 'WebSocket client must not transmit contact nicknames');
    });
  });
});
