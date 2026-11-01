import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { DatabaseService } from '../src/storage/db/database-service.js';
import { MIGRATIONS } from '../src/storage/db/migrations.js';
import {
  resolveMemberDisplayName,
  getMemberInitials,
  partitionGroupReceiptMembers
} from '../src/renderer/chat-shell-state.js';

describe('Group Per-Member Receipt Tracking & Message Info Tests', () => {
  let tmpDir;
  let dbService;
  let mockSessionStore;
  const currentUserId = 'user-alice';
  const groupRoomId = 'group-core-dev';
  const memberBob = 'user-bob';
  const memberCharlie = 'user-charlie';
  const memberDana = 'user-dana';

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'ollachat-group-receipts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    await fs.mkdir(tmpDir, { recursive: true });
    mockSessionStore = {
      currentSession: { userId: currentUserId },
      getSession() {
        return this.currentSession;
      }
    };
    dbService = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });
  });

  afterEach(async () => {
    if (dbService && dbService.databaseManager?.isOpen) {
      await dbService.databaseManager.close();
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('1. Migration 5 adds delivered_at and read_at columns to message_receipts and staged_receipts', async () => {
    await dbService._getAuthorizedUser();
    const db = dbService.databaseManager;

    const receiptCols = await db.all("PRAGMA table_info('message_receipts');");
    const colNames = receiptCols.map((c) => c.name);
    assert.ok(colNames.includes('delivered_at'), 'message_receipts must have delivered_at column');
    assert.ok(colNames.includes('read_at'), 'message_receipts must have read_at column');

    // Verify migration is registered and contains version 5
    const mig5 = MIGRATIONS.find((m) => m.version === 5);
    assert.ok(mig5, 'Migration 5 must be defined in migrations list');
  });

  test('2. Preserves delivery and read timestamps separately for each member', async () => {
    const msgId = 'group-msg-100';
    const tDelivered = '2026-10-26T10:00:00.000Z';
    const tRead = '2026-10-26T10:05:00.000Z';

    await dbService.saveConversation({
      roomId: groupRoomId,
      kind: 'group',
      displayName: 'Core Dev Team'
    });

    await dbService.saveMessage({
      id: msgId,
      roomId: groupRoomId,
      senderId: currentUserId,
      body: { text: 'Sprint planning' },
      deliveryStatus: 'sent',
      createdAt: '2026-10-26T09:59:00.000Z'
    });

    // Bob receives delivered receipt
    await dbService.updateMessageStatus({
      id: msgId,
      status: 'delivered',
      recipientId: memberBob,
      timestamp: tDelivered
    });

    let res = await dbService.getMessageReceipts({ messageId: msgId });
    let bobReceipt = res.receipts.find((r) => r.recipientId === memberBob);
    assert.equal(bobReceipt.status, 'delivered');
    assert.equal(bobReceipt.deliveredAt, tDelivered);
    assert.equal(bobReceipt.readAt, null);

    // Bob later reads the message
    await dbService.updateMessageStatus({
      id: msgId,
      status: 'read',
      recipientId: memberBob,
      timestamp: tRead
    });

    res = await dbService.getMessageReceipts({ messageId: msgId });
    bobReceipt = res.receipts.find((r) => r.recipientId === memberBob);
    assert.equal(bobReceipt.status, 'read');
    assert.equal(bobReceipt.deliveredAt, tDelivered, 'delivered_at must be preserved after read event arrives');
    assert.equal(bobReceipt.readAt, tRead, 'read_at must record read receipt timestamp');
  });

  test('3. Duplicate and out-of-order receipt events are handled safely', async () => {
    const msgId = 'group-msg-101';
    const tDelivered = '2026-10-26T10:00:00.000Z';
    const tRead = '2026-10-26T10:05:00.000Z';

    await dbService.saveConversation({
      roomId: groupRoomId,
      kind: 'group',
      displayName: 'Core Dev Team'
    });

    await dbService.saveMessage({
      id: msgId,
      roomId: groupRoomId,
      senderId: currentUserId,
      body: { text: 'Out of order test' },
      deliveryStatus: 'sent'
    });

    // Charlie receives 'read' event BEFORE 'delivered' event (out of order network)
    await dbService.updateMessageStatus({
      id: msgId,
      status: 'read',
      recipientId: memberCharlie,
      timestamp: tRead
    });

    let res = await dbService.getMessageReceipts({ messageId: msgId });
    let charlieReceipt = res.receipts.find((r) => r.recipientId === memberCharlie);
    assert.equal(charlieReceipt.status, 'read');
    assert.equal(charlieReceipt.readAt, tRead);

    // Charlie subsequently receives a delayed 'delivered' event
    await dbService.updateMessageStatus({
      id: msgId,
      status: 'delivered',
      recipientId: memberCharlie,
      timestamp: tDelivered
    });

    res = await dbService.getMessageReceipts({ messageId: msgId });
    charlieReceipt = res.receipts.find((r) => r.recipientId === memberCharlie);
    assert.equal(charlieReceipt.status, 'read', 'Status must NOT downgrade from read to delivered');
    assert.equal(charlieReceipt.readAt, tRead, 'read_at must remain intact');
    assert.equal(charlieReceipt.deliveredAt, tDelivered, 'delivered_at must be populated from delayed delivered event');

    // Bob receives duplicate read event
    await dbService.updateMessageStatus({
      id: msgId,
      status: 'read',
      recipientId: memberBob,
      timestamp: tRead
    });
    await dbService.updateMessageStatus({
      id: msgId,
      status: 'read',
      recipientId: memberBob,
      timestamp: '2026-10-26T10:10:00.000Z'
    });

    res = await dbService.getMessageReceipts({ messageId: msgId });
    const bobReceipts = res.receipts.filter((r) => r.recipientId === memberBob);
    assert.equal(bobReceipts.length, 1, 'Duplicate receipt must not duplicate rows');
    assert.equal(bobReceipts[0].status, 'read');
  });

  test('4. One member receipt does not affect another member status', async () => {
    const msgId = 'group-msg-102';

    await dbService.saveConversation({
      roomId: groupRoomId,
      kind: 'group',
      displayName: 'Core Dev'
    });

    await dbService.saveMessage({
      id: msgId,
      roomId: groupRoomId,
      senderId: currentUserId,
      body: { text: 'Status isolation test' },
      deliveryStatus: 'sent'
    });

    // Bob reads
    await dbService.updateMessageStatus({
      id: msgId,
      status: 'read',
      recipientId: memberBob,
      timestamp: '2026-10-26T10:01:00.000Z'
    });

    // Charlie gets delivered only
    await dbService.updateMessageStatus({
      id: msgId,
      status: 'delivered',
      recipientId: memberCharlie,
      timestamp: '2026-10-26T10:02:00.000Z'
    });

    // Dana receives nothing (pending)

    const res = await dbService.getMessageReceipts({ messageId: msgId });
    const bobReceipt = res.receipts.find((r) => r.recipientId === memberBob);
    const charlieReceipt = res.receipts.find((r) => r.recipientId === memberCharlie);
    const danaReceipt = res.receipts.find((r) => r.recipientId === memberDana);

    assert.equal(bobReceipt.status, 'read', 'Bob should be read');
    assert.equal(charlieReceipt.status, 'delivered', 'Charlie should be delivered, unaffected by Bob');
    assert.equal(danaReceipt, undefined, 'Dana has no receipt (pending), unaffected by Bob or Charlie');
  });

  test('5. Receipts persist locally and survive application restart', async () => {
    const msgId = 'group-msg-103';
    const tDelivered = '2026-10-26T10:00:00.000Z';
    const tRead = '2026-10-26T10:05:00.000Z';

    await dbService.saveConversation({
      roomId: groupRoomId,
      kind: 'group',
      displayName: 'Core Dev'
    });

    await dbService.saveMessage({
      id: msgId,
      roomId: groupRoomId,
      senderId: currentUserId,
      body: { text: 'Persistence test' },
      deliveryStatus: 'sent'
    });

    await dbService.updateMessageStatus({
      id: msgId,
      status: 'delivered',
      recipientId: memberBob,
      timestamp: tDelivered
    });

    await dbService.updateMessageStatus({
      id: msgId,
      status: 'read',
      recipientId: memberBob,
      timestamp: tRead
    });

    // Close database to simulate application exit
    await dbService.databaseManager.close();

    // Reopen database with new DatabaseService instance
    const dbServiceRestarted = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });

    const res = await dbServiceRestarted.getMessageReceipts({ messageId: msgId });
    const bobReceipt = res.receipts.find((r) => r.recipientId === memberBob);

    assert.ok(bobReceipt, 'Bob receipt must survive restart');
    assert.equal(bobReceipt.status, 'read');
    assert.equal(bobReceipt.deliveredAt, tDelivered);
    assert.equal(bobReceipt.readAt, tRead);

    await dbServiceRestarted.databaseManager.close();
  });

  test('6. Staged receipts arriving before message creation preserve delivered_at and read_at', async () => {
    const clientMsgId = 'opt-group-999';
    const canonicalId = 'srv-group-999';
    const tDelivered = '2026-10-26T10:00:00.000Z';

    // Staged receipt arrives before message is saved to DB
    await dbService.updateMessageStatus({
      id: clientMsgId,
      status: 'delivered',
      recipientId: memberBob,
      timestamp: tDelivered
    });

    // Verify staged receipt can be queried by clientMessageId
    let res = await dbService.getMessageReceipts({ messageId: clientMsgId });
    assert.equal(res.receipts.length, 1);
    assert.equal(res.receipts[0].recipientId, memberBob);
    assert.equal(res.receipts[0].deliveredAt, tDelivered);

    // Now message is saved with canonical ID
    await dbService.saveMessage({
      id: canonicalId,
      clientMessageId: clientMsgId,
      roomId: groupRoomId,
      senderId: currentUserId,
      body: { text: 'Staged test' },
      deliveryStatus: 'sent'
    });

    // Query by canonical ID -> transferred receipt reflects delivered_at
    res = await dbService.getMessageReceipts({ messageId: canonicalId });
    assert.equal(res.receipts.length, 1);
    assert.equal(res.receipts[0].recipientId, memberBob);
    assert.equal(res.receipts[0].status, 'delivered');
    assert.equal(res.receipts[0].deliveredAt, tDelivered);
  });

  test('7. resolveMemberDisplayName safely handles names, nicknames, phones, and missing data', () => {
    // 1. With contact nickname
    const mockStateWithNickname = {
      getContactNickname: (id) => (id === 'user-1' ? 'Bobby Best Friend' : null),
      conversations: []
    };
    // Mock global shellState for test
    globalThis.shellState = mockStateWithNickname;
    assert.equal(resolveMemberDisplayName('user-1', { displayName: 'Bob' }), 'Bobby Best Friend');

    // 2. With participant profile displayName
    globalThis.shellState = { getContactNickname: () => null, conversations: [] };
    assert.equal(resolveMemberDisplayName('user-2', { displayName: 'Charlie Brown' }), 'Charlie Brown');

    // 3. With phone fallback
    assert.equal(resolveMemberDisplayName('user-3', { phone: '+1234567890' }), '+1234567890');

    // 4. Safe fallback for long user ID
    assert.equal(resolveMemberDisplayName('user-dana-super-long-identifier', {}), 'Member (user-dan)');

    // 5. Short ID fallback
    assert.equal(resolveMemberDisplayName('user4', {}), 'Member (user4)');

    // 6. Null or missing memberId
    assert.equal(resolveMemberDisplayName(null, null), 'Member');
  });

  test('8. getMemberInitials derives clean initials for avatars', () => {
    assert.equal(getMemberInitials('Alice Smith'), 'AS');
    assert.equal(getMemberInitials('Bob'), 'BO');
    assert.equal(getMemberInitials('+123456789'), '+1');
    assert.equal(getMemberInitials(''), '?');
    assert.equal(getMemberInitials(null), '?');
  });

  test('9. partitionGroupReceiptMembers properly separates members into Read, Delivered, and Pending', () => {
    const participantsMap = new Map([
      ['user-alice', { principalId: 'user-alice', displayName: 'Alice' }],
      ['user-bob', { principalId: 'user-bob', displayName: 'Bob' }],
      ['user-charlie', { principalId: 'user-charlie', displayName: 'Charlie' }],
      ['user-dana', { principalId: 'user-dana', displayName: 'Dana' }]
    ]);

    const dbReceipts = [
      {
        recipientId: 'user-charlie',
        status: 'read',
        readAt: '2026-10-26T10:05:00.000Z',
        deliveredAt: '2026-10-26T10:01:00.000Z'
      },
      {
        recipientId: 'user-bob',
        status: 'delivered',
        deliveredAt: '2026-10-26T10:01:00.000Z',
        readAt: null
      }
    ];

    const message = {
      id: 'msg-group-partition',
      senderId: 'user-alice',
      roomId: 'group-1'
    };

    const { readList, deliveredList, pendingList } = partitionGroupReceiptMembers({
      message,
      currentUserId: 'user-alice',
      participantsMap,
      dbReceipts,
      getDisplayNameFn: (id, p) => p?.displayName || id
    });

    // 1. Sender (Alice) must be excluded from recipient lists
    const allRecipientIds = [...readList, ...deliveredList, ...pendingList].map((x) => x.id);
    assert.ok(!allRecipientIds.includes('user-alice'), 'Sender must not appear in recipient list');

    // 2. Charlie is read
    assert.equal(readList.length, 1);
    assert.equal(readList[0].id, 'user-charlie');
    assert.equal(readList[0].time, '2026-10-26T10:05:00.000Z');

    // 3. Bob is delivered
    assert.equal(deliveredList.length, 1);
    assert.equal(deliveredList[0].id, 'user-bob');
    assert.equal(deliveredList[0].time, '2026-10-26T10:01:00.000Z');

    // 4. Dana is pending (no receipt observed, not treated as failure)
    assert.equal(pendingList.length, 1);
    assert.equal(pendingList[0].id, 'user-dana');
    assert.equal(pendingList[0].time, null);
    assert.equal(pendingList[0].status, 'pending');
  });

  test('10. Static Invariants: index.html and app.js maintain modal structure and live updates', async () => {
    const appJs = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
    const html = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

    // HTML elements for group sections
    assert.ok(html.includes('id="info-1to1-sections"'), 'index.html must have #info-1to1-sections');
    assert.ok(html.includes('id="info-group-sections"'), 'index.html must have #info-group-sections');
    assert.ok(html.includes('id="info-group-read-list"'), 'index.html must have #info-group-read-list');
    assert.ok(html.includes('id="info-group-delivered-list"'), 'index.html must have #info-group-delivered-list');
    assert.ok(html.includes('id="info-group-pending-list"'), 'index.html must have #info-group-pending-list');

    // Live update triggers on WebSocket receipts
    assert.ok(appJs.includes('checkAndRefreshOpenMessageInfo(msgId)'), 'app.js must call checkAndRefreshOpenMessageInfo');
    assert.ok(appJs.includes('function checkAndRefreshOpenMessageInfo'), 'checkAndRefreshOpenMessageInfo function defined');

    // Safe name and initial derivation
    assert.ok(appJs.includes('function renderGroupMessageInfo'), 'renderGroupMessageInfo function defined');
    assert.ok(appJs.includes('function renderMemberList'), 'renderMemberList function defined');
  });

  test('11. Static Invariants: 1-to-1 chats preserve existing behavior and do not fake timestamps', async () => {
    const appJs = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
    assert.ok(appJs.includes("if (infoReadTime) infoReadTime.textContent = ''"), 'preserves 1:1 empty read timestamp');
    assert.ok(appJs.includes("if (infoDeliveredTime) infoDeliveredTime.textContent = ''"), 'preserves 1:1 empty delivered timestamp');
    assert.ok(appJs.includes("infoGroupSections?.classList.add('hidden')"), '1:1 mode hides group sections');
    assert.ok(appJs.includes("info1to1Sections?.classList.remove('hidden')"), '1:1 mode shows 1:1 sections');
  });
});
