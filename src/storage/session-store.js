import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_SESSION = Object.freeze({
  sessionToken: null,
  userId: null,
  phone: null,
  displayName: null,
  about: null,
  avatarUrl: null,
  onboardingDone: false
});

/**
 * SessionStore manages persistent authentication credentials and profile metadata
 * strictly adhering to the Android reference pattern (SessionStore.kt).
 *
 * It persists data in `ollacore_session.json` within Electron's `userData` folder.
 */
export class SessionStore {
  /**
   * @param {string} storageDir Path to directory containing session data (typically app.getPath('userData'))
   */
  constructor(storageDir) {
    if (!storageDir) {
      throw new Error('SessionStore requires a valid storage directory path');
    }
    this.storageDir = storageDir;
    this.filePath = path.join(storageDir, 'ollacore_session.json');
    this.currentSession = { ...DEFAULT_SESSION };
    this.isLoaded = false;
  }

  /**
   * Sanitizes any loaded or in-memory object against the expected session structure.
   * @private
   */
  _sanitize(raw) {
    if (!raw || typeof raw !== 'object') {
      return { ...DEFAULT_SESSION };
    }
    return {
      sessionToken: typeof raw.sessionToken === 'string' && raw.sessionToken.trim() !== '' ? raw.sessionToken.trim() : null,
      userId: typeof raw.userId === 'string' && raw.userId.trim() !== '' ? raw.userId.trim() : null,
      phone: typeof raw.phone === 'string' && raw.phone.trim() !== '' ? raw.phone.trim() : null,
      displayName: typeof raw.displayName === 'string' && raw.displayName.trim() !== '' ? raw.displayName.trim() : null,
      about: typeof raw.about === 'string' && raw.about.trim() !== '' ? raw.about.trim() : null,
      avatarUrl: typeof raw.avatarUrl === 'string' && raw.avatarUrl.trim() !== '' ? raw.avatarUrl.trim() : null,
      avatarVersion: typeof raw.avatarVersion === 'string' && raw.avatarVersion.trim() !== '' ? raw.avatarVersion.trim() : (typeof raw.avatar_version === 'string' && raw.avatar_version.trim() !== '' ? raw.avatar_version.trim() : null),
      onboardingDone: Boolean(raw.onboardingDone)
    };
  }

  /**
   * Loads session from disk. Gracefully falls back to default session if
   * the file is missing, empty, or corrupt.
   * @returns {Promise<typeof DEFAULT_SESSION>}
   */
  async load() {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
      const content = await fs.readFile(this.filePath, 'utf8');
      if (!content || !content.trim()) {
        this.currentSession = { ...DEFAULT_SESSION };
      } else {
        const parsed = JSON.parse(content);
        this.currentSession = this._sanitize(parsed);
      }
    } catch (err) {
      // File does not exist, syntax error in JSON, or read error
      this.currentSession = { ...DEFAULT_SESSION };
    }
    this.isLoaded = true;
    return this.getSession();
  }

  /**
   * Returns a copy of the current in-memory session.
   * @returns {typeof DEFAULT_SESSION}
   */
  getSession() {
    return { ...this.currentSession };
  }

  /**
   * Atomically writes session data to disk using a temporary file + rename.
   * @private
   */
  async _persist() {
    await fs.mkdir(this.storageDir, { recursive: true });
    const tmpFileName = `ollacore_session.json.tmp.${crypto.randomBytes(6).toString('hex')}`;
    const tmpFilePath = path.join(this.storageDir, tmpFileName);
    const serialized = JSON.stringify(this.currentSession, null, 2);

    await fs.writeFile(tmpFilePath, serialized, 'utf8');

    // Windows filesystem can transiently lock files during rapid rename/replace operations
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await fs.rename(tmpFilePath, this.filePath);
        return;
      } catch (err) {
        if ((err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') && attempt < 4) {
          await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
        } else {
          try {
            await fs.copyFile(tmpFilePath, this.filePath);
            await fs.unlink(tmpFilePath).catch(() => {});
            return;
          } catch {
            throw err;
          }
        }
      }
    }
  }

  /**
   * Persists session credentials while preserving onboardingDone state.
   * Mirrors Android SessionStore.saveSession(token, userId, phone, displayName).
   */
  async saveSession({ sessionToken, userId, phone, displayName = null, about = null, avatarUrl = null, avatarVersion = null } = {}) {
    if (!this.isLoaded) {
      await this.load();
    }

    this.currentSession = {
      ...this.currentSession,
      sessionToken: typeof sessionToken === 'string' && sessionToken.trim() !== '' ? sessionToken.trim() : null,
      userId: typeof userId === 'string' && userId.trim() !== '' ? userId.trim() : null,
      phone: typeof phone === 'string' && phone.trim() !== '' ? phone.trim() : null,
      displayName: typeof displayName === 'string' && displayName.trim() !== '' ? displayName.trim() : (displayName === null ? null : this.currentSession.displayName),
      about: typeof about === 'string' && about.trim() !== '' ? about.trim() : (about === null ? null : this.currentSession.about),
      avatarUrl: typeof avatarUrl === 'string' && avatarUrl.trim() !== '' ? avatarUrl.trim() : (avatarUrl === null ? null : this.currentSession.avatarUrl),
      avatarVersion: typeof avatarVersion === 'string' && avatarVersion.trim() !== '' ? avatarVersion.trim() : (avatarVersion === null ? null : this.currentSession.avatarVersion),
      onboardingDone: this.currentSession.onboardingDone
    };

    await this._persist();
    return this.getSession();
  }

  /**
   * Updates only supplied profile fields.
   * Mirrors Android SessionStore.updateProfile(displayName, about, avatarUrl).
   */
  async updateProfile({ displayName, about, avatarUrl, avatarVersion, avatar_version } = {}) {
    if (!this.isLoaded) {
      await this.load();
    }

    const updated = { ...this.currentSession };
    if (displayName !== undefined) {
      updated.displayName = typeof displayName === 'string' && displayName.trim() !== '' ? displayName.trim() : null;
    }
    if (about !== undefined) {
      updated.about = typeof about === 'string' && about.trim() !== '' ? about.trim() : null;
    }
    if (avatarUrl !== undefined) {
      updated.avatarUrl = typeof avatarUrl === 'string' && avatarUrl.trim() !== '' ? avatarUrl.trim() : null;
    }
    const avVersion = avatarVersion !== undefined ? avatarVersion : (avatar_version !== undefined ? avatar_version : undefined);
    if (avVersion !== undefined) {
      updated.avatarVersion = typeof avVersion === 'string' && avVersion.trim() !== '' ? avVersion.trim() : null;
    }

    this.currentSession = updated;
    await this._persist();
    return this.getSession();
  }

  /**
   * Sets onboarding status flag.
   * Mirrors Android SessionStore.setOnboardingDone(done).
   */
  async setOnboardingDone(done = true) {
    if (!this.isLoaded) {
      await this.load();
    }
    this.currentSession.onboardingDone = Boolean(done);
    await this._persist();
    return this.getSession();
  }

  /**
   * Clears session credentials and profile while strictly preserving onboardingDone.
   * Mirrors Android SessionStore.clear().
   */
  async clear() {
    if (!this.isLoaded) {
      await this.load();
    }
    const keepOnboarding = this.currentSession.onboardingDone;
    this.currentSession = {
      ...DEFAULT_SESSION,
      onboardingDone: keepOnboarding
    };
    await this._persist();
    return this.getSession();
  }
}
