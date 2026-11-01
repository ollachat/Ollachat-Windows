/**
 * Safe LocalStorage -> SQLite Migration Manager (Phase 4B).
 *
 * Collects legacy localStorage state for the authenticated user,
 * transactionally migrates it into the user's isolated SQLite database,
 * verifies persistence, and marks migration version in app_metadata.
 * Preserves existing localStorage stores without premature deletion.
 */

/**
 * Collects legacy localStorage entries for a specific user ID.
 * @param {string} userKey
 * @returns {object}
 */
export function collectLocalStorageMigrationData(userKey) {
  if (typeof localStorage === 'undefined' || !userKey) {
    return {};
  }

  const safeParse = (key, fallback = null) => {
    try {
      const val = localStorage.getItem(key);
      if (!val) return fallback;
      return JSON.parse(val);
    } catch {
      return fallback;
    }
  };

  const pinnedRoomIds = safeParse(`ollachat_pinned_chats_${userKey}`, []);
  const favouriteRoomIds = safeParse(`ollachat_favourite_chats_${userKey}`, []);
  const archivedRoomIds = safeParse(`ollachat_archived_chats_${userKey}`, []);
  const markedUnreadRoomIds = safeParse(`ollachat_marked_unread_${userKey}`, []);
  const customLists = safeParse(`ollachat_custom_lists_${userKey}`, []);
  const callHistory = safeParse(`ollachat_call_history_${userKey}`, []);
  const contactNicknames = safeParse(`ollachat_contact_nicknames_${userKey}`, {});
  const pinnedMessages = safeParse(`ollachat_pinned_messages_${userKey}`, {});
  const unreadEdits = safeParse(`ollachat_unread_edits_${userKey}`, {});
  const deletedForMeMessageIds = safeParse(`ollachat_deleted_for_me_${userKey}`, []);
  const starredMessageIds = safeParse(`ollachat_starred_${userKey}`, []);

  return {
    pinnedRoomIds: Array.isArray(pinnedRoomIds) ? pinnedRoomIds : [],
    favouriteRoomIds: Array.isArray(favouriteRoomIds) ? favouriteRoomIds : [],
    archivedRoomIds: Array.isArray(archivedRoomIds) ? archivedRoomIds : [],
    markedUnreadRoomIds: Array.isArray(markedUnreadRoomIds) ? markedUnreadRoomIds : [],
    customLists: Array.isArray(customLists) ? customLists : [],
    callHistory: Array.isArray(callHistory) ? callHistory : [],
    contactNicknames: (contactNicknames && typeof contactNicknames === 'object') ? contactNicknames : {},
    pinnedMessages: (pinnedMessages && typeof pinnedMessages === 'object') ? pinnedMessages : {},
    unreadEdits: (unreadEdits && typeof unreadEdits === 'object') ? unreadEdits : {},
    deletedForMeMessageIds: Array.isArray(deletedForMeMessageIds) ? deletedForMeMessageIds : [],
    starredMessageIds: Array.isArray(starredMessageIds) ? starredMessageIds : []
  };
}

/**
 * Runs the idempotent Phase 4B migration for the authenticated user.
 * @param {string} userKey
 * @param {object} [dbBridge=window.ollacoreDesktop?.db]
 * @returns {Promise<{ ok: boolean, alreadyMigrated?: boolean, migrated?: boolean, error?: string }>}
 */
export async function runLocalStorageMigration(userKey, dbBridge = null) {
  const db = dbBridge || (typeof window !== 'undefined' ? window.ollacoreDesktop?.db : null);
  if (!db || !userKey) {
    return { ok: false, error: 'Database bridge or user key unavailable' };
  }

  try {
    // 1. Check if SQLite already records migration version >= 1
    if (typeof db.getMetadata === 'function') {
      try {
        const verMeta = await db.getMetadata({ key: 'localstorage_migration_version' });
        const existingVer = verMeta?.value ? parseInt(verMeta.value, 10) : 0;
        if (existingVer >= 1) {
          return { ok: true, alreadyMigrated: true, version: existingVer };
        }
      } catch (metaErr) {
        // Continue if getMetadata fails on empty table
        console.warn('[Migrator] Could not check existing version from app_metadata:', metaErr);
      }
    }

    // 2. Collect localStorage snapshot
    const data = collectLocalStorageMigrationData(userKey);

    // 3. Delegate transactional write to DatabaseService
    if (typeof db.migrateLocalStorage !== 'function') {
      return { ok: false, error: 'migrateLocalStorage API not available on db bridge' };
    }

    const res = await db.migrateLocalStorage({ version: 1, data });
    if (!res || !res.ok) {
      throw new Error(res?.error?.message || 'migrateLocalStorage returned unsuccessful status');
    }

    // 4. Record local marker for client-side auditing without deleting original data
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(`ollachat_migrated_v1_${userKey}`, new Date().toISOString());
      } catch (_) {}
    }

    return {
      ok: true,
      migrated: true,
      version: 1,
      counts: res.counts
    };
  } catch (err) {
    console.error('[Migrator] Safe LocalStorage -> SQLite migration failed:', err);
    return {
      ok: false,
      error: err.message || 'Unknown migration error'
    };
  }
}

/**
 * Hydrates state models from SQLite for features migrated from localStorage.
 * @param {object} shellState
 * @param {object} [dbBridge=null]
 */
export async function hydrateMigratedStateFromDb(shellState, dbBridge = null) {
  const db = dbBridge || (typeof window !== 'undefined' ? window.ollacoreDesktop?.db : null);
  if (!db || !shellState) return;

  try {
    // 1. Custom lists from SQLite
    if (typeof db.getCustomLists === 'function') {
      const dbLists = await db.getCustomLists();
      if (Array.isArray(dbLists) && dbLists.length > 0) {
        shellState.customLists = dbLists;
      }
    }

    // 2. Metadata: contact nicknames
    if (typeof db.getMetadata === 'function') {
      const nicknamesMeta = await db.getMetadata({ key: 'contact_nicknames' });
      if (nicknamesMeta?.value) {
        try {
          const parsed = JSON.parse(nicknamesMeta.value);
          if (parsed && typeof parsed === 'object') {
            shellState.contactNicknames = new Map(Object.entries(parsed));
          }
        } catch (_) {}
      }

      // 3. Metadata: pinned messages
      const pinnedMsgsMeta = await db.getMetadata({ key: 'pinned_messages' });
      if (pinnedMsgsMeta?.value) {
        try {
          const parsed = JSON.parse(pinnedMsgsMeta.value);
          if (parsed && typeof parsed === 'object') {
            shellState.pinnedMessages = new Map(Object.entries(parsed));
          }
        } catch (_) {}
      }

      // 4. Metadata: unread edits
      const unreadEditsMeta = await db.getMetadata({ key: 'unread_edits' });
      if (unreadEditsMeta?.value) {
        try {
          const parsed = JSON.parse(unreadEditsMeta.value);
          if (parsed && typeof parsed === 'object') {
            for (const [rId, msgIds] of Object.entries(parsed)) {
              if (Array.isArray(msgIds) && msgIds.length > 0) {
                if (!shellState._unreadEditedMessages) shellState._unreadEditedMessages = new Map();
                shellState._unreadEditedMessages.set(String(rId), new Set(msgIds.map(String)));
              }
            }
          }
        } catch (_) {}
      }
    }
  } catch (err) {
    console.warn('[Migrator] Hydration from SQLite encountered an issue:', err);
  }
}
