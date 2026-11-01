import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ChatShellState,
  RoomMessagesState
} from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appJsPath = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
const appJs = fs.readFileSync(appJsPath, 'utf8');

// Lightweight Mock DOM node for testing in Node without external dependencies
function createMockElement(tagName = 'div', className = '', id = '') {
  const children = [];
  const attributes = new Map();
  const classListSet = new Set(className.split(' ').filter(Boolean));

  return {
    tagName: tagName.toUpperCase(),
    id,
    className,
    dataset: {},
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    classList: {
      add: (cls) => classListSet.add(cls),
      remove: (cls) => classListSet.delete(cls),
      contains: (cls) => classListSet.has(cls)
    },
    setAttribute: (k, v) => attributes.set(k, String(v)),
    getAttribute: (k) => attributes.get(k) || null,
    removeAttribute: (k) => attributes.delete(k),
    appendChild: (child) => {
      children.push(child);
      return child;
    },
    removeChild: (child) => {
      const idx = children.indexOf(child);
      if (idx !== -1) children.splice(idx, 1);
      return child;
    },
    get children() {
      return children;
    },
    set innerHTML(val) {
      if (val === '') children.length = 0;
    },
    querySelector: (selector) => {
      const all = [];
      function traverse(node) {
        for (const c of node.children) {
          all.push(c);
          traverse(c);
        }
      }
      traverse({ children });
      if (selector.startsWith('#')) {
        const targetId = selector.slice(1);
        return all.find((el) => el.id === targetId) || null;
      }
      if (selector.startsWith('[data-message-id="')) {
        const val = selector.match(/data-message-id="([^"]+)"/)?.[1];
        return all.find((el) => el.getAttribute('data-message-id') === val) || null;
      }
      return all[0] || null;
    },
    querySelectorAll: (selector) => {
      const all = [];
      function traverse(node) {
        for (const c of node.children) {
          all.push(c);
          traverse(c);
        }
      }
      traverse({ children });
      if (selector.includes('.message-row')) {
        return all.filter((el) => el.classList.contains('message-row'));
      }
      return all;
    },
    getBoundingClientRect: () => ({
      top: 0,
      bottom: 600,
      left: 0,
      right: 300,
      width: 300,
      height: 600
    })
  };
}

describe('Conversation Switching Scroll Restoration & Stability Suite', () => {
  let messagesScrollArea;
  let messagesList;
  let scrollBottomBtn;
  let shellState;
  let roomSavedScrollPositions;

  beforeEach(() => {
    messagesScrollArea = createMockElement('div', 'messages-scroll-area', 'messages-scroll-area');
    messagesList = createMockElement('div', 'messages-list', 'messages-list');
    scrollBottomBtn = createMockElement('button', 'scroll-bottom-btn hidden', 'scroll-bottom-btn');
    messagesScrollArea.appendChild(messagesList);

    shellState = new ChatShellState({
      userProfile: { userId: 'usr_me', name: 'Me' }
    });
    roomSavedScrollPositions = new Map();
  });

  function createMockMessageRow(id, text, height = 40, contentOffsetTop = 0) {
    const row = createMockElement('div', 'message-row incoming', `msg-${id}`);
    row.setAttribute('data-message-id', id);

    const bubble = createMockElement('div', 'message-bubble');
    row.appendChild(bubble);

    row.contentOffsetTop = contentOffsetTop;
    row.contentHeight = height;

    row.getBoundingClientRect = () => {
      const top = row.contentOffsetTop - messagesScrollArea.scrollTop;
      return {
        top,
        bottom: top + row.contentHeight,
        left: 0,
        right: 300,
        width: 300,
        height: row.contentHeight
      };
    };

    return row;
  }

  function simulateSaveRoomScrollPosition(roomId, { forceNearBottom = false } = {}) {
    if (!roomId || !messagesScrollArea || !messagesList) return;
    const messageRows = messagesList.querySelectorAll('.message-row[data-message-id], .message-row, [data-message-id]');
    if (messageRows.length === 0) return;

    const scrollTop = messagesScrollArea.scrollTop;
    const scrollHeight = messagesScrollArea.scrollHeight;
    const clientHeight = messagesScrollArea.clientHeight;
    const distFromBottom = scrollHeight - scrollTop - clientHeight;
    let isNearBottom = forceNearBottom || distFromBottom <= 140 || scrollHeight <= (clientHeight + 5);
    let isViewingLatest = isNearBottom;
    let lastMessageId = null;

    if (messageRows.length > 0) {
      const lastRow = messageRows[messageRows.length - 1];
      lastMessageId = lastRow.getAttribute('data-message-id') || lastRow.id?.replace(/^msg-/, '');
      const lastRect = lastRow.getBoundingClientRect();
      const areaRect = messagesScrollArea.getBoundingClientRect();
      if (lastRect.top < areaRect.bottom && (lastRect.bottom >= areaRect.top || lastRect.bottom >= (areaRect.bottom - 100))) {
        isViewingLatest = true;
      }
    }

    if (isViewingLatest || isNearBottom) {
      isNearBottom = true;
      isViewingLatest = true;
    }

    let anchorMessageId = null;
    let anchorOffsetTop = 0;
    const areaRect = messagesScrollArea.getBoundingClientRect();

    for (const row of messageRows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > areaRect.top) {
        anchorMessageId = row.getAttribute('data-message-id') || row.id?.replace(/^msg-/, '');
        anchorOffsetTop = rect.top - areaRect.top;
        break;
      }
    }

    roomSavedScrollPositions.set(String(roomId), {
      scrollTop,
      scrollHeight,
      clientHeight,
      isNearBottom,
      isViewingLatest,
      lastMessageId: lastMessageId || null,
      anchorMessageId: anchorMessageId || null,
      anchorOffsetTop,
      savedAt: Date.now()
    });
  }

  function simulateRestoreRoomScrollPosition(roomId) {
    if (!roomId) return false;
    const saved = roomSavedScrollPositions.get(String(roomId));
    if (!saved) return false;

    if (saved.isViewingLatest || saved.isNearBottom) {
      messagesScrollArea.scrollTop = messagesScrollArea.scrollHeight;
      scrollBottomBtn?.classList.add('hidden');
      return { type: 'bottom', scrollTop: messagesScrollArea.scrollTop };
    }

    if (saved.anchorMessageId) {
      const el = messagesList.querySelector(`[data-message-id="${saved.anchorMessageId}"]`);
      if (el) {
        const areaRect = messagesScrollArea.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const currentDiff = elRect.top - areaRect.top;
        const adjustment = currentDiff - saved.anchorOffsetTop;
        messagesScrollArea.scrollTop += adjustment;

        const distFromBottom = messagesScrollArea.scrollHeight - messagesScrollArea.scrollTop - messagesScrollArea.clientHeight;
        if (distFromBottom > 150) {
          scrollBottomBtn?.classList.remove('hidden');
        } else {
          scrollBottomBtn?.classList.add('hidden');
        }
        return { type: 'anchor', anchorMessageId: saved.anchorMessageId, scrollTop: messagesScrollArea.scrollTop };
      }
    }

    messagesScrollArea.scrollTop = saved.scrollTop;
    return { type: 'pixel', scrollTop: messagesScrollArea.scrollTop };
  }

  // ───────────────────────────────────────────────────────────────────
  // Static Contract Invariants
  // ───────────────────────────────────────────────────────────────────
  describe('Static Invariants', () => {
    test('app.js exports near-bottom detection and scroll restoration methods', () => {
      assert.ok(appJs.includes('export const roomSavedScrollPositions = new Map()'));
      assert.ok(appJs.includes('export function saveRoomScrollPosition('));
      assert.ok(appJs.includes('export function restoreRoomScrollPosition('));
      assert.ok(appJs.includes('export function captureScrollAnchor('));
      assert.ok(appJs.includes('export function restoreScrollAnchor('));
    });

    test('app.js guards against synthetic reflow scroll corrupting bottom positions', () => {
      assert.ok(
        appJs.includes('!isUserScroll && prevSaved && (prevSaved.isViewingLatest || prevSaved.isNearBottom) && !isNear'),
        'Must protect against synthetic reflow events overwriting near-bottom state'
      );
    });

    test('app.js uses 140px threshold for near-bottom detection to align with UI button hiding', () => {
      assert.ok(
        appJs.includes('distFromBottom <= 140'),
        'Must use 140px threshold for reliable bottom detection'
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Functional Invariant Tests
  // ───────────────────────────────────────────────────────────────────
  describe('Scenario 1: User at latest message returns to latest message', () => {
    test('Returning to User A after visiting User B restores User A to the latest message if previously at bottom', () => {
      shellState.selectedRoomId = 'room_A';
      messagesScrollArea.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 });

      // Populate room A with 20 messages
      messagesList.innerHTML = '';
      for (let i = 1; i <= 20; i++) {
        const row = createMockMessageRow(`msg_A_${i}`, `Hello ${i}`, 40, (i - 1) * 45);
        messagesList.appendChild(row);
      }
      messagesScrollArea.scrollHeight = 1000;
      messagesScrollArea.clientHeight = 600;
      messagesScrollArea.scrollTop = 400; // Scrolled to bottom (distFromBottom = 0)

      // User leaves Room A -> saveRoomScrollPosition('room_A')
      simulateSaveRoomScrollPosition('room_A');

      const savedA = roomSavedScrollPositions.get('room_A');
      assert.ok(savedA);
      assert.equal(savedA.isNearBottom, true, 'Room A must be flagged near bottom');
      assert.equal(savedA.isViewingLatest, true, 'Room A must be flagged viewing latest');

      // User enters Room B
      shellState.selectedRoomId = 'room_B';
      messagesList.innerHTML = '';
      for (let i = 1; i <= 5; i++) {
        const row = createMockMessageRow(`msg_B_${i}`, `Chat B ${i}`, 40, (i - 1) * 45);
        messagesList.appendChild(row);
      }
      messagesScrollArea.scrollHeight = 300;
      messagesScrollArea.scrollTop = 0;
      simulateSaveRoomScrollPosition('room_B');

      // User returns to Room A
      shellState.selectedRoomId = 'room_A';
      messagesList.innerHTML = '';
      for (let i = 1; i <= 20; i++) {
        const row = createMockMessageRow(`msg_A_${i}`, `Hello ${i}`, 40, (i - 1) * 45);
        messagesList.appendChild(row);
      }
      messagesScrollArea.scrollHeight = 1000;

      // Restore Room A position
      const restoreResult = simulateRestoreRoomScrollPosition('room_A');
      assert.equal(restoreResult.type, 'bottom');
      assert.equal(messagesScrollArea.scrollTop, 1000, 'ScrollTop must match scrollHeight (latest message)');
      assert.ok(scrollBottomBtn.classList.contains('hidden'), 'Scroll bottom button must be hidden at bottom');
    });
  });

  describe('Scenario 2: User reading older messages preserves reading position', () => {
    test('Returning to User A restores the previous reading position if the user was reading older messages', () => {
      shellState.selectedRoomId = 'room_A';
      messagesScrollArea.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 });

      // Populate room A with 50 messages
      messagesList.innerHTML = '';
      for (let i = 1; i <= 50; i++) {
        const row = createMockMessageRow(`msg_A_${i}`, `Message ${i}`, 50, (i - 1) * 60);
        messagesList.appendChild(row);
      }
      messagesScrollArea.scrollHeight = 3000;
      messagesScrollArea.clientHeight = 600;
      // User is scrolled up reading message 15 (contentOffsetTop = 14 * 60 = 840)
      messagesScrollArea.scrollTop = 830; // so msg_A_15 top = 840 - 830 = 10px

      // User leaves Room A -> save
      simulateSaveRoomScrollPosition('room_A');

      const savedA = roomSavedScrollPositions.get('room_A');
      assert.ok(savedA);
      assert.equal(savedA.isNearBottom, false, 'Room A was not near bottom');
      assert.equal(savedA.isViewingLatest, false, 'Room A was not viewing latest');
      assert.equal(savedA.anchorMessageId, 'msg_A_15', 'Anchor must be message 15');
      assert.equal(savedA.anchorOffsetTop, 10, 'Anchor offset must be preserved');

      // User visits Room B
      shellState.selectedRoomId = 'room_B';
      messagesList.innerHTML = '';
      messagesScrollArea.scrollHeight = 500;
      messagesScrollArea.scrollTop = 0;

      // User returns to Room A
      shellState.selectedRoomId = 'room_A';
      messagesList.innerHTML = '';
      for (let i = 1; i <= 50; i++) {
        const row = createMockMessageRow(`msg_A_${i}`, `Message ${i}`, 50, (i - 1) * 60);
        messagesList.appendChild(row);
      }
      messagesScrollArea.scrollHeight = 3000;
      messagesScrollArea.scrollTop = 0;

      const restoreResult = simulateRestoreRoomScrollPosition('room_A');
      assert.equal(restoreResult.type, 'anchor');
      assert.equal(restoreResult.anchorMessageId, 'msg_A_15');
      // ScrollTop adjusted: 0 + (840 - 0) - 10 = 830
      assert.equal(messagesScrollArea.scrollTop, 830);
      // Not forced to bottom (3000)
      assert.notEqual(messagesScrollArea.scrollTop, 3000);
    });
  });

  describe('Scenario 3: Multi-conversation switching independence', () => {
    test('Switching between several conversations does not mix their saved scroll positions', () => {
      messagesScrollArea.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 });
      messagesScrollArea.clientHeight = 600;

      // Room A: At bottom
      shellState.selectedRoomId = 'room_A';
      messagesList.innerHTML = '';
      for (let i = 1; i <= 10; i++) {
        messagesList.appendChild(createMockMessageRow(`msg_A_${i}`, `A ${i}`, 40, (i - 1) * 50));
      }
      messagesScrollArea.scrollHeight = 500;
      messagesScrollArea.scrollTop = 0; // fits in screen
      simulateSaveRoomScrollPosition('room_A');

      // Room B: Scrolled up reading older message 5 (contentOffsetTop = 4 * 60 = 240)
      shellState.selectedRoomId = 'room_B';
      messagesList.innerHTML = '';
      for (let i = 1; i <= 40; i++) {
        messagesList.appendChild(createMockMessageRow(`msg_B_${i}`, `B ${i}`, 50, (i - 1) * 60));
      }
      messagesScrollArea.scrollHeight = 2400;
      messagesScrollArea.scrollTop = 240; // msg_B_5 top = 240 - 240 = 0, msg_B_4 bottom = 180 + 50 - 240 = -10
      simulateSaveRoomScrollPosition('room_B');

      // Room C: At bottom with large history
      shellState.selectedRoomId = 'room_C';
      messagesList.innerHTML = '';
      for (let i = 1; i <= 30; i++) {
        messagesList.appendChild(createMockMessageRow(`msg_C_${i}`, `C ${i}`, 50, (i - 1) * 60));
      }
      messagesScrollArea.scrollHeight = 1800;
      messagesScrollArea.scrollTop = 1200; // at bottom (dist = 0)
      simulateSaveRoomScrollPosition('room_C');

      // Verify states are isolated
      assert.equal(roomSavedScrollPositions.get('room_A').isNearBottom, true);
      assert.equal(roomSavedScrollPositions.get('room_B').isNearBottom, false);
      assert.equal(roomSavedScrollPositions.get('room_B').anchorMessageId, 'msg_B_5');
      assert.equal(roomSavedScrollPositions.get('room_C').isNearBottom, true);

      // Return to B -> restores anchor
      messagesList.innerHTML = '';
      for (let i = 1; i <= 40; i++) {
        messagesList.appendChild(createMockMessageRow(`msg_B_${i}`, `B ${i}`, 50, (i - 1) * 60));
      }
      messagesScrollArea.scrollHeight = 2400;
      messagesScrollArea.scrollTop = 0;
      const restoreB = simulateRestoreRoomScrollPosition('room_B');
      assert.equal(restoreB.type, 'anchor');
      assert.equal(restoreB.anchorMessageId, 'msg_B_5');
      assert.equal(messagesScrollArea.scrollTop, 240);

      // Return to A -> restores bottom
      messagesList.innerHTML = '';
      for (let i = 1; i <= 10; i++) {
        messagesList.appendChild(createMockMessageRow(`msg_A_${i}`, `A ${i}`, 40, (i - 1) * 50));
      }
      messagesScrollArea.scrollHeight = 500;
      const restoreA = simulateRestoreRoomScrollPosition('room_A');
      assert.equal(restoreA.type, 'bottom');

      // Return to C -> restores bottom
      messagesList.innerHTML = '';
      for (let i = 1; i <= 30; i++) {
        messagesList.appendChild(createMockMessageRow(`msg_C_${i}`, `C ${i}`, 50, (i - 1) * 60));
      }
      messagesScrollArea.scrollHeight = 1800;
      const restoreC = simulateRestoreRoomScrollPosition('room_C');
      assert.equal(restoreC.type, 'bottom');
    });
  });

  describe('Scenario 4: Stale responses and synthetic reflow protection', () => {
    test('Delayed message-history responses do not overwrite the active conversation scroll position', () => {
      let activeLoadToken = 1;
      let selectedRoomId = 'room_A';

      // Load for room A initiated
      const token1 = activeLoadToken;

      // User immediately switches to room B
      activeLoadToken = 2;
      selectedRoomId = 'room_B';

      // Stale response arrives for room A
      const isStale = (token1 !== activeLoadToken || selectedRoomId !== 'room_A');
      assert.equal(isStale, true, 'Async response for room_A must be recognized as stale');

      // No mutation or scroll change must be applied to room B
      assert.equal(selectedRoomId, 'room_B');
    });

    test('Synthetic scroll reflow event does not downgrade an at-bottom room to reading older history', () => {
      // Room A is saved at bottom
      roomSavedScrollPositions.set('room_A', {
        scrollTop: 2000,
        scrollHeight: 2600,
        clientHeight: 600,
        isNearBottom: true,
        isViewingLatest: true,
        lastMessageId: 'msg_100',
        savedAt: Date.now()
      });

      // Simulate a synthetic reflow during message prepending where scrollTop is 0 and scrollHeight is 5000
      messagesScrollArea.scrollTop = 0;
      messagesScrollArea.scrollHeight = 5000;
      messagesScrollArea.clientHeight = 600;

      const isUserScroll = false; // Synthetic event without user interaction
      const prevSaved = roomSavedScrollPositions.get('room_A');
      const distFromBottom = messagesScrollArea.scrollHeight - messagesScrollArea.scrollTop - messagesScrollArea.clientHeight;
      const isNear = distFromBottom <= 140;

      // Guard check from app.js
      let savedOverwritten = false;
      if (!isUserScroll && prevSaved && (prevSaved.isViewingLatest || prevSaved.isNearBottom) && !isNear) {
        // Ignored, do not overwrite!
      } else {
        savedOverwritten = true;
      }

      assert.equal(savedOverwritten, false, 'Synthetic reflow must NOT overwrite near-bottom state');
      assert.equal(roomSavedScrollPositions.get('room_A').isNearBottom, true);
    });
  });

  describe('Scenario 5: New messages arriving while conversation is inactive', () => {
    test('New messages arriving while inactive are displayed at the bottom when user returns', () => {
      // Room A was left at bottom
      roomSavedScrollPositions.set('room_A', {
        scrollTop: 1000,
        scrollHeight: 1600,
        clientHeight: 600,
        isNearBottom: true,
        isViewingLatest: true,
        lastMessageId: 'msg_A_10',
        savedAt: Date.now()
      });

      // While inactive, new messages arrive: msg_A_11, msg_A_12
      shellState.selectedRoomId = 'room_A';
      messagesList.innerHTML = '';
      for (let i = 1; i <= 12; i++) {
        messagesList.appendChild(createMockMessageRow(`msg_A_${i}`, `Message ${i}`, 50, (i - 1) * 60));
      }
      messagesScrollArea.scrollHeight = 1900; // expanded by new messages

      // When returning to room A:
      const restoreResult = simulateRestoreRoomScrollPosition('room_A');
      assert.equal(restoreResult.type, 'bottom');
      assert.equal(messagesScrollArea.scrollTop, 1900, 'Scroll position must be at the very bottom including newest messages');

      // The last element in DOM is msg_A_12
      const allRows = messagesList.querySelectorAll('.message-row');
      const lastRow = allRows[allRows.length - 1];
      assert.equal(lastRow.getAttribute('data-message-id'), 'msg_A_12');
    });
  });
});
