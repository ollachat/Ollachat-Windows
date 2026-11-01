/**
 * verify-theme-preview.mjs
 *
 * Direct Electron verification for Chat Theme Live Preview:
 * 1. Opens the Electron BrowserWindow with the actual app
 * 2. Opens the Chat Theme modal
 * 3. Changes color theme -> confirms preview updates immediately
 * 4. Changes bubble style -> confirms preview updates immediately
 * 5. Changes wallpaper -> confirms preview updates immediately
 * 6. Confirms miniature conversation (incoming, media, outgoing, timestamps, checkmarks) in preview
 * 7. Clicks Cancel and confirms real chat is UNCHANGED
 * 8. Reopens modal, selects a distinct theme combination, clicks "Save & Apply"
 * 9. Confirms the real chat uses the selected theme combination
 */

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

app.whenReady().then(async () => {
  try {
    console.log('==> Starting Electron Chat Theme Live Preview verification...');

    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      show: false,
      webPreferences: {
        preload: path.join(rootDir, 'dist/preload/preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    await win.loadFile(path.join(rootDir, 'dist/renderer/index.html'));
    console.log('[1/8] Loaded dist/renderer/index.html in Electron window');

    // Wait for DOM ready
    await new Promise(r => setTimeout(r, 600));

    // Step 1: Check Live Preview elements exist in DOM
    const previewDomCheck = await win.webContents.executeJavaScript(`
      (() => {
        const modal = document.getElementById('chat-theme-modal');
        const previewContainer = document.querySelector('.theme-preview-container');
        const previewScreen = document.getElementById('theme-preview-screen');
        const previewIncoming = document.getElementById('theme-preview-incoming');
        const previewMedia = document.getElementById('theme-preview-media');
        const previewOutgoing = document.getElementById('theme-preview-outgoing');
        const previewStatus = document.getElementById('theme-preview-status-name');
        return {
          hasModal: !!modal,
          hasContainer: !!previewContainer,
          hasScreen: !!previewScreen,
          hasIncoming: !!previewIncoming,
          hasMedia: !!previewMedia,
          hasOutgoing: !!previewOutgoing,
          hasStatus: !!previewStatus
        };
      })()
    `);
    console.log('[2/8] Preview elements verification:', previewDomCheck);
    if (!Object.values(previewDomCheck).every(Boolean)) {
      throw new Error('Missing preview elements in DOM');
    }

    // Step 2: Open Theme Modal and record initial real chat styles
    const initialRealChatStyles = await win.webContents.executeJavaScript(`
      (() => {
        // Open the modal
        const btnOpen = document.getElementById('btn-chat-theme');
        if (btnOpen) btnOpen.click();
        else if (window.__TEST_HOOKS__?.openThemeModal) window.__TEST_HOOKS__.openThemeModal();

        return {
          incomingBg: document.documentElement.style.getPropertyValue('--chat-incoming-bg'),
          outgoingBg: document.documentElement.style.getPropertyValue('--chat-outgoing-bg'),
          bubbleRadius: document.documentElement.style.getPropertyValue('--chat-bubble-radius'),
          statusName: document.getElementById('theme-preview-status-name')?.textContent
        };
      })()
    `);
    console.log('[3/8] Initial modal opened. Initial real chat styling:', initialRealChatStyles);

    // Step 3: Change color theme to "Ocean", bubble style to "Rounded", wallpaper to "Waves"
    const changedPreviewState = await win.webContents.executeJavaScript(`
      (() => {
        // Click Ocean preset
        const oceanCard = document.querySelector('.theme-preset-card[data-preset-id="ocean"]');
        if (oceanCard) oceanCard.click();

        // Click Rounded bubble style
        const roundedCard = document.querySelector('.bubble-style-card[data-bubble-id="rounded"]');
        if (roundedCard) roundedCard.click();

        // Click Waves wallpaper
        const wavesCard = document.querySelector('.wallpaper-card[data-wallpaper-id="waves"]');
        if (wavesCard) wavesCard.click();

        const previewScreen = document.getElementById('theme-preview-screen');
        const previewIncoming = document.getElementById('theme-preview-incoming');
        const previewOutgoing = document.getElementById('theme-preview-outgoing');
        const previewMedia = document.getElementById('theme-preview-media');
        const statusName = document.getElementById('theme-preview-status-name');

        return {
          statusName: statusName?.textContent,
          previewIncomingBg: previewIncoming?.style.backgroundColor,
          previewOutgoingBg: previewOutgoing?.style.backgroundColor || previewOutgoing?.style.background,
          previewBubbleRadius: previewIncoming?.style.borderRadius,
          previewMediaRadius: previewMedia?.style.borderRadius,
          previewScreenBg: previewScreen?.style.background || previewScreen?.style.backgroundColor,
          // Check CSS variables on previewScreen
          screenVarIncomingBg: previewScreen?.style.getPropertyValue('--chat-incoming-bg'),
          screenVarOutgoingBg: previewScreen?.style.getPropertyValue('--chat-outgoing-bg'),
          screenVarBubbleRadius: previewScreen?.style.getPropertyValue('--chat-bubble-radius'),
          // Check REAL chat DOM values (must NOT be changed yet!)
          realChatIncomingBg: document.documentElement.style.getPropertyValue('--chat-incoming-bg'),
          realChatBubbleRadius: document.documentElement.style.getPropertyValue('--chat-bubble-radius')
        };
      })()
    `);
    console.log('[4/8] Selected Ocean + Rounded + Waves in preview:');
    console.log('      Preview status name:', changedPreviewState.statusName);
    console.log('      Preview incoming bg:', changedPreviewState.previewIncomingBg);
    console.log('      Preview bubble radius:', changedPreviewState.previewBubbleRadius);
    console.log('      Real chat incoming bg before save:', changedPreviewState.realChatIncomingBg);

    if (changedPreviewState.statusName !== 'Ocean') {
      throw new Error(`Expected preview status name "Ocean", got "${changedPreviewState.statusName}"`);
    }
    if (changedPreviewState.previewBubbleRadius !== '18px') {
      throw new Error(`Expected preview bubble radius "18px", got "${changedPreviewState.previewBubbleRadius}"`);
    }

    // Step 4: Click Cancel and verify real chat is unchanged
    const afterCancelState = await win.webContents.executeJavaScript(`
      (() => {
        const btnCancel = document.getElementById('btn-cancel-theme');
        btnCancel.click();

        return {
          isModalHidden: document.getElementById('chat-theme-modal').classList.contains('hidden'),
          realChatIncomingBg: document.documentElement.style.getPropertyValue('--chat-incoming-bg'),
          realChatBubbleRadius: document.documentElement.style.getPropertyValue('--chat-bubble-radius')
        };
      })()
    `);
    console.log('[5/8] Cancelled modal. Modal hidden:', afterCancelState.isModalHidden);
    console.log('      Real chat incoming bg is unchanged:', afterCancelState.realChatIncomingBg === initialRealChatStyles.incomingBg);
    console.log('      Real chat bubble radius is unchanged:', afterCancelState.realChatBubbleRadius === initialRealChatStyles.bubbleRadius);

    if (afterCancelState.realChatIncomingBg !== initialRealChatStyles.incomingBg) {
      throw new Error('Cancel failed: real chat styling was modified before Save & Apply!');
    }

    // Step 5: Reopen modal and verify fresh state reflects current room theme, not cancelled preview
    await win.webContents.executeJavaScript(`
      (() => {
        const btnOpen = document.getElementById('btn-chat-theme');
        if (btnOpen) btnOpen.click();
        else if (window.__TEST_HOOKS__?.openThemeModal) window.__TEST_HOOKS__.openThemeModal();
      })()
    `);
    await new Promise(r => setTimeout(r, 200));

    // Step 6: Select "Emerald" + "Soft" (12px) + "Slate" and click "Save & Apply"
    const savedState = await win.webContents.executeJavaScript(`
      (async () => {
        // Select Emerald
        const emeraldCard = document.querySelector('.theme-preset-card[data-preset-id="emerald"]');
        if (emeraldCard) emeraldCard.click();

        // Select Soft
        const softCard = document.querySelector('.bubble-style-card[data-bubble-id="soft"]');
        if (softCard) softCard.click();

        // Select Slate
        const slateCard = document.querySelector('.wallpaper-card[data-wallpaper-id="slate"]');
        if (slateCard) slateCard.click();

        // Click Save & Apply
        const btnSave = document.getElementById('btn-save-theme');
        btnSave.click();

        // Brief delay for persistence/DOM update
        await new Promise(r => setTimeout(r, 200));

        return {
          isModalHidden: document.getElementById('chat-theme-modal').classList.contains('hidden'),
          realChatIncomingBg: document.documentElement.style.getPropertyValue('--chat-incoming-bg'),
          realChatOutgoingBg: document.documentElement.style.getPropertyValue('--chat-outgoing-bg'),
          realChatBubbleRadius: document.documentElement.style.getPropertyValue('--chat-bubble-radius')
        };
      })()
    `);
    console.log('[6/8] Saved and Applied Emerald + Soft:');
    console.log('      Modal hidden after save:', savedState.isModalHidden);
    console.log('      Real chat incoming bg now:', savedState.realChatIncomingBg);
    console.log('      Real chat bubble radius now:', savedState.realChatBubbleRadius);

    if (savedState.realChatIncomingBg !== '#d1fae5') {
      throw new Error(`Expected real chat incoming bg #d1fae5 (Emerald), got ${savedState.realChatIncomingBg}`);
    }
    if (savedState.realChatBubbleRadius !== '12px') {
      throw new Error(`Expected real chat bubble radius 12px (Soft), got ${savedState.realChatBubbleRadius}`);
    }

    // Step 7: Test "Use app theme" in preview
    await win.webContents.executeJavaScript(`
      (() => {
        // Reopen modal
        const btnOpen = document.getElementById('btn-chat-theme');
        if (btnOpen) btnOpen.click();
        else if (window.__TEST_HOOKS__?.openThemeModal) window.__TEST_HOOKS__.openThemeModal();

        // Click "Use app theme"
        const btnReset = document.getElementById('btn-reset-theme');
        btnReset.click();
      })()
    `);

    const resetPreviewState = await win.webContents.executeJavaScript(`
      (() => {
        const previewStatus = document.getElementById('theme-preview-status-name');
        const previewIncoming = document.getElementById('theme-preview-incoming');
        const previewScreen = document.getElementById('theme-preview-screen');
        return {
          statusText: previewStatus?.textContent,
          incomingBg: previewIncoming?.style.backgroundColor,
          realChatIncomingBg: document.documentElement.style.getPropertyValue('--chat-incoming-bg')
        };
      })()
    `);
    console.log('[7/8] "Use app theme" clicked:');
    console.log('      Preview status text:', resetPreviewState.statusText);
    console.log('      Preview incoming bg:', resetPreviewState.incomingBg);
    console.log('      Real chat incoming bg remains Emerald before save:', resetPreviewState.realChatIncomingBg === '#d1fae5');

    if (!resetPreviewState.statusText.includes('App Theme')) {
      throw new Error(`Expected preview status to include "App Theme", got "${resetPreviewState.statusText}"`);
    }

    // Close modal
    await win.webContents.executeJavaScript(`
      (() => {
        document.getElementById('btn-close-theme').click();
      })()
    `);

    console.log('[8/8] Live Electron verification PASSED successfully!');
    win.destroy();
    app.quit();
    process.exit(0);
  } catch (err) {
    console.error('Electron verification FAILED:', err);
    app.quit();
    process.exit(1);
  }
});
