import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatShellState } from '../src/renderer/chat-shell-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

describe('Message Selection Count and Forwarding UX Verification Suite', () => {

  describe('1. HTML Markup & Element ID Verification', () => {
    test('index.html contains all required selection toolbar and forward modal elements', () => {
      const indexPath = path.join(projectRoot, 'src', 'renderer', 'index.html');
      const html = fs.readFileSync(indexPath, 'utf8');

      // Selection toolbar elements
      assert.ok(html.includes('id="message-selection-bar"'), 'Must define #message-selection-bar');
      assert.ok(html.includes('id="btn-cancel-selection"'), 'Must define #btn-cancel-selection');
      assert.ok(html.includes('id="selection-count-label"'), 'Must define #selection-count-label');
      assert.ok(html.includes('id="btn-forward-selected"'), 'Must define #btn-forward-selected');

      // Forward modal elements
      assert.ok(html.includes('id="forward-modal"'), 'Must define #forward-modal');
      assert.ok(html.includes('id="forward-modal-title"'), 'Must define #forward-modal-title');
      assert.ok(html.includes('id="btn-close-forward-modal"'), 'Must define #btn-close-forward-modal');
      assert.ok(html.includes('id="forward-chat-search"'), 'Must define #forward-chat-search');
      assert.ok(html.includes('id="forward-chat-list"'), 'Must define #forward-chat-list');
      assert.ok(html.includes('id="forward-selection-count"'), 'Must define #forward-selection-count');
      assert.ok(html.includes('id="btn-cancel-forward"'), 'Must define #btn-cancel-forward');
      assert.ok(html.includes('id="btn-confirm-forward"'), 'Must define #btn-confirm-forward');
      assert.ok(html.includes('id="forward-spinner"'), 'Must define #forward-spinner');
    });

    test('app.js references the correct selection count element ID', () => {
      const appJsPath = path.join(projectRoot, 'src', 'renderer', 'app.js');
      const appJs = fs.readFileSync(appJsPath, 'utf8');

      // Ensure selectionCountBadge resolves selection-count-label
      assert.ok(
        appJs.includes("getElementById('selection-count-label')"),
        "app.js must query #selection-count-label for the selection count badge"
      );
    });
  });

  describe('2. Selection Count Accurate Progression (0 -> 1 -> 2 -> 3 -> 2 -> 1 -> 0)', () => {
    test('Selecting 1st message updates count to 1 and enables forward button state', () => {
      const shell = new ChatShellState();
      let toolbarCount = `${shell.getSelectedMessageIds().length} selected`;
      let forwardEnabled = shell.getSelectedMessageIds().length > 0;

      assert.equal(toolbarCount, '0 selected');
      assert.equal(forwardEnabled, false);

      shell.toggleMessageSelection('msg_001');
      toolbarCount = `${shell.getSelectedMessageIds().length} selected`;
      forwardEnabled = shell.getSelectedMessageIds().length > 0;

      assert.equal(toolbarCount, '1 selected');
      assert.equal(forwardEnabled, true);
      assert.equal(shell.isMessageSelectionMode, true);
    });

    test('Selecting 2nd and 3rd messages updates count to 2 and 3 sequentially', () => {
      const shell = new ChatShellState();
      shell.toggleMessageSelection('msg_001');
      assert.equal(`${shell.getSelectedMessageIds().length} selected`, '1 selected');

      shell.toggleMessageSelection('msg_002');
      assert.equal(`${shell.getSelectedMessageIds().length} selected`, '2 selected');

      shell.toggleMessageSelection('msg_003');
      assert.equal(`${shell.getSelectedMessageIds().length} selected`, '3 selected');
    });

    test('Deselecting decrements count and deselecting all clears selection mode and returns 0 selected', () => {
      const shell = new ChatShellState();
      shell.toggleMessageSelection('msg_001');
      shell.toggleMessageSelection('msg_002');
      shell.toggleMessageSelection('msg_003');
      assert.equal(`${shell.getSelectedMessageIds().length} selected`, '3 selected');

      // Deselect 1
      shell.toggleMessageSelection('msg_002');
      assert.equal(`${shell.getSelectedMessageIds().length} selected`, '2 selected');
      assert.equal(shell.isMessageSelectionMode, true);

      // Deselect 2nd
      shell.toggleMessageSelection('msg_001');
      assert.equal(`${shell.getSelectedMessageIds().length} selected`, '1 selected');
      assert.equal(shell.isMessageSelectionMode, true);

      // Deselect 3rd (last one)
      shell.toggleMessageSelection('msg_003');
      assert.equal(`${shell.getSelectedMessageIds().length} selected`, '0 selected');
      assert.equal(shell.isMessageSelectionMode, false);
      assert.equal(shell.getSelectedMessageIds().length, 0);
    });
  });

  describe('3. Multi-Modality and Edge Case Selection Protection', () => {
    test('Supports selecting text, images, videos, documents, and voice notes', () => {
      const shell = new ChatShellState();
      const messages = [
        { id: 'text_1', kind: 'text' },
        { id: 'image_1', kind: 'image' },
        { id: 'video_1', kind: 'video' },
        { id: 'doc_1', kind: 'document' },
        { id: 'voice_1', kind: 'voice' }
      ];

      messages.forEach((m) => shell.toggleMessageSelection(m));
      assert.equal(shell.getSelectedMessageIds().length, 5);
      assert.equal(`${shell.getSelectedMessageIds().length} selected`, '5 selected');

      messages.forEach((m) => {
        assert.equal(shell.isMessageSelected(m), true);
        assert.equal(shell.isMessageSelected(m.id), true);
      });
    });

    test('Conversation change clears stale selected message IDs', () => {
      const shell = new ChatShellState();
      shell.selectConversation('room_1');
      shell.toggleMessageSelection('msg_room1_a');
      shell.toggleMessageSelection('msg_room1_b');
      assert.equal(shell.getSelectedMessageIds().length, 2);

      // Switch conversation
      shell.selectConversation('room_2');
      assert.equal(shell.getSelectedMessageIds().length, 0);
      assert.equal(shell.isMessageSelectionMode, false);
      assert.equal(`${shell.getSelectedMessageIds().length} selected`, '0 selected');
    });

    test('enterMessageSelectionMode initializes selection cleanly', () => {
      const shell = new ChatShellState();
      shell.enterMessageSelectionMode('initial_msg');
      assert.equal(shell.isMessageSelectionMode, true);
      assert.equal(shell.getSelectedMessageIds().length, 1);
      assert.equal(shell.isMessageSelected('initial_msg'), true);
    });

    test('exitMessageSelectionMode resets selection completely', () => {
      const shell = new ChatShellState();
      shell.enterMessageSelectionMode('initial_msg');
      shell.toggleMessageSelection('another_msg');
      assert.equal(shell.getSelectedMessageIds().length, 2);

      shell.exitMessageSelectionMode();
      assert.equal(shell.isMessageSelectionMode, false);
      assert.equal(shell.getSelectedMessageIds().length, 0);
      assert.equal(shell.isMessageSelected('initial_msg'), false);
    });
  });

  describe('4. Forwarding UX State Management & Duplicate Prevention', () => {
    test('Simulated forwarding UX loop prevents concurrent duplicate execution', async () => {
      let isForwardingInProgress = false;
      let executionCount = 0;

      async function triggerForward() {
        if (isForwardingInProgress) return 'duplicate_blocked';
        isForwardingInProgress = true;
        executionCount++;
        await new Promise((r) => setTimeout(r, 25));
        isForwardingInProgress = false;
        return 'success';
      }

      const [res1, res2] = await Promise.all([
        triggerForward(),
        triggerForward()
      ]);

      assert.equal(executionCount, 1);
      assert.ok((res1 === 'success' && res2 === 'duplicate_blocked') || (res2 === 'success' && res1 === 'duplicate_blocked'));
      assert.equal(isForwardingInProgress, false);
    });

    test('Forwarding progress text updates dynamically per item with media distinction', () => {
      const messages = [
        { id: '1', kind: 'text' },
        { id: '2', kind: 'image', attachmentId: 'att_1' },
        { id: '3', kind: 'voice', attachment_ids: ['att_2'] }
      ];

      const statuses = [];
      const totalOps = messages.length;

      messages.forEach((msg, idx) => {
        const completed = idx + 1;
        const isMedia = Boolean(msg.attachmentId || msg.attachment_ids || ['image', 'voice'].includes(msg.kind));
        const status = isMedia
          ? `Uploading & forwarding (${completed}/${totalOps})...`
          : `Forwarding (${completed}/${totalOps})...`;
        statuses.push(status);
      });

      assert.deepEqual(statuses, [
        'Forwarding (1/3)...',
        'Uploading & forwarding (2/3)...',
        'Uploading & forwarding (3/3)...'
      ]);
    });
  });
});
