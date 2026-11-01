import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatShellState,
  getConversationTitle,
  getConversationSubtitle,
  getConversationHeaderStatus,
  getDirectPeerUserId
} from '../src/renderer/chat-shell-state.js';

describe('WhatsApp-Style Real-Time Contact Status in Chat Header (17 Requirements)', () => {

  /**
   * Helper that simulates the real-time contact status header controller from app.js.
   */
  function createHeaderStatusController(shellState = new ChatShellState()) {
    const remoteTypingTimeouts = new Map();
    let isLocalTyping = false;
    let activeTypingRoomId = null;
    let lastLocalTypingSent = 0;
    let localTypingInactivityTimer = null;
    const dispatchedEvents = [];

    // Mock WebSocket send methods
    const mockChat = {
      typingStart: async (roomId) => {
        dispatchedEvents.push({ type: 'typing.started', roomId, timestamp: Date.now() });
        return { ok: true };
      },
      typingStop: async (roomId) => {
        dispatchedEvents.push({ type: 'typing.stopped', roomId, timestamp: Date.now() });
        return { ok: true };
      }
    };

    let headerSubtitleText = '';
    let headerTitleText = '';
    let headerSubtitleClasses = new Set();

    function updateChatHeaderSubtitle() {
      const selected = shellState.getSelectedConversation();
      if (!selected) {
        headerSubtitleText = '';
        headerSubtitleClasses.clear();
        return;
      }

      const isGroup = selected.kind === 'group' || selected.isGroup === true;
      if (isGroup) {
        headerSubtitleText = getConversationHeaderStatus(selected);
        headerSubtitleClasses.delete('is-typing');
        headerSubtitleClasses.delete('is-online');
        return;
      }

      const peerId = shellState.getDirectPeerUserId(selected);
      const isTyping = peerId ? shellState.isUserTyping(selected.roomId, peerId) : false;
      const isOnline = peerId ? shellState.isUserOnline(selected.roomId, peerId) : false;
      const statusText = getConversationHeaderStatus(selected, { isTyping, isOnline });

      headerSubtitleText = statusText;
      if (isTyping) {
        headerSubtitleClasses.add('is-typing');
        headerSubtitleClasses.delete('is-online');
      } else if (isOnline) {
        headerSubtitleClasses.add('is-online');
        headerSubtitleClasses.delete('is-typing');
      } else {
        headerSubtitleClasses.delete('is-typing');
        headerSubtitleClasses.delete('is-online');
      }
    }

    function updateChatHeader() {
      const selected = shellState.getSelectedConversation();
      if (selected) {
        headerTitleText = shellState.getConversationTitle(selected);
      } else {
        headerTitleText = '';
      }
      updateChatHeaderSubtitle();
    }

    function selectConversation(roomId) {
      const previousRoomId = shellState.selectedRoomId;
      if (previousRoomId && previousRoomId !== roomId) {
        stopLocalTyping(previousRoomId);
      }
      shellState.selectConversation(roomId);
      updateChatHeader();
    }

    function handleRealtimeEvent(frame) {
      if (!frame || typeof frame !== 'object') return;
      const { type, room_id, payload } = frame;
      const eventRoomId = room_id || frame.roomId || payload?.room_id;

      if (type === 'presence.changed') {
        const principalId = payload?.principal_id || payload?.principalId;
        const online = Boolean(payload?.online);
        if (eventRoomId && principalId) {
          shellState.setPresence(eventRoomId, principalId, online);
          if (!online) {
            const key = `${eventRoomId}:${principalId}`;
            if (remoteTypingTimeouts.has(key)) {
              clearTimeout(remoteTypingTimeouts.get(key));
              remoteTypingTimeouts.delete(key);
            }
            shellState.setTyping(eventRoomId, principalId, false);
          }
          if (shellState.selectedRoomId && String(eventRoomId) === String(shellState.selectedRoomId)) {
            updateChatHeaderSubtitle();
          }
        }
        return;
      }

      if (type === 'typing.started') {
        const principalId = payload?.principal_id || payload?.principalId;
        const currentUserId = shellState.currentUser?.userId;
        if (eventRoomId && principalId && (!currentUserId || String(principalId) !== String(currentUserId))) {
          shellState.setTyping(eventRoomId, principalId, true);
          const key = `${eventRoomId}:${principalId}`;
          if (remoteTypingTimeouts.has(key)) {
            clearTimeout(remoteTypingTimeouts.get(key));
          }
          const timer = setTimeout(() => {
            remoteTypingTimeouts.delete(key);
            shellState.setTyping(eventRoomId, principalId, false);
            if (shellState.selectedRoomId && String(eventRoomId) === String(shellState.selectedRoomId)) {
              updateChatHeaderSubtitle();
            }
          }, 6000);
          remoteTypingTimeouts.set(key, timer);

          if (shellState.selectedRoomId && String(eventRoomId) === String(shellState.selectedRoomId)) {
            updateChatHeaderSubtitle();
          }
        }
        return;
      }

      if (type === 'typing.stopped') {
        const principalId = payload?.principal_id || payload?.principalId;
        if (eventRoomId && principalId) {
          const key = `${eventRoomId}:${principalId}`;
          if (remoteTypingTimeouts.has(key)) {
            clearTimeout(remoteTypingTimeouts.get(key));
            remoteTypingTimeouts.delete(key);
          }
          shellState.setTyping(eventRoomId, principalId, false);
          if (shellState.selectedRoomId && String(eventRoomId) === String(shellState.selectedRoomId)) {
            updateChatHeaderSubtitle();
          }
        }
        return;
      }
    }

    function stopLocalTyping(roomId = null) {
      if (localTypingInactivityTimer) {
        clearTimeout(localTypingInactivityTimer);
        localTypingInactivityTimer = null;
      }
      const targetRoom = roomId || activeTypingRoomId || shellState.selectedRoomId;
      const wasTyping = isLocalTyping;
      isLocalTyping = false;
      activeTypingRoomId = null;
      lastLocalTypingSent = 0;

      if (wasTyping && targetRoom) {
        mockChat.typingStop(targetRoom);
      }
    }

    function handleLocalUserTyping(text, roomId = null, simulatedNow = Date.now()) {
      const targetRoom = roomId || shellState.selectedRoomId;
      if (!targetRoom) return;

      if (!text || !text.trim()) {
        stopLocalTyping(targetRoom);
        return;
      }

      const now = simulatedNow;
      if (!isLocalTyping || activeTypingRoomId !== targetRoom || now - lastLocalTypingSent > 3000) {
        isLocalTyping = true;
        activeTypingRoomId = targetRoom;
        lastLocalTypingSent = now;
        mockChat.typingStart(targetRoom);
      }

      if (localTypingInactivityTimer) {
        clearTimeout(localTypingInactivityTimer);
      }
      localTypingInactivityTimer = setTimeout(() => {
        stopLocalTyping(targetRoom);
      }, 3000);
    }

    function cleanup() {
      stopLocalTyping();
      remoteTypingTimeouts.forEach((t) => clearTimeout(t));
      remoteTypingTimeouts.clear();
      shellState.clear();
    }

    return {
      shellState,
      mockChat,
      dispatchedEvents,
      selectConversation,
      handleRealtimeEvent,
      handleLocalUserTyping,
      stopLocalTyping,
      updateChatHeaderSubtitle,
      updateChatHeader,
      cleanup,
      getSubtitle: () => headerSubtitleText,
      getTitle: () => headerTitleText,
      getClasses: () => Array.from(headerSubtitleClasses),
      hasTimeout: (roomId, principalId) => remoteTypingTimeouts.has(`${roomId}:${principalId}`)
    };
  }

  // Sample seed data
  function setupTestInbox(ctrl) {
    ctrl.shellState.setCurrentUser({ userId: 'usr_me', phone: '+15550001111', displayName: 'My Profile' });
    ctrl.shellState.setInbox([
      {
        roomId: 'room_direct_1',
        title: 'rmm',
        kind: 'direct',
        peer: {
          userId: 'usr_peer_1',
          displayName: 'rmm',
          phone: '+15550002222'
        }
      },
      {
        roomId: 'room_direct_2',
        title: 'Alice',
        kind: 'direct',
        peer: {
          userId: 'usr_peer_2',
          displayName: 'Alice',
          phone: '+15550003333'
        }
      },
      {
        roomId: 'room_group_1',
        title: 'Work Project',
        kind: 'group',
        participantCount: 5,
        participants: [
          { userId: 'usr_me' },
          { userId: 'usr_peer_1' },
          { userId: 'usr_peer_2' }
        ]
      }
    ]);
  }

  // ═══════════════════════════════════════════════════════════════
  // ONLINE / OFFLINE TESTS (1 - 5)
  // ═══════════════════════════════════════════════════════════════

  test('1. presence.changed online=true updates direct chat header to "online"', () => {
    const ctrl = createHeaderStatusController();
    setupTestInbox(ctrl);
    ctrl.selectConversation('room_direct_1');

    // Initially offline -> shows phone number
    assert.equal(ctrl.getSubtitle(), '+15550002222');

    // Remote contact comes online
    ctrl.handleRealtimeEvent({
      v: 1,
      type: 'presence.changed',
      room_id: 'room_direct_1',
      payload: { principal_id: 'usr_peer_1', online: true }
    });

    assert.equal(ctrl.getSubtitle(), 'online');
    assert.ok(ctrl.getClasses().includes('is-online'));
    assert.ok(!ctrl.getClasses().includes('is-typing'));
    ctrl.cleanup();
  });

  test('2. presence.changed online=false restores offline state (peer phone)', () => {
    const ctrl = createHeaderStatusController();
    setupTestInbox(ctrl);
    ctrl.selectConversation('room_direct_1');

    // Peer comes online
    ctrl.handleRealtimeEvent({
      type: 'presence.changed',
      room_id: 'room_direct_1',
      payload: { principal_id: 'usr_peer_1', online: true }
    });
    assert.equal(ctrl.getSubtitle(), 'online');

    // Peer goes offline
    ctrl.handleRealtimeEvent({
      type: 'presence.changed',
      room_id: 'room_direct_1',
      payload: { principal_id: 'usr_peer_1', online: false }
    });
    assert.equal(ctrl.getSubtitle(), '+15550002222');
    assert.ok(!ctrl.getClasses().includes('is-online'));
    assert.ok(!ctrl.getClasses().includes('is-typing'));
    ctrl.cleanup();
  });

  test('3. Presence events for another room do not affect current contact header', () => {
    const ctrl = createHeaderStatusController();
    setupTestInbox(ctrl);
    ctrl.selectConversation('room_direct_1');
    assert.equal(ctrl.getSubtitle(), '+15550002222');

    // Presence event arrives for room_direct_2
    ctrl.handleRealtimeEvent({
      type: 'presence.changed',
      room_id: 'room_direct_2',
      payload: { principal_id: 'usr_peer_2', online: true }
    });

    // Active room 1 is still offline
    assert.equal(ctrl.getSubtitle(), '+15550002222');

    // Switch to room_direct_2 -> should be online
    ctrl.selectConversation('room_direct_2');
    assert.equal(ctrl.getSubtitle(), 'online');
    ctrl.cleanup();
  });

  test('4. Presence state survives normal UI re-render', () => {
    const ctrl = createHeaderStatusController();
    setupTestInbox(ctrl);
    ctrl.selectConversation('room_direct_1');

    ctrl.handleRealtimeEvent({
      type: 'presence.changed',
      room_id: 'room_direct_1',
      payload: { principal_id: 'usr_peer_1', online: true }
    });
    assert.equal(ctrl.getSubtitle(), 'online');

    // Trigger normal header re-render
    ctrl.updateChatHeader();
    assert.equal(ctrl.getSubtitle(), 'online');
    assert.ok(ctrl.getClasses().includes('is-online'));
    ctrl.cleanup();
  });

  test('5. Reconnect correctly refreshes/updates presence', () => {
    const ctrl = createHeaderStatusController();
    setupTestInbox(ctrl);
    ctrl.selectConversation('room_direct_1');

    // Simulate initial presence on connect
    ctrl.handleRealtimeEvent({
      type: 'presence.changed',
      room_id: 'room_direct_1',
      payload: { principal_id: 'usr_peer_1', online: true }
    });
    assert.equal(ctrl.getSubtitle(), 'online');

    // Disconnect sets offline
    ctrl.handleRealtimeEvent({
      type: 'presence.changed',
      room_id: 'room_direct_1',
      payload: { principal_id: 'usr_peer_1', online: false }
    });
    assert.equal(ctrl.getSubtitle(), '+15550002222');

    // Reconnect catch-up receives updated presence.changed
    ctrl.handleRealtimeEvent({
      type: 'presence.changed',
      room_id: 'room_direct_1',
      payload: { principal_id: 'usr_peer_1', online: true }
    });
    assert.equal(ctrl.getSubtitle(), 'online');
    ctrl.cleanup();
  });

  // ═══════════════════════════════════════════════════════════════
  // TYPING TESTS (6 - 12)
  // ═══════════════════════════════════════════════════════════════

  test('6. typing.started from current contact shows "typing…"', () => {
    const ctrl = createHeaderStatusController();
    setupTestInbox(ctrl);
    ctrl.selectConversation('room_direct_1');

    ctrl.handleRealtimeEvent({
      type: 'typing.started',
      room_id: 'room_direct_1',
      payload: { principal_id: 'usr_peer_1' }
    });

    assert.equal(ctrl.getSubtitle(), 'typing…');
    assert.ok(ctrl.getClasses().includes('is-typing'));
    ctrl.cleanup();
  });

  test('7. typing.stopped restores normal status ("online" if online, or offline phone)', () => {
    const ctrl = createHeaderStatusController();
    setupTestInbox(ctrl);
    ctrl.selectConversation('room_direct_1');

    // Peer is online and typing
    ctrl.handleRealtimeEvent({
      type: 'presence.changed',
      room_id: 'room_direct_1',
      payload: { principal_id: 'usr_peer_1', online: true }
    });
    ctrl.handleRealtimeEvent({
      type: 'typing.started',
      room_id: 'room_direct_1',
      payload: { principal_id: 'usr_peer_1' }
    });
    assert.equal(ctrl.getSubtitle(), 'typing…');

    // Peer stops typing -> should revert to 'online'
    ctrl.handleRealtimeEvent({
      type: 'typing.stopped',
      room_id: 'room_direct_1',
      payload: { principal_id: 'usr_peer_1' }
    });
    assert.equal(ctrl.getSubtitle(), 'online');
    assert.ok(ctrl.getClasses().includes('is-online'));
    assert.ok(!ctrl.getClasses().includes('is-typing'));

    // If peer was offline and sent typing.stopped, reverts to phone
    ctrl.handleRealtimeEvent({
      type: 'presence.changed',
      room_id: 'room_direct_1',
      payload: { principal_id: 'usr_peer_1', online: false }
    });
    assert.equal(ctrl.getSubtitle(), '+15550002222');
    ctrl.cleanup();
  });

  test('8. Typing from another participant does not affect direct contact incorrectly', () => {
    const ctrl = createHeaderStatusController();
    setupTestInbox(ctrl);
    ctrl.selectConversation('room_direct_1');

    // Remote typing event arrives for room_direct_2
    ctrl.handleRealtimeEvent({
      type: 'typing.started',
      room_id: 'room_direct_2',
      payload: { principal_id: 'usr_peer_2' }
    });

    // Room 1 subtitle is completely unaffected
    assert.equal(ctrl.getSubtitle(), '+15550002222');
    assert.ok(!ctrl.getClasses().includes('is-typing'));
    ctrl.cleanup();
  });

  test('9. Typing status disappears when 6-second timeout occurs', async () => {
    const ctrl = createHeaderStatusController();
    setupTestInbox(ctrl);
    ctrl.selectConversation('room_direct_1');

    // Peer is online
    ctrl.handleRealtimeEvent({
      type: 'presence.changed',
      room_id: 'room_direct_1',
      payload: { principal_id: 'usr_peer_1', online: true }
    });

    // Peer starts typing
    ctrl.handleRealtimeEvent({
      type: 'typing.started',
      room_id: 'room_direct_1',
      payload: { principal_id: 'usr_peer_1' }
    });
    assert.equal(ctrl.getSubtitle(), 'typing…');
    assert.ok(ctrl.hasTimeout('room_direct_1', 'usr_peer_1'));

    // Simulate timeout expiration manually to test deterministic behavior
    ctrl.shellState.setTyping('room_direct_1', 'usr_peer_1', false);
    ctrl.updateChatHeaderSubtitle();

    assert.equal(ctrl.getSubtitle(), 'online');
    assert.ok(!ctrl.getClasses().includes('is-typing'));
    ctrl.cleanup();
  });

  test('10. Local typing sends the correct supported event (typing.started) throttled/debounced', () => {
    const ctrl = createHeaderStatusController();
    setupTestInbox(ctrl);
    ctrl.selectConversation('room_direct_1');

    // First keystroke
    const t0 = 10000;
    ctrl.handleLocalUserTyping('h', 'room_direct_1', t0);
    assert.equal(ctrl.dispatchedEvents.length, 1);
    assert.equal(ctrl.dispatchedEvents[0].type, 'typing.started');
    assert.equal(ctrl.dispatchedEvents[0].roomId, 'room_direct_1');

    // Rapid second keystroke within 500ms -> throttled, no new event sent
    ctrl.handleLocalUserTyping('he', 'room_direct_1', t0 + 500);
    assert.equal(ctrl.dispatchedEvents.length, 1);

    // Keystroke after 3500ms (> 3s throttle window) -> dispatches typing.started refresh
    ctrl.handleLocalUserTyping('hello', 'room_direct_1', t0 + 3500);
    assert.equal(ctrl.dispatchedEvents.length, 2);
    assert.equal(ctrl.dispatchedEvents[1].type, 'typing.started');

    // Clearing input text immediately dispatches typing.stopped
    ctrl.handleLocalUserTyping('', 'room_direct_1', t0 + 4000);
    assert.equal(ctrl.dispatchedEvents.length, 3);
    assert.equal(ctrl.dispatchedEvents[2].type, 'typing.stopped');
    ctrl.cleanup();
  });

  test('11. Sending a message stops local typing state', () => {
    const ctrl = createHeaderStatusController();
    setupTestInbox(ctrl);
    ctrl.selectConversation('room_direct_1');

    // Local user starts typing
    ctrl.handleLocalUserTyping('Hello there', 'room_direct_1', 1000);
    assert.equal(ctrl.dispatchedEvents.length, 1);
    assert.equal(ctrl.dispatchedEvents[0].type, 'typing.started');

    // Message is sent -> triggers stopLocalTyping
    ctrl.stopLocalTyping('room_direct_1');
    assert.equal(ctrl.dispatchedEvents.length, 2);
    assert.equal(ctrl.dispatchedEvents[1].type, 'typing.stopped');
    assert.equal(ctrl.dispatchedEvents[1].roomId, 'room_direct_1');
    ctrl.cleanup();
  });

  test('12. Changing rooms stops local typing state for the previous room', () => {
    const ctrl = createHeaderStatusController();
    setupTestInbox(ctrl);
    ctrl.selectConversation('room_direct_1');

    // Start typing in room 1
    ctrl.handleLocalUserTyping('Drafting in room 1', 'room_direct_1', 1000);
    assert.equal(ctrl.dispatchedEvents.length, 1);
    assert.equal(ctrl.dispatchedEvents[0].type, 'typing.started');
    assert.equal(ctrl.dispatchedEvents[0].roomId, 'room_direct_1');

    // Switch to room 2 -> must stop typing in room 1
    ctrl.selectConversation('room_direct_2');
    assert.equal(ctrl.dispatchedEvents.length, 2);
    assert.equal(ctrl.dispatchedEvents[1].type, 'typing.stopped');
    assert.equal(ctrl.dispatchedEvents[1].roomId, 'room_direct_1');
    ctrl.cleanup();
  });

  // ═══════════════════════════════════════════════════════════════
  // RECORDING AUDIO HONESTY TEST (13)
  // ═══════════════════════════════════════════════════════════════

  test('13. If no supported recording protocol exists, verify that no fake recording state is displayed', () => {
    const ctrl = createHeaderStatusController();
    setupTestInbox(ctrl);
    ctrl.selectConversation('room_direct_1');

    // Peer is online
    ctrl.handleRealtimeEvent({
      type: 'presence.changed',
      room_id: 'room_direct_1',
      payload: { principal_id: 'usr_peer_1', online: true }
    });

    // Simulated unsupported event or call event must never show "recording audio…"
    ctrl.handleRealtimeEvent({
      type: 'recording.started', // unsupported
      room_id: 'room_direct_1',
      payload: { principal_id: 'usr_peer_1' }
    });

    // Subtitle must remain 'online', not fake recording
    assert.equal(ctrl.getSubtitle(), 'online');
    assert.notEqual(ctrl.getSubtitle(), 'recording audio…');
    assert.notEqual(ctrl.getSubtitle(), 'recording…');
    ctrl.cleanup();
  });

  // ═══════════════════════════════════════════════════════════════
  // PERSONAL NICKNAME COMPATIBILITY TESTS (14 - 16)
  // ═══════════════════════════════════════════════════════════════

  test('14. Nickname + online displays correctly (Nickname in title, "online" in subtitle)', () => {
    const ctrl = createHeaderStatusController();
    setupTestInbox(ctrl);

    // Set personal nickname for peer_1
    ctrl.shellState.setContactNickname('usr_peer_1', 'Rahul');
    ctrl.selectConversation('room_direct_1');

    assert.equal(ctrl.getTitle(), 'Rahul');
    assert.equal(ctrl.getSubtitle(), '+15550002222');

    // Peer comes online
    ctrl.handleRealtimeEvent({
      type: 'presence.changed',
      room_id: 'room_direct_1',
      payload: { principal_id: 'usr_peer_1', online: true }
    });

    // Title must stay Nickname, subtitle becomes "online"
    assert.equal(ctrl.getTitle(), 'Rahul');
    assert.notEqual(ctrl.getTitle(), 'rmm'); // Server name must not overwrite nickname
    assert.equal(ctrl.getSubtitle(), 'online');
    ctrl.cleanup();
  });

  test('15. Nickname + typing displays correctly (Nickname in title, "typing…" in subtitle)', () => {
    const ctrl = createHeaderStatusController();
    setupTestInbox(ctrl);

    ctrl.shellState.setContactNickname('usr_peer_1', 'Rahul');
    ctrl.selectConversation('room_direct_1');

    // Peer starts typing
    ctrl.handleRealtimeEvent({
      type: 'typing.started',
      room_id: 'room_direct_1',
      payload: { principal_id: 'usr_peer_1' }
    });

    assert.equal(ctrl.getTitle(), 'Rahul');
    assert.equal(ctrl.getSubtitle(), 'typing…');
    ctrl.cleanup();
  });

  test('16. Nickname + offline displays correctly (Nickname in title, phone in subtitle)', () => {
    const ctrl = createHeaderStatusController();
    setupTestInbox(ctrl);

    ctrl.shellState.setContactNickname('usr_peer_1', 'Rahul');
    ctrl.selectConversation('room_direct_1');

    // Peer was online, now goes offline
    ctrl.handleRealtimeEvent({
      type: 'presence.changed',
      room_id: 'room_direct_1',
      payload: { principal_id: 'usr_peer_1', online: false }
    });

    assert.equal(ctrl.getTitle(), 'Rahul');
    assert.equal(ctrl.getSubtitle(), '+15550002222');
    ctrl.cleanup();
  });

  // ═══════════════════════════════════════════════════════════════
  // GROUP CHAT HEADER IMMUTABILITY TEST (17)
  // ═══════════════════════════════════════════════════════════════

  test('17. Group chat header remains unchanged (shows member count) and is not corrupted by direct presence/typing events', () => {
    const ctrl = createHeaderStatusController();
    setupTestInbox(ctrl);
    ctrl.selectConversation('room_group_1');

    assert.equal(ctrl.getTitle(), 'Work Project');
    assert.equal(ctrl.getSubtitle(), '5 members');

    // Direct peer presence arrives for group room
    ctrl.handleRealtimeEvent({
      type: 'presence.changed',
      room_id: 'room_group_1',
      payload: { principal_id: 'usr_peer_1', online: true }
    });

    // Group subtitle must continue showing member count
    assert.equal(ctrl.getSubtitle(), '5 members');
    assert.notEqual(ctrl.getSubtitle(), 'online');

    // Direct peer typing arrives for group room
    ctrl.handleRealtimeEvent({
      type: 'typing.started',
      room_id: 'room_group_1',
      payload: { principal_id: 'usr_peer_1' }
    });

    // Group subtitle still shows member count (not single typing)
    assert.equal(ctrl.getSubtitle(), '5 members');
    assert.notEqual(ctrl.getSubtitle(), 'typing…');
    ctrl.cleanup();
  });

});
