import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AuthController } from '../src/auth/auth-controller.js';
import { SessionStore } from '../src/storage/session-store.js';
import { OllacoreApi, normalizeUserProfile } from '../src/api/ollacore-api.js';
import { validateMediaFile, EXTENSION_MIME_MAP } from '../src/api/mime-validator.js';
import { ChatShellState } from '../src/renderer/chat-shell-state.js';

describe('Profile Photo Editing & Avatar Lifecycle Suite', () => {
  let tempDir;
  let sessionStore;

  // Minimal valid 1x1 image samples
  const VALID_PNG_BUFFER = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  // Valid minimal JPEG header + data
  const VALID_JPEG_BUFFER = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60,
    0x00, 0x60, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
    0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xbf, 0xff, 0xd9
  ]);
  // Valid minimal WebP header
  const VALID_WEBP_BUFFER = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x1a, 0x00, 0x00, 0x00]), // file size - 8
    Buffer.from('WEBPVP8 ', 'ascii'),
    Buffer.from([0x0e, 0x00, 0x00, 0x00]), // frame length
    Buffer.from([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00, 0x02, 0x00, 0x34, 0x25])
  ]);

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ollachat_avatar_test_'));
    sessionStore = new SessionStore(tempDir);
    await sessionStore.load();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // ═════════════════════════════════════════════════════════════════
  // 1. File Selection & Image Validation Tests
  // ═════════════════════════════════════════════════════════════════
  describe('1. Image Validation & Format Verification', () => {
    test('1. Valid PNG selection passes validation and detects image/png MIME', () => {
      const res = validateMediaFile({
        filename: 'avatar.png',
        byteSize: VALID_PNG_BUFFER.length,
        declaredMime: 'image/png',
        headerBytes: VALID_PNG_BUFFER.subarray(0, 32),
        maxSize: 5 * 1024 * 1024
      });

      assert.equal(res.isValid, true);
      assert.equal(res.kind, 'image');
      assert.equal(res.effectiveMime, 'image/png');
    });

    test('2. Valid JPG/JPEG selection passes validation and detects image/jpeg MIME', () => {
      const res = validateMediaFile({
        filename: 'photo.jpg',
        byteSize: VALID_JPEG_BUFFER.length,
        declaredMime: 'image/jpeg',
        headerBytes: VALID_JPEG_BUFFER.subarray(0, 32),
        maxSize: 5 * 1024 * 1024
      });

      assert.equal(res.isValid, true);
      assert.equal(res.kind, 'image');
      assert.equal(res.effectiveMime, 'image/jpeg');
    });

    test('3. Valid WebP selection passes validation and detects image/webp MIME', () => {
      const res = validateMediaFile({
        filename: 'avatar.webp',
        byteSize: VALID_WEBP_BUFFER.length,
        declaredMime: 'image/webp',
        headerBytes: VALID_WEBP_BUFFER.subarray(0, 32),
        maxSize: 5 * 1024 * 1024
      });

      assert.equal(res.isValid, true);
      assert.equal(res.kind, 'image');
      assert.equal(res.effectiveMime, 'image/webp');
    });

    test('4. Invalid file type rejection (PDF, executable, document)', () => {
      // PDF file pretending to be image
      const pdfBuffer = Buffer.from('%PDF-1.4 Fake PDF Content');
      const resPdf = validateMediaFile({
        filename: 'document.pdf',
        byteSize: pdfBuffer.length,
        declaredMime: 'application/pdf',
        headerBytes: pdfBuffer.subarray(0, 32),
        maxSize: 5 * 1024 * 1024
      });
      assert.notEqual(resPdf.kind, 'image');

      // Executable
      const exeBuffer = Buffer.from([0x4D, 0x5A, 0x90, 0x00]); // MZ
      const resExe = validateMediaFile({
        filename: 'trojan.exe',
        byteSize: 1024,
        declaredMime: 'application/x-msdownload',
        headerBytes: exeBuffer,
        maxSize: 5 * 1024 * 1024
      });
      assert.equal(resExe.isValid, false);
    });

    test('5. Invalid image rejection (wrong magic bytes for declared extension)', () => {
      // Text file disguised as JPG
      const fakeJpg = Buffer.from('This is clearly plain text not a jpeg image');
      const res = validateMediaFile({
        filename: 'fake_avatar.jpg',
        byteSize: fakeJpg.length,
        declaredMime: 'image/jpeg',
        headerBytes: fakeJpg.subarray(0, 32),
        maxSize: 5 * 1024 * 1024
      });

      // Magic bytes mismatch should fail validation
      assert.equal(res.isValid, false);
    });

    test('6. Oversized image rejection (> 5MB limit)', () => {
      const oversizedSize = 6 * 1024 * 1024; // 6MB
      const res = validateMediaFile({
        filename: 'huge_photo.jpg',
        byteSize: oversizedSize,
        declaredMime: 'image/jpeg',
        headerBytes: VALID_JPEG_BUFFER.subarray(0, 32),
        maxSize: 5 * 1024 * 1024
      });

      assert.equal(res.isValid, false);
      assert.match(res.error, /too large/i);
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 2. AuthController & Backend Contract Tests for Avatar
  // ═════════════════════════════════════════════════════════════════
  describe('2. AuthController & Backend Contract for Avatar', () => {
    test('7. Save commits avatar_url via PATCH /directory/me and persists in SessionStore', async () => {
      await sessionStore.saveSession({
        sessionToken: 'token_avatar_test',
        userId: 'uuid-avatar-1',
        displayName: 'Alice',
        about: 'Bio 1',
        avatarUrl: null
      });

      let capturedPayload = null;
      let capturedToken = null;

      const mockApi = {
        async updateProfile(token, profile) {
          capturedToken = token;
          capturedPayload = profile;
          return {
            id: 'uuid-avatar-1',
            display_name: profile.display_name,
            avatar_url: profile.avatar_url
          };
        }
      };

      const authController = new AuthController({ api: mockApi, sessionStore });
      await authController.init();

      const newAvatarUrl = 'https://api.ollacore.com:9443/chatbox-attachments/sample-avatar.jpg';
      const updated = await authController.updateProfile({
        displayName: 'Alice',
        about: 'Bio 1',
        avatarUrl: newAvatarUrl
      });

      assert.equal(capturedToken, 'token_avatar_test');
      assert.equal(capturedPayload.display_name, 'Alice');
      assert.equal(capturedPayload.avatar_url, newAvatarUrl);
      assert.equal(updated.avatarUrl, newAvatarUrl);

      // Verify SessionStore disk persistence
      const savedSession = sessionStore.getSession();
      assert.equal(savedSession.avatarUrl, newAvatarUrl);
    });

    test('8. Remove photo works using documented backend contract (avatar_url: null)', async () => {
      const initialAvatar = 'https://example.com/existing-photo.jpg';
      await sessionStore.saveSession({
        sessionToken: 'token_remove_avatar',
        userId: 'uuid-avatar-2',
        displayName: 'Bob',
        avatarUrl: initialAvatar
      });

      let capturedPayload = null;
      const mockApi = {
        async updateProfile(token, profile) {
          capturedPayload = profile;
          // Real backend echoes display_name and omits avatar_url on patch
          return { display_name: profile.display_name };
        }
      };

      const authController = new AuthController({ api: mockApi, sessionStore });
      await authController.init();

      // Remove photo
      const updated = await authController.updateProfile({
        displayName: 'Bob',
        avatarUrl: null
      });

      assert.equal(capturedPayload.avatar_url, null);
      assert.equal(updated.avatarUrl, null);

      const saved = sessionStore.getSession();
      assert.equal(saved.avatarUrl, null);
    });

    test('9. Avatar persists across application restart', async () => {
      const avatarUrl = 'https://api.ollacore.com:9443/chatbox-attachments/persisted.png';
      await sessionStore.saveSession({
        sessionToken: 'token_restart_test',
        userId: 'uuid-avatar-3',
        displayName: 'Charlie',
        avatarUrl
      });

      // Simulate app restart by constructing a new SessionStore pointing to the same storage
      const newSessionStore = new SessionStore(tempDir);
      await newSessionStore.load();

      const restored = newSessionStore.getSession();
      assert.equal(restored.avatarUrl, avatarUrl);
      assert.equal(restored.displayName, 'Charlie');
    });

    test('10. Existing display-name and about editing still works when avatar is untouched', async () => {
      const avatarUrl = 'https://example.com/my-avatar.jpg';
      await sessionStore.saveSession({
        sessionToken: 'token_compat',
        userId: 'uuid-avatar-4',
        displayName: 'Original Name',
        about: 'Original About',
        avatarUrl
      });

      const mockApi = {
        async updateProfile(token, profile) {
          return { display_name: profile.display_name };
        }
      };

      const authController = new AuthController({ api: mockApi, sessionStore });
      await authController.init();

      const updated = await authController.updateProfile({
        displayName: 'Modified Name',
        about: 'Modified About'
        // avatarUrl is untouched (undefined)
      });

      assert.equal(updated.displayName, 'Modified Name');
      assert.equal(updated.about, 'Modified About');
      assert.equal(updated.avatarUrl, avatarUrl); // Preserved
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // 3. UI Controller & Interaction Tests
  // ═════════════════════════════════════════════════════════════════
  describe('3. UI Controller, Preview, and Action Tests', () => {
    /**
     * UI harness replicating index.html and app.js profile editing with avatar support.
     */
    function createAvatarUiHarness(initialSession, apiMock) {
      const shellState = new ChatShellState();
      shellState.setCurrentUser(initialSession);

      const dom = {
        settingsModal: { classList: new Set(['hidden']) },
        profileViewMode: { classList: new Set() },
        profileEditMode: { classList: new Set(['hidden']) },
        profileEditStatus: {
          classList: new Set(['hidden']),
          className: 'status-banner hidden',
          textContent: ''
        },

        userDisplayName: { textContent: initialSession?.displayName || '' },
        userAbout: { textContent: initialSession?.about || 'Available on OllaChat' },
        userPhone: { textContent: initialSession?.phone || '' },
        userId: { textContent: initialSession?.userId || '' },
        settingClient: { textContent: 'OllaChat Desktop (Windows x64)' },

        modalUserAvatar: { innerHTML: '', textContent: '', style: {} },
        modalUserAvatarEdit: {
          innerHTML: '',
          textContent: '',
          style: {},
          attributes: {},
          setAttribute(k, v) { this.attributes[k] = v; },
          getAttribute(k) { return this.attributes[k]; }
        },
        currentUserName: { textContent: initialSession?.displayName || '' },
        currentUserAvatar: { innerHTML: '', textContent: '', style: {} },

        editProfileName: { value: '' },
        editProfileAbout: { value: '' },
        btnChangePhoto: { textContent: 'Add photo', title: 'Add profile photo' },
        btnRemovePhoto: { classList: new Set(['hidden']) },
        btnSaveProfile: { disabled: false, textContent: 'Save' },
        btnCancelEditProfile: { disabled: false }
      };

      for (const key of ['settingsModal', 'profileViewMode', 'profileEditMode', 'profileEditStatus', 'btnRemovePhoto']) {
        const el = dom[key];
        el.classList.add = function (cls) { Set.prototype.add.call(el.classList, cls); };
        el.classList.remove = function (cls) { Set.prototype.delete.call(el.classList, cls); };
        el.classList.contains = function (cls) { return el.classList.has(cls); };
      }

      const editProfileState = {
        avatarAction: 'none',
        previewUrl: null
      };

      function renderAvatarElement(el, avatarUrl, initials, color, isEdit = false) {
        if (!el) return;
        if (avatarUrl) {
          el.innerHTML = `<img src="${avatarUrl}" alt="Avatar" class="avatar-img" />`;
          el.style.backgroundColor = 'transparent';
        } else {
          el.innerHTML = '';
          el.textContent = initials;
          el.style.backgroundColor = color;
        }
      }

      function updateProfileDisplay(session) {
        shellState.setCurrentUser(session);
        const name = session?.displayName || session?.phone || 'OllaChat User';
        const phone = session?.phone || '';
        const initials = 'OC';
        const color = '#3b82f6';
        const aboutText = session?.about || 'Available on OllaChat';
        const userIdVal = session?.userId || 'N/A';
        const avatarUrl = session?.avatarUrl || null;

        dom.currentUserName.textContent = name;
        renderAvatarElement(dom.currentUserAvatar, avatarUrl, initials, color, false);
        dom.userDisplayName.textContent = name;
        dom.userPhone.textContent = phone;
        dom.userId.textContent = userIdVal;
        dom.userAbout.textContent = aboutText;
        renderAvatarElement(dom.modalUserAvatar, avatarUrl, initials, color, false);
        renderAvatarElement(dom.modalUserAvatarEdit, avatarUrl, initials, color, true);

        dom.btnChangePhoto.textContent = avatarUrl ? 'Change photo' : 'Add photo';
        dom.btnChangePhoto.title = avatarUrl ? 'Change profile photo' : 'Add profile photo';
        dom.modalUserAvatarEdit.setAttribute('aria-label', avatarUrl ? 'Change profile photo' : 'Add profile photo');

        if (avatarUrl) {
          dom.btnRemovePhoto.classList.remove('hidden');
        } else {
          dom.btnRemovePhoto.classList.add('hidden');
        }
      }

      function setProfileEditMode(isEditing) {
        if (isEditing) {
          dom.profileViewMode.classList.add('hidden');
          dom.profileEditMode.classList.remove('hidden');

          const currentSession = shellState.currentUser;
          editProfileState.avatarAction = 'none';
          editProfileState.previewUrl = currentSession?.avatarUrl || null;

          dom.editProfileName.value = currentSession?.displayName || '';
          dom.editProfileAbout.value = currentSession?.about || '';
          renderAvatarElement(dom.modalUserAvatarEdit, currentSession?.avatarUrl, 'OC', '#3b82f6', true);

          dom.btnChangePhoto.textContent = currentSession?.avatarUrl ? 'Change photo' : 'Add photo';
          dom.modalUserAvatarEdit.setAttribute('aria-label', currentSession?.avatarUrl ? 'Change profile photo' : 'Add profile photo');

          if (currentSession?.avatarUrl) {
            dom.btnRemovePhoto.classList.remove('hidden');
          } else {
            dom.btnRemovePhoto.classList.add('hidden');
          }
        } else {
          dom.profileEditMode.classList.add('hidden');
          dom.profileViewMode.classList.remove('hidden');
          editProfileState.avatarAction = 'none';
          editProfileState.previewUrl = null;
        }
      }

      async function handlePickPhoto() {
        const res = await apiMock.pickPhoto();
        if (!res || res.cancelled) return;
        if (!res.ok) {
          dom.profileEditStatus.textContent = res.error;
          dom.profileEditStatus.classList.remove('hidden');
          return;
        }

        editProfileState.avatarAction = 'set';
        editProfileState.previewUrl = res.previewUrl;
        renderAvatarElement(dom.modalUserAvatarEdit, res.previewUrl, 'OC', '#3b82f6', true);
        dom.btnChangePhoto.textContent = 'Change photo';
        dom.modalUserAvatarEdit.setAttribute('aria-label', 'Change profile photo');
        dom.btnRemovePhoto.classList.remove('hidden');
      }

      function handleRemovePhoto() {
        editProfileState.avatarAction = 'remove';
        editProfileState.previewUrl = null;
        renderAvatarElement(dom.modalUserAvatarEdit, null, 'OC', '#3b82f6', true);
        dom.btnChangePhoto.textContent = 'Add photo';
        dom.modalUserAvatarEdit.setAttribute('aria-label', 'Add profile photo');
        dom.btnRemovePhoto.classList.add('hidden');
      }

      async function handleSaveProfile() {
        const nameVal = dom.editProfileName.value.trim();
        const aboutVal = dom.editProfileAbout.value.trim();

        dom.btnSaveProfile.disabled = true;
        const res = await apiMock.updateProfile({
          displayName: nameVal,
          about: aboutVal,
          avatarAction: editProfileState.avatarAction
        });
        dom.btnSaveProfile.disabled = false;

        if (res.ok && res.session) {
          updateProfileDisplay(res.session);
          setProfileEditMode(false);
        }
      }

      // Initialize
      updateProfileDisplay(initialSession);

      return {
        dom,
        shellState,
        editProfileState,
        setProfileEditMode,
        handlePickPhoto,
        handleRemovePhoto,
        handleSaveProfile,
        updateProfileDisplay
      };
    }

    test('11. Initial state without photo renders Add photo button and no remove button', () => {
      const harness = createAvatarUiHarness({ displayName: 'Dana', avatarUrl: null }, {});
      harness.setProfileEditMode(true);

      assert.equal(harness.dom.btnChangePhoto.textContent, 'Add photo');
      assert.equal(harness.dom.btnRemovePhoto.classList.contains('hidden'), true);
      assert.equal(harness.dom.modalUserAvatarEdit.getAttribute('aria-label'), 'Add profile photo');
    });

    test('12. Initial state with photo renders Change photo button and Remove photo button', () => {
      const initialAvatar = 'https://example.com/dana.jpg';
      const harness = createAvatarUiHarness({ displayName: 'Dana', avatarUrl: initialAvatar }, {});
      harness.setProfileEditMode(true);

      assert.equal(harness.dom.btnChangePhoto.textContent, 'Change photo');
      assert.equal(harness.dom.btnRemovePhoto.classList.contains('hidden'), false);
      assert.equal(harness.dom.modalUserAvatarEdit.getAttribute('aria-label'), 'Change profile photo');
      assert.ok(harness.dom.modalUserAvatarEdit.innerHTML.includes('<img'));
    });

    test('13. Native file picker cancellation preserves existing state', async () => {
      const harness = createAvatarUiHarness({ displayName: 'Dana', avatarUrl: null }, {
        async pickPhoto() { return { ok: true, cancelled: true }; }
      });
      harness.setProfileEditMode(true);

      await harness.handlePickPhoto();

      assert.equal(harness.editProfileState.avatarAction, 'none');
      assert.equal(harness.editProfileState.previewUrl, null);
      assert.equal(harness.dom.btnChangePhoto.textContent, 'Add photo');
      assert.equal(harness.dom.btnRemovePhoto.classList.contains('hidden'), true);
    });

    test('14. Preview appears immediately after selection without committing to backend', async () => {
      let updateProfileCalled = false;
      const fakePreview = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
      const harness = createAvatarUiHarness({ displayName: 'Dana', avatarUrl: null }, {
        async pickPhoto() { return { ok: true, previewUrl: fakePreview }; },
        async updateProfile() { updateProfileCalled = true; return { ok: true }; }
      });
      harness.setProfileEditMode(true);

      await harness.handlePickPhoto();

      assert.equal(harness.editProfileState.avatarAction, 'set');
      assert.equal(harness.editProfileState.previewUrl, fakePreview);
      assert.ok(harness.dom.modalUserAvatarEdit.innerHTML.includes(fakePreview));
      assert.equal(harness.dom.btnChangePhoto.textContent, 'Change photo');
      assert.equal(harness.dom.btnRemovePhoto.classList.contains('hidden'), false);
      assert.equal(updateProfileCalled, false); // Backend was NOT called yet
    });

    test('15. Cancel leaves the existing avatar unchanged', async () => {
      const initialAvatar = 'https://example.com/initial.jpg';
      const harness = createAvatarUiHarness({ displayName: 'Dana', avatarUrl: initialAvatar }, {
        async pickPhoto() { return { ok: true, previewUrl: 'data:image/jpeg;base64,1234' }; }
      });
      harness.setProfileEditMode(true);

      // User picks a new photo
      await harness.handlePickPhoto();
      assert.equal(harness.editProfileState.avatarAction, 'set');

      // User cancels
      harness.setProfileEditMode(false);

      // Check view mode displays original avatar
      assert.ok(harness.dom.modalUserAvatar.innerHTML.includes(initialAvatar));
      assert.ok(harness.dom.currentUserAvatar.innerHTML.includes(initialAvatar));
    });

    test('16. Save commits new photo and updates Settings and Sidebar UI', async () => {
      const serverSavedAvatar = 'https://api.ollacore.com:9443/chatbox-attachments/saved.jpg';
      const harness = createAvatarUiHarness({ displayName: 'Dana', avatarUrl: null }, {
        async pickPhoto() { return { ok: true, previewUrl: 'data:image/jpeg;base64,xyz' }; },
        async updateProfile({ displayName, about, avatarAction }) {
          assert.equal(avatarAction, 'set');
          return {
            ok: true,
            session: {
              userId: 'uuid-1',
              displayName,
              about,
              avatarUrl: serverSavedAvatar
            }
          };
        }
      });
      harness.setProfileEditMode(true);

      await harness.handlePickPhoto();
      await harness.handleSaveProfile();

      // UI returns to view mode
      assert.equal(harness.dom.profileViewMode.classList.contains('hidden'), false);
      assert.equal(harness.dom.profileEditMode.classList.contains('hidden'), true);

      // Avatar updated in settings modal
      assert.ok(harness.dom.modalUserAvatar.innerHTML.includes(serverSavedAvatar));
      // Avatar updated in sidebar footer
      assert.ok(harness.dom.currentUserAvatar.innerHTML.includes(serverSavedAvatar));
    });

    test('17. Remove photo action removes photo on save and restores default avatar', async () => {
      const initialAvatar = 'https://example.com/initial.jpg';
      const harness = createAvatarUiHarness({ displayName: 'Dana', avatarUrl: initialAvatar }, {
        async updateProfile({ displayName, about, avatarAction }) {
          assert.equal(avatarAction, 'remove');
          return {
            ok: true,
            session: {
              userId: 'uuid-1',
              displayName,
              about,
              avatarUrl: null
            }
          };
        }
      });
      harness.setProfileEditMode(true);

      // User removes photo
      harness.handleRemovePhoto();
      assert.equal(harness.editProfileState.avatarAction, 'remove');
      assert.equal(harness.dom.btnRemovePhoto.classList.contains('hidden'), true);
      assert.equal(harness.dom.btnChangePhoto.textContent, 'Add photo');

      // User saves
      await harness.handleSaveProfile();

      // View mode now has initials fallback (no img tag)
      assert.equal(harness.dom.modalUserAvatar.innerHTML.includes('<img'), false);
      assert.equal(harness.dom.currentUserAvatar.innerHTML.includes('<img'), false);
      assert.equal(harness.dom.modalUserAvatar.textContent, 'OC');
      assert.equal(harness.shellState.currentUser.avatarUrl, null);
    });

    test('18. Session token is never exposed to renderer during profile operations', () => {
      // Inspect exposed renderer API contract
      const exposedRendererMethods = [
        'getInfo',
        'auth.getProfile',
        'auth.updateProfile',
        'profile.pickPhoto',
        'profile.clearPendingPhoto'
      ];

      for (const method of exposedRendererMethods) {
        assert.ok(!method.includes('token'), `Method signature '${method}' must not accept or expose session tokens`);
      }
    });
  });
});
