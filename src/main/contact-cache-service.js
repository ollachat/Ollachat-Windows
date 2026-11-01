import { normalizePhone } from '../storage/db/database-service.js';

export const CONTACT_TTL = {
  FRESH_MS: 24 * 60 * 60 * 1000,          // 24 hours fresh TTL
  STALE_MAX_MS: 7 * 24 * 60 * 60 * 1000,  // 7 days stale-while-revalidate boundary
  NEGATIVE_MS: 15 * 60 * 1000,            // 15 minutes negative-cache TTL
  MAX_AGE_MS: 30 * 24 * 60 * 60 * 1000    // 30 days maximum cache age
};

/**
 * Normalizes an individual contact record ensuring both camelCase and snake_case
 * fields and canonical boolean registration flags are present.
 * @param {object} c
 * @returns {object}
 */
export function normalizeContactRecord(c) {
  if (!c || typeof c !== 'object') return null;
  const uid = (c.userId ?? c.user_id) ? String(c.userId ?? c.user_id).trim() : '';
  const phone = normalizePhone(c.phone || c.cleaned || '');
  const dispName = (c.displayName !== undefined ? c.displayName : (c.display_name !== undefined ? c.display_name : null));
  const isReg = (c.isRegistered !== undefined || c.is_registered !== undefined)
    ? Boolean(c.isRegistered || c.is_registered)
    : Boolean(uid);

  return {
    userId: uid,
    user_id: uid,
    phone,
    displayName: dispName,
    display_name: dispName,
    isRegistered: isReg,
    is_registered: isReg
  };
}

/**
 * Checks if an error is an offline or transient network failure.
 * @param {any} err
 * @returns {boolean}
 */
export function isNetworkOrOfflineError(err) {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  const code = (err.code || '').toLowerCase();
  const status = err.httpStatus || err.status;

  if (status === 502 || status === 503 || status === 504) return true;
  if (
    code.includes('offline') ||
    code.includes('econnrefused') ||
    code.includes('econnreset') ||
    code.includes('etimedout') ||
    code.includes('enotfound') ||
    code.includes('enetunreach') ||
    msg.includes('network') ||
    msg.includes('offline') ||
    msg.includes('fetch failed') ||
    msg.includes('timed out') ||
    msg.includes('econnrefused')
  ) {
    return true;
  }
  return false;
}

/**
 * ContactCacheService coordinates cached-first contact lookups,
 * background revalidation, negative caching, and offline fallback resolution.
 */
export class ContactCacheService {
  /**
   * @param {object} params
   * @param {import('../storage/db/database-service.js').DatabaseService} params.databaseService
   * @param {import('../api/chat-api.js').ChatApi} params.chatApi
   * @param {import('../storage/session-store.js').SessionStore} [params.sessionStore]
   * @param {(updatedContact: object) => void} [params.onContactUpdated]
   */
  constructor({ databaseService, chatApi, sessionStore, onContactUpdated } = {}) {
    if (!databaseService) {
      throw new Error('ContactCacheService requires a valid databaseService');
    }
    this.databaseService = databaseService;
    this.chatApi = chatApi;
    this.sessionStore = sessionStore || null;
    this.onContactUpdated = onContactUpdated || null;

    /**
     * Map of canonical normalized phone -> in-flight lookup Promise
     * Prevents duplicate concurrent network requests for the same number.
     * @type {Map<string, Promise<object|null>>}
     */
    this._inFlightLookups = new Map();
  }

  /**
   * Performs cached-first contact lookup for an array of phone numbers.
   *
   * 1. Normalizes and deduplicates input phones.
   * 2. Checks local SQLite contact_cache table.
   * 3. Partitions into fresh, stale, and misses.
   * 4. For stale entries: returns cached value immediately, queues silent background refresh.
   * 5. For misses (and expired records): queries OllaCore, writes positive and negative records to SQLite.
   * 6. If network fails or device is offline: resolves from local cache / conversation peer fallbacks.
   *
   * @param {string[]|string} phones
   * @param {object} [options]
   * @param {string} [options.sessionToken] Optional session token override
   * @param {boolean} [options.forceRefresh=false] If true, bypasses fresh cache and re-queries network
   * @returns {Promise<{ contacts: Array<object> }>}
   */
  async lookupContacts(phones = [], options = {}) {
    const list = Array.isArray(phones) ? phones : [phones];
    const uniquePhones = [...new Set(list.map((p) => normalizePhone(p)).filter(Boolean))];

    if (uniquePhones.length === 0) {
      return { contacts: [] };
    }

    const sessionToken = options.sessionToken || this._getSessionToken();
    const now = Date.now();
    const freshResults = [];
    const stalePhonesToRefresh = [];
    const phonesToFetch = [];
    const expiredCacheFallbackMap = new Map();

    // 1. Check local SQLite cache
    let cachedList = [];
    try {
      cachedList = await this.databaseService.getCachedContacts(uniquePhones);
    } catch (err) {
      console.warn('[ContactCacheService] Error reading cached contacts:', err.message);
    }

    const cachedMap = new Map(cachedList.map((c) => [c.phone, c]));

    // 2. Classify each requested phone number
    for (const phone of uniquePhones) {
      const cached = cachedMap.get(phone);

      if (options.forceRefresh) {
        if (cached) expiredCacheFallbackMap.set(phone, cached);
        phonesToFetch.push(phone);
        continue;
      }

      if (!cached) {
        phonesToFetch.push(phone);
        continue;
      }

      const updatedAtMs = new Date(cached.updatedAt || cached.updated_at || 0).getTime();
      const ageMs = now - updatedAtMs;

      if (cached.isRegistered) {
        if (ageMs <= CONTACT_TTL.FRESH_MS) {
          // Fresh positive cache hit
          freshResults.push(normalizeContactRecord(cached));
        } else if (ageMs <= CONTACT_TTL.STALE_MAX_MS) {
          // Stale positive cache hit: usable immediately, revalidate in background
          freshResults.push(normalizeContactRecord(cached));
          stalePhonesToRefresh.push(phone);
        } else {
          // Expired positive cache (> 7 days): re-fetch if online, keep as fallback if offline
          expiredCacheFallbackMap.set(phone, cached);
          phonesToFetch.push(phone);
        }
      } else {
        // Negative cache entry (unregistered number)
        if (ageMs <= CONTACT_TTL.NEGATIVE_MS) {
          // Fresh negative cache hit: still unregistered
          freshResults.push(normalizeContactRecord(cached));
        } else {
          // Expired negative cache (> 15 mins): re-check with OllaCore
          expiredCacheFallbackMap.set(phone, cached);
          phonesToFetch.push(phone);
        }
      }
    }

    // 3. Queue asynchronous background refresh for stale positive hits
    if (stalePhonesToRefresh.length > 0 && sessionToken) {
      this._scheduleBackgroundRefresh(stalePhonesToRefresh, sessionToken);
    }

    // 4. If all requested phones were satisfied by local cache, return immediately
    if (phonesToFetch.length === 0) {
      return { contacts: freshResults };
    }

    // 5. Query network for missing/expired phones
    let fetchedResults = [];
    let networkError = null;

    try {
      if (!sessionToken && !this.chatApi) {
        const err = new Error('No session token available');
        err.code = 'UNAUTHORIZED';
        err.httpStatus = 401;
        throw err;
      }

      fetchedResults = await this._fetchFromOllaCore(phonesToFetch, sessionToken);
    } catch (err) {
      networkError = err;
    }

    // 6. Handle network success
    if (!networkError) {
      return {
        contacts: [...freshResults, ...fetchedResults]
      };
    }

    // 7. Handle network failure (Offline resilience & fallbacks)
    if (networkError.httpStatus === 401 || networkError.code === 'unauthorized' || networkError.code === 'UNAUTHORIZED') {
      // Re-throw authentication errors directly so UI can handle session logout
      throw networkError;
    }

    const offlineResults = [];
    const missingPhonesAfterFallback = [];

    for (const phone of phonesToFetch) {
      // A. Check expired cache
      if (expiredCacheFallbackMap.has(phone)) {
        const fallback = expiredCacheFallbackMap.get(phone);
        offlineResults.push(normalizeContactRecord(fallback));
        continue;
      }

      // B. Check conversations peer fallback
      let convFallback = null;
      try {
        const convList = await this.databaseService.getContactFallbackFromConversations([phone]);
        if (convList.length > 0) {
          convFallback = convList[0];
          // Save peer fallback into contact cache for future fast resolution
          await this.databaseService.saveCachedContacts([convFallback]).catch(() => {});
        }
      } catch (_) {}

      if (convFallback) {
        offlineResults.push(normalizeContactRecord(convFallback));
      } else {
        missingPhonesAfterFallback.push(phone);
      }
    }

    // If some or all could be resolved locally offline:
    if (freshResults.length > 0 || offlineResults.length > 0) {
      return {
        contacts: [...freshResults, ...offlineResults]
      };
    }

    // If completely unknown locally and network failed:
    if (isNetworkOrOfflineError(networkError) || missingPhonesAfterFallback.length > 0) {
      const offlineErr = new Error('Device is offline and contact not found in local cache.');
      offlineErr.code = 'OFFLINE_CACHE_MISS';
      offlineErr.httpStatus = 503;
      offlineErr.originalError = networkError;
      throw offlineErr;
    }

    throw networkError;
  }

  /**
   * Fetches missing contacts from OllaCore with deduplication of in-flight requests.
   * Persists both positive matches and negative results into SQLite contact_cache.
   * @param {string[]} phones
   * @param {string} sessionToken
   * @returns {Promise<Array<object>>}
   */
  async _fetchFromOllaCore(phones, sessionToken) {
    if (!this.chatApi) {
      throw new Error('ContactCacheService: chatApi client is not configured.');
    }

    // Separate phones that are already in-flight from ones that need a new request
    const inFlightPromises = [];
    const phonesToRequest = [];

    for (const phone of phones) {
      if (this._inFlightLookups.has(phone)) {
        inFlightPromises.push(this._inFlightLookups.get(phone));
      } else {
        phonesToRequest.push(phone);
      }
    }

    let batchPromise = null;
    if (phonesToRequest.length > 0) {
      batchPromise = (async () => {
        try {
          const apiRes = await this.chatApi.lookupContacts(sessionToken, phonesToRequest);
          const rawContacts = Array.isArray(apiRes?.contacts) ? apiRes.contacts : [];

          const returnedByPhone = new Map();
          for (const c of rawContacts) {
            const normP = normalizePhone(c.phone);
            if (normP) {
              returnedByPhone.set(normP, c);
            }
          }

          const recordsToPersist = [];
          const outputContacts = [];
          const nowIso = new Date().toISOString();

          for (const phone of phonesToRequest) {
            const matched = returnedByPhone.get(phone);
            if (matched && (matched.userId || matched.user_id)) {
              // Positive match: registered user
              const norm = normalizeContactRecord(matched);
              recordsToPersist.push({
                phone,
                userId: norm.userId,
                displayName: norm.displayName,
                isRegistered: 1,
                cachedAt: nowIso,
                updatedAt: nowIso
              });
              outputContacts.push(norm);
            } else {
              // Negative match: unregistered phone
              const negativeRecord = {
                phone,
                userId: '',
                displayName: null,
                isRegistered: 0,
                cachedAt: nowIso,
                updatedAt: nowIso
              };
              recordsToPersist.push(negativeRecord);
              outputContacts.push(normalizeContactRecord(negativeRecord));
            }
          }

          // Persist batch into SQLite
          await this.databaseService.saveCachedContacts(recordsToPersist).catch((dbErr) => {
            console.warn('[ContactCacheService] Error saving cached contacts:', dbErr.message);
          });

          return outputContacts;
        } finally {
          for (const phone of phonesToRequest) {
            this._inFlightLookups.delete(phone);
          }
        }
      })();

      const safeLookupPromise = batchPromise.catch(() => null);
      for (const phone of phonesToRequest) {
        this._inFlightLookups.set(
          phone,
          safeLookupPromise.then((results) => (Array.isArray(results) ? results.find((c) => c.phone === phone) || null : null))
        );
      }
    }

    const [batchResults, ...awaitedInFlights] = await Promise.all([
      batchPromise ? batchPromise : Promise.resolve([]),
      ...inFlightPromises
    ]);

    const combined = [...batchResults];
    for (const item of awaitedInFlights) {
      if (item) combined.push(item);
    }

    return combined;
  }

  /**
   * Silent, non-blocking background revalidation of stale contacts.
   * If a contact's display_name has changed on OllaCore, updates SQLite,
   * reconciles conversation peer_display_name, and triggers onContactUpdated.
   * @param {string[]} phones
   * @param {string} sessionToken
   * @returns {Promise<void>}
   */
  async refreshContactsInBackground(phones, sessionToken) {
    if (!phones || phones.length === 0 || !sessionToken || !this.chatApi) return;
    const uniquePhones = [...new Set(phones.map((p) => normalizePhone(p)).filter(Boolean))];
    if (uniquePhones.length === 0) return;

    try {
      const apiRes = await this.chatApi.lookupContacts(sessionToken, uniquePhones);
      const rawContacts = Array.isArray(apiRes?.contacts) ? apiRes.contacts : [];
      const returnedByPhone = new Map(
        rawContacts.map((c) => [normalizePhone(c.phone), c]).filter(([p]) => Boolean(p))
      );

      const existingCached = await this.databaseService.getCachedContacts(uniquePhones);
      const existingMap = new Map(existingCached.map((c) => [c.phone, c]));
      const recordsToUpdate = [];
      const nowIso = new Date().toISOString();

      for (const phone of uniquePhones) {
        const matched = returnedByPhone.get(phone);
        const existing = existingMap.get(phone);

        if (matched && (matched.userId || matched.user_id)) {
          const norm = normalizeContactRecord(matched);
          const nameChanged = !existing || (norm.displayName && existing.displayName !== norm.displayName);

          recordsToUpdate.push({
            phone,
            userId: norm.userId,
            displayName: norm.displayName,
            isRegistered: 1,
            cachedAt: existing?.cachedAt || nowIso,
            updatedAt: nowIso
          });

          if (nameChanged && norm.userId) {
            // Reconcile conversation display name while preserving user nicknames
            await this.databaseService.reconcileConversationPeerDisplayName(norm.userId, norm.displayName).catch(() => {});
            this.onContactUpdated?.(norm);
          }
        } else {
          // Changed to unregistered
          recordsToUpdate.push({
            phone,
            userId: '',
            displayName: null,
            isRegistered: 0,
            cachedAt: existing?.cachedAt || nowIso,
            updatedAt: nowIso
          });
        }
      }

      if (recordsToUpdate.length > 0) {
        await this.databaseService.saveCachedContacts(recordsToUpdate).catch(() => {});
      }
    } catch (err) {
      // Background revalidation failures are strictly non-fatal and silent
      console.warn('[ContactCacheService] Background refresh failed:', err.message);
    }
  }

  _scheduleBackgroundRefresh(phones, sessionToken) {
    Promise.resolve().then(async () => {
      try {
        await this.refreshContactsInBackground(phones, sessionToken);
      } catch (err) {
        console.warn('[ContactCacheService] Scheduled background refresh caught:', err.message);
      }
    });
  }

  /**
   * Prunes unused contact cache records older than maxAgeMs.
   * @param {number} [maxAgeMs=CONTACT_TTL.MAX_AGE_MS]
   * @returns {Promise<{ ok: boolean, deleted: number }>}
   */
  async pruneOldCache(maxAgeMs = CONTACT_TTL.MAX_AGE_MS) {
    try {
      return await this.databaseService.pruneStaleContactCache(maxAgeMs);
    } catch (err) {
      console.warn('[ContactCacheService] pruneOldCache warning:', err.message);
      return { ok: false, deleted: 0 };
    }
  }

  _getSessionToken() {
    return this.sessionStore?.getSession?.()?.sessionToken || this.sessionStore?.currentSession?.sessionToken || null;
  }
}
