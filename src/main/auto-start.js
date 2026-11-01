/**
 * Windows Auto-Start and Background Daemon Lifecycle Helper
 * Manages Windows login item settings and hidden startup detection.
 */

/**
 * Determines whether the application was requested to start hidden in the background.
 *
 * @param {string[]} argv e.g. process.argv
 * @param {object} [loginSettings] e.g. app.getLoginItemSettings()
 * @returns {boolean}
 */
export function shouldStartHidden(argv = [], loginSettings = null) {
  if (Array.isArray(argv)) {
    if (argv.includes('--hidden') || argv.includes('--background') || argv.includes('--minimized')) {
      return true;
    }
  }
  if (loginSettings && typeof loginSettings === 'object') {
    if (loginSettings.wasOpenedAsHidden || loginSettings.wasOpenedAtLogin) {
      return true;
    }
  }
  return false;
}

/**
 * Configures the Windows auto-start on user login setting.
 *
 * @param {object} appInstance Electron app object or mock
 * @param {boolean} enabled Whether auto-start should be active
 * @param {object} [options]
 * @param {string} [options.execPath]
 * @returns {boolean} Whether operation completed successfully
 */
export function setAutoStart(appInstance, enabled = true, options = {}) {
  if (!appInstance || typeof appInstance.setLoginItemSettings !== 'function') {
    return false;
  }

  try {
    const execPath = options.execPath || process.execPath;
    appInstance.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      openAsHidden: Boolean(enabled),
      path: execPath,
      args: enabled ? ['--hidden'] : []
    });
    return true;
  } catch (err) {
    console.warn('[AutoStart] Failed to update login item settings:', err?.message || err);
    return false;
  }
}

/**
 * Checks whether Windows auto-start is currently enabled.
 *
 * @param {object} appInstance Electron app object or mock
 * @returns {boolean}
 */
export function isAutoStartEnabled(appInstance) {
  if (!appInstance || typeof appInstance.getLoginItemSettings !== 'function') {
    return false;
  }

  try {
    const settings = appInstance.getLoginItemSettings();
    return Boolean(settings?.openAtLogin);
  } catch {
    return false;
  }
}
