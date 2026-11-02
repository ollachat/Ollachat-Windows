import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatShellState } from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const htmlPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const cssPath = path.join(__dirname, '..', 'src', 'renderer', 'styles.css');
const appJsPath = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
const shellStatePath = path.join(__dirname, '..', 'src', 'renderer', 'chat-shell-state.js');

const html = fs.readFileSync(htmlPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
const appJs = fs.readFileSync(appJsPath, 'utf8').replace(/\r\n/g, '\n');
const shellStateJs = fs.readFileSync(shellStatePath, 'utf8');

describe('Chat Header Three-Dot Options Menu (Section 30 - 35 Tests)', () => {
  // 1. Three-dot button is clickable.
  test('1. Three-dot button is clickable and accessible', () => {
    assert.ok(html.includes('id="btn-chat-menu"'), 'Must define #btn-chat-menu');
    assert.ok(html.includes('type="button" id="btn-chat-menu"'), 'Must be a button element with type="button"');
    assert.ok(!html.includes('id="btn-chat-menu" class="btn-icon" title="More options" disabled'), 'Must not be disabled');
    assert.ok(html.includes('aria-haspopup="menu"'), 'Must have aria-haspopup="menu"');
    assert.ok(html.includes('aria-expanded="false"'), 'Must start with aria-expanded="false"');
  });

  // 2. Three-dot button opens menu.
  test('2. Three-dot button opens menu and toggles openChatHeaderMenu', () => {
    assert.ok(html.includes('id="chat-header-menu"'), 'Must define #chat-header-menu in HTML');
    assert.ok(html.includes('class="conversation-context-menu hidden" role="menu"'), 'Menu starts hidden with role="menu"');
    assert.ok(appJs.includes("btnChatMenu?.addEventListener('click'"), 'Button has click listener');
    assert.ok(appJs.includes('openChatHeaderMenu()'), 'Calls openChatHeaderMenu() on button click');
    assert.ok(appJs.includes("chatHeaderMenu.classList.remove('hidden')"), 'Removes hidden class when opening');
    assert.ok(appJs.includes("btnChatMenu.setAttribute('aria-expanded', 'true')"), 'Sets aria-expanded to true when opened');
  });

  // 3. Menu is positioned correctly.
  test('3. Menu is positioned correctly anchored near button and clamped inside viewport', () => {
    assert.ok(appJs.includes('btnChatMenu.getBoundingClientRect()'), 'Anchors position using button bounding rect');
    assert.ok(appJs.includes('rect.right - menuWidth'), 'Positions menu anchored to right edge of button');
    assert.ok(appJs.includes('window.innerWidth - menuWidth - 10'), 'Clamps left edge against viewport right boundary');
    assert.ok(appJs.includes('rect.top - menuHeight - 6'), 'Clamps top edge against viewport bottom boundary');
    assert.ok(appJs.includes('chatHeaderMenu.style.left ='), 'Applies computed left position');
    assert.ok(appJs.includes('chatHeaderMenu.style.top ='), 'Applies computed top position');
  });

  // 4. Menu closes on outside click.
  test('4. Menu closes on outside click', () => {
    assert.ok(appJs.includes('chatHeaderMenu && !chatHeaderMenu.classList.contains(\'hidden\')'), 'Checks if menu is open');
    assert.ok(appJs.includes('!chatHeaderMenu.contains(e.target) && (!btnChatMenu || !btnChatMenu.contains(e.target))'), 'Detects outside clicks');
    assert.ok(appJs.includes('closeChatHeaderMenu()'), 'Calls closeChatHeaderMenu() on outside click');
  });

  // 5. Menu closes on Escape.
  test('5. Menu closes on Escape key', () => {
    assert.ok(appJs.includes("e.key === 'Escape'"), 'Escape key handler present');
    assert.ok(appJs.includes("if (chatHeaderMenu && !chatHeaderMenu.classList.contains('hidden')) {\n        closeChatHeaderMenu();"), 'Closes chatHeaderMenu on Escape');
  });

  // 6. Menu closes when switching chats.
  test('6. Menu closes when switching chats or navigation rail', () => {
    const selectConvIdx = appJs.indexOf('function selectConversation(');
    const closeInSelect = appJs.indexOf('closeChatHeaderMenu();', selectConvIdx);
    assert.ok(selectConvIdx !== -1 && closeInSelect !== -1 && closeInSelect - selectConvIdx < 2000, 'selectConversation calls closeChatHeaderMenu()');

    const switchRailIdx = appJs.indexOf('function switchNavigationRail(');
    const closeInRail = appJs.indexOf('closeChatHeaderMenu();', switchRailIdx);
    assert.ok(switchRailIdx !== -1 && closeInRail !== -1 && closeInRail - switchRailIdx < 1000, 'switchNavigationRail calls closeChatHeaderMenu()');
  });

  // 7. Existing header buttons still work.
  test('7. Existing header voice, video, search, contact identity, and theme buttons still work', () => {
    assert.ok(html.includes('id="btn-start-voice-call"'), 'Voice call button in header');
    assert.ok(html.includes('id="btn-start-video-call"'), 'Video call button in header');
    assert.ok(html.includes('id="btn-chat-search"'), 'Search button in header');
    assert.ok(html.includes('id="btn-chat-theme"'), 'Chat theme button in header');
    assert.ok(html.includes('id="chat-header-info"'), 'Contact info identity area in header');
    assert.ok(appJs.includes("btnStartVoiceCall?.addEventListener('click'"), 'Voice button listener intact');
    assert.ok(appJs.includes("btnStartVideoCall?.addEventListener('click'"), 'Video button listener intact');
    assert.ok(appJs.includes("btnChatSearch?.addEventListener('click'"), 'Search button listener intact');
    assert.ok(appJs.includes("btnChatTheme?.addEventListener('click'"), 'Theme button listener intact');
    assert.ok(appJs.includes("chatHeaderInfo?.addEventListener('click'"), 'Identity click listener intact');
  });

  // 8. Contact Info action works if supported.
  test('8. Contact Info action opens the existing Contact Info panel', () => {
    assert.ok(html.includes('id="menu-item-contact-info" data-action="contact-info"'), 'Menu item contact info defined');
    assert.ok(appJs.includes("menuItemContactInfo?.addEventListener('click'"), 'Menu item contact info has click listener');
    assert.ok(appJs.includes('openContactInfo(roomId)'), 'Calls existing openContactInfo function');
  });

  // 9. Search action works if supported.
  test('9. Search action opens the existing chat search bar', () => {
    assert.ok(html.includes('id="menu-item-chat-search" data-action="chat-search"'), 'Menu item search defined');
    assert.ok(appJs.includes("menuItemChatSearch?.addEventListener('click'"), 'Menu item search has click listener');
    assert.ok(appJs.includes('openChatSearch()'), 'Calls existing openChatSearch function');
  });

  // 10. Select messages works if supported (Omitted because unsupported).
  test('10. Select messages is verified unsupported and intentionally not rendered', () => {
    assert.ok(!html.includes('Select messages'), 'Select messages action must not be rendered');
    assert.ok(!html.includes('data-action="select-messages"'), 'No select-messages action in HTML');
  });

  // 11. Chat Theme action works.
  test('11. Chat Theme action opens existing Chat Theme modal', () => {
    assert.ok(html.includes('id="menu-item-chat-theme" data-action="chat-theme"'), 'Menu item chat theme defined');
    assert.ok(appJs.includes("menuItemChatTheme?.addEventListener('click'"), 'Menu item chat theme has click listener');
    assert.ok(appJs.includes('openThemeModal(roomId)'), 'Calls existing openThemeModal function');
  });

  // 12. Favourite action toggles correctly.
  test('12. Favourite action dynamically toggles between Add/Remove and updates state', () => {
    assert.ok(html.includes('id="menu-item-toggle-favourite" data-action="toggle-favourite"'), 'Menu item favourite defined');
    assert.ok(appJs.includes("menuFavText.textContent = isFav ? 'Remove from favourites' : 'Add to favourites'"), 'Dynamic favourite label');
    assert.ok(appJs.includes('shellState.toggleFavouriteChat(roomId)'), 'Calls toggleFavouriteChat on ChatShellState');

    const state = new ChatShellState();
    assert.strictEqual(state.isFavourite('r1'), false);
    state.toggleFavouriteChat('r1');
    assert.strictEqual(state.isFavourite('r1'), true);
    state.toggleFavouriteChat('r1');
    assert.strictEqual(state.isFavourite('r1'), false);
  });

  // 13. Change List works.
  test('13. Change List opens modal and allows managing list membership', () => {
    assert.ok(html.includes('id="menu-item-change-list" data-action="change-list"'), 'Menu item change list defined');
    assert.ok(html.includes('id="change-chat-lists-modal"'), 'Change chat lists modal dialog defined');
    assert.ok(appJs.includes("menuItemChangeList?.addEventListener('click'"), 'Menu item change list has click listener');
    assert.ok(appJs.includes('openChangeChatListsModal(roomId)'), 'Calls openChangeChatListsModal');
    assert.ok(shellStateJs.includes('toggleRoomInCustomList(listId, roomId)'), 'ChatShellState has toggleRoomInCustomList');

    const state = new ChatShellState();
    const l1 = state.createCustomList('Colleagues', ['r10']);
    assert.ok(l1);
    assert.strictEqual(state.toggleRoomInCustomList(l1.id, 'r20'), true);
    assert.ok(state.getCustomList(l1.id).roomIds.includes('r20'));
    assert.strictEqual(state.toggleRoomInCustomList(l1.id, 'r20'), false);
    assert.ok(!state.getCustomList(l1.id).roomIds.includes('r20'));
  });

  // 14. Archive/Unarchive works.
  test('14. Archive/Unarchive dynamically toggles between Archive/Unarchive and updates state', () => {
    assert.ok(html.includes('id="menu-item-toggle-archive" data-action="toggle-archive"'), 'Menu item archive defined');
    assert.ok(appJs.includes("menuArchiveText.textContent = isArchived ? 'Unarchive chat' : 'Archive chat'"), 'Dynamic archive label');
    assert.ok(appJs.includes('shellState.toggleArchiveChat(roomId)'), 'Calls toggleArchiveChat on ChatShellState');

    const state = new ChatShellState();
    assert.strictEqual(state.isArchived('r1'), false);
    state.toggleArchiveChat('r1');
    assert.strictEqual(state.isArchived('r1'), true);
    state.toggleArchiveChat('r1');
    assert.strictEqual(state.isArchived('r1'), false);
  });

  // 15. Unsupported actions are not rendered.
  test('15. All unsupported WhatsApp menu items are strictly omitted', () => {
    const unsupportedTerms = [
      'Select messages',
      'Disappearing messages',
      'Export chat',
      'Close chat',
      'Send call link',
      'Schedule call',
      'New group call',
      'Report',
      'Add participant',
      'Remove participant',
      'Promote admin',
      'Demote admin'
    ];
    for (const term of unsupportedTerms) {
      assert.ok(!html.includes(`>${term}<`), `Must NOT render unsupported action: ${term}`);
    }
  });

  // 16. Direct-chat menu works.
  test('16. Direct-chat menu displays Contact info label', () => {
    assert.ok(appJs.includes("menuContactInfoText.textContent = isGroup ? 'Group info' : 'Contact info'"), 'Sets Contact info for direct chats');
  });

  // 17. Group-chat menu works.
  test('17. Group-chat menu displays Group info label', () => {
    assert.ok(appJs.includes("isGroup ? 'Group info' : 'Contact info'"), 'Sets Group info for group chats');
  });

  // 18. Light theme works.
  test('18. Light theme compatibility using CSS variables', () => {
    assert.ok(css.includes('--bg-card'), 'Uses --bg-card for menu background');
    assert.ok(css.includes('--border-color'), 'Uses --border-color');
    assert.ok(css.includes('--text-primary'), 'Uses --text-primary');
    assert.ok(css.includes('--bg-hover'), 'Uses --bg-hover');
  });

  // 19. Dark theme works.
  test('19. Dark theme compatibility preserves contrast and styling', () => {
    assert.ok(css.includes('[data-theme="dark"]') || css.includes(':root'), 'CSS theme variables defined for themes');
    assert.ok(css.includes('.conversation-context-menu'), 'CSS styles .conversation-context-menu for all themes');
  });

  // 20. System theme works.
  test('20. System theme compatibility via ThemeManager', () => {
    const themeManagerPath = path.join(__dirname, '..', 'src', 'renderer', 'theme-manager.js');
    const themeJs = fs.readFileSync(themeManagerPath, 'utf8');
    assert.ok(themeJs.includes('system'), 'ThemeManager supports system theme');
  });

  // 21. Custom Lists remain intact.
  test('21. Custom chat lists remain intact', () => {
    const state = new ChatShellState();
    const list = state.createCustomList('Family', ['roomA']);
    assert.ok(list);
    assert.strictEqual(state.customLists.length, 1);
    assert.strictEqual(state.customLists[0].name, 'Family');
  });

  // 22. All filter remains intact.
  test('22. All filter remains intact in ChatShellState', () => {
    const state = new ChatShellState();
    state.conversations = [
      { roomId: 'r1', kind: 'direct', isArchived: false },
      { roomId: 'r2', kind: 'group', isArchived: false }
    ];
    state.setActiveFilter('all');
    assert.strictEqual(state.getFilteredConversations().length, 2);
  });

  // 23. Unread filter remains intact.
  test('23. Unread filter remains intact in ChatShellState', () => {
    const state = new ChatShellState();
    state.conversations = [
      { roomId: 'r1', unreadCount: 0, isArchived: false },
      { roomId: 'r2', unreadCount: 3, isArchived: false }
    ];
    state.setActiveFilter('unread');
    assert.strictEqual(state.getFilteredConversations().length, 1);
    assert.strictEqual(state.getFilteredConversations()[0].roomId, 'r2');
  });

  // 24. Favourites filter remains intact.
  test('24. Favourites filter remains intact in ChatShellState', () => {
    const state = new ChatShellState();
    state.conversations = [
      { roomId: 'r1', isArchived: false },
      { roomId: 'r2', isArchived: false }
    ];
    state.toggleFavouriteChat('r1');
    state.setActiveFilter('favourites');
    assert.strictEqual(state.getFilteredConversations().length, 1);
    assert.strictEqual(state.getFilteredConversations()[0].roomId, 'r1');
  });

  // 25. Groups filter remains intact.
  test('25. Groups filter remains intact in ChatShellState', () => {
    const state = new ChatShellState();
    state.conversations = [
      { roomId: 'r1', kind: 'direct', isArchived: false },
      { roomId: 'r2', kind: 'group', isArchived: false }
    ];
    state.setActiveFilter('groups');
    assert.strictEqual(state.getFilteredConversations().length, 1);
    assert.strictEqual(state.getFilteredConversations()[0].roomId, 'r2');
  });

  // 26. Calls page remains intact.
  test('26. Calls page remains intact in HTML and app.js', () => {
    assert.ok(html.includes('id="calls-view"'), 'Calls view element present in HTML');
    assert.ok(appJs.includes("destination === 'calls'"), 'Calls destination routing intact');
  });

  // 27. Archived page remains intact.
  test('27. Archived page remains intact in HTML and app.js', () => {
    assert.ok(html.includes('id="archived-sidebar"'), 'Archived sidebar element present in HTML');
    assert.ok(appJs.includes("destination === 'archived'"), 'Archived destination routing intact');
  });

  // 28. Contact Info remains intact.
  test('28. Contact Info panel remains intact in HTML and app.js', () => {
    assert.ok(html.includes('id="contact-info-panel"'), 'Contact info panel present');
    assert.ok(appJs.includes('export async function openContactInfo'), 'openContactInfo function exported');
  });

  // 29. Messaging remains intact.
  test('29. Messaging composer and message list intact', () => {
    assert.ok(html.includes('id="chat-messages-container"'), 'Messages container present');
    assert.ok(html.includes('id="composer-input"'), 'Composer input present');
  });

  // 30. Voice calling remains intact.
  test('30. Voice calling controls intact', () => {
    assert.ok(html.includes('id="voice-call-overlay"'), 'Voice call overlay present');
    assert.ok(appJs.includes('voiceCallManager.startCall'), 'Voice call manager startCall intact');
  });

  // 31. Video calling remains intact.
  test('31. Video calling controls intact', () => {
    assert.ok(html.includes('id="video-stage"'), 'Video stage present');
    assert.ok(appJs.includes('voiceCallManager.startVideoCall'), 'Voice call manager startVideoCall intact');
  });

  // 32. Minimized audio calls remain intact.
  test('32. Minimized audio calls overlay intact', () => {
    assert.ok(html.includes('id="btn-call-popout"'), 'Popout button present in HTML');
    assert.ok(html.includes('id="btn-call-maximize"'), 'Maximize button present in HTML');
  });

  // 33. Add People remains intact.
  test('33. Add People modal intact', () => {
    assert.ok(html.includes('id="call-add-participant-modal"'), 'Add participant modal present in HTML');
  });

  // 34. No ak_ credentials introduced.
  test('34. No ak_ credentials introduced anywhere in codebase', () => {
    assert.ok(!html.includes('ak_'), 'No ak_ in HTML');
    assert.ok(!appJs.includes('ak_'), 'No ak_ in app.js');
    assert.ok(!shellStateJs.includes('ak_'), 'No ak_ in chat-shell-state.js');
  });

  // 35. No undocumented OllaCore endpoint introduced.
  test('35. No undocumented OllaCore endpoint introduced', () => {
    assert.ok(!appJs.includes('/api/v1/chats/close'), 'No fake close chat endpoint');
    assert.ok(!appJs.includes('/api/v1/chats/export'), 'No fake export endpoint');
    assert.ok(!appJs.includes('/api/v1/calls/link'), 'No fake call link endpoint');
    assert.ok(!appJs.includes('/api/v1/calls/schedule'), 'No fake schedule call endpoint');
    assert.ok(!appJs.includes('/api/v1/reports'), 'No fake report endpoint');
    assert.ok(!appJs.includes('/api/v1/blocks'), 'No fake block endpoint');
  });

  // 36. REGRESSION: openChatHeaderMenu must NOT call shellState.getConversation()
  //     which does not exist on ChatShellState, causing runtime TypeError.
  //     It must instead use the existing getSelectedConversation() or
  //     conversations.find() pattern that is part of the verified API surface.
  test('36. REGRESSION: openChatHeaderMenu uses real ChatShellState API (no shellState.getConversation)', () => {
    // Verify the nonexistent method is not called anywhere in app.js
    assert.ok(
      !appJs.includes('shellState.getConversation('),
      'app.js must NOT call shellState.getConversation() — method does not exist on ChatShellState'
    );

    // Verify the correct real API is used inside openChatHeaderMenu
    const menuFnStart = appJs.indexOf('function openChatHeaderMenu(');
    const menuFnEnd = appJs.indexOf('\nfunction ', menuFnStart + 1);
    const menuFnBody = menuFnEnd === -1 ? appJs.slice(menuFnStart) : appJs.slice(menuFnStart, menuFnEnd);

    assert.ok(
      menuFnBody.includes('shellState.getSelectedConversation()') || menuFnBody.includes('shellState.conversations?.find('),
      'openChatHeaderMenu() must resolve conversation using getSelectedConversation() or conversations.find()'
    );

    // Verify ChatShellState actually exposes getSelectedConversation
    assert.ok(
      shellStateJs.includes('getSelectedConversation()'),
      'ChatShellState must define getSelectedConversation()'
    );

    // Verify ChatShellState does NOT define getConversation (there is no such method)
    // (It defines getCustomList, getUnreadConversationsCount, etc — but NOT getConversation)
    const classBody = shellStateJs;
    // Check that getConversation is absent as a class method definition
    const hasGetConvMethod = /\bgetConversation\s*\(/.test(classBody);
    assert.ok(
      !hasGetConvMethod,
      'ChatShellState must NOT define getConversation() — the correct method is getSelectedConversation()'
    );

    // Runtime-level check: verify ChatShellState instance has getSelectedConversation
    const state = new ChatShellState();
    assert.strictEqual(typeof state.getSelectedConversation, 'function', 'getSelectedConversation is a function on ChatShellState instance');
    assert.strictEqual(typeof state.getConversation, 'undefined', 'getConversation is undefined on ChatShellState instance (must not be called)');

    // Verify correct result when a conversation is selected
    state.conversations = [
      { roomId: 'room1', kind: 'direct', isArchived: false },
      { roomId: 'room2', kind: 'group', isArchived: false }
    ];
    state.selectedRoomId = 'room1';
    const selected = state.getSelectedConversation();
    assert.ok(selected, 'getSelectedConversation returns a result when selectedRoomId is set');
    assert.strictEqual(selected.roomId, 'room1', 'getSelectedConversation returns the correct conversation');
    assert.strictEqual(selected.kind, 'direct', 'getSelectedConversation returns correct kind for label logic');
  });
});

