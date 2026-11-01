import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { DatabaseManager } from '../src/storage/db/database-manager.js';
import { DatabaseService } from '../src/storage/db/database-service.js';

describe('Receipt Concurrency and Persistence Regression Suite', () => {
  let tmpDir;
  let mockSessionStore;
  let dbService;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'ollachat-concurrency-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    await fs.mkdir(tmpDir, { recursive: true });

    mockSessionStore = {
      currentSession: {
        userId: 'user_alice',
        sessionToken: 'token_secret_concurrency',
        phone: '+15550001'
      },
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

  // 1. Concurrent saveMessage() and updateMessageStatus(..., 'read')
  test('1. concurrent saveMessage() and updateMessageStatus(read) serialize cleanly without transaction collisions', async () => {
    const roomId = 'room_conc_1';
    const msgId = 'msg_conc_1';

    await dbService.saveConversation({ roomId, title: 'Chat 1' });

    // Fire saveMessage and updateMessageStatus concurrently on the exact same connection
    const [saveRes, statusRes] = await Promise.all([
      dbService.saveMessage({
        id: msgId,
        roomId,
        senderId: 'user_alice',
        status: 'sent',
        body: { text: 'Concurrent message' }
      }),
      dbService.updateMessageStatus({
        id: msgId,
        status: 'read',
        recipientId: 'user_bob'
      })
    ]);

    assert.equal(saveRes.ok, true, 'saveMessage should succeed');
    assert.equal(statusRes.ok, true, 'updateMessageStatus should succeed');

    // Verify row in messages has read status
    const msgRow = await dbService.getMessageById(msgId, roomId);
    assert.ok(msgRow, 'Message must exist');
    assert.equal(msgRow.status, 'read', 'Message status must be read despite concurrency');

    // Verify message_receipts has read status
    const receipts = await dbService.databaseManager.all(
      'SELECT status, recipient_id FROM message_receipts WHERE message_id = ?;',
      [msgId]
    );
    assert.equal(receipts.length, 1, 'Exactly one receipt must exist');
    assert.equal(receipts[0].status, 'read', 'Receipt status must be read');

    // Verify staged_receipts is drained
    const staged = await dbService.databaseManager.all(
      'SELECT * FROM staged_receipts WHERE message_id = ?;',
      [msgId]
    );
    assert.equal(staged.length, 0, 'staged_receipts must be empty');
  });

  // 2. Concurrent message saving and delivered/read receipt events
  test('2. concurrent saves and mixed delivered/read receipt events resolve to strongest status without collisions', async () => {
    const roomId = 'room_conc_2';
    await dbService.saveConversation({ roomId, title: 'Chat 2' });

    const messageCount = 10;
    const tasks = [];

    for (let i = 0; i < messageCount; i++) {
      const id = `msg_batch_${i}`;
      // Interleave concurrent saves and receipt events
      tasks.push(
        dbService.saveMessage({
          id,
          roomId,
          senderId: 'user_alice',
          status: 'sent',
          body: { text: `Message ${i}` }
        })
      );
      tasks.push(
        dbService.updateMessageStatus({
          id,
          status: 'delivered',
          recipientId: 'user_bob'
        })
      );
      tasks.push(
        dbService.updateMessageStatus({
          id,
          status: 'read',
          recipientId: 'user_bob'
        })
      );
    }

    const results = await Promise.all(tasks);
    for (const r of results) {
      assert.equal(r.ok, true, 'All concurrent operations must succeed without collision');
    }

    // Verify each message is in 'read' state with no orphaned staged receipts
    for (let i = 0; i < messageCount; i++) {
      const id = `msg_batch_${i}`;
      const msg = await dbService.getMessageById(id, roomId);
      assert.ok(msg, `Message ${id} must exist in DB`);
      assert.equal(msg.status, 'read', `Message ${id} must have strongest status "read"`);

      const receipts = await dbService.databaseManager.all(
        'SELECT status FROM message_receipts WHERE message_id = ?;',
        [id]
      );
      assert.equal(receipts.length, 1, `Message ${id} must have 1 receipt`);
      assert.equal(receipts[0].status, 'read', `Receipt for ${id} must be "read"`);
    }

    const remainingStaged = await dbService.databaseManager.all('SELECT * FROM staged_receipts;');
    assert.equal(remainingStaged.length, 0, 'All staged receipts must be reconciled');
  });

  // 3. Receipt arrival during optimistic-to-canonical reconciliation
  test('3. receipt arriving during optimistic-to-canonical reconciliation preserves read status and deletes optimistic row', async () => {
    const roomId = 'room_conc_3';
    await dbService.saveConversation({ roomId, title: 'Chat 3' });

    const clientMsgId = 'opt_local_uuid_101';
    const canonicalMsgId = 'canon_server_uuid_202';

    // Step A: Save optimistic message first
    await dbService.saveMessage({
      id: clientMsgId,
      clientMessageId: clientMsgId,
      roomId,
      senderId: 'user_alice',
      status: 'sending',
      body: { text: 'Optimistic message' }
    });

    // Step B: Concurrently send read receipt for clientMessageId and save canonical ACK message
    const [receiptRes, canonRes] = await Promise.all([
      dbService.updateMessageStatus({
        id: clientMsgId,
        status: 'read',
        recipientId: 'user_bob'
      }),
      dbService.saveMessage({
        id: canonicalMsgId,
        clientMessageId: clientMsgId,
        roomId,
        senderId: 'user_alice',
        status: 'sent',
        body: { text: 'Optimistic message' }
      })
    ]);

    assert.equal(receiptRes.ok, true);
    assert.equal(canonRes.ok, true);

    // Canonical row must exist with status 'read'
    const canonicalRow = await dbService.getMessageById(canonicalMsgId, roomId);
    assert.ok(canonicalRow, 'Canonical row must exist');
    assert.equal(canonicalRow.status, 'read', 'Canonical message must have status "read"');

    // Optimistic temporary row with id=clientMsgId must be removed from messages table
    const oldRow = await dbService.databaseManager.get(
      'SELECT id FROM messages WHERE id = ?;',
      [clientMsgId]
    );
    assert.equal(oldRow, undefined, 'Old optimistic row must be cleaned up from messages');

    // Receipts must be attached to canonical row
    const receipts = await dbService.databaseManager.all(
      'SELECT message_id, status FROM message_receipts WHERE message_id = ?;',
      [canonicalMsgId]
    );
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, 'read');
  });

  // 4. Close and reopen the database, then verify READ and DELIVERED are preserved
  test('4. close and reopen database: READ and DELIVERED statuses survive restarts without reverting', async () => {
    const roomId = 'room_conc_4';
    await dbService.saveConversation({ roomId, title: 'Chat 4' });

    // Save 3 messages with different final statuses
    await dbService.saveMessage({
      id: 'msg_restart_sent',
      roomId,
      senderId: 'user_alice',
      status: 'sent',
      body: { text: 'Just sent' }
    });

    await dbService.saveMessage({
      id: 'msg_restart_deliv',
      roomId,
      senderId: 'user_alice',
      status: 'sent',
      body: { text: 'Delivered' }
    });
    await dbService.updateMessageStatus({
      id: 'msg_restart_deliv',
      status: 'delivered',
      recipientId: 'user_bob'
    });

    await dbService.saveMessage({
      id: 'msg_restart_read',
      roomId,
      senderId: 'user_alice',
      status: 'sent',
      body: { text: 'Read message' }
    });
    await dbService.updateMessageStatus({
      id: 'msg_restart_read',
      status: 'read',
      recipientId: 'user_bob'
    });

    // Close database connection cleanly (simulating application exit / Ctrl+C)
    await dbService.databaseManager.close();
    assert.equal(dbService.databaseManager.isOpen, false);

    // Reopen database connection on same user directory (simulating npm start)
    const restartedDbService = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });

    const messages = await restartedDbService.getMessages({ roomId });
    const sentMsg = messages.find((m) => m.id === 'msg_restart_sent');
    const delivMsg = messages.find((m) => m.id === 'msg_restart_deliv');
    const readMsg = messages.find((m) => m.id === 'msg_restart_read');

    assert.ok(sentMsg && delivMsg && readMsg, 'All messages must exist after restart');
    assert.equal(sentMsg.status, 'sent', 'Sent message remains sent');
    assert.equal(delivMsg.status, 'delivered', 'Delivered message remains delivered (double grey ticks)');
    assert.equal(readMsg.status, 'read', 'Read message MUST remain read (double blue ticks) after restart');

    await restartedDbService.databaseManager.close();
  });

  // 5. Server history marked 'sent' cannot downgrade a persisted READ receipt
  test('5. server history resync with status "sent" cannot downgrade persisted READ or DELIVERED status', async () => {
    const roomId = 'room_conc_5';
    const msgId = 'msg_history_test';

    await dbService.saveConversation({ roomId, title: 'Chat 5' });

    // Message saved and read
    await dbService.saveMessage({
      id: msgId,
      roomId,
      senderId: 'user_alice',
      status: 'sent',
      body: { text: 'Hello' }
    });
    await dbService.updateMessageStatus({
      id: msgId,
      status: 'read',
      recipientId: 'user_bob'
    });

    const beforeSync = await dbService.getMessageById(msgId, roomId);
    assert.equal(beforeSync.status, 'read');

    // Simulate startup full-room history sync from server where status is only marked 'sent'
    await dbService.saveMessage({
      id: msgId,
      roomId,
      senderId: 'user_alice',
      status: 'sent', // Incoming payload has 'sent'
      body: { text: 'Hello' },
      eventSeq: 10
    });

    const afterSync = await dbService.getMessageById(msgId, roomId);
    assert.equal(afterSync.status, 'read', 'Server sync with status "sent" must NEVER downgrade "read"');

    const receipts = await dbService.databaseManager.all(
      'SELECT status FROM message_receipts WHERE message_id = ?;',
      [msgId]
    );
    assert.equal(receipts[0].status, 'read', 'message_receipts must remain "read"');
  });

  // 6. A failed transaction does not poison the queue or roll back another transaction
  test('6. a failed transaction rolls back cleanly without poisoning the transaction queue or rolling back other transactions', async () => {
    const roomId = 'room_conc_6';
    await dbService.saveConversation({ roomId, title: 'Chat 6' });

    // Step A: Trigger a transaction that intentionally fails
    let caughtError = null;
    try {
      await dbService.databaseManager.transaction(async () => {
        await dbService.databaseManager.run(
          `INSERT INTO messages (id, room_id, sender_id, kind, body_json, status, created_at, local_received_at)
           VALUES ('poison_test', ?, 'alice', 'text', '{}', 'sent', datetime('now'), datetime('now'));`,
          [roomId]
        );
        throw new Error('Forced transaction abortion');
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError, 'Transaction must throw');
    assert.equal(caughtError.message, 'Forced transaction abortion');

    // Verify rolled back
    const rolledBackMsg = await dbService.getMessageById('poison_test', roomId);
    assert.equal(rolledBackMsg, null, 'Poison message must have been rolled back');

    // Step B: Subsequent transaction must execute cleanly on the queue
    const validSave = await dbService.saveMessage({
      id: 'valid_after_poison',
      roomId,
      senderId: 'user_alice',
      status: 'sent',
      body: { text: 'Healthy transaction' }
    });
    assert.equal(validSave.ok, true, 'Subsequent transaction must succeed');

    const statusRes = await dbService.updateMessageStatus({
      id: 'valid_after_poison',
      status: 'read',
      recipientId: 'user_bob'
    });
    assert.equal(statusRes.ok, true, 'Status update must succeed');

    const healthyMsg = await dbService.getMessageById('valid_after_poison', roomId);
    assert.equal(healthyMsg.status, 'read', 'Healthy message must be persisted as read');
  });

  // 7. Repeated concurrent receipts do not create duplicate rows or lose strongest status
  test('7. repeated concurrent receipts do not create duplicate receipt rows or downgrade highest status', async () => {
    const roomId = 'room_conc_7';
    const msgId = 'msg_race_multi';

    await dbService.saveConversation({ roomId, title: 'Chat 7' });
    await dbService.saveMessage({
      id: msgId,
      roomId,
      senderId: 'user_alice',
      status: 'sent',
      body: { text: 'Race test' }
    });

    // Launch 10 concurrent status updates: 5 delivered and 5 read
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(dbService.updateMessageStatus({ id: msgId, status: 'delivered', recipientId: 'user_bob' }));
      promises.push(dbService.updateMessageStatus({ id: msgId, status: 'read', recipientId: 'user_bob' }));
    }

    const results = await Promise.all(promises);
    for (const r of results) {
      assert.equal(r.ok, true);
    }

    // Verify message status is 'read'
    const msg = await dbService.getMessageById(msgId, roomId);
    assert.equal(msg.status, 'read', 'Status must be read');

    // Verify exactly 1 receipt row exists for (msgId, user_bob)
    const receipts = await dbService.databaseManager.all(
      'SELECT recipient_id, status FROM message_receipts WHERE message_id = ?;',
      [msgId]
    );
    assert.equal(receipts.length, 1, 'Must have exactly one receipt row (no duplicates)');
    assert.equal(receipts[0].status, 'read', 'Receipt row must be read');
  });

  // 8. Early staged receipt before message arrival reconciles atomically when message is created
  test('8. early receipt arriving before canonical message is staged and then atomically promoted to read', async () => {
    const roomId = 'room_conc_8';
    const msgId = 'early_arrival_msg';

    await dbService.saveConversation({ roomId, title: 'Chat 8' });

    // Step A: Read receipt arrives BEFORE message row exists
    const earlyReceiptRes = await dbService.updateMessageStatus({
      id: msgId,
      status: 'read',
      recipientId: 'user_bob'
    });
    assert.equal(earlyReceiptRes.ok, true);
    assert.equal(earlyReceiptRes.staged, true, 'Receipt must be staged');

    // Verify in staged_receipts
    const stagedBefore = await dbService.databaseManager.all(
      'SELECT * FROM staged_receipts WHERE message_id = ?;',
      [msgId]
    );
    assert.equal(stagedBefore.length, 1);
    assert.equal(stagedBefore[0].status, 'read');

    // Step B: Canonical message now arrives with status 'sent'
    const saveRes = await dbService.saveMessage({
      id: msgId,
      roomId,
      senderId: 'user_alice',
      status: 'sent',
      body: { text: 'Arrived after receipt' }
    });
    assert.equal(saveRes.ok, true);

    // Verify message in DB was immediately elevated to 'read'
    const msg = await dbService.getMessageById(msgId, roomId);
    assert.equal(msg.status, 'read', 'Message must be promoted to "read" upon canonical save');

    // Verify receipt was transferred into message_receipts
    const receipts = await dbService.databaseManager.all(
      'SELECT recipient_id, status FROM message_receipts WHERE message_id = ?;',
      [msgId]
    );
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, 'read');

    // Verify staged row was cleaned up
    const stagedAfter = await dbService.databaseManager.all(
      'SELECT * FROM staged_receipts WHERE message_id = ?;',
      [msgId]
    );
    assert.equal(stagedAfter.length, 0, 'staged_receipts must be cleared after reconciliation');
  });

  // 9. Original failure reproduction: raw overlapping SQLite transactions collide, while DatabaseManager serialized transactions succeed
  test('9. original failure reproduction: raw overlapping SQLite transactions collide, while DatabaseManager serialized transactions succeed', async () => {
    await dbService.saveConversation({ roomId: 'room_reproduce', title: 'Reproduce Chat' });

    // Part A: Demonstrate the exact failure mode on raw SQLite connection when transactions overlap
    const rawDb = dbService.databaseManager.db;
    let collisionError = null;
    await new Promise((res, rej) => rawDb.run('BEGIN TRANSACTION;', (e) => e ? rej(e) : res()));
    try {
      // While transaction 1 is active, attempting another BEGIN TRANSACTION causes SQLite collision
      await new Promise((res, rej) => rawDb.run('BEGIN TRANSACTION;', (e) => e ? rej(e) : res()));
    } catch (err) {
      collisionError = err;
    } finally {
      await new Promise((res) => rawDb.run('ROLLBACK;', () => res()));
    }
    assert.ok(collisionError, 'Original failure reproduced: raw overlapping SQLite transactions collide');
    assert.match(collisionError.message, /cannot start a transaction within a transaction/);

    // Part B: Demonstrate that DatabaseManager.transaction() serializes them safely without any error
    const results = [];
    await Promise.all([
      dbService.databaseManager.transaction(async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push('tx1');
      }),
      dbService.databaseManager.transaction(async () => {
        results.push('tx2');
      }),
      dbService.databaseManager.transaction(async () => {
        results.push('tx3');
      })
    ]);
    assert.deepEqual(results, ['tx1', 'tx2', 'tx3'], 'DatabaseManager transactions serialize and complete successfully in FIFO order');
  });
});
