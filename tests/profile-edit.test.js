import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AuthController, AUTH_STEPS } from '../src/auth/auth-controller.js';
import { SessionStore } from '../src/storage/session-store.js';
import { OllacoreApi, normalizeUserProfile } from '../src/api/ollacore-api.js';
import { ApiError } from '../src/api/api-error.js';
import { ChatShellState } from '../src/renderer/chat-shell-state.js';

describe('Windows OllaChat Settings & Profile Screen Suite', () => {
  let tempDir;
  let sessionStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ollachat_profile_test_'));
    sessionStore = new SessionStore(tempDir);
    await sessionStore.load();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Cleanup best effort
    }
  });

  // ═════════════════════════════════════════════════════════════════
  // 1. OllacoreApi PATCH /directory/me Contract Tests
  // ═════════════════════════════════════════════════════════════════
  describe('1. OllacoreApi PATCH /directory/me Contract', () => {
    test('PATCH /directory/me is called with Bearer token and whitelist body fields', async () => {
      let capturedUrl = null;
      let capturedOptions = null;

      const api = new OllacoreApi({ baseUrl: 'http://mock-api.local', appId: 'ollachat-win' });
      api._request = async (path, options) => {
        capturedUrl = path;
        capturedOptions = options;
        return {
          id: 'mock-uuid-1234',
          display_name: options.body.display_name,
          about: options.body.about
        };
      };

      const result = await api.updateProfile('mock_bearer_token', {
        displayName: 'Alice Desktop',
        about: 'Available on OllaChat',
        // Attempt to pass arbitrary or read-only fields
        userId: 'hack-uuid',
        phone: '+9999999999',
        arbitrary: 'ignored'
      });

      assert.equal(capturedUrl, '/directory/me');
      assert.equal(capturedOptions.method, 'PATCH');
      assert.equal(capturedOptions.headers.Authorization, 'Bearer mock_bearer_token');
      // Verify only display_name and about (and avatar_url) are sent in body
      assert.deepEqual(capturedOptions.body, {
        display_name: 'Alice Desktop',
        about: 'Available on OllaChat'
      });
      // Verifies result is normalized
      assert.equal(result.displayName, 'Alice Desktop');
      assert.equal(result.about, 'Available on OllaChat');
      assert.equal(result.userId, 'mock-uuid-1234');
    });

    test('PATCH /directory/me requires sessionToken', async () => {
      const api = new OllacoreApi({ baseUrl: 'http://mock-api.local' });
      await assert.rejects(
        () => api.updateProfile(null, { displayName: 'Alice' }),
        /Authentication token required/
      );
    });

    test('normalizeUserProfile handles server payload with snake_case and camelCase compatibility', () => {
      const normalized = normalizeUserProfile({
        id: 'uuid-abc',
        phone: '+15551234567',
        display_name: 'Bob',
        about: 'Working remotely',
        avatar_url: 'https://example.com/avatar.png'
      });

      assert.equal(normalized.userId, 'uuid-abc');
      assert.equal(normalized.id, 'uuid-abc');
      assert.equal(normalized.phone, '+15551234567');
      assert.equal(normalized.displayName, 'Bob');
      assert.equal(normalized.display_name, 'Bob');
      assert.equal(normalized.about, 'Working remotely');
      assert.equal(normalized.avatarUrl, 'https://example.com/avatar.png');
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 2. AuthController Profile Editing & Security Tests
  // ═════════════════════════════════════════════════════════════════
  describe('2. AuthController Profile Updating & Security', () => {
    test('Display name and About can be edited via updateProfile and persisted to SessionStore', async () => {
      await sessionStore.saveSession({
        sessionToken: 'token_sec_123',
        userId: 'fixed-uuid-1111',
        phone: '+15550009999',
        displayName: 'Initial Name',
        about: 'Initial About'
      });

      const mockApi = {
        updateProfileCalls: [],
        async updateProfile(token, profile) {
          this.updateProfileCalls.push({ token, profile });
          // Simulating real backend: echoes display_name, omits about in patch response
          return {
            id: 'fixed-uuid-1111',
            display_name: profile.display_name
          };
        }
      };

      const authController = new AuthController({ api: mockApi, sessionStore });
      await authController.init();

      const updated = await authController.updateProfile({
        displayName: 'New Display Name',
        about: 'Updated bio on OllaChat'
      });

      // Verify API was called with sessionToken
      assert.equal(mockApi.updateProfileCalls.length, 1);
      assert.equal(mockApi.updateProfileCalls[0].token, 'token_sec_123');
      assert.equal(mockApi.updateProfileCalls[0].profile.displayName, 'New Display Name');
      assert.equal(mockApi.updateProfileCalls[0].profile.about, 'Updated bio on OllaChat');

      // Verify session updated and merged correctly
      assert.equal(updated.displayName, 'New Display Name');
      assert.equal(updated.about, 'Updated bio on OllaChat');
      assert.equal(updated.userId, 'fixed-uuid-1111');
      assert.equal(updated.phone, '+15550009999');

      // Verify SessionStore reflects the update
      const stored = sessionStore.getSession();
      assert.equal(stored.displayName, 'New Display Name');
      assert.equal(stored.about, 'Updated bio on OllaChat');
      assert.equal(stored.userId, 'fixed-uuid-1111');
    });

    test('User ID remains strictly read-only and cannot be mutated by updateProfile', async () => {
      await sessionStore.saveSession({
        sessionToken: 'token_immutable_test',
        userId: 'immutable-server-uuid-5555',
        phone: '+15550001234',
        displayName: 'Test User',
        about: 'Test About'
      });

      const mockApi = {
        async updateProfile(token, profile) {
          return { display_name: profile.display_name };
        }
      };

      const authController = new AuthController({ api: mockApi, sessionStore });
      await authController.init();

      // Attempt to pass a modified userId or id
      await authController.updateProfile({
        displayName: 'Attacker Name',
        userId: 'hacked-uuid-9999',
        id: 'hacked-uuid-9999',
        phone: '+9999999999',
        sessionToken: 'stolen_token'
      });

      const session = sessionStore.getSession();
      // Server-generated UUID and phone are completely unchanged
      assert.equal(session.userId, 'immutable-server-uuid-5555');
      assert.equal(session.phone, '+15550001234');
      assert.equal(session.sessionToken, 'token_immutable_test');
      assert.equal(session.displayName, 'Attacker Name');
    });

    test('Failed save throws error and does NOT corrupt SessionStore', async () => {
      await sessionStore.saveSession({
        sessionToken: 'token_fail_test',
        userId: 'uuid-fail-test',
        phone: '+15550002222',
        displayName: 'Safe Name',
        about: 'Safe About'
      });

      const mockApi = {
        async updateProfile() {
          throw new ApiError('Internal server error', 'server_error', 500);
        }
      };

      const authController = new AuthController({ api: mockApi, sessionStore });
      await authController.init();

      await assert.rejects(
        () => authController.updateProfile({ displayName: 'Corrupted Name', about: 'Corrupted About' }),
        /Internal server error/
      );

      // SessionStore remains intact
      const session = sessionStore.getSession();
      assert.equal(session.displayName, 'Safe Name');
      assert.equal(session.about, 'Safe About');
    });

    test('Unauthenticated user cannot update profile', async () => {
      const mockApi = { async updateProfile() { return {}; } };
      const authController = new AuthController({ api: mockApi, sessionStore });
      await authController.init();

      await assert.rejects(
        () => authController.updateProfile({ displayName: 'Anon' }),
        /Not authenticated/
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 3. Profile Data Consistency & Persistence Tests
  // ═════════════════════════════════════════════════════════════════
  describe('3. Profile Data Consistency & Persistence', () => {
    test('Profile changes persist after closing Settings, reopening, and application restart', async () => {
      // 1. Initial login save
      await sessionStore.saveSession({
        sessionToken: 'token_persist_test',
        userId: 'uuid-persist-777',
        phone: '+15557778888',
        displayName: 'Version 1',
        about: 'About V1'
      });

      // 2. Profile update
      await sessionStore.updateProfile({
        displayName: 'Version 2 (Saved)',
        about: 'About V2 (Saved)'
      });

      // 3. Simulate closing and reopening Settings (reading current session)
      const reopenedSession = sessionStore.getSession();
      assert.equal(reopenedSession.displayName, 'Version 2 (Saved)');
      assert.equal(reopenedSession.about, 'About V2 (Saved)');
      assert.equal(reopenedSession.userId, 'uuid-persist-777');

      // 4. Simulate application restart (new SessionStore instance reading same disk storage)
      const restartedStore = new SessionStore(tempDir);
      await restartedStore.load();

      const restartedSession = restartedStore.getSession();
      assert.equal(restartedSession.displayName, 'Version 2 (Saved)');
      assert.equal(restartedSession.about, 'About V2 (Saved)');
      assert.equal(restartedSession.userId, 'uuid-persist-777');
      assert.equal(restartedSession.phone, '+15557778888');
      assert.equal(restartedSession.sessionToken, 'token_persist_test');
    });

    test('SessionStore preserves onboardingDone and authentication tokens during updateProfile', async () => {
      await sessionStore.saveSession({
        sessionToken: 'token_sec',
        userId: 'uuid-1',
        phone: '+12345',
        displayName: 'A'
      });
      await sessionStore.setOnboardingDone(true);

      await sessionStore.updateProfile({ displayName: 'B', about: 'Hello' });

      const session = sessionStore.getSession();
      assert.equal(session.displayName, 'B');
      assert.equal(session.about, 'Hello');
      assert.equal(session.onboardingDone, true);
      assert.equal(session.sessionToken, 'token_sec');
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 4. Settings & Profile Screen UI Controller Tests
  // ═════════════════════════════════════════════════════════════════
  describe('4. Settings & Profile Screen UI Controller Logic', () => {
    /**
     * Creates a mock DOM environment mirroring index.html and app.js profile editing behavior.
     */
    function createProfileUiHarness(initialSession, apiMock) {
      const shellState = new ChatShellState();
      shellState.setCurrentUser(initialSession);

      // DOM Elements Mock
      const dom = {
        settingsModal: { classList: new Set(['hidden']) },
        profileViewMode: { classList: new Set() },
        profileEditMode: { classList: new Set(['hidden']) },
        profileViewFooter: { classList: new Set() },
        profileEditFooter: { classList: new Set(['hidden']) },
        profileEditStatus: {
          classList: new Set(['hidden']),
          className: 'status-banner hidden',
          textContent: '',
          innerHTML: ''
        },
        userDisplayName: { textContent: initialSession?.displayName || '' },
        userAbout: { textContent: initialSession?.about || 'Available on OllaChat' },
        userPhone: { textContent: initialSession?.phone || '' },
        userId: { textContent: initialSession?.userId || '' },
        settingClient: { textContent: 'OllaChat Desktop (Windows x64)' },

        editProfileName: { value: '', focusCalled: false, focus() { this.focusCalled = true; } },
        editProfileAbout: { value: '' },
        userPhoneEdit: { textContent: initialSession?.phone || '' },
        userIdEdit: { textContent: initialSession?.userId || '' },
        settingClientEdit: { textContent: 'OllaChat Desktop (Windows x64)' },

        btnSaveProfile: { disabled: false, textContent: 'Save', innerHTML: 'Save' },
        btnCancelEditProfile: { disabled: false },
        btnEditProfile: {},

        currentUserName: { textContent: initialSession?.displayName || '' },
        currentUserPhone: { textContent: initialSession?.phone || '' }
      };

      // Helper to emulate classList API
      for (const key of ['settingsModal', 'profileViewMode', 'profileEditMode', 'profileViewFooter', 'profileEditFooter', 'profileEditStatus']) {
        const el = dom[key];
        el.classList.add = function (cls) { el.classList.add ? Set.prototype.add.call(el.classList, cls) : null; };
        el.classList.remove = function (cls) { el.classList.delete ? Set.prototype.delete.call(el.classList, cls) : null; };
        el.classList.contains = function (cls) { return el.classList.has(cls); };
      }

      function updateProfileDisplay(session) {
        shellState.setCurrentUser(session);
        const name = session?.displayName || session?.phone || 'OllaChat User';
        const aboutText = session?.about || 'Available on OllaChat';
        const phone = session?.phone || '';
        const userIdVal = session?.userId || 'N/A';

        // Sidebar
        dom.currentUserName.textContent = name;
        dom.currentUserPhone.textContent = phone;

        // Settings view mode
        dom.userDisplayName.textContent = name;
        dom.userPhone.textContent = phone;
        dom.userId.textContent = userIdVal;
        dom.userAbout.textContent = aboutText;

        // Settings edit mode
        dom.userPhoneEdit.textContent = phone;
        dom.userIdEdit.textContent = userIdVal;
      }

      function hideProfileEditStatus() {
        dom.profileEditStatus.classList.add('hidden');
        dom.profileEditStatus.textContent = '';
        dom.profileEditStatus.className = 'status-banner hidden';
      }

      function showProfileEditStatus(message, type = 'error') {
        dom.profileEditStatus.className = `status-banner ${type}`;
        if (type === 'saving') {
          dom.profileEditStatus.innerHTML = `<span class="spinner spinner-sm"></span><span>${message}</span>`;
        } else {
          dom.profileEditStatus.textContent = message;
        }
        dom.profileEditStatus.classList.remove('hidden');
      }

      function setProfileEditMode(isEditing) {
        if (isEditing) {
          dom.profileViewMode.classList.add('hidden');
          dom.profileViewFooter.classList.add('hidden');
          dom.profileEditMode.classList.remove('hidden');
          dom.profileEditFooter.classList.remove('hidden');

          const current = shellState.currentUser;
          dom.editProfileName.value = current?.displayName || '';
          dom.editProfileAbout.value = current?.about || '';
          hideProfileEditStatus();
          dom.editProfileName.focus();
        } else {
          dom.profileEditMode.classList.add('hidden');
          dom.profileEditFooter.classList.add('hidden');
          dom.profileViewMode.classList.remove('hidden');
          dom.profileViewFooter.classList.remove('hidden');
          hideProfileEditStatus();
        }
      }

      function openSettings() {
        setProfileEditMode(false);
        if (shellState.currentUser) {
          updateProfileDisplay(shellState.currentUser);
        }
        dom.settingsModal.classList.remove('hidden');
      }

      function closeSettings() {
        setProfileEditMode(false);
        dom.settingsModal.classList.add('hidden');
      }

      async function handleSaveProfile() {
        const nameVal = dom.editProfileName.value.trim();
        const aboutVal = dom.editProfileAbout.value.trim();

        if (!nameVal) {
          showProfileEditStatus('Display name cannot be empty', 'error');
          dom.editProfileName.focus();
          return;
        }

        dom.btnSaveProfile.disabled = true;
        dom.btnSaveProfile.innerHTML = '<span class="spinner spinner-sm"></span> Saving...';
        dom.btnCancelEditProfile.disabled = true;
        showProfileEditStatus('Saving changes...', 'saving');

        try {
          const res = await apiMock.updateProfile({ displayName: nameVal, about: aboutVal });
          if (res?.ok && res.session) {
            updateProfileDisplay(res.session);
            showProfileEditStatus('Profile updated successfully!', 'success');
            setProfileEditMode(false);
          } else {
            const errMsg = res?.error || 'Failed to update profile';
            showProfileEditStatus(errMsg, 'error');
          }
        } catch (err) {
          showProfileEditStatus(err?.message || 'Failed to update profile', 'error');
        } finally {
          dom.btnSaveProfile.disabled = false;
          dom.btnSaveProfile.textContent = 'Save';
          dom.btnCancelEditProfile.disabled = false;
        }
      }

      return {
        dom,
        shellState,
        setProfileEditMode,
        openSettings,
        closeSettings,
        handleSaveProfile,
        updateProfileDisplay
      };
    }

    test('A. Edit Profile opens and transitions between view and edit modes', () => {
      const initial = {
        userId: 'uuid-ui-1',
        displayName: 'Charlie',
        about: 'Living the OllaChat life',
        phone: '+15551112222'
      };
      const harness = createProfileUiHarness(initial, {});

      // Initially in view mode
      assert.equal(harness.dom.profileViewMode.classList.contains('hidden'), false);
      assert.equal(harness.dom.profileEditMode.classList.contains('hidden'), true);

      // Open Edit Profile
      harness.setProfileEditMode(true);
      assert.equal(harness.dom.profileViewMode.classList.contains('hidden'), true);
      assert.equal(harness.dom.profileEditMode.classList.contains('hidden'), false);
      assert.equal(harness.dom.editProfileName.value, 'Charlie');
      assert.equal(harness.dom.editProfileAbout.value, 'Living the OllaChat life');
      assert.equal(harness.dom.editProfileName.focusCalled, true);

      // User ID remains read-only span
      assert.equal(harness.dom.userIdEdit.textContent, 'uuid-ui-1');
      assert.equal(harness.dom.settingClientEdit.textContent, 'OllaChat Desktop (Windows x64)');
    });

    test('B. Cancel does not modify the profile and reverts UI to view mode', () => {
      const initial = {
        userId: 'uuid-ui-2',
        displayName: 'Dana',
        about: 'Original Bio',
        phone: '+15553334444'
      };
      const harness = createProfileUiHarness(initial, {});

      harness.setProfileEditMode(true);
      // User modifies values
      harness.dom.editProfileName.value = 'Unsaved Name';
      harness.dom.editProfileAbout.value = 'Unsaved Bio';

      // User clicks Cancel
      harness.setProfileEditMode(false);

      // Modal is back in view mode
      assert.equal(harness.dom.profileViewMode.classList.contains('hidden'), false);
      assert.equal(harness.dom.profileEditMode.classList.contains('hidden'), true);

      // Original profile remains untouched
      assert.equal(harness.dom.userDisplayName.textContent, 'Dana');
      assert.equal(harness.dom.userAbout.textContent, 'Original Bio');
      assert.equal(harness.shellState.currentUser.displayName, 'Dana');

      // Reopening edit mode re-initializes with original values
      harness.setProfileEditMode(true);
      assert.equal(harness.dom.editProfileName.value, 'Dana');
      assert.equal(harness.dom.editProfileAbout.value, 'Original Bio');
    });

    test('C. Successful save updates UI, session state, and sidebar', async () => {
      const initial = {
        userId: 'uuid-ui-3',
        displayName: 'Evan',
        about: 'Old Evan Bio',
        phone: '+15555556666'
      };

      const apiMock = {
        async updateProfile(payload) {
          return {
            ok: true,
            session: {
              ...initial,
              displayName: payload.displayName,
              about: payload.about
            }
          };
        }
      };

      const harness = createProfileUiHarness(initial, apiMock);
      harness.setProfileEditMode(true);

      // Edit fields
      harness.dom.editProfileName.value = 'Evan Senior';
      harness.dom.editProfileAbout.value = 'Engineer at OllaChat';

      // Save
      await harness.handleSaveProfile();

      // UI is returned to view mode
      assert.equal(harness.dom.profileViewMode.classList.contains('hidden'), false);
      assert.equal(harness.dom.profileEditMode.classList.contains('hidden'), true);

      // Settings modal displays updated information
      assert.equal(harness.dom.userDisplayName.textContent, 'Evan Senior');
      assert.equal(harness.dom.userAbout.textContent, 'Engineer at OllaChat');

      // Sidebar footer displays updated information
      assert.equal(harness.dom.currentUserName.textContent, 'Evan Senior');

      // Shell state updated
      assert.equal(harness.shellState.currentUser.displayName, 'Evan Senior');
      assert.equal(harness.shellState.currentUser.about, 'Engineer at OllaChat');

      // User ID and Client remain unchanged
      assert.equal(harness.dom.userId.textContent, 'uuid-ui-3');
      assert.equal(harness.dom.settingClient.textContent, 'OllaChat Desktop (Windows x64)');
    });

    test('D. Empty display name shows validation error and does not call API', async () => {
      let apiCalled = false;
      const harness = createProfileUiHarness({ displayName: 'Frank' }, {
        async updateProfile() { apiCalled = true; return { ok: true }; }
      });

      harness.setProfileEditMode(true);
      harness.dom.editProfileName.value = '   '; // whitespace only

      await harness.handleSaveProfile();

      assert.equal(apiCalled, false);
      assert.equal(harness.dom.profileEditStatus.classList.contains('hidden'), false);
      assert.equal(harness.dom.profileEditStatus.textContent, 'Display name cannot be empty');
      assert.equal(harness.dom.profileEditMode.classList.contains('hidden'), false); // Form stays open
    });

    test('E. Failed save displays an error banner, keeps edit mode open, and re-enables save button', async () => {
      const harness = createProfileUiHarness({ displayName: 'Grace' }, {
        async updateProfile() {
          return { ok: false, error: 'Network timeout: unable to reach OllaCore' };
        }
      });

      harness.setProfileEditMode(true);
      harness.dom.editProfileName.value = 'Grace Hopper';

      await harness.handleSaveProfile();

      // Error shown
      assert.equal(harness.dom.profileEditStatus.classList.contains('hidden'), false);
      assert.equal(harness.dom.profileEditStatus.textContent, 'Network timeout: unable to reach OllaCore');

      // Form remains in edit mode so user doesn't lose inputs
      assert.equal(harness.dom.profileEditMode.classList.contains('hidden'), false);
      assert.equal(harness.dom.editProfileName.value, 'Grace Hopper');

      // Save button re-enabled
      assert.equal(harness.dom.btnSaveProfile.disabled, false);
      assert.equal(harness.dom.btnSaveProfile.textContent, 'Save');
    });

    test('F. Reopening Settings resets edit mode and retains updated profile', () => {
      const harness = createProfileUiHarness({
        userId: 'uuid-reopen',
        displayName: 'Hank',
        about: 'Hank bio'
      }, {});

      // Open settings, start editing
      harness.openSettings();
      harness.setProfileEditMode(true);
      harness.dom.editProfileName.value = 'Hank Modified';

      // Close settings
      harness.closeSettings();
      assert.equal(harness.dom.settingsModal.classList.contains('hidden'), true);
      assert.equal(harness.dom.profileEditMode.classList.contains('hidden'), true);

      // Reopen settings
      harness.openSettings();
      assert.equal(harness.dom.settingsModal.classList.contains('hidden'), false);
      assert.equal(harness.dom.profileViewMode.classList.contains('hidden'), false);
      assert.equal(harness.dom.profileEditMode.classList.contains('hidden'), true);
      assert.equal(harness.dom.userDisplayName.textContent, 'Hank');
    });
  });
});
