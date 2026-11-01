/**
 * Emoji Picker & Text Insertion Engine for OllaChat Windows Desktop.
 * Self-contained, zero-dependency, and accessible.
 */

import { EMOJI_CATEGORIES, EMOJI_LIST } from './emoji-data.js';

/**
 * Inserts text/emoji into an input or textarea element at the current cursor position.
 * Preserves existing text, advances cursor directly after the inserted content,
 * and dispatches a bubbling 'input' event for auto-resize & button state updates.
 *
 * @param {HTMLInputElement|HTMLTextAreaElement} inputElement
 * @param {string} textToInsert
 * @returns {string} The updated input value
 */
export function insertTextAtCursor(inputElement, textToInsert) {
  if (!inputElement || typeof textToInsert !== 'string') {
    return inputElement?.value || '';
  }

  const value = inputElement.value ?? '';
  let start = inputElement.selectionStart;
  let end = inputElement.selectionEnd;

  // Fallback to end of text if cursor position is invalid or element not focused
  if (typeof start !== 'number' || typeof end !== 'number' || isNaN(start) || isNaN(end)) {
    start = value.length;
    end = value.length;
  }

  const before = value.slice(0, start);
  const after = value.slice(end);
  const newValue = before + textToInsert + after;

  inputElement.value = newValue;

  const newCursorPos = start + textToInsert.length;
  if (typeof inputElement.setSelectionRange === 'function') {
    try {
      inputElement.setSelectionRange(newCursorPos, newCursorPos);
    } catch {
      // Ignored in headless/test environments
    }
  }

  // Trigger input event so composer auto-resize, draft state, and send button update
  if (typeof inputElement.dispatchEvent === 'function') {
    try {
      const event = new Event('input', { bubbles: true, cancelable: true });
      inputElement.dispatchEvent(event);
    } catch {
      // Fallback for custom mock environments
    }
  }

  return newValue;
}

/**
 * Tests whether a string is composed entirely of emoji characters (plus optional whitespace).
 * Correctly accounts for multi-codepoint sequences (ZWJ, skin tone modifiers, variation selectors).
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isEmojiOnly(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Extended Pictographic, ZWJ (\u200D), Variation Selectors (\uFE0E, \uFE0F),
  // Fitzpatrick Skin Tone Modifiers (\u{1F3FB}-\u{1F3FF}), Regional Indicator Symbols (\u{1F1E6}-\u{1F1FF}),
  // and Combining Enclosing Keycaps (\u20E3)
  const emojiOnlyPattern = /^[\s\p{Extended_Pictographic}\u200D\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}*#0-9\u20E3]+$/u;
  if (!emojiOnlyPattern.test(trimmed)) {
    return false;
  }

  // Must contain at least one true pictographic emoji character
  return /\p{Extended_Pictographic}/u.test(trimmed);
}

/**
 * Filters the offline emoji list by query and/or category.
 *
 * @param {string} [query='']
 * @param {string} [category='all']
 * @returns {Array<{ char: string, name: string, category: string }>}
 */
export function filterEmojis(query = '', category = 'all') {
  const q = (query || '').toLowerCase().trim();
  return EMOJI_LIST.filter((item) => {
    const matchesCategory = category === 'all' || item.category === category;
    if (!matchesCategory) return false;
    if (!q) return true;
    return item.name.toLowerCase().includes(q) || item.char === q;
  });
}

/**
 * Controller class managing the emoji picker popover, category tabs,
 * search filtering, keyboard accessibility, and composer integration.
 */
export class EmojiPicker {
  /**
   * @param {object} options
   * @param {HTMLElement} options.triggerBtn
   * @param {HTMLElement} options.popover
   * @param {HTMLTextAreaElement|HTMLInputElement} options.input
   * @param {HTMLInputElement} [options.searchInput]
   * @param {HTMLElement} [options.grid]
   * @param {HTMLElement} [options.categoriesContainer]
   * @param {HTMLElement} [options.previewChar]
   * @param {HTMLElement} [options.previewName]
   * @param {HTMLElement} [options.closeBtn]
   * @param {Function} [options.onSelect]
   */
  constructor(options = {}) {
    this.triggerBtn = options.triggerBtn;
    this.popover = options.popover;
    this.input = options.input;
    this.searchInput = options.searchInput;
    this.grid = options.grid;
    this.categoriesContainer = options.categoriesContainer;
    this.previewChar = options.previewChar;
    this.previewName = options.previewName;
    this.closeBtn = options.closeBtn;
    this.onSelect = options.onSelect;
    this.doc = options.document || (typeof document !== 'undefined' ? document : null);

    this.activeCategory = 'smileys';
    this.searchQuery = '';
    this._isOpen = false;

    this._onDocumentClick = this._handleDocumentClick.bind(this);
    this._onDocumentKeyDown = this._handleDocumentKeyDown.bind(this);

    this.init();
  }

  init() {
    if (!this.popover) return;

    // Attach trigger button handler
    if (this.triggerBtn) {
      this.triggerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggle();
      });
    }

    // Attach close button handler
    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.close();
      });
    }

    // Attach search input handler
    if (this.searchInput) {
      this.searchInput.addEventListener('input', () => {
        this.searchQuery = this.searchInput.value.trim();
        this.render();
      });

      this.searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          this.close();
        }
      });
    }

    // Attach category tabs handler
    if (this.categoriesContainer) {
      this.categoriesContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.emoji-cat-btn');
        if (!btn) return;
        const cat = btn.getAttribute('data-category');
        if (cat) {
          this.activeCategory = cat;
          this.updateCategoryTabs();
          this.render();
        }
      });
    }

    // Prevent clicks inside popover from propagating to document
    this.popover.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    // Initial render of emoji list
    this.render();
  }

  isOpen() {
    return this._isOpen;
  }

  open() {
    if (this._isOpen || !this.popover) return;
    this._isOpen = true;
    this.popover.classList.remove('hidden');

    if (this.triggerBtn) {
      this.triggerBtn.setAttribute('aria-expanded', 'true');
      this.triggerBtn.classList.add('active');
    }

    // Focus search input or composer smoothly
    if (this.searchInput) {
      this.searchInput.value = '';
      this.searchQuery = '';
      this.updateCategoryTabs();
      this.render();
      setTimeout(() => this.searchInput.focus(), 50);
    }

    this.doc?.addEventListener('click', this._onDocumentClick);
    this.doc?.addEventListener('keydown', this._onDocumentKeyDown);
  }

  close() {
    if (!this._isOpen || !this.popover) return;
    this._isOpen = false;
    this.popover.classList.add('hidden');

    if (this.triggerBtn) {
      this.triggerBtn.setAttribute('aria-expanded', 'false');
      this.triggerBtn.classList.remove('active');
    }

    this.doc?.removeEventListener('click', this._onDocumentClick);
    this.doc?.removeEventListener('keydown', this._onDocumentKeyDown);
  }

  toggle() {
    if (this._isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  updateCategoryTabs() {
    if (!this.categoriesContainer) return;
    const btns = this.categoriesContainer.querySelectorAll('.emoji-cat-btn');
    btns.forEach((btn) => {
      const cat = btn.getAttribute('data-category');
      const isActive = cat === this.activeCategory && !this.searchQuery;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  updatePreview(char, name) {
    if (this.previewChar) this.previewChar.textContent = char || '😊';
    if (this.previewName) this.previewName.textContent = name || 'Smiling face with smiling eyes';
  }

  render() {
    if (!this.grid) return;
    this.grid.innerHTML = '';

    const categoryToFilter = this.searchQuery ? 'all' : this.activeCategory;
    const items = filterEmojis(this.searchQuery, categoryToFilter);

    if (items.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'emoji-picker-empty';
      emptyEl.textContent = 'No matching emojis found';
      this.grid.appendChild(emptyEl);
      return;
    }

    const fragment = document.createDocumentFragment();
    items.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-item';
      btn.setAttribute('data-emoji', item.char);
      btn.setAttribute('title', item.name);
      btn.setAttribute('aria-label', item.name);
      btn.textContent = item.char;

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.selectEmoji(item.char);
      });

      btn.addEventListener('mouseenter', () => {
        this.updatePreview(item.char, item.name);
      });

      btn.addEventListener('focus', () => {
        this.updatePreview(item.char, item.name);
      });

      fragment.appendChild(btn);
    });

    this.grid.appendChild(fragment);
  }

  selectEmoji(emojiChar) {
    if (!emojiChar) return;

    if (this.input) {
      insertTextAtCursor(this.input, emojiChar);
      // Retain focus on composer so the user can continue typing immediately
      try {
        this.input.focus();
      } catch {
        // Ignored in test environment
      }
    }

    if (typeof this.onSelect === 'function') {
      this.onSelect(emojiChar);
    }
  }

  _handleDocumentClick(e) {
    if (!this._isOpen) return;

    const clickedInsidePopover = this.popover && this.popover.contains(e.target);
    const clickedTrigger = this.triggerBtn && this.triggerBtn.contains(e.target);

    if (!clickedInsidePopover && !clickedTrigger) {
      this.close();
    }
  }

  _handleDocumentKeyDown(e) {
    if (!this._isOpen) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      if (this.input) {
        try {
          this.input.focus();
        } catch {
          // Ignored
        }
      }
    }
  }

  destroy() {
    this.close();
    this.doc?.removeEventListener('click', this._onDocumentClick);
    this.doc?.removeEventListener('keydown', this._onDocumentKeyDown);
  }
}
