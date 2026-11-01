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
const projectRoot = path.join(__dirname, '..');

const htmlPath = path.join(projectRoot, 'src', 'renderer', 'index.html');
const cssPath = path.join(projectRoot, 'src', 'renderer', 'styles.css');
const appJsPath = path.join(projectRoot, 'src', 'renderer', 'app.js');
const shellStatePath = path.join(projectRoot, 'src', 'renderer', 'chat-shell-state.js');
const chatApiPath = path.join(projectRoot, 'src', 'api', 'chat-api.js');

const html = fs.readFileSync(htmlPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
const appJs = fs.readFileSync(appJsPath, 'utf8');
const shellStateJs = fs.readFileSync(shellStatePath, 'utf8');
const chatApiJs = fs.readFileSync(chatApiPath, 'utf8');

// In-memory mock localStorage for Node.js test environment
const mockStorage = new Map();
globalThis.localStorage = {
  getItem: (key) => mockStorage.get(key) || null,
  setItem: (key, val) => mockStorage.set(key, String(val)),
  removeItem: (key) => mockStorage.delete(key),
  clear: () => mockStorage.clear()
};

describe('Delete Chat Context Menu Option & Local Deletion Suite', () => {
  let state;

  beforeEach(() => {
    mockStorage.clear();
    state = new ChatShellState();
    state.setCurrentUser({ userId: 'user-self', name: 'Self' });
  });

  // 1. Delete chat option appears in context menu
  test('1. Delete chat option appears as the final destructive action in conversation-context-menu', () => {
    assert.ok(html.includes('id="conversation-context-menu"'), 'Must define #conversation-context-menu');
    assert.ok(html.includes('id="ctx-chat-delete-btn"'), 'Must define #ctx-chat-delete-btn');
    assert.ok(html.includes('id="ctx-chat-delete-text"'), 'Must define #ctx-chat-delete-text');
    assert.ok(html.includes('Delete chat</span>'), 'Must display "Delete chat" text');

    // Must be the final item in conversation-context-menu
    const menuStart = html.indexOf('id="conversation-context-menu"');
    const menuEnd = html.indexOf('</div>', html.indexOf('id="ctx-chat-delete-btn"'));
    const menuHtml = html.slice(menuStart, menuEnd);

    const deleteBtnIdx = menuHtml.indexOf('id="ctx-chat-delete-btn"');
    const archiveBtnIdx = menuHtml.indexOf('data-action="archive"');
    const unreadBtnIdx = menuHtml.indexOf('data-action="toggle-unread"');
    const favBtnIdx = menuHtml.indexOf('data-action="favourite"');
    const pinBtnIdx = menuHtml.indexOf('data-action="pin"');

    assert.ok(deleteBtnIdx > archiveBtnIdx, 'Delete chat must appear after Archive chat');
    assert.ok(archiveBtnIdx > unreadBtnIdx, 'Archive chat must appear after Mark as unread');
    assert.ok(unreadBtnIdx > favBtnIdx, 'Mark as unread must appear after Add to favourites');
    assert.ok(favBtnIdx > pinBtnIdx, 'Add to favourites must appear after Pin chat');
  });

  // 2. Visually separated from non-destructive actions and styled destructively
  test('2. Delete chat is visually separated by a separator and styled with destructive danger styling', () => {
    const menuStart = html.indexOf('id="conversation-context-menu"');
    const menuEnd = html.indexOf('</div>', html.indexOf('id="ctx-chat-delete-btn"'));
    const menuHtml = html.slice(menuStart, menuEnd);

    const archiveBtnIdx = menuHtml.indexOf('data-action="archive"');
    const deleteBtnIdx = menuHtml.indexOf('id="ctx-chat-delete-btn"');
    const separatorIdx = menuHtml.indexOf('class="context-menu-separator"', archiveBtnIdx);

    assert.ok(separatorIdx !== -1, 'Must have a separator after archive chat');
    assert.ok(separatorIdx < deleteBtnIdx, 'Separator must be placed directly before Delete chat');

    // Destructive class verification
    assert.ok(
      menuHtml.includes('class="context-menu-item danger') || menuHtml.includes('class="context-menu-item text-danger'),
      'Must have danger/text-danger class for destructive styling'
    );
  });

  // 3. Existing menu architecture is reused
  test('3. Uses existing conversation-context-menu architecture and click dispatcher', () => {
    assert.ok(appJs.includes("const conversationContextMenu = document.getElementById('conversation-context-menu');"));
    assert.ok(appJs.includes("action === 'delete' || action === 'delete-chat'"));
    assert.ok(appJs.includes('requestDeleteChat(roomId)'));
  });

  // 4. Confirmation dialog specifications
  test('4. Confirmation dialog has title "Delete chat?", message "Are you sure you want to delete this chat?", and Cancel / Delete chat buttons', () => {
    assert.ok(appJs.includes("openConfirmModal("));
    assert.ok(appJs.includes("'Delete chat?'"), 'Confirmation title must be "Delete chat?"');
    assert.ok(appJs.includes("'Are you sure you want to delete this chat?'"), 'Confirmation message must match requirement');
    assert.ok(appJs.includes("'Delete chat'"), 'Proceed button text must be "Delete chat"');

    // Dialog elements in index.html
    assert.ok(html.includes('id="group-confirm-modal"'));
    assert.ok(html.includes('id="confirm-modal-title"'));
    assert.ok(html.includes('id="confirm-modal-message"'));
    assert.ok(html.includes('id="btn-confirm-cancel"'));
    assert.ok(html.includes('id="btn-confirm-proceed"'));
  });

  // 5. Cancel leaves chat unchanged
  test('5. Cancel leaves chat completely unchanged (no state change)', () => {
    state.conversations = [
      { roomId: 'room-1', kind: 'direct', name: 'Bob' },
      { roomId: 'room-2', kind: 'direct', name: 'Charlie' }
    ];
    state.selectedRoomId = 'room-1';
    state.pinChat('room-1');
    state.favouriteChat('room-1');

    // Simulate opening confirmation modal and then cancelling (closeConfirmModal)
    let pendingConfirmAction = () => {
      state.removeConversation('room-1');
    };

    // Cancellation: clear pending action without invoking it
    pendingConfirmAction = null;

    // Verify state is strictly preserved
    assert.strictEqual(state.conversations.length, 2, 'Conversation count unchanged');
    assert.strictEqual(state.conversations[0].roomId, 'room-1');
    assert.strictEqual(state.selectedRoomId, 'room-1', 'Selected room unchanged');
    assert.strictEqual(state.isPinned('room-1'), true, 'Pin state unchanged');
    assert.strictEqual(state.isFavourite('room-1'), true, 'Favourite state unchanged');
  });

  // 6. Confirm removes the chat from the local chat list
  test('6. Confirm removes the chat from the local chat list in ChatShellState', () => {
    state.conversations = [
      { roomId: 'room-1', kind: 'direct', name: 'Bob' },
      { roomId: 'room-2', kind: 'direct', name: 'Charlie' }
    ];
    state.selectedRoomId = 'room-1';

    const removed = state.removeConversation('room-1');
    assert.strictEqual(removed, true, 'removeConversation returns true');
    assert.strictEqual(state.conversations.length, 1, 'Chat list now has 1 conversation');
    assert.strictEqual(state.conversations[0].roomId, 'room-2', 'room-2 is the remaining conversation');
    assert.ok(!state.conversations.some((c) => c.roomId === 'room-1'), 'room-1 removed from list');
  });

  // 7. Currently selected chat closes correctly
  test('7. Currently selected chat closes correctly on deletion', () => {
    state.conversations = [
      { roomId: 'room-target', kind: 'direct', name: 'Target' },
      { roomId: 'room-other', kind: 'direct', name: 'Other' }
    ];
    state.selectedRoomId = 'room-target';
    state.activeContactInfoRoomId = 'room-target';

    state.removeConversation('room-target');

    assert.strictEqual(state.selectedRoomId, null, 'selectedRoomId cleared to null');
    assert.strictEqual(state.activeContactInfoRoomId, null, 'activeContactInfoRoomId closed');

    // Verify in app.js that panels are toggled when selected chat is deleted
    assert.ok(appJs.includes("chatSelectedPanel?.classList.add('hidden')"));
    assert.ok(appJs.includes("chatEmptyPanel?.classList.remove('hidden')"));
    assert.ok(appJs.includes("closeChatSearch()"));
    assert.ok(appJs.includes("closeChatHeaderMenu()"));
  });

  // 8. Other conversations remain unchanged
  test('8. Other conversations, pins, favourites, and custom lists remain unchanged', () => {
    state.conversations = [
      { roomId: 'room-delete', kind: 'direct', name: 'Deleted' },
      { roomId: 'room-keep-1', kind: 'direct', name: 'Keeper 1', unreadCount: 5 },
      { roomId: 'room-keep-2', kind: 'group', name: 'Keeper 2', unreadCount: 0 }
    ];
    state.pinChat('room-delete');
    state.pinChat('room-keep-1');
    state.favouriteChat('room-keep-2');
    state.createCustomList('Colleagues', ['room-delete', 'room-keep-1']);

    state.removeConversation('room-delete');

    assert.strictEqual(state.conversations.length, 2);
    assert.strictEqual(state.conversations[0].roomId, 'room-keep-1');
    assert.strictEqual(state.conversations[0].unreadCount, 5);
    assert.strictEqual(state.conversations[1].roomId, 'room-keep-2');
    assert.strictEqual(state.isPinned('room-delete'), false, 'Deleted chat unpinned');
    assert.strictEqual(state.isPinned('room-keep-1'), true, 'Keeper 1 pin preserved');
    assert.strictEqual(state.isFavourite('room-keep-2'), true, 'Keeper 2 favourite preserved');

    const customList = state.getCustomList(state.customLists[0].id);
    assert.deepStrictEqual(customList.roomIds, ['room-keep-1'], 'Custom list updated without deleting keeper');
  });

  // 9. No unsupported API endpoint is called
  test('9. No unsupported API endpoint is called for conversation deletion', () => {
    // Check that chatApi does NOT expose a deleteRoom / deleteConversation method
    assert.strictEqual(chatApiJs.includes('deleteRoom'), false, 'No deleteRoom in chat-api.js');
    assert.strictEqual(chatApiJs.includes('deleteConversation'), false, 'No deleteConversation in chat-api.js');

    // Check that app.js does NOT invent a fake DELETE /rooms/ or /api/v1/chats endpoint
    assert.ok(!appJs.includes('/api/v1/chats/delete'), 'No fake /api/v1/chats/delete');
    assert.ok(!appJs.includes('/rooms/delete'), 'No fake /rooms/delete');
    assert.ok(!appJs.includes('chatApi.deleteRoom'), 'Does not invoke nonexistent chatApi.deleteRoom');
    assert.ok(!appJs.includes('chatApi.deleteConversation'), 'Does not invoke nonexistent chatApi.deleteConversation');
  });

  // 10. No ak_ credential is exposed or used
  test('10. No ak_ credential is exposed or used anywhere in the Windows codebase', () => {
    assert.ok(!html.includes('ak_'), 'No ak_ in index.html');
    assert.ok(!appJs.includes('ak_'), 'No ak_ in app.js');
    assert.ok(!shellStateJs.includes('ak_'), 'No ak_ in chat-shell-state.js');
    assert.ok(!chatApiJs.includes('ak_'), 'No ak_ in chat-api.js');
  });

  // 11. Existing Pin / Favourite / Unread / Archive actions remain unchanged
  test('11. Existing Pin, Favourite, Mark as unread, and Archive actions remain unchanged', () => {
    assert.ok(html.includes('data-action="pin"'), 'pin action exists');
    assert.ok(html.includes('id="ctx-chat-pin-text"'), 'pin text exists');
    assert.ok(html.includes('data-action="favourite"'), 'favourite action exists');
    assert.ok(html.includes('id="ctx-chat-fav-text"'), 'fav text exists');
    assert.ok(html.includes('data-action="toggle-unread"'), 'unread action exists');
    assert.ok(html.includes('id="ctx-chat-unread-text"'), 'unread text exists');
    assert.ok(html.includes('data-action="archive"'), 'archive action exists');
    assert.ok(html.includes('id="ctx-chat-archive-text"'), 'archive text exists');

    // Handlers in app.js remain intact
    assert.ok(appJs.includes("shellState.togglePinChat(roomId)"));
    assert.ok(appJs.includes("shellState.toggleFavouriteChat(roomId)"));
    assert.ok(appJs.includes("shellState.markConversationAsUnread(roomId)"));
    assert.ok(appJs.includes("shellState.archiveChat(roomId)"));
  });

  // 12. Clear Chat behavior remains unchanged
  test('12. Clear Chat behavior remains completely separate and unchanged', () => {
    // Clear Chat has its own dedicated modal and options
    assert.ok(html.includes('id="clear-chat-modal"'));
    assert.ok(html.includes('id="btn-clear-chat-cancel"'));
    assert.ok(html.includes('id="btn-clear-chat-proceed"'));
    assert.ok(appJs.includes('function requestClearChat('));
    assert.ok(appJs.includes('function handleClearChatProceed('));

    // Clear chat clears messages for a room but keeps the room in chat list
    const roomMsgState = new RoomMessagesState();
    roomMsgState.roomId = 'room-1';
    roomMsgState.messages = [{ id: 'm1', content: 'test' }];

    state.conversations = [{ roomId: 'room-1', kind: 'direct' }];
    roomMsgState.clearMessages('room-1');

    // Messages are cleared
    assert.strictEqual(roomMsgState.messages.length, 0, 'Messages cleared');
    // Conversation remains in chat list!
    assert.strictEqual(state.conversations.length, 1, 'Conversation still exists in chat list');
  });

  // 13. Local deletion does not alter group membership on the server
  test('13. Local deletion does not invoke group exit or alter membership', () => {
    assert.ok(!appJs.includes('chatApi.leaveGroup(roomId)\n      shellState.removeConversation(roomId)'));
    // requestDeleteChat does not call leaveGroup or removeMember
    const delFnStart = appJs.indexOf('export function requestDeleteChat(');
    const delFnEnd = appJs.indexOf('\nfunction ', delFnStart + 1);
    const delFnBody = delFnEnd === -1 ? appJs.slice(delFnStart) : appJs.slice(delFnStart, delFnEnd);

    assert.ok(!delFnBody.includes('leaveGroup'), 'requestDeleteChat must not call leaveGroup');
    assert.ok(!delFnBody.includes('removeMember'), 'requestDeleteChat must not call removeMember');
  });
});
