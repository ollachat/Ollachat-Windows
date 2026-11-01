import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 1280,
      height: 850,
      show: true,
      webPreferences: {
        preload: path.join(rootDir, 'dist/preload/preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    await win.loadFile(path.join(rootDir, 'dist/renderer/index.html'));
    await new Promise(r => setTimeout(r, 800));

    // Open theme modal
    const modalInfo = await win.webContents.executeJavaScript(`
      (() => {
        try {
          const btnOpen = document.getElementById('btn-chat-theme');
          if (btnOpen) btnOpen.click();
          else if (window.__TEST_HOOKS__?.openThemeModal) window.__TEST_HOOKS__.openThemeModal();

          const container = document.querySelector('.theme-preview-container');
          const header = document.querySelector('.theme-preview-header');
          const screen = document.getElementById('theme-preview-screen');
          
          const dumpStyles = (el) => {
            if (!el) return null;
            const s = window.getComputedStyle(el);
            return {
              display: s.display,
              height: s.height,
              minHeight: s.minHeight,
              maxHeight: s.maxHeight,
              flexShrink: s.flexShrink,
              flexGrow: s.flexGrow,
              overflow: s.overflow,
              position: s.position,
              boxSizing: s.boxSizing
            };
          };

          return {
            containerStyles: dumpStyles(container),
            headerStyles: dumpStyles(header),
            screenStyles: dumpStyles(screen),
            containerRect: container ? container.getBoundingClientRect() : null,
            headerRect: header ? header.getBoundingClientRect() : null,
            screenRect: screen ? screen.getBoundingClientRect() : null
          };
        } catch (err) {
          return { error: err.message, stack: err.stack };
        }
      })()
    `);

    console.log('DOM INSPECTION RESULTS:', JSON.stringify(modalInfo, null, 2));

    // Select Ocean, Rounded, Waves
    await win.webContents.executeJavaScript(`
      (() => {
        const oceanCard = document.querySelector('.theme-preset-card[data-preset-id="ocean"]');
        if (oceanCard) oceanCard.click();
        const roundedCard = document.querySelector('.bubble-style-card[data-bubble-id="rounded"]');
        if (roundedCard) roundedCard.click();
        const wavesCard = document.querySelector('.wallpaper-card[data-wallpaper-id="waves"]');
        if (wavesCard) wavesCard.click();

        const modalBody = document.querySelector('.theme-modal-body');
        if (modalBody) {
          modalBody.scrollTop = modalBody.scrollHeight;
        }
      })()
    `);

    // Capture screenshot
    await new Promise(r => setTimeout(r, 400));
    const image = await win.webContents.capturePage();
    const screenshotPath = path.join(rootDir, 'dist', 'theme-modal-ocean-screenshot.png');
    fs.writeFileSync(screenshotPath, image.toPNG());
    console.log('Saved Ocean screenshot to:', screenshotPath);

    win.destroy();
    app.quit();
    process.exit(0);
  } catch (err) {
    console.error('Inspection failed:', err);
    app.quit();
    process.exit(1);
  }
});
