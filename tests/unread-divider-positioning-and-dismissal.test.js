import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ChatShellState,
  RoomMessagesState,
  findLatestUnreadMessage,
  findFirstUnreadMessage
} from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appJsPath = path.join(__dirname, '..', 'src', 'renderer', 'app.js');
const appJs = fs.readFileSync(appJsPath, 'utf8');

describe('Unread Divider Exact Positioning & Dismissal Suite', () => {
  const currentUserId = 'usr_me';
  const peerUserId = 'usr_alice';

  describe('1. Unread Divider Positioning Relative to Sent Messages', () => {
    test('Unread divider is placed exactly at the first unread message AFTER the user’s latest outgoing reply', () => {
      // Exact scenario from user report:
      // Current user sent: haaaaaaai (m1), bro (m2), can you see this (m3)
      // Alice replied: yah i can see this (m4) [11:25 AM]
      // Current user replied: ok bro (m5) [11:26 AM]
      // Alice sent: chill maadu (m6) [11:26 AM]
      const messages = [
        { id: 'm1', senderId: currentUserId, body: { text: 'haaaaaaai' }, createdAt: '2026-11-02T11:24:00Z', status: 'sent' },
        { id: 'm2', senderId: currentUserId, body: { text: 'bro' }, createdAt: '2026-11-02T11:24:10Z', status: 'sent' },
        { id: 'm3', senderId: currentUserId, body: { text: 'can you see this' }, createdAt: '2026-11-02T11:24:20Z', status: 'sent' },
        { id: 'm4', senderId: peerUserId, body: { text: 'yah i can see this' }, createdAt: '2026-11-02T11:25:00Z', status: 'delivered' },
        { id: 'm5', senderId: currentUserId, body: { text: 'ok bro' }, createdAt: '2026-11-02T11:26:00Z', status: 'sent' },
        { id: 'm6', senderId: peerUserId, body: { text: 'chill maadu' }, createdAt: '2026-11-02T11:26:30Z', status: 'delivered' }
      ];

      // Even if unreadCount was reported as 2 (or 1):
      const dividerTarget = findFirstUnreadMessage(messages, {
        currentUserId,
        unreadCount: 2,
        isMarkedUnread: false
      });

      assert.ok(dividerTarget, 'Unread message must be found');
      assert.equal(dividerTarget.id, 'm6', 'Divider must be placed above m6 (chill maadu), NEVER m4 (yah i can see this)');
      assert.notEqual(dividerTarget.id, 'm4', 'm4 was already seen and replied to with m5 (ok bro)');
    });

    test('When current user sent the latest message in chat, unread divider is absent', () => {
      const messages = [
        { id: 'm1', senderId: peerUserId, body: { text: 'Hello' }, createdAt: '2026-11-02T11:20:00Z', status: 'read' },
        { id: 'm2', senderId: currentUserId, body: { text: 'Hi Alice' }, createdAt: '2026-11-02T11:21:00Z', status: 'sent' }
      ];

      const dividerTarget = findFirstUnreadMessage(messages, {
        currentUserId,
        unreadCount: 0,
        isMarkedUnread: false
      });

      assert.equal(dividerTarget, null, 'Must be null when user was the last to send a message');
    });

    test('When conversation is explicitly marked as unread, allows targeting message even if user sent later', () => {
      const messages = [
        { id: 'm1', senderId: peerUserId, body: { text: 'Incoming' }, createdAt: '2026-11-02T11:20:00Z', status: 'read' },
        { id: 'm2', senderId: currentUserId, body: { text: 'Outgoing reply' }, createdAt: '2026-11-02T11:21:00Z', status: 'sent' }
      ];

      const dividerTarget = findFirstUnreadMessage(messages, {
        currentUserId,
        unreadCount: 1,
        isMarkedUnread: true
      });

      assert.ok(dividerTarget, 'Must find divider when manually marked as unread');
    });

    test('When all incoming messages below user’s reply are marked as read, unread divider is absent', () => {
      const messages = [
        { id: 'm1', senderId: currentUserId, body: { text: 'haaaaaaai' }, createdAt: '2026-11-02T11:24:00Z', status: 'sent' },
        { id: 'm2', senderId: currentUserId, body: { text: 'bro' }, createdAt: '2026-11-02T11:24:10Z', status: 'sent' },
        { id: 'm3', senderId: currentUserId, body: { text: 'can you see this' }, createdAt: '2026-11-02T11:24:20Z', status: 'sent' },
        { id: 'm4', senderId: peerUserId, body: { text: 'yah i can see this' }, createdAt: '2026-11-02T11:25:00Z', status: 'read' },
        { id: 'm5', senderId: currentUserId, body: { text: 'ok bro' }, createdAt: '2026-11-02T11:26:00Z', status: 'sent' },
        { id: 'm6', senderId: peerUserId, body: { text: 'chill maadu' }, createdAt: '2026-11-02T11:26:30Z', status: 'read' }
      ];

      const dividerTarget = findFirstUnreadMessage(messages, {
        currentUserId,
        unreadCount: 0,
        isMarkedUnread: false
      });

      assert.equal(dividerTarget, null, 'Divider must be null when all messages are already read');
    });

    test('When all incoming messages in conversation are marked as read, unread divider is absent even if stale unreadCount > 0 is passed', () => {
      const messages = [
        { id: 'm1', senderId: peerUserId, body: { text: 'Hello' }, createdAt: '2026-11-02T11:20:00Z', status: 'read' },
        { id: 'm2', senderId: peerUserId, body: { text: 'Are you there?' }, createdAt: '2026-11-02T11:21:00Z', status: 'read' }
      ];

      const dividerTarget = findFirstUnreadMessage(messages, {
        currentUserId,
        unreadCount: 2, // stale unread count from server
        isMarkedUnread: false
      });

      assert.equal(dividerTarget, null, 'Divider must be null when messages are verified read by status');
    });
  });

  describe('2. Unread Divider Dismissal Lifecycle', () => {
    test('app.js exports dismissUnreadDivider and scheduleDismissUnreadDivider', () => {
      assert.ok(
        appJs.includes('export function dismissUnreadDivider('),
        'app.js must export dismissUnreadDivider'
      );
      assert.ok(
        appJs.includes('export function scheduleDismissUnreadDivider('),
        'app.js must export scheduleDismissUnreadDivider'
      );
    });

    test('advanceReadCursorForActiveRoom marks incoming messages as read in-memory and persists status to SQLite', () => {
      assert.ok(
        appJs.includes("inc.status = 'read'"),
        'advanceReadCursorForActiveRoom must set incoming message status to read'
      );
      assert.ok(
        appJs.includes("persistMessageStatusToDb(inc.id, 'read'"),
        'advanceReadCursorForActiveRoom must persist incoming message read status to SQLite'
      );
    });

    test('advanceReadCursorForActiveRoom schedules unread divider dismissal when viewing bottom', () => {
      assert.ok(
        appJs.includes('scheduleDismissUnreadDivider(roomId, 2000)'),
        'advanceReadCursorForActiveRoom must schedule dismissal after viewing interval'
      );
    });

    test('handleSendMessage dismisses unread divider immediately', () => {
      const sendFnBody = appJs.slice(appJs.indexOf('async function handleSendMessage()'), appJs.indexOf('async function handleSendMessage()') + 15000);
      assert.ok(
        sendFnBody.includes('dismissUnreadDivider(targetRoomId);'),
        'handleSendMessage must call dismissUnreadDivider upon sending outgoing message'
      );
    });

    test('scrollBottomBtn click schedules unread divider dismissal', () => {
      assert.ok(
        appJs.includes('scheduleDismissUnreadDivider(shellState.selectedRoomId, 1000)'),
        'Clicking scroll to bottom button must schedule divider dismissal'
      );
    });

    test('messagesScrollArea scroll near bottom schedules unread divider dismissal', () => {
      assert.ok(
        appJs.includes('scheduleDismissUnreadDivider(shellState.selectedRoomId, 1500)'),
        'Scrolling to bottom of conversation must schedule divider dismissal'
      );
    });
  });

  describe('3. Reconciling SQLite Local Inbox with Server Inbox on Restart', () => {
    test('loadInbox reconciles local unread count = 0 when no new messages arrived from server', () => {
      assert.ok(
        appJs.includes('const noNewMessages = (localLastId && serverLastId && localLastId === serverLastId)'),
        'loadInbox must check if no new messages arrived from server'
      );
      assert.ok(
        appJs.includes('conv.unreadCount = 0'),
        'loadInbox must retain unreadCount = 0 when conversation was already read locally'
      );
    });
  });
});
