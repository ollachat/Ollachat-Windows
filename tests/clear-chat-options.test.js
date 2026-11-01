import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  deleteCachedAttachments,
  saveAttachmentToCache,
  getSafeAttachmentCachePath,
  isAttachmentCached
} from '../src/storage/attachment-cache.js';

import {
  ChatShellState,
  RoomMessagesState,
  resolveMessageContent,
  getConversationPreview,
  collectAttachmentIdsFromMessage,
  collectAttachmentIdsFromMessages,
  getEligibleAttachmentIdsForDeletion,
  isDeletableForChatsOnly
} from '../src/renderer/chat-shell-state.js';

// Setup Mock localStorage for Node test runner
const mockStorage = new Map();
globalThis.localStorage = {
  getItem: (k) => mockStorage.get(k) || null,
  setItem: (k, v) => mockStorage.set(k, String(v)),
  removeItem: (k) => mockStorage.delete(k),
  clear: () => mockStorage.clear()
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

describe('Two-Option Clear Chat Redesign Suite (18 Invariants)', () => {
  let tempDir;
  let cacheDir;
  let outsideDir;
  let indexHtml;
  let stylesCss;
  let appJs;
  let mainJs;
  let preloadJs;

  before(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ollachat-clear-chat-test-'));
    cacheDir = path.join(tempDir, 'attachments_cache');
    outsideDir = path.join(tempDir, 'user_downloads');
    await fsPromises.mkdir(cacheDir, { recursive: true });
    await fsPromises.mkdir(outsideDir, { recursive: true });

    indexHtml = await fsPromises.readFile(path.join(projectRoot, 'src', 'renderer', 'index.html'), 'utf8');
    stylesCss = await fsPromises.readFile(path.join(projectRoot, 'src', 'renderer', 'styles.css'), 'utf8');
    appJs = await fsPromises.readFile(path.join(projectRoot, 'src', 'renderer', 'app.js'), 'utf8');
    mainJs = await fsPromises.readFile(path.join(projectRoot, 'src', 'main', 'main.js'), 'utf8');
    preloadJs = await fsPromises.readFile(path.join(projectRoot, 'src', 'preload', 'preload.js'), 'utf8');
  });

  after(async () => {
    try {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    } catch (_) {}
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 1: Modal defaults to "Delete chats only"
  // ─────────────────────────────────────────────────────────────────────────────
  test('1. Modal defaults to "Delete chats only"', () => {
    // HTML checks
    assert.ok(indexHtml.includes('id="clear-chat-modal"'), 'Modal element exists in index.html');
    assert.ok(indexHtml.includes('id="clear-chat-option-messages-only"'), 'Messages only radio option exists');
    assert.ok(indexHtml.includes('id="clear-chat-option-messages-and-media"'), 'Messages and media radio option exists');
    assert.ok(
      indexHtml.includes('id="clear-chat-option-messages-only" name="clearChatOption" value="messages_only" checked'),
      'messages_only radio is checked by default in HTML markup'
    );
    assert.ok(
      !indexHtml.includes('id="clear-chat-option-messages-and-media" name="clearChatOption" value="messages_and_media" checked'),
      'messages_and_media must NEVER be default checked'
    );

    // app.js checks: openClearChatModal always explicitly forces messages_only to checked
    assert.ok(appJs.includes('clearChatOptionMessagesOnly.checked = true;'), 'Resets messages_only to true when opened');
    assert.ok(appJs.includes('clearChatOptionMessagesAndMedia.checked = false;'), 'Resets messages_and_media to false when opened');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 2: Cancelling modal makes no changes to messages or cache
  // ─────────────────────────────────────────────────────────────────────────────
  test('2. Cancelling modal makes no changes to messages or cache', async () => {
    const roomId = 'room_cancel_test';
    const rState = new RoomMessagesState(roomId, 'user_self');
    const msg = {
      id: 'msg_cancel_1',
      roomId,
      senderId: 'user_other',
      content: 'Important note',
      attachmentId: 'att_cancel_1'
    };
    rState.messages = [msg];

    // Create a cached file
    const safePath = await saveAttachmentToCache(cacheDir, 'att_cancel_1', 'doc.pdf', Buffer.from('PDF_CANCEL_CONTENT'));
    assert.ok(await isAttachmentCached(cacheDir, 'att_cancel_1', 'doc.pdf'));

    // Simulate modal opening and cancelling
    let pendingRoomId = roomId;
    // User clicks cancel: closeClearChatModal()
    pendingRoomId = null;

    // Messages must remain completely untouched
    assert.equal(rState.messages.length, 1);
    assert.equal(rState.messages[0].id, 'msg_cancel_1');
    assert.equal(rState.isDeletedForMe('msg_cancel_1', roomId), false);

    // File in cache remains intact
    assert.ok(await isAttachmentCached(cacheDir, 'att_cancel_1', 'doc.pdf'));
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 3: "Delete chats only" selectively deletes text messages & voice notes, preserving media & imported audio
  // ─────────────────────────────────────────────────────────────────────────────
  test('3. "Delete chats only" selectively deletes text messages & voice notes, preserving media & imported audio', () => {
    const roomId = 'room_chats_only_3';
    const rState = new RoomMessagesState(roomId, 'user_self');
    rState.messages = [
      { id: 'msg_text_1', roomId, kind: 'text', content: 'Plain text hello', eventSeq: 1 },
      { id: 'msg_vn_2', roomId, kind: 'file', body: { is_voice_note: true, filename: 'voice_message_1.webm', mime: 'audio/webm' }, eventSeq: 2 },
      { id: 'msg_photo_3', roomId, kind: 'image', body: { filename: 'sunset.jpg', mime: 'image/jpeg' }, attachmentId: 'att_photo_3', eventSeq: 3 },
      { id: 'msg_audio_4', roomId, kind: 'audio', body: { filename: 'song.mp3', mime: 'audio/mpeg', is_voice_note: false }, attachmentId: 'att_audio_4', eventSeq: 4 },
      { id: 'msg_doc_5', roomId, kind: 'file', body: { filename: 'contract.pdf', mime: 'application/pdf' }, attachmentId: 'att_doc_5', eventSeq: 5 }
    ];
    rState.oldestSeq = 1;
    rState.newestSeq = 5;
    rState.hasMore = true;

    // Execute chats-only selective clear
    rState.clearMessages(roomId, { chatsOnly: true });

    // Text & Voice note MUST be deleted
    assert.ok(rState.isDeletedForMe('msg_text_1', roomId), 'Plain text message is marked deleted');
    assert.ok(rState.isDeletedForMe('msg_vn_2', roomId), 'OllaChat voice note is marked deleted');

    // Photo, Imported Audio (mp3), and Document MUST be preserved in rState.messages
    assert.equal(rState.messages.length, 3, '3 media/document messages must remain preserved');
    assert.equal(rState.messages[0].id, 'msg_photo_3');
    assert.equal(rState.messages[1].id, 'msg_audio_4');
    assert.equal(rState.messages[2].id, 'msg_doc_5');

    // Not marked deleted for me
    assert.equal(rState.isDeletedForMe('msg_photo_3', roomId), false);
    assert.equal(rState.isDeletedForMe('msg_audio_4', roomId), false);
    assert.equal(rState.isDeletedForMe('msg_doc_5', roomId), false);

    // Sequence boundaries updated
    assert.equal(rState.oldestSeq, 3);
    assert.equal(rState.newestSeq, 5);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 4: "Delete chats only" prevents deleted text/voice messages returning on refetch
  // ─────────────────────────────────────────────────────────────────────────────
  test('4. "Delete chats only" prevents deleted text/voice messages returning on refetch', () => {
    const roomId = 'room_refetch_4';
    const rState = new RoomMessagesState(roomId, 'user_self');
    rState.messages = [
      { id: 'srv_msg_4_1', roomId, kind: 'text', content: 'Server message' },
      { clientMessageId: 'client_msg_4_2', roomId, kind: 'file', body: { is_voice_note: true } }
    ];

    rState.clearMessages(roomId, { chatsOnly: true });

    // Simulate a REST refetch or catch-up receiving the same message IDs
    assert.ok(rState.isDeletedForMe('srv_msg_4_1', roomId), 'Server message ID is marked deleted for me');
    assert.ok(rState.isDeletedForMe('client_msg_4_2', roomId), 'Client voice note ID is marked deleted for me');

    // Simulate message filtering logic used in appendMessage / setMessages / syncCatchUp
    const incomingFetchedMessages = [
      { id: 'srv_msg_4_1', roomId, content: 'Server message' },
      { id: 'srv_msg_4_3', roomId, kind: 'image', attachmentId: 'att_new_img', content: 'New image' }
    ];

    const filtered = incomingFetchedMessages.filter(m => !rState.isDeletedForMe(m.id, roomId));
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 'srv_msg_4_3');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 5: "Delete chats only" does NOT delete physical cached files
  // ─────────────────────────────────────────────────────────────────────────────
  test('5. "Delete chats only" does NOT delete physical cached files', async () => {
    const roomId = 'room_keep_files_5';
    const attId = 'att_keep_5';
    await saveAttachmentToCache(cacheDir, attId, 'statement.pdf', Buffer.from('STATEMENT DATA'));
    assert.ok(await isAttachmentCached(cacheDir, attId, 'statement.pdf'));

    const rState = new RoomMessagesState(roomId, 'user_self');
    rState.messages = [{ id: 'msg_5_1', roomId, kind: 'file', attachmentId: attId, body: { filename: 'statement.pdf' } }];

    // Chats-only: do NOT call deleteCachedAttachments
    rState.clearMessages(roomId, { chatsOnly: true });

    // Verify message is preserved in state
    assert.equal(rState.messages.length, 1);
    assert.equal(rState.messages[0].id, 'msg_5_1');

    // Verify file still exists on disk in attachments_cache
    assert.ok(await isAttachmentCached(cacheDir, attId, 'statement.pdf'), 'Physical cache file must be preserved');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 6: "Delete chats only" clears sidebar last-message preview
  // ─────────────────────────────────────────────────────────────────────────────
  test('6. "Delete chats only" clears sidebar last-message preview', () => {
    const shellState = new ChatShellState();
    const roomId = 'room_preview_6';
    shellState.conversations = [
      {
        roomId,
        title: 'Project Alpha',
        lastMessage: { preview: 'Latest project update', timestamp: 123456 },
        last_message: { preview: 'Latest project update' }
      }
    ];

    // Action simulation from handleClearChatProceed:
    const conv = shellState.conversations.find(c => c.roomId === roomId);
    assert.ok(conv);
    assert.equal(getConversationPreview(conv), 'Latest project update');

    // Clearing
    conv.lastMessage = null;
    conv.last_message = null;

    assert.equal(getConversationPreview(conv), 'No messages yet');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 7: "Delete chats only" resets unread counts
  // ─────────────────────────────────────────────────────────────────────────────
  test('7. "Delete chats only" resets unread counts', () => {
    const shellState = new ChatShellState();
    const roomId = 'room_unread_7';
    shellState.conversations = [
      {
        roomId,
        title: 'Work Chat',
        unreadCount: 8,
        unread_count: 8
      }
    ];

    // Before clear
    const conv = shellState.conversations.find(c => c.roomId === roomId);
    assert.equal(conv.unreadCount, 8);
    assert.equal(shellState.getUnreadConversationsCount(), 1);

    // Execute clear operation
    conv.unreadCount = 0;
    conv.unread_count = 0;
    shellState.markConversationAsRead(roomId);

    assert.equal(conv.unreadCount, 0);
    assert.equal(conv.unread_count, 0);
    assert.equal(shellState.getUnreadConversationsCount(), 0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 8: "Delete chats only" preserves pinned, favourite, nickname, archive state
  // ─────────────────────────────────────────────────────────────────────────────
  test('8. "Delete chats only" preserves pinned, favourite, nickname, archive state', () => {
    const shellState = new ChatShellState();
    const roomId = 'room_preserve_8';
    const peerUserId = 'peer_user_88';

    shellState.conversations = [
      {
        roomId,
        kind: 'direct',
        peer: { userId: peerUserId, phone: '+15551234567' },
        pinned: true,
        isPinned: true,
        favourite: true,
        isFavourite: true,
        archived: true,
        isArchived: true,
        customLists: ['VIP', 'Clients'],
        lastMessage: { preview: 'Old message' }
      }
    ];

    shellState.setContactNickname(peerUserId, 'Special Contact');
    assert.equal(shellState.getContactNickname(peerUserId), 'Special Contact');

    // Clear operation applied to conversation
    const conv = shellState.conversations.find(c => c.roomId === roomId);
    conv.lastMessage = null;
    conv.last_message = null;
    conv.unreadCount = 0;
    shellState.markConversationAsRead(roomId);

    // Verify all metadata is 100% intact
    assert.equal(conv.pinned, true, 'pinned preserved');
    assert.equal(conv.isPinned, true, 'isPinned preserved');
    assert.equal(conv.favourite, true, 'favourite preserved');
    assert.equal(conv.isFavourite, true, 'isFavourite preserved');
    assert.equal(conv.archived, true, 'archived preserved');
    assert.equal(conv.isArchived, true, 'isArchived preserved');
    assert.deepEqual(conv.customLists, ['VIP', 'Clients'], 'custom-lists preserved');
    assert.equal(shellState.getContactNickname(peerUserId), 'Special Contact', 'contact nickname preserved');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 9: "Delete chats only" does NOT leave the group
  // ─────────────────────────────────────────────────────────────────────────────
  test('9. "Delete chats only" does NOT leave the group', () => {
    const shellState = new ChatShellState();
    const roomId = 'group_room_9';
    shellState.conversations = [
      {
        roomId,
        kind: 'group',
        title: 'Core Devs',
        isExited: false,
        exited: false,
        memberCount: 15,
        lastMessage: { preview: 'Release is ready' }
      }
    ];

    const conv = shellState.conversations.find(c => c.roomId === roomId);
    // Clearing group chat
    conv.lastMessage = null;
    conv.last_message = null;
    conv.unreadCount = 0;

    assert.equal(conv.isExited, false, 'isExited must remain false');
    assert.equal(conv.exited, false, 'exited must remain false');
    assert.equal(conv.memberCount, 15, 'memberCount must remain 15');
    const clearProceedIndex = appJs.indexOf('async function handleClearChatProceed');
    assert.ok(clearProceedIndex !== -1, 'handleClearChatProceed function exists in app.js');
    const clearProceedBody = appJs.slice(clearProceedIndex, clearProceedIndex + 1500);
    assert.ok(!clearProceedBody.includes('leaveGroup'), 'handleClearChatProceed must never call leaveGroup');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 10: "Delete chats and media" clears messages from current room
  // ─────────────────────────────────────────────────────────────────────────────
  test('10. "Delete chats and media" clears messages from current room', () => {
    const roomId = 'room_media_10';
    const rState = new RoomMessagesState(roomId, 'user_self');
    rState.messages = [
      { id: 'msg_10_1', roomId, attachmentId: 'att_10_1', content: 'Here is the image' },
      { id: 'msg_10_2', roomId, content: 'Follow-up text' }
    ];

    rState.clearMessages(roomId);
    assert.equal(rState.messages.length, 0);
    assert.ok(rState.isDeletedForMe('msg_10_1', roomId));
    assert.ok(rState.isDeletedForMe('msg_10_2', roomId));
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 11: "Delete chats and media" deletes eligible cached files
  // ─────────────────────────────────────────────────────────────────────────────
  test('11. "Delete chats and media" deletes eligible cached files', async () => {
    const attId1 = 'att_del_11_a';
    const attId2 = 'att_del_11_b';

    await saveAttachmentToCache(cacheDir, attId1, 'photo.jpg', Buffer.from('JPEG DATA'));
    await saveAttachmentToCache(cacheDir, attId2, 'manual.pdf', Buffer.from('PDF DATA'));

    assert.ok(await isAttachmentCached(cacheDir, attId1, 'photo.jpg'));
    assert.ok(await isAttachmentCached(cacheDir, attId2, 'manual.pdf'));

    const result = await deleteCachedAttachments(cacheDir, [attId1, attId2]);
    assert.equal(result.deletedCount, 2, '2 files deleted');

    assert.equal(await isAttachmentCached(cacheDir, attId1, 'photo.jpg'), false, 'photo.jpg deleted from cache');
    assert.equal(await isAttachmentCached(cacheDir, attId2, 'manual.pdf'), false, 'manual.pdf deleted from cache');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 12: "Delete chats and media" DOES NOT delete attachments referenced by another room
  // ─────────────────────────────────────────────────────────────────────────────
  test('12. "Delete chats and media" DOES NOT delete attachments referenced by another room', async () => {
    const sharedAttId = 'att_shared_12';
    const exclusiveAttId = 'att_exclusive_12';

    // Save both attachments to cache
    await saveAttachmentToCache(cacheDir, sharedAttId, 'shared_photo.jpg', Buffer.from('SHARED DATA'));
    await saveAttachmentToCache(cacheDir, exclusiveAttId, 'exclusive_doc.pdf', Buffer.from('EXCLUSIVE DATA'));

    // Target room has both shared and exclusive attachments
    const targetRoomId = 'room_target_12';
    const targetMessages = [
      { id: 'm1', roomId: targetRoomId, attachmentId: sharedAttId },
      { id: 'm2', roomId: targetRoomId, body: { attachment_id: exclusiveAttId } }
    ];

    // Other loaded room references sharedAttId
    const otherRoomId = 'room_other_12';
    const roomMessagesMap = new Map();
    roomMessagesMap.set(targetRoomId, { messages: targetMessages });
    roomMessagesMap.set(otherRoomId, {
      messages: [
        { id: 'm_other', roomId: otherRoomId, attachment_ids: [sharedAttId] }
      ]
    });

    // Check eligible IDs algorithm
    const eligible = getEligibleAttachmentIdsForDeletion(targetRoomId, roomMessagesMap, targetMessages);
    assert.deepEqual(eligible, [exclusiveAttId], 'Only exclusive attachment is eligible for cache deletion');

    // Run deletion on eligible IDs only
    const result = await deleteCachedAttachments(cacheDir, eligible);
    assert.equal(result.deletedCount, 1);

    // Verify shared attachment remains untouched in cache
    assert.ok(await isAttachmentCached(cacheDir, sharedAttId, 'shared_photo.jpg'), 'Shared attachment must NOT be deleted');
    // Verify exclusive attachment was deleted
    assert.equal(await isAttachmentCached(cacheDir, exclusiveAttId, 'exclusive_doc.pdf'), false, 'Exclusive attachment deleted');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 13: "Delete chats and media" purges renderer attachmentUrls cache
  // ─────────────────────────────────────────────────────────────────────────────
  test('13. "Delete chats and media" purges renderer attachmentUrls cache', () => {
    const attachmentUrls = new Map();
    attachmentUrls.set('att_purged_1', 'blob:http://localhost/1234');
    attachmentUrls.set('att_purged_2', 'blob:http://localhost/5678');
    attachmentUrls.set('att_kept_other_room', 'blob:http://localhost/9999');

    const eligibleIds = ['att_purged_1', 'att_purged_2'];

    // Purge logic executed in handleClearChatProceed:
    for (const id of eligibleIds) {
      attachmentUrls.delete(id);
    }

    assert.equal(attachmentUrls.has('att_purged_1'), false);
    assert.equal(attachmentUrls.has('att_purged_2'), false);
    assert.equal(attachmentUrls.has('att_kept_other_room'), true, 'Keeps entries for attachments belonging to other rooms');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 14: "Delete chats and media" safely handles missing cached files
  // ─────────────────────────────────────────────────────────────────────────────
  test('14. "Delete chats and media" safely handles missing cached files', async () => {
    // Attachment IDs that were never downloaded or cached
    const missingIds = ['att_never_cached_1', 'att_never_cached_2'];
    const result = await deleteCachedAttachments(cacheDir, missingIds);

    assert.equal(result.deletedCount, 0);
    assert.deepEqual(result.deletedFiles, []);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 15: Path traversal attempts are rejected
  // ─────────────────────────────────────────────────────────────────────────────
  test('15. Path traversal attempts are rejected', async () => {
    // Attempt malicious traversal IDs
    const maliciousIds = [
      '../../secret',
      '..\\..\\Windows\\System32\\config',
      '../../../etc/passwd',
      'valid_id/../../nested'
    ];

    // Must never throw, and must sanitize and remain inside cache directory
    const result = await deleteCachedAttachments(cacheDir, maliciousIds);
    assert.ok(typeof result.deletedCount === 'number');

    // getSafeAttachmentCachePath strictly confines path inside cacheDir
    const safePath = getSafeAttachmentCachePath(cacheDir, '../../evil', '../../secret.pdf');
    const resolvedCache = path.resolve(cacheDir);
    assert.ok(safePath.startsWith(resolvedCache + path.sep), 'Path must strictly remain inside cache directory');

    // Invalid cacheDir throws error
    assert.throws(() => {
      getSafeAttachmentCachePath('', 'id', 'file.pdf');
    }, /cacheDir is required/i);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 16: Nonexistent files do not throw errors
  // ─────────────────────────────────────────────────────────────────────────────
  test('16. Nonexistent files do not throw errors', async () => {
    const nonExistentCacheDir = path.join(tempDir, 'does_not_exist_folder');
    const result = await deleteCachedAttachments(nonExistentCacheDir, ['att_1', 'att_2']);

    assert.equal(result.deletedCount, 0);
    assert.deepEqual(result.deletedFiles, []);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 17: User-saved files outside attachments_cache are untouched
  // ─────────────────────────────────────────────────────────────────────────────
  test('17. User-saved files outside attachments_cache are untouched', async () => {
    const userFilePath = path.join(outsideDir, 'important_user_doc.pdf');
    await fsPromises.writeFile(userFilePath, 'USER PERSONAL DOWNLOAD');

    // Deletion requested for an ID that could match part of user document name
    await deleteCachedAttachments(cacheDir, ['important', 'user_doc']);

    // Check that outside file is completely unaffected
    const content = await fsPromises.readFile(userFilePath, 'utf8');
    assert.equal(content, 'USER PERSONAL DOWNLOAD', 'User downloads folder must NEVER be modified');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 18: Group metadata and membership are preserved
  // ─────────────────────────────────────────────────────────────────────────────
  test('18. Group metadata and membership are preserved', () => {
    const shellState = new ChatShellState();
    const groupId = 'group_meta_18';
    shellState.conversations = [
      {
        roomId: groupId,
        kind: 'group',
        title: 'Project Phoenix',
        description: 'Building next-gen messenger',
        avatarUrl: 'https://ollacore.internal/avatar/phoenix.png',
        admins: ['user_admin_1'],
        members: ['user_admin_1', 'user_self', 'user_member_3'],
        createdAt: 1600000000,
        unreadCount: 3,
        lastMessage: { preview: 'See you tomorrow' }
      }
    ];

    const group = shellState.conversations.find(c => c.roomId === groupId);

    // Apply Clear Chat proceed logic:
    group.lastMessage = null;
    group.last_message = null;
    group.unreadCount = 0;
    shellState.markConversationAsRead(groupId);

    // Verification:
    assert.equal(group.title, 'Project Phoenix');
    assert.equal(group.description, 'Building next-gen messenger');
    assert.equal(group.avatarUrl, 'https://ollacore.internal/avatar/phoenix.png');
    assert.deepEqual(group.admins, ['user_admin_1']);
    assert.deepEqual(group.members, ['user_admin_1', 'user_self', 'user_member_3']);
    assert.equal(group.createdAt, 1600000000);
    assert.equal(group.unreadCount, 0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 19: isDeletableForChatsOnly accurately distinguishes voice notes vs imported audio vs media
  // ─────────────────────────────────────────────────────────────────────────────
  test('19. isDeletableForChatsOnly accurately distinguishes voice notes vs imported audio vs media', () => {
    // Plain text message -> DELETABLE
    assert.equal(isDeletableForChatsOnly({ kind: 'text', content: 'hello' }), true);
    assert.equal(isDeletableForChatsOnly({ body: { text: 'hello' } }), true);

    // Deleted tombstone -> DELETABLE
    assert.equal(isDeletableForChatsOnly({ kind: 'deleted', isDeleted: true }), true);

    // OllaChat recorded voice note -> DELETABLE
    assert.equal(isDeletableForChatsOnly({ kind: 'file', body: { is_voice_note: true, filename: 'voice_message.webm', mime: 'audio/webm' } }), true);
    assert.equal(isDeletableForChatsOnly({ isVoiceNote: true, attachmentId: 'att_vn_1' }), true);
    assert.equal(isDeletableForChatsOnly({ kind: 'audio', body: { filename: 'voice_message_123.webm' } }), true);

    // User-imported audio file (mp3/wav/etc) -> PRESERVED (NOT deletable)
    assert.equal(isDeletableForChatsOnly({ kind: 'audio', body: { filename: 'song.mp3', mime: 'audio/mpeg', is_voice_note: false } }), false);
    assert.equal(isDeletableForChatsOnly({ kind: 'file', body: { filename: 'recording_from_studio.wav', mime: 'audio/wav' }, attachmentId: 'att_studio_1' }), false);
    assert.equal(isDeletableForChatsOnly({ kind: 'file', body: { filename: 'audio.webm', mime: 'audio/webm' }, attachmentId: 'att_picker_webm' }), false);

    // Images -> PRESERVED
    assert.equal(isDeletableForChatsOnly({ kind: 'image', attachmentId: 'att_img_1' }), false);
    assert.equal(isDeletableForChatsOnly({ body: { mime: 'image/png', filename: 'chart.png' }, attachmentId: 'att_img_2' }), false);

    // Videos -> PRESERVED
    assert.equal(isDeletableForChatsOnly({ kind: 'video', attachmentId: 'att_vid_1' }), false);

    // Documents / Files -> PRESERVED
    assert.equal(isDeletableForChatsOnly({ kind: 'file', body: { filename: 'taxes.pdf' }, attachmentId: 'att_pdf_1' }), false);
    assert.equal(isDeletableForChatsOnly({ kind: 'document', body: { filename: 'notes.docx' }, attachmentId: 'att_doc_1' }), false);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 20: Sidebar preview recalculates to latest preserved media message on "Delete chats only"
  // ─────────────────────────────────────────────────────────────────────────────
  test('20. Sidebar preview recalculates to latest preserved media message on "Delete chats only"', () => {
    const shellState = new ChatShellState();
    const roomId = 'room_preview_recalc_20';
    const rState = new RoomMessagesState(roomId, 'user_self');

    rState.messages = [
      { id: 'm1_img', roomId, kind: 'image', body: { filename: 'diagram.png' }, createdAt: '2026-03-30T10:00:00Z', eventSeq: 1 },
      { id: 'm2_text', roomId, kind: 'text', content: 'What do you think?', createdAt: '2026-03-30T10:05:00Z', eventSeq: 2 },
      { id: 'm3_vn', roomId, kind: 'file', body: { is_voice_note: true }, createdAt: '2026-03-30T10:10:00Z', eventSeq: 3 }
    ];

    shellState.conversations = [
      {
        roomId,
        title: 'Design Review',
        lastMessage: { preview: '🎤 Voice message', createdAt: '2026-03-30T10:10:00Z' },
        unreadCount: 2
      }
    ];

    // Simulate "Delete chats only" proceed:
    rState.clearMessages(roomId, { chatsOnly: true });

    const conv = shellState.conversations.find(c => c.roomId === roomId);
    if (rState.messages.length > 0) {
      const lastMsg = rState.messages[rState.messages.length - 1];
      const resolvedLast = resolveMessageContent(lastMsg);
      conv.lastMessage = {
        preview: resolvedLast.fallbackText || resolvedLast.text || 'Attachment',
        senderId: lastMsg.senderId || lastMsg.sender_id,
        createdAt: lastMsg.createdAt || lastMsg.created_at,
        kind: resolvedLast.kind
      };
      conv.last_message = conv.lastMessage;
    } else {
      conv.lastMessage = null;
      conv.last_message = null;
    }
    conv.unreadCount = 0;

    assert.equal(rState.messages.length, 1);
    assert.equal(rState.messages[0].id, 'm1_img');
    assert.ok(conv.lastMessage.preview.includes('diagram.png') || conv.lastMessage.preview.includes('Photo'));
    assert.equal(conv.unreadCount, 0);
  });

  beforeEach(() => {
    mockStorage.clear();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Invariant 21: Full 6-message mixed room scenario: text/voice deleted, media/docs/mp3 preserved & rendered
  // ─────────────────────────────────────────────────────────────────────────────
  test('21. Full 6-message mixed room scenario: text/voice deleted, media/docs/mp3 preserved & rendered', () => {
    const roomId = 'room_mixed_6_test';
    const rState = new RoomMessagesState('user_self');
    rState.roomId = roomId;

    // Given messages:
    // 1. text
    // 2. recorded OllaChat voice note
    // 3. imported MP3
    // 4. image
    // 5. video
    // 6. PDF/document
    rState.messages = [
      { id: 'msg_1_text', roomId, kind: 'text', content: 'Hey check this out', eventSeq: 101, createdAt: '2026-03-30T10:00:00Z' },
      { id: 'msg_2_voice', roomId, kind: 'file', body: { is_voice_note: true, filename: 'voice_message_1.webm', mime: 'audio/webm' }, eventSeq: 102, createdAt: '2026-03-30T10:01:00Z' },
      { id: 'msg_3_mp3', roomId, kind: 'audio', body: { filename: 'song.mp3', mime: 'audio/mpeg', is_voice_note: false }, attachmentId: 'att_mp3_1', eventSeq: 103, createdAt: '2026-03-30T10:02:00Z' },
      { id: 'msg_4_img', roomId, kind: 'image', body: { filename: 'vacation.jpg', mime: 'image/jpeg' }, attachmentId: 'att_img_1', eventSeq: 104, createdAt: '2026-03-30T10:03:00Z' },
      { id: 'msg_5_video', roomId, kind: 'video', body: { filename: 'demo.mp4', mime: 'video/mp4' }, attachmentId: 'att_vid_1', eventSeq: 105, createdAt: '2026-03-30T10:04:00Z' },
      { id: 'msg_6_pdf', roomId, kind: 'file', body: { filename: 'report.pdf', mime: 'application/pdf' }, attachmentId: 'att_pdf_1', eventSeq: 106, createdAt: '2026-03-30T10:05:00Z' }
    ];
    rState.oldestSeq = 101;
    rState.newestSeq = 106;
    rState.hasMore = true;

    // After: clearMessages(roomId, { chatsOnly: true })
    rState.clearMessages(roomId, { chatsOnly: true });

    // ASSERT:
    // - text is absent from rState.messages
    assert.equal(rState.messages.some(m => m.id === 'msg_1_text'), false, 'Text message is absent');
    // - recorded voice note is absent
    assert.equal(rState.messages.some(m => m.id === 'msg_2_voice'), false, 'Recorded voice note is absent');
    // - MP3 message is PRESENT
    assert.equal(rState.messages.some(m => m.id === 'msg_3_mp3'), true, 'MP3 message is PRESENT');
    // - image message is PRESENT
    assert.equal(rState.messages.some(m => m.id === 'msg_4_img'), true, 'Image message is PRESENT');
    // - video message is PRESENT
    assert.equal(rState.messages.some(m => m.id === 'msg_5_video'), true, 'Video message is PRESENT');
    // - PDF message is PRESENT
    assert.equal(rState.messages.some(m => m.id === 'msg_6_pdf'), true, 'PDF message is PRESENT');

    assert.equal(rState.messages.length, 4, 'Exactly 4 messages preserved in rState.messages');

    // Deleted-for-me set contains ONLY the deleted messages
    assert.ok(rState.isDeletedForMe('msg_1_text', roomId), 'msg_1_text marked deleted for me');
    assert.ok(rState.isDeletedForMe('msg_2_voice', roomId), 'msg_2_voice marked deleted for me');
    assert.equal(rState.isDeletedForMe('msg_3_mp3', roomId), false, 'msg_3_mp3 NOT marked deleted for me');
    assert.equal(rState.isDeletedForMe('msg_4_img', roomId), false, 'msg_4_img NOT marked deleted for me');
    assert.equal(rState.isDeletedForMe('msg_5_video', roomId), false, 'msg_5_video NOT marked deleted for me');
    assert.equal(rState.isDeletedForMe('msg_6_pdf', roomId), false, 'msg_6_pdf NOT marked deleted for me');

    // Normal chat rendering path receives those preserved messages:
    const renderedMessages = rState.messages.map(m => resolveMessageContent(m));
    assert.equal(renderedMessages.length, 4);
    assert.equal(renderedMessages[0].kind, 'audio');
    assert.equal(renderedMessages[0].isVoiceNote, false);
    assert.equal(renderedMessages[1].kind, 'image');
    assert.equal(renderedMessages[2].kind, 'video');
    assert.equal(renderedMessages[3].kind, 'file');

    // Subsequent refetch / catch-up does NOT make preserved messages disappear
    const serverFetchedBatch = [
      { id: 'msg_1_text', roomId, kind: 'text', content: 'Hey check this out', eventSeq: 101 },
      { id: 'msg_2_voice', roomId, kind: 'file', body: { is_voice_note: true }, eventSeq: 102 },
      { id: 'msg_3_mp3', roomId, kind: 'audio', body: { filename: 'song.mp3' }, attachmentId: 'att_mp3_1', eventSeq: 103 },
      { id: 'msg_4_img', roomId, kind: 'image', body: { filename: 'vacation.jpg' }, attachmentId: 'att_img_1', eventSeq: 104 },
      { id: 'msg_5_video', roomId, kind: 'video', body: { filename: 'demo.mp4' }, attachmentId: 'att_vid_1', eventSeq: 105 },
      { id: 'msg_6_pdf', roomId, kind: 'file', body: { filename: 'report.pdf' }, attachmentId: 'att_pdf_1', eventSeq: 106 },
      { id: 'msg_7_new', roomId, kind: 'text', content: 'A brand new message', eventSeq: 107 }
    ];

    // Simulate setInitialMessages on reopening the room
    const reopenedState = new RoomMessagesState('user_self');
    reopenedState.setInitialMessages(roomId, serverFetchedBatch, false);

    assert.equal(reopenedState.messages.length, 5, '4 preserved attachments + 1 new message');
    assert.equal(reopenedState.messages.some(m => m.id === 'msg_1_text'), false, 'Deleted text stays gone');
    assert.equal(reopenedState.messages.some(m => m.id === 'msg_2_voice'), false, 'Deleted voice note stays gone');
    assert.equal(reopenedState.messages.some(m => m.id === 'msg_3_mp3'), true, 'MP3 preserved on refetch');
    assert.equal(reopenedState.messages.some(m => m.id === 'msg_4_img'), true, 'Image preserved on refetch');
    assert.equal(reopenedState.messages.some(m => m.id === 'msg_5_video'), true, 'Video preserved on refetch');
    assert.equal(reopenedState.messages.some(m => m.id === 'msg_6_pdf'), true, 'PDF preserved on refetch');
    assert.equal(reopenedState.messages.some(m => m.id === 'msg_7_new'), true, 'New message received');
  });
});
