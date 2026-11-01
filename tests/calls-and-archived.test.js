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

// Mock localStorage for node test runner environment
const mockStorage = new Map();
globalThis.localStorage = {
  getItem: (key) => (mockStorage.has(key) ? mockStorage.get(key) : null),
  setItem: (key, val) => mockStorage.set(key, String(val)),
  removeItem: (key) => mockStorage.delete(key),
  clear: () => mockStorage.clear()
};

describe('Calls Page & Archived Chats System Tests (55 Invariants)', () => {
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
    state.setCurrentUser({ userId: 'user-alice', name: 'Alice' });
    state.setInbox([
      { roomId: 'r1', kind: 'direct', name: 'John Doe', unreadCount: 0, lastMessage: { preview: 'Hello', createdAt: Date.now() - 1000 } },
      { roomId: 'r2', kind: 'direct', name: 'Bob Smith', unreadCount: 2, lastMessage: { preview: 'Hey there', createdAt: Date.now() - 2000 } },
      { roomId: 'r3', kind: 'group', name: 'Project Group', unreadCount: 0, lastMessage: { preview: 'Update ready', createdAt: Date.now() - 3000 } },
      { roomId: 'r4', kind: 'group', name: 'College', unreadCount: 3, lastMessage: { preview: 'See you', createdAt: Date.now() - 4000 } }
    ]);
  });

  // ════════════════════════════════════════════════════════════════════
  // CALLS TESTS (1 - 17)
  // ════════════════════════════════════════════════════════════════════
  describe('Calls Page Feature Tests', () => {
    test('1. Calls rail item renders in left navigation rail with professional SVG icon', () => {
      assert.ok(html.includes('id="nav-item-calls"'), 'Must define #nav-item-calls in HTML');
      assert.ok(html.includes('title="Calls"'), 'Must have title="Calls"');
      assert.ok(html.includes('aria-label="Calls"'), 'Must have aria-label="Calls"');
      assert.ok(html.includes('<span class="nav-rail-tooltip">Calls</span>'), 'Must define tooltip for Calls');
      assert.ok(!html.includes('📞') && !html.includes('📱'), 'Do not use emojis for calls rail icon');
    });

    test('2. Calls rail item has correct active state toggle in switchNavigationRail', () => {
      assert.ok(appJs.includes("navItemCalls?.classList.toggle('active', destination === 'calls')"), 'Toggles active on #nav-item-calls');
      assert.ok(appJs.includes("navItemChats?.classList.toggle('active', destination === 'chats')"), 'Toggles active on #nav-item-chats');
      assert.ok(appJs.includes("navItemArchived?.classList.toggle('active', destination === 'archived')"), 'Toggles active on #nav-item-archived');
    });

    test('3. Clicking Calls opens Calls page', () => {
      assert.ok(html.includes('id="calls-view"'), 'Defines #calls-view container in HTML');
      assert.ok(appJs.includes("switchNavigationRail('calls')"), 'Calls switchNavigationRail("calls")');
      assert.ok(appJs.includes("callsView?.classList.remove('hidden')"), 'Reveals callsView on switching to calls');
    });

    test('4. Clicking Chats returns to Chats', () => {
      assert.ok(appJs.includes("switchNavigationRail('chats')"), 'Calls switchNavigationRail("chats")');
      assert.ok(appJs.includes("chatSidebar?.classList.remove('hidden')"), 'Restores chatSidebar on switching to chats');
      assert.ok(appJs.includes("callsView?.classList.add('hidden')"), 'Hides callsView on switching to chats');
    });

    test('5. Calls empty state works', () => {
      assert.ok(html.includes('id="calls-empty"'), 'Defines #calls-empty in HTML');
      assert.ok(html.includes('No calls yet'), 'Contains empty state title');
      assert.ok(html.includes('Your call history will appear here.'), 'Contains empty state subtitle');
    });

    test('6. Incoming call is recorded in local history', () => {
      const rec = state.addCallRecord({
        callId: 'c1',
        roomId: 'r1',
        participantId: 'p1',
        participantName: 'John Doe',
        direction: 'incoming',
        callType: 'voice',
        status: 'completed',
        startedAt: Date.now() - 32000,
        endedAt: Date.now(),
        duration: 32
      });
      assert.ok(rec, 'Returns saved record');
      assert.equal(rec.direction, 'incoming');
      assert.equal(rec.status, 'completed');
      assert.equal(rec.duration, 32);
      assert.equal(state.getCallHistory().length, 1);
    });

    test('7. Outgoing call is recorded in local history', () => {
      const rec = state.addCallRecord({
        callId: 'c2',
        roomId: 'r2',
        participantId: 'p2',
        participantName: 'Bob Smith',
        direction: 'outgoing',
        callType: 'video',
        status: 'completed',
        startedAt: Date.now() - 255000,
        endedAt: Date.now(),
        duration: 255
      });
      assert.equal(rec.direction, 'outgoing');
      assert.equal(rec.callType, 'video');
      assert.equal(rec.status, 'completed');
    });

    test('8. Missed call is recorded', () => {
      const rec = state.addCallRecord({
        callId: 'c3',
        roomId: 'r1',
        participantId: 'p1',
        participantName: 'John Doe',
        direction: 'incoming',
        callType: 'voice',
        status: 'missed',
        startedAt: Date.now() - 5000,
        duration: 0
      });
      assert.equal(rec.status, 'missed');
      assert.equal(rec.duration, 0);
    });

    test('9. Completed call duration is calculated and formatted correctly', () => {
      assert.equal(formatCallDuration(32), '00:32');
      assert.equal(formatCallDuration(255), '04:15');
      assert.equal(formatCallDuration(3765), '1:02:45');
      assert.equal(formatCallDuration(0), '');
      assert.equal(formatCallDuration(-5), '');
    });

    test('10. Voice call type is displayed and handled', () => {
      state.addCallRecord({ roomId: 'r1', participantName: 'John', callType: 'voice', status: 'completed', duration: 10 });
      const hist = state.getCallHistory();
      assert.equal(hist[0].callType, 'voice');
    });

    test('11. Video call type is displayed and handled', () => {
      state.addCallRecord({ roomId: 'r1', participantName: 'John', callType: 'video', status: 'completed', duration: 15 });
      const hist = state.getCallHistory();
      assert.equal(hist[0].callType, 'video');
    });

    test('12. Call search works correctly', () => {
      state.addCallRecord({ roomId: 'r1', participantName: 'Alice Smith', participantPhone: '+15551234', status: 'completed' });
      state.addCallRecord({ roomId: 'r2', participantName: 'Bob Jones', participantPhone: '+15559876', status: 'missed' });
      state.addCallRecord({ roomId: 'r3', participantName: 'Charlie Brown', participantPhone: '+15554321', status: 'completed' });

      assert.equal(state.getCallHistory('Alice').length, 1);
      assert.equal(state.getCallHistory('9876').length, 1);
      assert.equal(state.getCallHistory('NonExistent').length, 0);
      assert.equal(state.getCallHistory('').length, 3);
    });

    test('13. Call history persists in localStorage', () => {
      state.addCallRecord({ roomId: 'r1', participantName: 'John Doe', status: 'completed', duration: 45 });
      const raw = mockStorage.get('ollachat_call_history_user-alice');
      assert.ok(raw, 'Persisted in storage');
      const parsed = JSON.parse(raw);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].participantName, 'John Doe');
    });

    test('14. Call history is user-scoped and does not leak between accounts', () => {
      state.addCallRecord({ roomId: 'r1', participantName: 'Alice Only Call' });
      assert.equal(state.getCallHistory().length, 1);

      // User Bob logs in
      const bobState = new ChatShellState();
      bobState.setCurrentUser({ userId: 'user-bob', name: 'Bob' });
      assert.equal(bobState.getCallHistory().length, 0, "Bob does not see Alice's call history");

      bobState.addCallRecord({ roomId: 'r2', participantName: 'Bob Only Call' });
      assert.equal(bobState.getCallHistory().length, 1);

      // Alice logs back in
      const aliceStateReloaded = new ChatShellState();
      aliceStateReloaded.setCurrentUser({ userId: 'user-alice', name: 'Alice' });
      assert.equal(aliceStateReloaded.getCallHistory().length, 1);
      assert.equal(aliceStateReloaded.getCallHistory()[0].participantName, 'Alice Only Call');
    });

    test('15. Call history limit caps at 500 records', () => {
      for (let i = 0; i < 520; i++) {
        state.addCallRecord({ roomId: `r${i}`, participantName: `Caller ${i}` });
      }
      assert.equal(state.callHistory.length, 500, 'Must cap at 500 records');
    });

    test('16. Call row can reuse existing call action', () => {
      assert.ok(appJs.includes('function initiateCallFromRecord(record)'), 'Defines initiateCallFromRecord');
      assert.ok(appJs.includes('voiceCallManager.startCall(roomId'), 'Reuses voiceCallManager.startCall');
      assert.ok(appJs.includes('voiceCallManager.startVideoCall(roomId'), 'Reuses voiceCallManager.startVideoCall');
    });

    test('17. Invalid call record does not crash', () => {
      assert.doesNotThrow(() => {
        state.addCallRecord(null);
        state.addCallRecord(undefined);
        state.addCallRecord('not-an-object');
        state.getCallHistory(null);
        state.getCallHistory(undefined);
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // ARCHIVED TESTS (18 - 40)
  // ════════════════════════════════════════════════════════════════════
  describe('Archived Chats Feature Tests', () => {
    test('18. Archived rail item renders in left navigation rail with SVG icon', () => {
      assert.ok(html.includes('id="nav-item-archived"'), 'Defines #nav-item-archived');
      assert.ok(html.includes('title="Archived"'), 'Has title="Archived"');
      assert.ok(html.includes('<span class="nav-rail-tooltip">Archived</span>'), 'Has tooltip for Archived');
      assert.ok(!html.includes('📦') && !html.includes('🗃️'), 'No emojis for archived icon');
    });

    test('19. Archived is NOT present in chat filter row', () => {
      const filterRowStart = html.indexOf('id="chat-filter-row"');
      const filterRowEnd = html.indexOf('</div>', filterRowStart);
      const filterRowSubstr = html.substring(filterRowStart, filterRowEnd);
      assert.ok(!filterRowSubstr.toLowerCase().includes('archived'), 'Archived must NOT be in chat-filter-row');
    });

    test('20. Archive action exists in chat context menu', () => {
      assert.ok(html.includes('id="ctx-chat-archive-icon"'), 'Defines archive icon in conversation-context-menu');
      assert.ok(html.includes('id="ctx-chat-archive-text"'), 'Defines archive text in conversation-context-menu');
      assert.ok(html.includes('data-action="archive"'), 'Has data-action="archive"');
    });

    test('21. Archiving removes chat from normal Chats', () => {
      assert.equal(state.getFilteredConversations().length, 4);
      state.archiveChat('r1');
      assert.ok(state.isArchived('r1'));
      const activeList = state.getFilteredConversations();
      assert.equal(activeList.length, 3);
      assert.ok(!activeList.some((c) => c.roomId === 'r1'), 'r1 is removed from normal Chats view');
    });

    test('22. Archived page displays archived chat', () => {
      state.archiveChat('r1');
      const archived = state.getArchivedConversations();
      assert.equal(archived.length, 1);
      assert.equal(archived[0].roomId, 'r1');
      assert.equal(archived[0].name, 'John Doe');
    });

    test('23. Unarchive action works in archived context menu', () => {
      state.archiveChat('r1');
      assert.ok(state.isArchived('r1'));
      const deleted = state.unarchiveChat('r1');
      assert.ok(deleted);
      assert.ok(!state.isArchived('r1'));
    });

    test('24. Unarchive returns chat to normal Chats', () => {
      state.archiveChat('r1');
      assert.equal(state.getFilteredConversations().length, 3);
      state.unarchiveChat('r1');
      const activeList = state.getFilteredConversations();
      assert.equal(activeList.length, 4);
      assert.ok(activeList.some((c) => c.roomId === 'r1'), 'r1 returns to normal Chats view');
    });

    test('25. Archive persists after reload in same session', () => {
      state.archiveChat('r1');
      state.archiveChat('r3');
      const loaded = new ChatShellState();
      loaded.setCurrentUser({ userId: 'user-alice' });
      assert.ok(loaded.isArchived('r1'));
      assert.ok(loaded.isArchived('r3'));
      assert.ok(!loaded.isArchived('r2'));
    });

    test('26. Archive persists after restart with storage intact', () => {
      state.archiveChat('r2');
      const raw = mockStorage.get('ollachat_archived_chats_user-alice');
      assert.ok(raw);
      assert.deepEqual(JSON.parse(raw), ['r2']);
    });

    test('27. Archive is user-scoped and does not bleed to another account', () => {
      state.archiveChat('r1');
      state.archiveChat('r2');

      const bobState = new ChatShellState();
      bobState.setCurrentUser({ userId: 'user-bob' });
      assert.ok(!bobState.isArchived('r1'), "Bob does not have r1 archived");
      assert.ok(!bobState.isArchived('r2'), "Bob does not have r2 archived");

      bobState.archiveChat('r4');
      assert.ok(bobState.isArchived('r4'));
      assert.ok(!state.isArchived('r4'), "Alice does not have r4 archived");
    });

    test('28. Archived chat messages remain intact', () => {
      const conv = state.conversations.find((c) => c.roomId === 'r1');
      assert.ok(conv);
      state.archiveChat('r1');
      const archived = state.getArchivedConversations().find((c) => c.roomId === 'r1');
      assert.equal(archived.lastMessage.preview, 'Hello');
    });

    test('29. Archive does not leave group', () => {
      state.archiveChat('r3'); // Project Group
      const groupConv = state.conversations.find((c) => c.roomId === 'r3');
      assert.equal(groupConv.kind, 'group');
      assert.ok(state.isArchived('r3'));
    });

    test('30. Archive does not delete conversation', () => {
      assert.equal(state.conversations.length, 4);
      state.archiveChat('r1');
      assert.equal(state.conversations.length, 4, 'Total conversations count remains 4');
    });

    test('31. Archive preserves pin state', () => {
      state.pinChat('r1');
      assert.ok(state.isPinned('r1'));
      state.archiveChat('r1');
      assert.ok(state.isPinned('r1'), 'Pin state preserved when archived');
      state.unarchiveChat('r1');
      assert.ok(state.isPinned('r1'), 'Pin state preserved when unarchived');
    });

    test('32. Archive preserves favourite state', () => {
      state.favouriteChat('r1');
      assert.ok(state.isFavourite('r1'));
      state.archiveChat('r1');
      assert.ok(state.isFavourite('r1'), 'Favourite preserved when archived');
      state.unarchiveChat('r1');
      assert.ok(state.isFavourite('r1'), 'Favourite preserved when unarchived');
    });

    test('33. Archive preserves unread state', () => {
      const conv = state.conversations.find((c) => c.roomId === 'r2');
      assert.equal(conv.unreadCount, 2);
      state.archiveChat('r2');
      const archived = state.getArchivedConversations().find((c) => c.roomId === 'r2');
      assert.equal(archived.unreadCount, 2, 'Unread count preserved in archive');
    });

    test('34. New messages do not automatically unarchive the conversation', () => {
      state.archiveChat('r1');
      assert.ok(state.isArchived('r1'));

      // Simulate incoming message
      const conv = state.conversations.find((c) => c.roomId === 'r1');
      conv.lastMessage = { preview: 'New message while archived', createdAt: Date.now() };
      conv.unreadCount = 1;

      assert.ok(state.isArchived('r1'), 'Chat remains archived when new message arrives');
      assert.ok(!state.getFilteredConversations().some((c) => c.roomId === 'r1'), 'Not in normal chats');
      assert.ok(state.getArchivedConversations().some((c) => c.roomId === 'r1'), 'Present in archived chats');
    });

    test('35. Archived search works and searches only archived chats', () => {
      state.archiveChat('r1'); // John Doe
      state.archiveChat('r3'); // Project Group

      const matchJohn = state.getArchivedConversations('John');
      assert.equal(matchJohn.length, 1);
      assert.equal(matchJohn[0].name, 'John Doe');

      const matchProject = state.getArchivedConversations('Project');
      assert.equal(matchProject.length, 1);
      assert.equal(matchProject[0].name, 'Project Group');

      // Search for Bob (who is in normal chats, NOT archived)
      const matchBob = state.getArchivedConversations('Bob');
      assert.equal(matchBob.length, 0, 'Does NOT return non-archived conversations');
    });

    test('36. Empty Archived state works', () => {
      assert.ok(html.includes('id="archived-empty"'), 'Defines #archived-empty');
      assert.ok(html.includes('No archived chats'), 'Empty title');
      assert.ok(html.includes('Chats you archive will appear here.'), 'Empty description');
    });

    test('37. Archived chat can be opened via selectConversation', () => {
      state.archiveChat('r1');
      state.selectConversation('r1');
      assert.equal(state.selectedRoomId, 'r1');
      assert.equal(state.getSelectedConversation().name, 'John Doe');
    });

    test('38. Opening archived chat does not automatically unarchive it', () => {
      state.archiveChat('r1');
      state.selectConversation('r1');
      assert.ok(state.isArchived('r1'), 'Opening chat must NOT unarchive it');
      assert.ok(!state.getFilteredConversations().some((c) => c.roomId === 'r1'));
    });

    test('39. Custom List + Archive: archived chat is hidden from custom list', () => {
      const list = state.createCustomList('Work', ['r1', 'r2', 'r3']);
      state.setActiveFilter(list.id);

      assert.equal(state.getFilteredConversations().length, 3);
      state.archiveChat('r1');

      // Normal custom list filter must now only show non-archived chats
      const filtered = state.getFilteredConversations();
      assert.equal(filtered.length, 2);
      assert.ok(!filtered.some((c) => c.roomId === 'r1'));
      assert.ok(state.getArchivedConversations().some((c) => c.roomId === 'r1'));
    });

    test('40. Unarchive restores Custom List visibility without altering list membership', () => {
      const list = state.createCustomList('Work', ['r1', 'r2', 'r3']);
      state.archiveChat('r1');
      assert.ok(list.roomIds.includes('r1'), 'r1 remains in Work list definition');

      state.unarchiveChat('r1');
      state.setActiveFilter(list.id);
      const filtered = state.getFilteredConversations();
      assert.equal(filtered.length, 3);
      assert.ok(filtered.some((c) => c.roomId === 'r1'), 'r1 is visible in Work again');
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // REGRESSION TESTS (41 - 55)
  // ════════════════════════════════════════════════════════════════════
  describe('Regression Protection Invariants', () => {
    test('41. All filter remains unchanged and returns non-archived chats', () => {
      state.setActiveFilter('all');
      state.archiveChat('r4');
      assert.equal(state.getFilteredConversations().length, 3);
    });

    test('42. Unread filter remains unchanged', () => {
      state.setActiveFilter('unread');
      // r2 has unread: 2, r4 has unread: 3
      assert.equal(state.getFilteredConversations().length, 2);
      state.archiveChat('r2');
      assert.equal(state.getFilteredConversations().length, 1);
    });

    test('43. Favourites filter remains unchanged', () => {
      state.favouriteChat('r1');
      state.favouriteChat('r2');
      state.setActiveFilter('favourites');
      assert.equal(state.getFilteredConversations().length, 2);
      state.archiveChat('r1');
      assert.equal(state.getFilteredConversations().length, 1);
    });

    test('44. Groups filter remains unchanged', () => {
      state.setActiveFilter('groups');
      // r3, r4 are groups
      assert.equal(state.getFilteredConversations().length, 2);
    });

    test('45. Custom Lists creation, update, and deletion remain intact', () => {
      const newList = state.createCustomList('Family', ['r1']);
      assert.equal(newList.name, 'Family');
      state.updateCustomList(newList.id, { name: 'Close Family' });
      assert.equal(state.getCustomList(newList.id).name, 'Close Family');
      state.deleteCustomList(newList.id);
      assert.equal(state.getCustomList(newList.id), null);
    });

    test('46. Navigation rail layout remains intact in index.html and styles.css', () => {
      assert.ok(html.includes('class="nav-rail" id="nav-rail"'));
      assert.ok(css.includes('.nav-rail'));
      assert.ok(css.includes('.nav-rail-btn.active'));
    });

    test('47. Light theme works', () => {
      assert.doesNotThrow(() => {
        applyAppTheme('light');
        assert.equal(getResolvedAppTheme(), 'light');
      });
    });

    test('48. Dark theme works', () => {
      assert.doesNotThrow(() => {
        applyAppTheme('dark');
        assert.equal(getResolvedAppTheme(), 'dark');
      });
    });

    test('49. System theme works', () => {
      assert.doesNotThrow(() => {
        applyAppTheme('system');
        const resolved = getResolvedAppTheme();
        assert.ok(resolved === 'light' || resolved === 'dark');
      });
    });

    test('50. Chat Themes system remains intact', () => {
      assert.ok(html.includes('id="chat-theme-modal"'));
      assert.ok(html.includes('id="theme-presets-scroll"'));
      assert.ok(PRESET_THEMES && PRESET_THEMES.length >= 8);
    });

    test('51. Messaging and composer elements remain intact', () => {
      assert.ok(html.includes('id="composer-input"'));
      assert.ok(html.includes('id="btn-send-message"'));
      assert.ok(html.includes('id="messages-list"'));
    });

    test('52. Voice calling elements remain intact', () => {
      assert.ok(html.includes('id="btn-start-voice-call"'));
      assert.ok(html.includes('id="voice-call-overlay"'));
      assert.ok(html.includes('id="btn-call-mute"'));
      assert.ok(html.includes('id="btn-call-end"'));
    });

    test('53. Video calling elements remain intact', () => {
      assert.ok(html.includes('id="btn-start-video-call"'));
      assert.ok(html.includes('id="video-stage"'));
      assert.ok(html.includes('id="remote-video"'));
      assert.ok(html.includes('id="local-video"'));
    });

    test('54. Minimized audio calls and popout view remain intact', () => {
      assert.ok(html.includes('id="btn-call-popout"'));
      assert.ok(html.includes('id="btn-call-maximize"'));
    });

    test('55. Add People to call modal remains intact', () => {
      assert.ok(html.includes('id="btn-call-add-participant"'));
      assert.ok(html.includes('id="call-add-participant-modal"'));
      assert.ok(html.includes('id="call-participants-list"'));
    });
  });
});
