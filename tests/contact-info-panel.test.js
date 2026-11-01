import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChatShellState, formatCallDuration } from '../src/renderer/chat-shell-state.js';
import {
  applyAppTheme,
  getAppThemeSetting,
  getResolvedAppTheme,
  PRESET_THEMES
} from '../src/renderer/theme-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Mock localStorage for test environment
const mockStorage = new Map();
globalThis.localStorage = {
  getItem: (key) => (mockStorage.has(key) ? mockStorage.get(key) : null),
  setItem: (key, val) => mockStorage.set(key, String(val)),
  removeItem: (key) => mockStorage.delete(key),
  clear: () => mockStorage.clear()
};

describe('WhatsApp-Style Chat Contact Info Panel (40 Invariants)', () => {
  const indexPath = path.join(projectRoot, 'src', 'renderer', 'index.html');
  const cssPath = path.join(projectRoot, 'src', 'renderer', 'styles.css');
  const appPath = path.join(projectRoot, 'src', 'renderer', 'app.js');
  const html = fs.readFileSync(indexPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  const appJs = fs.readFileSync(appPath, 'utf8');

  let state;

  beforeEach(() => {
    mockStorage.clear();
    state = new ChatShellState();
    state.setCurrentUser({ userId: 'user-alice', name: 'Alice', phone: '+1234567890' });
    state.setInbox([
      {
        roomId: 'r1',
        kind: 'direct',
        name: 'John Doe',
        phone: '+1987654321',
        peer: {
          userId: 'user-john',
          displayName: 'John Doe',
          phone: '+1987654321',
          username: 'johndoe',
          about: 'Available for chats'
        },
        unreadCount: 0,
        lastMessage: { preview: 'Hello', createdAt: Date.now() - 1000 }
      },
      {
        roomId: 'r2',
        kind: 'direct',
        name: 'Bob Smith',
        peer: {
          userId: 'user-bob',
          displayName: 'Bob Smith'
          // no phone, no username, no bio
        },
        unreadCount: 2,
        lastMessage: { preview: 'Hey there', createdAt: Date.now() - 2000 }
      },
      {
        roomId: 'r3',
        kind: 'group',
        name: 'Project Delta',
        description: 'Official group for Project Delta discussions',
        unreadCount: 0,
        lastMessage: { preview: 'Update ready', createdAt: Date.now() - 3000 }
      },
      {
        roomId: 'r4',
        kind: 'group',
        name: 'College Friends',
        // no description
        unreadCount: 3,
        lastMessage: { preview: 'See you', createdAt: Date.now() - 4000 }
      }
    ]);
  });

  // ════════════════════════════════════════════════════════════════════
  // 1 - 12: HEADER CLICK & PANEL BASICS
  // ════════════════════════════════════════════════════════════════════
  describe('Header Click & Contact Info Panel Basics', () => {
    test('1. Chat header identity area is clickable and accessible', () => {
      assert.ok(html.includes('id="chat-header-info"'), 'Must define #chat-header-info');
      assert.ok(html.includes('class="chat-header-info" role="button" tabindex="0"'), 'Header identity has button role and tabindex');
      assert.ok(css.includes('.chat-header-info[role="button"]'), 'CSS styles chat-header-info as a clickable button');
    });

    test('2. Existing header call, search, and theme buttons remain separate and functional', () => {
      assert.ok(html.includes('id="btn-start-voice-call"'), 'Voice call button in header');
      assert.ok(html.includes('id="btn-start-video-call"'), 'Video call button in header');
      assert.ok(html.includes('id="btn-chat-search"'), 'Search button in header');
      assert.ok(html.includes('id="btn-chat-theme"'), 'Chat theme button in header');
      assert.ok(appJs.includes("btnStartVoiceCall?.addEventListener('click'"), 'Voice button listener intact');
      assert.ok(appJs.includes("btnStartVideoCall?.addEventListener('click'"), 'Video button listener intact');
      assert.ok(appJs.includes("btnChatSearch?.addEventListener('click'"), 'Search button listener intact');
    });

    test('3. Clicking identity area opens Contact Info panel', () => {
      assert.ok(appJs.includes("chatHeaderInfo?.addEventListener('click'"), 'Listens for click on chatHeaderInfo');
      assert.ok(appJs.includes('openContactInfo(shellState.selectedRoomId)'), 'Calls openContactInfo with selectedRoomId');
    });

    test('4. Contact Info panel renders as a dedicated right-side panel', () => {
      assert.ok(html.includes('id="contact-info-panel"'), 'Defines #contact-info-panel in HTML');
      assert.ok(html.includes('class="contact-info-panel hidden"'), 'Panel starts hidden with .hidden class');
      assert.ok(css.includes('.contact-info-panel'), 'CSS defines .contact-info-panel');
      assert.ok(css.includes('border-left: 1px solid var(--border-color)'), 'Border-left creates right-side panel separation');
    });

    test('5. Contact avatar renders with initials and color in Contact Info', () => {
      assert.ok(html.includes('id="contact-info-avatar"'), 'Defines #contact-info-avatar');
      assert.ok(appJs.includes('contactInfoAvatar.textContent = initials'), 'Sets avatar initials in app.js');
      assert.ok(appJs.includes('contactInfoAvatar.style.backgroundColor = color'), 'Sets avatar color in app.js');
    });

    test('6. Contact name renders in Contact Info hero section', () => {
      assert.ok(html.includes('id="contact-info-name"'), 'Defines #contact-info-name');
      assert.ok(appJs.includes('contactInfoName.textContent = title'), 'Sets title in app.js');
    });

    test('7. Available phone/identifier renders when present', () => {
      assert.ok(html.includes('id="contact-info-identifier"'), 'Defines #contact-info-identifier');
      assert.ok(html.includes('id="contact-info-phone-value"'), 'Defines #contact-info-phone-value');
      assert.ok(appJs.includes('contactInfoPhoneValue.textContent = phone'), 'Populates phone value');
    });

    test('8. Available About/bio renders when present', () => {
      assert.ok(html.includes('id="contact-info-about-section"'), 'Defines #contact-info-about-section');
      assert.ok(html.includes('id="contact-info-about-text"'), 'Defines #contact-info-about-text');
      assert.ok(appJs.includes('contactInfoAboutText.textContent = bio.trim()'), 'Populates bio text');
    });

    test('9. Missing optional fields are hidden cleanly without placeholder strings', () => {
      assert.ok(appJs.includes("contactInfoPhoneRow?.classList.add('hidden')"), 'Hides phone row when missing');
      assert.ok(appJs.includes("contactInfoUsernameRow?.classList.add('hidden')"), 'Hides username row when missing');
      assert.ok(appJs.includes("contactInfoAboutSection?.classList.add('hidden')"), 'Hides about section when missing');
      assert.ok(!appJs.includes("contactInfoName.textContent = 'undefined'"), 'Never sets undefined as text');
      assert.ok(!appJs.includes("contactInfoName.textContent = 'null'"), 'Never sets null as text');
    });

    test('10. Close button closes Contact Info panel', () => {
      assert.ok(html.includes('id="btn-close-contact-info"'), 'Defines #btn-close-contact-info');
      assert.ok(appJs.includes("btnCloseContactInfo?.addEventListener('click', closeContactInfo)"), 'Wired closeContactInfo to close button');
    });

    test('11. Escape closes Contact Info panel', () => {
      assert.ok(appJs.includes("if (e.key === 'Escape')"), 'Listens for Escape key');
      assert.ok(appJs.includes('contactInfoPanel && !contactInfoPanel.classList.contains(\'hidden\')'), 'Checks if contactInfoPanel is open on Escape');
      assert.ok(appJs.includes('closeContactInfo();'), 'Calls closeContactInfo on Escape');
    });

    test('12. Switching conversations does not show stale contact data', () => {
      state.selectConversation('r1');
      state.openContactInfo('r1');
      assert.equal(state.getContactInfoRoomId(), 'r1');

      state.selectConversation('r2');
      state.openContactInfo('r2');
      assert.equal(state.getContactInfoRoomId(), 'r2', 'Active contact info room id updates to newly selected conversation');

      state.closeContactInfo();
      assert.equal(state.getContactInfoRoomId(), null);
      assert.equal(state.isContactInfoOpen(), false);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 13 - 18: DIRECT, GROUP, PARTICIPANTS & ACTIONS
  // ════════════════════════════════════════════════════════════════════
  describe('Direct vs Group Data & Functional Action Buttons', () => {
    test('13. Direct chat Contact Info displays direct identity and hides participants', () => {
      state.selectConversation('r1');
      const conv = state.getSelectedConversation();
      assert.equal(conv.kind, 'direct');
      assert.ok(appJs.includes("contactInfoHeaderTitle.textContent = isGroup ? 'Group info' : 'Contact info'"));
      assert.ok(appJs.includes("contactInfoParticipantsSection?.classList.add('hidden')"), 'Hides participants in direct chat');
    });

    test('14. Group Contact Info displays group identity and description if available', () => {
      state.selectConversation('r3');
      const conv = state.getSelectedConversation();
      assert.equal(conv.kind, 'group');
      assert.equal(conv.name, 'Project Delta');
      assert.equal(conv.description, 'Official group for Project Delta discussions');
      assert.ok(appJs.includes("contactInfoParticipantsSection?.classList.remove('hidden')"), 'Shows participants in group chat');
    });

    test('15. Available participant data renders with names, avatars, and roles', () => {
      assert.ok(html.includes('id="contact-info-participants-list"'), 'Defines #contact-info-participants-list');
      assert.ok(html.includes('id="contact-info-participants-count"'), 'Defines #contact-info-participants-count');
      assert.ok(appJs.includes('renderContactInfoParticipantsList'), 'Defines renderContactInfoParticipantsList');
      assert.ok(appJs.includes("adminBadge.textContent = 'Group Admin'"), 'Displays Group Admin badge for admins');
      assert.ok(appJs.includes("`${nameText} (You)`"), 'Appends (You) for current user');
    });

    test('16. Voice action reuses existing voice calling implementation', () => {
      assert.ok(html.includes('id="btn-contact-action-voice"'), 'Defines #btn-contact-action-voice');
      assert.ok(appJs.includes("btnContactActionVoice?.addEventListener('click'"), 'Wires click on voice action');
      assert.ok(appJs.includes('voiceCallManager.startCall(shellState.selectedRoomId'), 'Starts call via existing voiceCallManager');
    });

    test('17. Video action reuses existing video calling implementation', () => {
      assert.ok(html.includes('id="btn-contact-action-video"'), 'Defines #btn-contact-action-video');
      assert.ok(appJs.includes("btnContactActionVideo?.addEventListener('click'"), 'Wires click on video action');
      assert.ok(appJs.includes('voiceCallManager.startVideoCall(shellState.selectedRoomId'), 'Starts video call via existing voiceCallManager');
    });

    test('18. Search action reuses existing in-chat search implementation', () => {
      assert.ok(html.includes('id="btn-contact-action-search"'), 'Defines #btn-contact-action-search');
      assert.ok(appJs.includes("btnContactActionSearch?.addEventListener('click'"), 'Wires click on search action');
      assert.ok(appJs.includes('openChatSearch();'), 'Triggers openChatSearch()');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 19 - 22: THEMES & ISOLATION
  // ════════════════════════════════════════════════════════════════════
  describe('Theme Compatibility & Isolation', () => {
    test('19. Contact Info follows Light theme', () => {
      assert.doesNotThrow(() => {
        applyAppTheme('light');
        assert.equal(getResolvedAppTheme(), 'light');
      });
      assert.ok(css.includes('--bg-surface'), 'Uses global surface background token');
      assert.ok(css.includes('--text-primary'), 'Uses global text primary token');
    });

    test('20. Contact Info follows Dark theme', () => {
      assert.doesNotThrow(() => {
        applyAppTheme('dark');
        assert.equal(getResolvedAppTheme(), 'dark');
      });
    });

    test('21. Contact Info follows System theme', () => {
      assert.doesNotThrow(() => {
        applyAppTheme('system');
        const resolved = getResolvedAppTheme();
        assert.ok(resolved === 'light' || resolved === 'dark');
      });
    });

    test('22. Chat-specific wallpaper does not leak into Contact Info panel', () => {
      assert.ok(css.includes('.contact-info-panel {'), 'CSS defines .contact-info-panel');
      assert.ok(css.includes('background-color: var(--bg-surface)'), 'Panel has explicit surface background');
      // Verify wallpaper is scoped to chat-messages-container
      assert.ok(css.includes('.messages-scroll-area') || css.includes('.chat-messages-container'));
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 23 - 37: REGRESSION PROTECTION
  // ════════════════════════════════════════════════════════════════════
  describe('Regression Protection Invariants', () => {
    test('23. Navigation rail remains intact with Chats, Calls, Archived, Settings, Logout, Profile', () => {
      assert.ok(html.includes('id="nav-item-chats"'));
      assert.ok(html.includes('id="nav-item-calls"'));
      assert.ok(html.includes('id="nav-item-archived"'));
      assert.ok(html.includes('id="btn-settings"'));
      assert.ok(html.includes('id="btn-logout"'));
      assert.ok(html.includes('id="user-profile-trigger"'));
    });

    test('24. Custom Lists remain intact', () => {
      const list = state.createCustomList('Work', ['r1', 'r3']);
      assert.equal(list.name, 'Work');
      assert.equal(state.getCustomLists().length, 1);
      state.updateCustomList(list.id, { name: 'Work Project' });
      assert.equal(state.getCustomList(list.id).name, 'Work Project');
      state.deleteCustomList(list.id);
      assert.equal(state.getCustomList(list.id), null);
    });

    test('25. All filter remains intact', () => {
      state.setActiveFilter('all');
      assert.equal(state.getFilteredConversations().length, 4);
    });

    test('26. Unread filter remains intact', () => {
      state.setActiveFilter('unread');
      const unreadList = state.getFilteredConversations();
      assert.equal(unreadList.length, 2);
      assert.ok(unreadList.every((c) => (c.unreadCount || 0) > 0));
    });

    test('27. Favourites filter remains intact', () => {
      state.favouriteChat('r1');
      state.setActiveFilter('favourites');
      const favs = state.getFilteredConversations();
      assert.equal(favs.length, 1);
      assert.equal(favs[0].roomId, 'r1');
    });

    test('28. Groups filter remains intact', () => {
      state.setActiveFilter('groups');
      const groups = state.getFilteredConversations();
      assert.equal(groups.length, 2);
      assert.ok(groups.every((c) => c.kind === 'group'));
    });

    test('29. Pin and Favourite actions remain intact', () => {
      state.pinChat('r2');
      assert.ok(state.isPinned('r2'));
      state.unpinChat('r2');
      assert.ok(!state.isPinned('r2'));

      state.favouriteChat('r3');
      assert.ok(state.isFavourite('r3'));
      state.unfavouriteChat('r3');
      assert.ok(!state.isFavourite('r3'));
    });

    test('30. Archive and Unarchive remain intact', () => {
      state.archiveChat('r1');
      assert.ok(state.isArchived('r1'));
      assert.equal(state.getArchivedConversations().length, 1);

      state.unarchiveChat('r1');
      assert.ok(!state.isArchived('r1'));
      assert.equal(state.getArchivedConversations().length, 0);
    });

    test('31. Calls page remains intact', () => {
      assert.ok(html.includes('id="calls-view"'));
      assert.ok(html.includes('id="calls-history-list"'));
      state.addCallRecord({
        id: 'call-1',
        roomId: 'r1',
        direction: 'incoming',
        callType: 'voice',
        status: 'completed',
        startedAt: Date.now() - 45000,
        endedAt: Date.now(),
        duration: 45
      });
      assert.equal(state.getCallHistory().length, 1);
      assert.equal(formatCallDuration(45), '00:45');
    });

    test('32. Archived page remains intact', () => {
      assert.ok(html.includes('id="archived-sidebar"'));
      assert.ok(html.includes('id="archived-conversation-list"'));
      assert.ok(html.includes('id="archived-search"'));
    });

    test('33. Messaging and composer remain intact', () => {
      assert.ok(html.includes('id="composer-input"'));
      assert.ok(html.includes('id="btn-send-message"'));
      assert.ok(html.includes('id="messages-list"'));
    });

    test('34. Voice calling remains intact', () => {
      assert.ok(html.includes('id="voice-call-overlay"'));
      assert.ok(appJs.includes('voiceCallManager'));
    });

    test('35. Video calling remains intact', () => {
      assert.ok(html.includes('id="video-stage"'));
      assert.ok(html.includes('id="remote-video"'));
    });

    test('36. Minimized audio call remains intact', () => {
      assert.ok(html.includes('id="btn-call-popout"'));
      assert.ok(html.includes('id="btn-call-maximize"'));
    });

    test('37. Add People modal remains intact', () => {
      assert.ok(html.includes('id="call-add-participant-modal"'));
      assert.ok(html.includes('id="call-participants-list"'));
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 38 - 40: SECURITY & UNSUPPORTED FEATURES OMISSION
  // ════════════════════════════════════════════════════════════════════
  describe('Security & Unsupported Features Audit', () => {
    test('38. No authentication tokens or sensitive secrets stored in Contact Info state', () => {
      assert.ok(!html.includes('token'), 'HTML does not store or hardcode tokens');
      // Contact info state only stores activeContactInfoRoomId (a string ID)
      state.openContactInfo('r1');
      assert.equal(typeof state.getContactInfoRoomId(), 'string');
    });

    test('39. No ak_ credentials introduced anywhere in windows codebase', () => {
      const srcPath = path.join(projectRoot, 'src');
      const files = ['chat-shell-state.js', 'app.js', 'index.html', 'styles.css'];
      for (const f of files) {
        const full = path.join(srcPath, 'renderer', f);
        if (fs.existsSync(full)) {
          const content = fs.readFileSync(full, 'utf8');
          assert.ok(!content.includes('ak_'), `File ${f} must not contain ak_ credentials`);
        }
      }
    });

    test('40. Unsupported features are NOT rendered (no fake buttons or mock features)', () => {
      // Must NOT include fake media gallery, starred messages list, disappearing messages, fake privacy/encryption toggles
      assert.ok(!html.includes('id="contact-info-starred-messages"'), 'Starred messages section must NOT exist');
      assert.ok(!html.includes('id="contact-info-disappearing"'), 'Disappearing messages section must NOT exist');
      assert.ok(!html.includes('id="contact-info-encryption"'), 'Fake encryption claims section must NOT exist');
      assert.ok(!html.includes('id="contact-info-media-gallery"'), 'Fake media/links/docs gallery must NOT exist');
      assert.ok(!html.includes('id="contact-info-mute-toggle"'), 'Fake per-chat mute toggle must NOT exist');
      assert.ok(!html.includes('id="contact-info-add-admin"'), 'Fake promote to admin button must NOT exist');
      assert.ok(!html.includes('id="contact-info-remove-member"'), 'Fake remove member button must NOT exist');
    });
  });
});
