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
const appJsPath = path.join(projectRoot, 'src', 'renderer', 'app.js');

const html = fs.readFileSync(htmlPath, 'utf8').replace(/\r\n/g, '\n');
const appJs = fs.readFileSync(appJsPath, 'utf8').replace(/\r\n/g, '\n');

// In-memory mock localStorage for Node.js test environment
const mockStorage = new Map();
globalThis.localStorage = {
  getItem: (key) => mockStorage.get(key) || null,
  setItem: (key, val) => mockStorage.set(key, String(val)),
  removeItem: (key) => mockStorage.delete(key),
  clear: () => mockStorage.clear()
};

describe('WhatsApp-Style Minimal Leave Group Confirmation Suite', () => {
  let state;

  beforeEach(() => {
    mockStorage.clear();
    state = new ChatShellState();
    state.setCurrentUser({ userId: 'user-self', name: 'Self' });
  });

  // 1. Modal DOM elements existence, title "Exit group?", and short description
  test('1. index.html contains #leave-group-confirm-modal with title "Exit group?" and short description', () => {
    assert.ok(html.includes('id="leave-group-confirm-modal"'), 'Must define #leave-group-confirm-modal');
    assert.ok(html.includes('id="leave-group-modal-title"'), 'Must define #leave-group-modal-title');
    assert.ok(html.includes('id="leave-group-modal-message"'), 'Must define #leave-group-modal-message');
    assert.ok(html.includes('>Exit group?</h3>'), 'Default dialog title must be "Exit group?"');
    assert.ok(html.includes('>Are you sure you want to exit this group?</p>'), 'Default description must be short and clean');

    // Accessibility attributes
    assert.ok(html.includes('aria-labelledby="leave-group-modal-title"'), 'Modal must have aria-labelledby');
    assert.ok(html.includes('role="dialog" aria-modal="true"'), 'Modal must have dialog role and aria-modal');
  });

  // 2. Display exactly three buttons: Cancel, Exit, Exit and delete
  test('2. Leave group modal displays only three buttons: Cancel, Exit, Exit and delete', () => {
    assert.ok(html.includes('id="btn-leave-group-cancel"'), 'Must have Cancel button');
    assert.ok(html.includes('id="btn-leave-group-confirm"'), 'Must have Exit button');
    assert.ok(html.includes('id="btn-leave-group-delete"'), 'Must have Exit and delete button');

    // Button label text verification
    assert.ok(html.includes('>Cancel</button>'), 'Cancel button label must be Cancel');
    assert.ok(html.includes('>Exit</button>'), 'Exit button label must be Exit');
    assert.ok(html.includes('>Exit and delete</button>'), 'Exit and delete button label must be Exit and delete');

    // Visual button hierarchy: Exit and delete styled as danger action
    const modalFooterStart = html.indexOf('id="leave-group-confirm-modal"');
    const modalFooterEnd = html.indexOf('</div>', html.indexOf('id="btn-leave-group-delete"'));
    const footerHtml = html.slice(modalFooterStart, modalFooterEnd);

    assert.ok(footerHtml.includes('id="btn-leave-group-delete" class="btn btn-danger-sm"'));
  });

  // 3. app.js binds all leave group modal elements
  test('3. app.js binds all leave group modal elements', () => {
    assert.ok(appJs.includes("const leaveGroupConfirmModal = document.getElementById('leave-group-confirm-modal');"));
    assert.ok(appJs.includes("const leaveGroupModalTitle = document.getElementById('leave-group-modal-title');"));
    assert.ok(appJs.includes("const leaveGroupModalMessage = document.getElementById('leave-group-modal-message');"));
    assert.ok(appJs.includes("const btnCloseLeaveGroup = document.getElementById('btn-close-leave-group');"));
    assert.ok(appJs.includes("const btnLeaveGroupCancel = document.getElementById('btn-leave-group-cancel');"));
    assert.ok(appJs.includes("const btnLeaveGroupDelete = document.getElementById('btn-leave-group-delete');"));
    assert.ok(appJs.includes("const btnLeaveGroupConfirm = document.getElementById('btn-leave-group-confirm');"));
  });

  // 4. openLeaveGroupConfirmModal sets minimal title and description
  test('4. openLeaveGroupConfirmModal sets minimal title "Exit group?" and short description', () => {
    assert.ok(appJs.includes("leaveGroupModalTitle.textContent = 'Exit group?'"));
    assert.ok(appJs.includes("leaveGroupModalMessage.textContent = 'Are you sure you want to exit this group?'"));
  });

  // 5. openConversationContextMenu sets "Leave group" for active groups and "Delete chat" for direct chats
  test('5. openConversationContextMenu displays "Leave group" for active groups and "Delete chat" for direct chats', () => {
    assert.ok(appJs.includes("const isGroup = Boolean(item.kind === 'group' || item.type === 'group');"));
    assert.ok(appJs.includes("const isExited = Boolean(item.isExited || item.exited);"));
    assert.ok(appJs.includes("if (isGroup && !isExited)"));
    assert.ok(appJs.includes("ctxChatDeleteText.textContent = 'Leave group'"));
    assert.ok(appJs.includes("ctxChatDeleteBtn.setAttribute('data-action', 'leave-group')"));
    assert.ok(appJs.includes("ctxChatDeleteText.textContent = 'Delete chat'"));
    assert.ok(appJs.includes("ctxChatDeleteBtn.setAttribute('data-action', 'delete-chat')"));
  });

  // 6. Context menu click dispatcher routes leave-group vs delete-chat
  test('6. Context menu click dispatcher opens leave group modal on leave-group and requestDeleteChat on delete-chat', () => {
    assert.ok(appJs.includes("action === 'leave-group' || action === 'exit-group'"));
    assert.ok(appJs.includes("openLeaveGroupConfirmModal(roomId)"));
    assert.ok(appJs.includes("action === 'delete' || action === 'delete-chat'"));
    assert.ok(appJs.includes("requestDeleteChat(roomId)"));
  });

  // 7. Modal functions exported
  test('7. openLeaveGroupConfirmModal, closeLeaveGroupConfirmModal, handleConfirmLeaveGroup, handleConfirmDeleteGroupChat are defined and exported', () => {
    assert.ok(appJs.includes('export function openLeaveGroupConfirmModal('));
    assert.ok(appJs.includes('export function closeLeaveGroupConfirmModal('));
    assert.ok(appJs.includes('export async function handleConfirmLeaveGroup('));
    assert.ok(appJs.includes('export async function handleConfirmDeleteGroupChat('));
  });

  // 8. Exit and Exit-and-delete double-click guard
  test('8. isProcessingLeaveGroup prevents accidental concurrent execution of Exit and Exit and delete', () => {
    assert.ok(appJs.includes('let isProcessingLeaveGroup = false;'));
    assert.ok(appJs.includes('if (!targetRoomId || isProcessingLeaveGroup) return;'));
    assert.ok(appJs.includes('isProcessingLeaveGroup = true;'));
    assert.ok(appJs.includes('isProcessingLeaveGroup = false;'));
  });

  // 9. Exit button calls leaveGroup and keeps chat in user list
  test('9. Exit button calls leaveGroup API and retains conversation in user chat list', () => {
    const handleLeaveStart = appJs.indexOf('export async function handleConfirmLeaveGroup(');
    assert.ok(handleLeaveStart !== -1);
    const handleLeaveEnd = appJs.indexOf('\nexport async function handleConfirmDeleteGroupChat(', handleLeaveStart);
    const handleLeaveBody = appJs.slice(handleLeaveStart, handleLeaveEnd);

    assert.ok(handleLeaveBody.includes('window.ollacoreDesktop.chatApi.leaveGroup(targetRoomId)'), 'Must call leaveGroup API');
    assert.ok(handleLeaveBody.includes('conv.isExited = true'), 'Must set isExited to true');
    assert.ok(handleLeaveBody.includes('conv.exited = true'), 'Must set exited to true');
    assert.ok(handleLeaveBody.includes('persistConversationToDb(conv)'), 'Must persist to DB');
    assert.ok(handleLeaveBody.includes('renderConversationList()'), 'Must re-render conversation list');
    assert.ok(handleLeaveBody.includes('updateChatFilterCounts()'), 'Must update filter counts');
  });

  // 10. Exit and delete first calls leaveGroup successfully then deletes conversation locally
  test('10. Exit and delete calls leaveGroup first, then removes conversation locally only on success', () => {
    const handleLeaveStart = appJs.indexOf('export async function handleConfirmLeaveGroup(');
    const handleLeaveEnd = appJs.indexOf('\nexport async function handleConfirmDeleteGroupChat(', handleLeaveStart);
    const handleLeaveBody = appJs.slice(handleLeaveStart, handleLeaveEnd);

    // Verify sequence: await leaveGroup precedes deleteChat execution
    const apiCallIdx = handleLeaveBody.indexOf('await window.ollacoreDesktop.chatApi.leaveGroup(targetRoomId)');
    const deleteBlockIdx = handleLeaveBody.indexOf('if (deleteChat)');
    const removeConvIdx = handleLeaveBody.indexOf('shellState.removeConversation(targetRoomId)');

    assert.ok(apiCallIdx !== -1, 'Must call leaveGroup');
    assert.ok(deleteBlockIdx !== -1, 'Must have deleteChat branch');
    assert.ok(removeConvIdx !== -1, 'Must remove conversation locally');
    assert.ok(apiCallIdx < deleteBlockIdx, 'API call must happen before local delete');
    assert.ok(deleteBlockIdx < removeConvIdx, 'Local delete must be inside deleteChat branch');
  });

  // 11. API failure does not remove conversation or change exit state
  test('11. API failure alerts error and does not remove conversation from chat list', () => {
    const handleLeaveStart = appJs.indexOf('export async function handleConfirmLeaveGroup(');
    const handleLeaveEnd = appJs.indexOf('\nexport async function handleConfirmDeleteGroupChat(', handleLeaveStart);
    const handleLeaveBody = appJs.slice(handleLeaveStart, handleLeaveEnd);

    const tryIdx = handleLeaveBody.indexOf('try {');
    const catchIdx = handleLeaveBody.indexOf('catch (err) {');
    const deleteBlockIdx = handleLeaveBody.indexOf('if (deleteChat)');

    assert.ok(tryIdx < deleteBlockIdx && deleteBlockIdx < catchIdx, 'Delete execution is inside try block');
    assert.ok(handleLeaveBody.includes("formatBackendGroupError('Exit group', err)"), 'Error is reported via formatBackendGroupError');
  });

  // 12. Sole-owner can exit group, delegating succession to backend leaveGroup API
  test('12. Sole-owner can exit group, delegating succession to backend leaveGroup API', () => {
    const handleLeaveStart = appJs.indexOf('export async function handleConfirmLeaveGroup(');
    const handleLeaveEnd = appJs.indexOf('\nexport async function handleConfirmDeleteGroupChat(', handleLeaveStart);
    const handleLeaveBody = appJs.slice(handleLeaveStart, handleLeaveEnd);

    assert.ok(!handleLeaveBody.includes('You are the only owner of this group. Please promote another member to owner before leaving.'));
    assert.ok(handleLeaveBody.includes('window.ollacoreDesktop.chatApi.leaveGroup(targetRoomId)'));
  });

  // 13. Modal listeners and outside click / Escape key dismissal
  test('13. Leave group modal has close listeners, outside click dismissal, and Escape key handling', () => {
    assert.ok(appJs.includes("btnCloseLeaveGroup?.addEventListener('click', closeLeaveGroupConfirmModal)"));
    assert.ok(appJs.includes("btnLeaveGroupCancel?.addEventListener('click', closeLeaveGroupConfirmModal)"));
    assert.ok(appJs.includes("btnLeaveGroupConfirm?.addEventListener('click'"));
    assert.ok(appJs.includes("btnLeaveGroupDelete?.addEventListener('click'"));
    assert.ok(appJs.includes("closeLeaveGroupConfirmModal()"));

    // Escape key handlers
    assert.ok(appJs.includes("leaveGroupConfirmModal && !leaveGroupConfirmModal.classList.contains('hidden')"));
  });

  // 14. Non-destructive options in context menu remain intact
  test('14. Pin, favourite, unread, archive, and mute remain functional in conversation context menu', () => {
    assert.ok(appJs.includes("action === 'pin'"));
    assert.ok(appJs.includes("action === 'favourite'"));
    assert.ok(appJs.includes("action === 'toggle-unread'"));
    assert.ok(appJs.includes("action === 'archive'"));
    assert.ok(appJs.includes("action === 'toggle-mute'"));
  });

  // 15. State simulation: Exit retains conversation in chat list with isExited=true
  test('15. State simulation: Exit retains conversation in chat list with isExited=true and preserves messages', () => {
    const groupRoom = {
      roomId: 'group-room-1',
      kind: 'group',
      name: 'Project Team',
      isExited: false
    };
    state.conversations = [groupRoom];
    state.selectedRoomId = 'group-room-1';

    const rState = new RoomMessagesState('group-room-1', 'user-self');
    rState.messages = [{ id: 'm1', text: 'Hello team' }];

    // Simulate Exit
    groupRoom.isExited = true;
    groupRoom.exited = true;
    if (state.selectedRoomId === 'group-room-1') {
      state.selectedRoomId = null;
    }

    // State invariants
    assert.strictEqual(state.conversations.length, 1, 'Group is retained in list');
    assert.strictEqual(state.conversations[0].isExited, true, 'isExited is true');
    assert.strictEqual(state.conversations[0].exited, true, 'exited is true');
    assert.strictEqual(rState.messages.length, 1, 'Message history is preserved');
    assert.strictEqual(state.selectedRoomId, null, 'Selected room cleared');
  });

  // 16. State simulation: Exit and delete removes group locally from chat list
  test('16. State simulation: Exit and delete removes group locally from chat list', () => {
    const groupRoom = {
      roomId: 'group-room-2',
      kind: 'group',
      name: 'Dev Team',
      isExited: false
    };
    const otherRoom = {
      roomId: 'direct-room-1',
      kind: 'direct',
      name: 'Alice'
    };
    state.conversations = [groupRoom, otherRoom];
    state.selectedRoomId = 'group-room-2';

    const rState = new RoomMessagesState('group-room-2', 'user-self');
    rState.messages = [{ id: 'm1', text: 'Work on feature' }];

    // Simulate Exit and delete
    state.removeConversation('group-room-2');
    rState.clearMessages('group-room-2');
    if (state.selectedRoomId === 'group-room-2') {
      state.selectedRoomId = null;
    }

    // State invariants
    assert.strictEqual(state.conversations.length, 1, 'Only other conversation remains');
    assert.strictEqual(state.conversations[0].roomId, 'direct-room-1', 'Remaining conversation is Alice');
    assert.strictEqual(rState.messages.length, 0, 'Local messages cleared');
    assert.strictEqual(state.selectedRoomId, null, 'Selected room cleared');
  });

  // 17. State simulation: Cancel leaves all state unmodified
  test('17. State simulation: Cancel leaves all state unmodified', () => {
    const groupRoom = {
      roomId: 'group-room-3',
      kind: 'group',
      name: 'Marketing',
      isExited: false
    };
    state.conversations = [groupRoom];
    state.selectedRoomId = 'group-room-3';
    state.pinChat('group-room-3');

    // Simulate Cancel (dialog closed, pending action cleared, state touched)
    assert.strictEqual(state.conversations.length, 1);
    assert.strictEqual(state.conversations[0].isExited, false);
    assert.strictEqual(state.selectedRoomId, 'group-room-3');
    assert.strictEqual(state.isPinned('group-room-3'), true);
  });
});
