/**
 * Safe Pending Intent Manager for OllaChat Windows
 * Handles holding a single validated startup intent until the renderer
 * is fully ready and authenticated, ensuring cold-start intents are never dropped.
 */
export class PendingIntentManager {
  constructor() {
    this._pendingIntent = null;
  }

  /**
   * Sets the pending intent.
   * @param {object} intent
   */
  setIntent(intent) {
    if (!intent || typeof intent !== 'object' || !intent.action) return;
    this._pendingIntent = intent;
  }

  /**
   * Retrieves and clears the pending intent (dispatched exactly once).
   * @returns {object|null}
   */
  getAndClear() {
    const intent = this._pendingIntent;
    this._pendingIntent = null;
    return intent;
  }

  /**
   * Checks if an intent is pending.
   * @returns {boolean}
   */
  hasPending() {
    return this._pendingIntent !== null;
  }

  /**
   * Inspects pending intent without clearing.
   * @returns {object|null}
   */
  peek() {
    return this._pendingIntent;
  }

  /**
   * Clears pending intent without returning.
   */
  clear() {
    this._pendingIntent = null;
  }
}
