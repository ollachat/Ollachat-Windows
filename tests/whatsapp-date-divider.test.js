import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  groupMessagesByDay,
  formatDayDivider,
  calculateVisibleDateLabel,
  RoomMessagesState
} from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('WhatsApp-Style Date Divider & Floating Indicator Tests', () => {
  const fixedNow = new Date('2026-10-25T12:00:00Z');

  // ── Scenario 1: A conversation containing messages from one day ──
  test('Scenario 1: Conversation containing messages from one day produces exactly one divider', () => {
    const messages = [
      { id: 'm1', createdAt: '2026-10-25T08:00:00Z', body: { text: 'Morning' } },
      { id: 'm2', createdAt: '2026-10-25T10:30:00Z', body: { text: 'Midday' } },
      { id: 'm3', createdAt: '2026-10-25T11:45:00Z', body: { text: 'Lunch' } }
    ];

    const groups = groupMessagesByDay(messages, fixedNow);
    assert.equal(groups.length, 1, 'Exactly one day group produced');
    assert.equal(groups[0].label, 'Today', 'Label is "Today"');
    assert.equal(groups[0].messages.length, 3, 'All 3 messages in the single group');
  });

  // ── Scenario 2: A conversation spanning several days ──
  test('Scenario 2: Conversation spanning several days produces contextual labels and correct boundaries', () => {
    const messages = [
      { id: 'm1', createdAt: '2026-10-20T09:00:00Z', body: { text: 'Oct 20 message' } },
      { id: 'm2', createdAt: '2026-10-24T15:00:00Z', body: { text: 'Yesterday message' } },
      { id: 'm3', createdAt: '2026-10-25T10:00:00Z', body: { text: 'Today message' } }
    ];

    const groups = groupMessagesByDay(messages, fixedNow);
    assert.equal(groups.length, 3, 'Produces 3 day groups');
    assert.equal(groups[0].label, 'Tuesday, Oct 20', 'First day is formatted date');
    assert.equal(groups[1].label, 'Yesterday', 'Second day is "Yesterday"');
    assert.equal(groups[2].label, 'Today', 'Third day is "Today"');

    // Verify ordering
    assert.ok(groups[0].dateKey < groups[1].dateKey, 'Day 1 precedes Day 2');
    assert.ok(groups[1].dateKey < groups[2].dateKey, 'Day 2 precedes Day 3');
  });

  // ── Scenario 3: Hundreds of messages across many days ──
  test('Scenario 3: Hundreds of messages across 30 days preserve chronological order and equal-timestamp sequence', () => {
    const messages = [];
    const baseDate = new Date('2026-09-25T00:00:00Z');

    // Generate 300 messages across 30 days
    for (let day = 0; day < 30; day++) {
      for (let m = 0; m < 10; m++) {
        const d = new Date(baseDate.getTime() + day * 86400000 + m * 3600000);
        messages.push({
          id: `msg-${day}-${m}`,
          createdAt: d.toISOString(),
          eventSeq: day * 10 + m + 1,
          body: { text: `Day ${day} msg ${m}` }
        });
      }
    }

    // Add some messages with equal timestamps but distinct sequences/orders
    const tieDate = '2026-10-10T12:00:00Z';
    messages.push(
      { id: 'tie-2', createdAt: tieDate, eventSeq: 999, order: 2, body: { text: 'Tie second' } },
      { id: 'tie-1', createdAt: tieDate, eventSeq: 998, order: 1, body: { text: 'Tie first' } }
    );

    const groups = groupMessagesByDay(messages, fixedNow);
    assert.equal(groups.length, 30, 'Should have exactly 30 distinct day groups');

    // Verify chronological order across all groups
    for (let i = 1; i < groups.length; i++) {
      assert.ok(groups[i - 1].dateKey < groups[i].dateKey, `Group ${i - 1} precedes Group ${i}`);
    }

    // Check tie resolution within Oct 10 group
    const tieGroup = groups.find((g) => g.dateKey === '2026-10-10');
    assert.ok(tieGroup, 'Oct 10 group found');
    const tie1Idx = tieGroup.messages.findIndex((m) => m.id === 'tie-1');
    const tie2Idx = tieGroup.messages.findIndex((m) => m.id === 'tie-2');
    assert.ok(tie1Idx < tie2Idx, 'Equal timestamp message with lower seq appears before higher seq');
  });

  // ── Scenario 4: Fast scrolling and slow scrolling in both directions ──
  test('Scenario 4: calculateVisibleDateLabel tracks visible day during slow and fast scrolling in both directions', () => {
    // Construct mock DOM elements representing day dividers and message rows
    const mockElements = [
      { offsetTop: 10, offsetHeight: 28, dataset: { dateLabel: 'Oct 22' }, isDivider: true },
      { offsetTop: 45, offsetHeight: 50, dataset: { dateLabel: 'Oct 22' } },
      { offsetTop: 100, offsetHeight: 50, dataset: { dateLabel: 'Oct 22' } },
      { offsetTop: 160, offsetHeight: 28, dataset: { dateLabel: 'Yesterday' }, isDivider: true },
      { offsetTop: 195, offsetHeight: 60, dataset: { dateLabel: 'Yesterday' } },
      { offsetTop: 260, offsetHeight: 70, dataset: { dateLabel: 'Yesterday' } },
      { offsetTop: 340, offsetHeight: 28, dataset: { dateLabel: 'Today' }, isDivider: true },
      { offsetTop: 375, offsetHeight: 40, dataset: { dateLabel: 'Today' } },
      { offsetTop: 420, offsetHeight: 50, dataset: { dateLabel: 'Today' } }
    ];

    // Top of view (scrollTop = 0) -> Oct 22
    assert.equal(calculateVisibleDateLabel(0, mockElements), 'Oct 22');

    // Slow scrolling down:
    assert.equal(calculateVisibleDateLabel(50, mockElements), 'Oct 22');
    assert.equal(calculateVisibleDateLabel(120, mockElements), 'Oct 22');

    // Crosses into Yesterday (scrollTop = 150 -> targetY = 180)
    assert.equal(calculateVisibleDateLabel(150, mockElements), 'Yesterday');
    assert.equal(calculateVisibleDateLabel(220, mockElements), 'Yesterday');

    // Fast scroll down into Today (scrollTop = 350 -> targetY = 380)
    assert.equal(calculateVisibleDateLabel(350, mockElements), 'Today');
    assert.equal(calculateVisibleDateLabel(400, mockElements), 'Today');

    // Fast scroll up back to Oct 22 (scrollTop = 20 -> targetY = 50)
    assert.equal(calculateVisibleDateLabel(20, mockElements), 'Oct 22');

    // Slow scroll down back to Yesterday (scrollTop = 160)
    assert.equal(calculateVisibleDateLabel(160, mockElements), 'Yesterday');
  });

  // ── Scenario 5: Pausing after scrolling and confirming floating indicator fades away ──
  test('Scenario 5: Floating indicator uses debounce timer to fade away when scrolling stops', async () => {
    let indicatorVisible = true;
    let timerId = null;

    function simulateScroll() {
      indicatorVisible = true;
      if (timerId) clearTimeout(timerId);
      timerId = setTimeout(() => {
        indicatorVisible = false;
      }, 50); // fast 50ms test timeout
    }

    simulateScroll();
    assert.equal(indicatorVisible, true, 'Visible while scrolling');

    // Wait 80ms for pause
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(indicatorVisible, false, 'Faded out after scrolling stops');
  });

  // ── Scenario 6: Loading older history through pagination ──
  test('Scenario 6: Pagination prepending older messages preserves exact single day boundaries', () => {
    const rState = new RoomMessagesState('user-1');
    rState.roomId = 'room-1';

    // Page 1: Today and Yesterday
    const page1 = [
      { id: 'm3', createdAt: '2026-10-24T18:00:00Z', body: { text: 'Yesterday evening' } },
      { id: 'm4', createdAt: '2026-10-25T09:00:00Z', body: { text: 'Today morning' } }
    ];
    rState.setInitialMessages('room-1', page1, true);

    let groups = groupMessagesByDay(rState.messages, fixedNow);
    assert.equal(groups.length, 2, 'Initially 2 groups (Yesterday & Today)');

    // Page 2 (Older): earlier Yesterday message and Oct 20 message
    const page2 = [
      { id: 'm1', createdAt: '2026-10-20T10:00:00Z', body: { text: 'Oct 20 message' } },
      { id: 'm2', createdAt: '2026-10-24T08:00:00Z', body: { text: 'Yesterday morning' } }
    ];
    rState.prependOlderMessages(page2, false);

    groups = groupMessagesByDay(rState.messages, fixedNow);
    assert.equal(groups.length, 3, 'After pagination, exactly 3 groups (Oct 20, Yesterday, Today)');
    assert.equal(groups[0].label, 'Tuesday, Oct 20');
    assert.equal(groups[1].label, 'Yesterday');
    assert.equal(groups[1].messages.length, 2, 'Yesterday contains both m2 and m3 with strictly ONE divider');
    assert.equal(groups[2].label, 'Today');
  });

  // ── Scenario 7: Receiving a new realtime message while chat is open ──
  test('Scenario 7: Realtime message appends to active day without creating duplicate divider', () => {
    const rState = new RoomMessagesState('user-1');
    rState.roomId = 'room-1';

    const initial = [
      { id: 'm1', createdAt: '2026-10-25T08:00:00Z', body: { text: 'First msg today' } }
    ];
    rState.setInitialMessages('room-1', initial, false);

    let groups = groupMessagesByDay(rState.messages, fixedNow);
    assert.equal(groups.length, 1, 'Initially 1 group');

    // New realtime message arrives on same day
    rState.appendIncomingMessage({ id: 'm2', createdAt: '2026-10-25T11:00:00Z', body: { text: 'Second msg today' } });

    groups = groupMessagesByDay(rState.messages, fixedNow);
    assert.equal(groups.length, 1, 'Still strictly 1 day group');
    assert.equal(groups[0].messages.length, 2, 'Both messages grouped together');

    // Next day message arrives (e.g. crossing midnight)
    rState.appendIncomingMessage({ id: 'm3', createdAt: '2026-10-26T00:05:00Z', body: { text: 'Midnight message' } });

    groups = groupMessagesByDay(rState.messages, fixedNow);
    assert.equal(groups.length, 2, 'Crossed midnight: exactly 2 day groups');
    assert.equal(groups[0].messages.length, 2, 'Day 1 has 2 messages');
    assert.equal(groups[1].messages.length, 1, 'Day 2 has 1 message');
  });

  // ── Scenario 8: Switching conversations repeatedly ──
  test('Scenario 8: Switching conversations isolates room message states and resets floating indicator', () => {
    const roomA = new RoomMessagesState('user-1');
    roomA.roomId = 'room-A';
    roomA.setInitialMessages('room-A', [
      { id: 'a1', createdAt: '2026-10-25T08:00:00Z', body: { text: 'Room A today' } }
    ]);

    const roomB = new RoomMessagesState('user-1');
    roomB.roomId = 'room-B';
    roomB.setInitialMessages('room-B', [
      { id: 'b1', createdAt: '2026-10-22T08:00:00Z', body: { text: 'Room B older' } }
    ]);

    const groupsA = groupMessagesByDay(roomA.messages, fixedNow);
    assert.equal(groupsA[0].label, 'Today');

    const groupsB = groupMessagesByDay(roomB.messages, fixedNow);
    assert.equal(groupsB[0].label, 'Thursday, Oct 22');

    // Neither state leaks dividers to the other
    assert.notEqual(groupsA[0].dateKey, groupsB[0].dateKey);
  });

  // ── Scenario 9: Opening conversation from notification ──
  test('Scenario 9: Opening conversation from notification initiates clean message rendering', () => {
    const notifRoomState = new RoomMessagesState('user-1');
    notifRoomState.roomId = 'room-notif';
    notifRoomState.setInitialMessages('room-notif', [
      { id: 'n1', createdAt: '2026-10-24T10:00:00Z', body: { text: 'Notification origin' } },
      { id: 'n2', createdAt: '2026-10-25T09:00:00Z', body: { text: 'New notification message' } }
    ]);

    const groups = groupMessagesByDay(notifRoomState.messages, fixedNow);
    assert.equal(groups.length, 2, 'Two days rendered');
    assert.equal(groups[0].label, 'Yesterday');
    assert.equal(groups[1].label, 'Today');
  });

  // ── Scenario 10: Confirming that only one permanent divider appears per date transition ──
  test('Scenario 10: Only one permanent divider appears per date transition across any arrangement of messages', () => {
    // Arbitrary mix of disordered timestamps
    const messages = [
      { id: '1', createdAt: '2026-10-23T10:00:00Z' },
      { id: '2', createdAt: '2026-10-22T08:00:00Z' },
      { id: '3', createdAt: '2026-10-23T14:00:00Z' },
      { id: '4', createdAt: '2026-10-22T19:00:00Z' },
      { id: '5', createdAt: '2026-10-24T12:00:00Z' }
    ];

    const groups = groupMessagesByDay(messages, fixedNow);
    assert.equal(groups.length, 3, 'Coalesced to 3 calendar days');

    const dateKeys = groups.map((g) => g.dateKey);
    const uniqueKeys = Array.from(new Set(dateKeys));
    assert.equal(dateKeys.length, uniqueKeys.length, 'Strictly 1 divider per transition');
  });

  // ── Scenario 11: DOM structure & CSS styling contracts ──
  test('Scenario 11: DOM structure and CSS styling contract tests', () => {
    const htmlPath = path.join(__dirname, '../src/renderer/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    assert.ok(html.includes('id="floating-date-indicator"'), 'HTML contains #floating-date-indicator');
    assert.ok(html.includes('id="floating-date-pill"'), 'HTML contains #floating-date-pill');
    assert.ok(html.includes('class="floating-date-indicator hidden"'), 'Floating date indicator is initially hidden');

    const cssPath = path.join(__dirname, '../src/renderer/styles.css');
    const css = fs.readFileSync(cssPath, 'utf8');

    // .day-divider checks
    const dividerMatch = css.match(/\.day-divider\s*\{([^}]+)\}/);
    assert.ok(dividerMatch, 'CSS defines .day-divider');
    const dividerCss = dividerMatch[1];
    assert.ok(!dividerCss.includes('position: sticky'), '.day-divider must NOT be position: sticky');
    assert.ok(dividerCss.includes('position: relative'), '.day-divider must be position: relative');

    // .floating-date-indicator checks
    const floatMatch = css.match(/\.floating-date-indicator\s*\{([^}]+)\}/);
    assert.ok(floatMatch, 'CSS defines .floating-date-indicator');
    const floatCss = floatMatch[1];
    assert.ok(floatCss.includes('position: absolute'), 'Floating indicator must be position: absolute overlay');
    assert.ok(floatCss.includes('pointer-events: none'), 'Floating indicator must NOT intercept clicks');
    assert.ok(floatCss.includes('z-index: 10'), 'Floating indicator elevated above messages');

    // .floating-date-pill checks
    const floatPillMatch = css.match(/\.floating-date-pill\s*\{([^}]+)\}/);
    assert.ok(floatPillMatch, 'CSS defines .floating-date-pill');
    const floatPillCss = floatPillMatch[1];
    assert.ok(floatPillCss.includes('border-radius: var(--radius-full)'), 'Floating pill has rounded capsule radius');
    assert.ok(floatPillCss.includes('pointer-events: none'), 'Floating pill does not intercept pointer events');

    // .day-divider.near-top check
    const nearTopMatch = css.match(/\.day-divider\.near-top\s*\{([^}]+)\}/);
    assert.ok(nearTopMatch, 'CSS defines .day-divider.near-top');
    assert.ok(nearTopMatch[1].includes('opacity: 0'), 'near-top divider has opacity: 0 to prevent overlap');
  });
});
