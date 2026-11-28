import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalKey, normalizeFilePath } from './security.mjs';

export const DOC_CODE_SEED_EXTS = Object.freeze([
  'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'tsx', 'jsx', 'vue', 'svelte',
  'html', 'htm', 'css', 'scss', 'less', 'xml', 'toml', 'ini', 'conf', 'jsonc',
  'py', 'sh', 'bash', 'ps1', 'bat', 'cmd', 'sql', 'log',
]);

export const DEFAULT_CATEGORY_RULES = Object.freeze([
  Object.freeze({
    id: 'image',
    label: '图片',
    extensions: Object.freeze(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'avif', 'ico']),
  }),
  Object.freeze({
    id: 'video',
    label: '视频',
    extensions: Object.freeze([
      'mp4', 'm4v', 'mov', 'qt', 'mkv', 'webm', 'avi', 'flv', 'f4v', 'wmv', 'asf',
      'mts', 'm2ts', 'mpg', 'mpeg', 'ogv', '3gp', 'rmvb', 'vob', 'mxf',
    ]),
  }),
  Object.freeze({
    id: 'doc',
    label: '文档',
    extensions: Object.freeze([
      'md', 'mdx', 'txt', 'pdf', 'docx', 'docm', 'dotx', 'doc', 'xlsx', 'xlsm', 'xltx', 'xls',
      'pptx', 'ppsx', 'potx', 'ppt', 'odt', 'ods', 'odp', 'rtf', 'epub', 'eml', 'ipynb',
      'sqlite', 'sqlite3', 'db', 'srt', 'ass', 'ssa', 'vtt', 'lrc', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'csv', 'tsv',
      'js', 'mjs', 'cjs', 'ts', 'cts', 'tsx', 'jsx', 'vue', 'svelte',
      'html', 'htm', 'css', 'scss', 'less', 'xml', 'toml', 'ini', 'conf', 'jsonc',
      'py', 'sh', 'bash', 'ps1', 'bat', 'cmd', 'sql', 'log',
    ]),
  }),
]);

export const NON_SOUNDWAVE_THEMES = Object.freeze(['auto', 'obsidian', 'warm', 'crystal', 'alabaster']);

export const DEFAULT_WHEEL_SOUNDWAVE_BY_THEME = Object.freeze({
  auto: false,
  obsidian: false,
  warm: false,
  crystal: false,
  alabaster: false,
});

export function sanitizeWheelSoundwaveByTheme(raw, base = DEFAULT_WHEEL_SOUNDWAVE_BY_THEME) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const fallback = base && typeof base === 'object' && !Array.isArray(base) ? base : DEFAULT_WHEEL_SOUNDWAVE_BY_THEME;
  const out = {};
  for (const key of NON_SOUNDWAVE_THEMES) {
    if (typeof src[key] === 'boolean') out[key] = src[key];
    else if (typeof fallback[key] === 'boolean') out[key] = fallback[key];
    else out[key] = false;
  }
  return out;
}

export const DEFAULT_MAIN_CHAT_LAYOUT_SLOTS = Object.freeze({
  top_left: 'collapse_left',
  mid_left: 'expand_right',
  bottom_left: 'toggle_overview',
  top_right: 'expand_left',
  bottom_right: 'collapse_right',
});

export const DEFAULT_SETTINGS = Object.freeze({
  maxChildrenPerGroup: 6,
  autoAnchorSummaryMd: true,
  wheelTrigger: 'middle_or_badge', // legacy compat: synced with middleMode when needed
  wheelHotkey: 'Alt+Q',
  wheelSectors: 8,
  middleMode: 'bilateral_wheel', // 'bilateral_wheel' | 'classic_wheel' | 'off'
  wheelTriggerButton: 'middle', // 'middle' | 'right' | 'side_back' | 'side_forward' | 'left'
  wheelTriggerModifier: 'none', // 'none' | 'alt' | 'shift' | 'ctrl'
  wheelHoldSensitivity: 'balanced', // 'fast' | 'balanced' | 'safe'
  mainChatLayoutWheelEnabled: false, // opt-in 5-direction sidebar/overview wheel inside Antigravity main chat pane
  mainChatLayoutSlots: DEFAULT_MAIN_CHAT_LAYOUT_SLOTS,
  tabTriggerEnabled: true,
  tabMode: 'ae_tree', // 'ae_tree' | 'bilateral_wheel' | 'classic_wheel' | 'off'
  tabCustomHotkey: 'Tab', // canonical hotkey spec e.g. 'Tab' | 'Backquote' | 'Alt+Q' | 'Ctrl+Shift+W'
  tabTriggerAction: 'toggle', // 'toggle' | 'hold'
  tabCloseOnSelect: false,
  childSourceScope: 'opened_and_outlinks', // 'opened_and_outlinks' | 'opened_only'
  parentDirection: 'left', // 'left' | 'top' | 'right' | 'bottom'
  hoverPreviewEnabled: true,
  hoverPreviewDelayMs: 250,
  videoPreviewAnimated: true,
  richDocPreviewEnabled: true,
  richDocAutoStrategy: 'auto_yield', // 'auto_yield' | 'always_plugin' | 'manual_only'
  richDocPaperMode: false,
  categoryRules: DEFAULT_CATEGORY_RULES,
  scanWorkspace: true,
  scanArtifacts: true,
  extraScanDirs: [],
  encodingAutoDetect: true,
  foldChildTabsInNativeBar: true,
  preventPreviewTabOverwrite: true,
  rightPaneSelectionMenuEnabled: true,
  wheelSoundwaveEnabled: false,
  wheelSoundwaveByTheme: DEFAULT_WHEEL_SOUNDWAVE_BY_THEME,
  docCodeExtsSeeded: true,
  autoCheckUpdates: true,
  ignoredUpdateVersion: '',
  theme: 'auto', // 'auto' | 'obsidian' | 'warm' | 'crystal' | 'alabaster' | 'soundwave'
});

const VALID_TRIGGERS = new Set(['middle_or_badge', 'right_drag', 'hotkey_only', 'badge_only']);
const VALID_TRIGGER_BUTTONS = new Set(['middle', 'right', 'side_back', 'side_forward', 'left']);
const VALID_TRIGGER_MODIFIERS = new Set(['none', 'alt', 'shift', 'ctrl']);
const VALID_HOLD_SENSITIVITIES = new Set(['fast', 'balanced', 'safe']);
const VALID_MIDDLE_MODES = new Set(['bilateral_wheel', 'classic_wheel', 'off']);
const VALID_TAB_MODES = new Set(['ae_tree', 'bilateral_wheel', 'classic_wheel', 'off']);
const VALID_TAB_ACTIONS = new Set(['toggle', 'hold']);
const VALID_CHILD_SCOPES = new Set(['opened_and_outlinks', 'opened_only']);
const VALID_PARENT_DIRS = new Set(['left', 'top', 'right', 'bottom']);
const VALID_THEMES = new Set(['auto', 'obsidian', 'warm', 'crystal', 'alabaster', 'soundwave']);
const VALID_SECTORS = new Set([4, 6, 8]);
const VALID_DOC_STRATEGIES = new Set(['auto_yield', 'always_plugin', 'manual_only']);
const LAYOUT_SLOT_KEYS = Object.freeze(['top_left', 'mid_left', 'bottom_left', 'top_right', 'bottom_right']);
const VALID_MAIN_CHAT_LAYOUT_ACTIONS = new Set([
  'collapse_left',
  'expand_left',
  'toggle_left',
  'expand_right',
  'collapse_right',
  'toggle_right',
  'toggle_overview',
  'none',
]);

export function sanitizeMainChatLayoutSlots(raw, base = DEFAULT_MAIN_CHAT_LAYOUT_SLOTS) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const fallback = base && typeof base === 'object' ? base : DEFAULT_MAIN_CHAT_LAYOUT_SLOTS;
  const out = {};
  for (const key of LAYOUT_SLOT_KEYS) {
    if (VALID_MAIN_CHAT_LAYOUT_ACTIONS.has(src[key])) {
      out[key] = src[key];
    } else if (VALID_MAIN_CHAT_LAYOUT_ACTIONS.has(fallback[key])) {
      out[key] = fallback[key];
    } else {
      out[key] = DEFAULT_MAIN_CHAT_LAYOUT_SLOTS[key];
    }
  }
  return out;
}

const BARE_HOTKEY_KEYS = new Set([
  'Tab', 'Backquote',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);
const EXTRA_COMBO_HOTKEY_KEYS = new Set([
  'Space', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash',
  'Semicolon', 'Quote', 'Comma', 'Period', 'Slash',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);
const HOTKEY_KEY_ALIASES = Object.freeze({
  tab: 'Tab',
  backquote: 'Backquote',
  '`': 'Backquote',
  '~': 'Backquote',
  '·': 'Backquote',
  space: 'Space',
  spacebar: 'Space',
  ' ': 'Space',
  minus: 'Minus',
  '-': 'Minus',
  equal: 'Equal',
  '=': 'Equal',
  bracketleft: 'BracketLeft',
  '[': 'BracketLeft',
  bracketright: 'BracketRight',
  ']': 'BracketRight',
  backslash: 'Backslash',
  '\\': 'Backslash',
  semicolon: 'Semicolon',
  ';': 'Semicolon',
  quote: 'Quote',
  "'": 'Quote',
  comma: 'Comma',
  ',': 'Comma',
  period: 'Period',
  '.': 'Period',
  slash: 'Slash',
  '/': 'Slash',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
});

export function normalizeHotkeySpec(raw) {
  const text = String(raw || '').trim();
  if (!text || text.length > 40) return '';
  const parts = text.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > 5) return '';
  const mods = { Ctrl: false, Alt: false, Shift: false, Meta: false };
  let mainKey = '';
  for (const part of parts) {
    const low = part.toLowerCase();
    if (low === 'ctrl' || low === 'control') {
      mods.Ctrl = true;
    } else if (low === 'alt' || low === 'option') {
      mods.Alt = true;
    } else if (low === 'shift') {
      mods.Shift = true;
    } else if (low === 'meta' || low === 'cmd' || low === 'command' || low === 'win' || low === 'super') {
      mods.Meta = true;
    } else if (!mainKey) {
      if (/^key([a-z])$/i.test(part)) {
        mainKey = part.slice(3).toUpperCase();
      } else if (/^digit([0-9])$/i.test(part)) {
        mainKey = part.slice(5);
      } else if (/^[a-z0-9]$/i.test(part)) {
        mainKey = part.toUpperCase();
      } else if (/^f([1-9]|1[0-2])$/i.test(part)) {
        mainKey = part.toUpperCase();
      } else if (HOTKEY_KEY_ALIASES[low]) {
        mainKey = HOTKEY_KEY_ALIASES[low];
      } else {
        return '';
      }
    } else {
      return '';
    }
  }
  if (!mainKey) return '';
  const hasMod = mods.Ctrl || mods.Alt || mods.Shift || mods.Meta;
  const isBareAllowed = BARE_HOTKEY_KEYS.has(mainKey);
  const isComboAllowed = isBareAllowed || EXTRA_COMBO_HOTKEY_KEYS.has(mainKey) || /^[A-Z0-9]$/.test(mainKey);
  if (!isComboAllowed) return '';
  if (!hasMod && !isBareAllowed) return '';
  const orderedMods = ['Ctrl', 'Alt', 'Shift', 'Meta'].filter((m) => mods[m]);
  return orderedMods.length ? `${orderedMods.join('+')}+${mainKey}` : mainKey;
}

export function sanitizeCategoryRules(rawRules, fallback = DEFAULT_CATEGORY_RULES) {
  const src = Array.isArray(rawRules) ? rawRules : fallback;
  const out = [];
  const seenIds = new Set();
  for (let i = 0; i < src.length && out.length < 8; i++) {
    const r = src[i];
    if (!r || typeof r !== 'object') continue;
    const rawId = String(r.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (rawId === 'other') continue; // '其他' fallback category is always appended dynamically
    const id = rawId && !seenIds.has(rawId) ? rawId : `cat_${out.length + 1}`;
    seenIds.add(id);
    const label = String(r.label || '').trim().slice(0, 12);
    if (!label || label === '其他') continue;
    const rawExts = Array.isArray(r.extensions)
      ? r.extensions
      : String(r.extensions || '')
          .split(/[,;\s]+/)
          .filter(Boolean);
    const extensions = Array.from(
      new Set(
        rawExts
          .map((e) => String(e || '').trim().replace(/^\.+/, '').toLowerCase())
          .filter((e) => e && /^[a-z0-9]{1,16}$/.test(e))
      )
    );
    out.push({ id, label, extensions });
  }
  if (!out.length) {
    return DEFAULT_CATEGORY_RULES.map((c) => ({ id: c.id, label: c.label, extensions: [...c.extensions] }));
  }
  return out;
}

export function sanitizeSettings(raw, base = DEFAULT_SETTINGS) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const next = {
    ...base,
    categoryRules: sanitizeCategoryRules(base.categoryRules, DEFAULT_CATEGORY_RULES),
    mainChatLayoutSlots: sanitizeMainChatLayoutSlots(base.mainChatLayoutSlots, DEFAULT_MAIN_CHAT_LAYOUT_SLOTS),
    wheelSoundwaveByTheme: sanitizeWheelSoundwaveByTheme(base.wheelSoundwaveByTheme, DEFAULT_WHEEL_SOUNDWAVE_BY_THEME),
  };
  if (src.maxChildrenPerGroup !== undefined) {
    const n = Math.round(Number(src.maxChildrenPerGroup));
    if (Number.isFinite(n) && n >= 1 && n <= 30) next.maxChildrenPerGroup = n;
  }
  if (typeof src.autoAnchorSummaryMd === 'boolean') next.autoAnchorSummaryMd = src.autoAnchorSummaryMd;
  if (VALID_TRIGGERS.has(src.wheelTrigger)) next.wheelTrigger = src.wheelTrigger;
  if (typeof src.wheelHotkey === 'string' && src.wheelHotkey.trim().length > 0 && src.wheelHotkey.trim().length <= 24) {
    next.wheelHotkey = src.wheelHotkey.trim();
  }
  if (src.wheelSectors !== undefined) {
    const s = Number(src.wheelSectors);
    if (VALID_SECTORS.has(s)) next.wheelSectors = s;
  }
  if (VALID_MIDDLE_MODES.has(src.middleMode)) {
    next.middleMode = src.middleMode;
    if (src.middleMode === 'off' && next.wheelTrigger === 'middle_or_badge') {
      next.wheelTrigger = 'badge_only';
    } else if (src.middleMode !== 'off' && src.wheelTrigger === undefined && base.wheelTrigger === 'badge_only') {
      next.wheelTrigger = 'middle_or_badge';
    }
  }
  if (VALID_TRIGGER_BUTTONS.has(src.wheelTriggerButton)) {
    next.wheelTriggerButton = src.wheelTriggerButton;
  } else if (src.wheelTrigger === 'right_drag' && src.wheelTriggerButton === undefined && base.wheelTriggerButton === 'middle') {
    next.wheelTriggerButton = 'right';
  }
  if (VALID_TRIGGER_MODIFIERS.has(src.wheelTriggerModifier)) {
    next.wheelTriggerModifier = src.wheelTriggerModifier;
  }
  if (next.wheelTriggerButton === 'left' && next.wheelTriggerModifier === 'none') {
    next.wheelTriggerModifier = 'alt';
  }
  if (VALID_HOLD_SENSITIVITIES.has(src.wheelHoldSensitivity)) {
    next.wheelHoldSensitivity = src.wheelHoldSensitivity;
  }
  if (typeof src.mainChatLayoutWheelEnabled === 'boolean') {
    next.mainChatLayoutWheelEnabled = src.mainChatLayoutWheelEnabled;
  }
  if (src.mainChatLayoutSlots && typeof src.mainChatLayoutSlots === 'object') {
    next.mainChatLayoutSlots = sanitizeMainChatLayoutSlots(src.mainChatLayoutSlots, next.mainChatLayoutSlots);
  }
  if (typeof src.tabTriggerEnabled === 'boolean') next.tabTriggerEnabled = src.tabTriggerEnabled;
  if (VALID_TAB_MODES.has(src.tabMode)) next.tabMode = src.tabMode;
  if (src.tabCustomHotkey !== undefined) {
    const cleanHotkey = normalizeHotkeySpec(src.tabCustomHotkey);
    if (cleanHotkey) next.tabCustomHotkey = cleanHotkey;
  }
  if (VALID_TAB_ACTIONS.has(src.tabTriggerAction)) next.tabTriggerAction = src.tabTriggerAction;
  if (typeof src.tabCloseOnSelect === 'boolean') next.tabCloseOnSelect = src.tabCloseOnSelect;
  if (VALID_CHILD_SCOPES.has(src.childSourceScope)) next.childSourceScope = src.childSourceScope;
  if (VALID_PARENT_DIRS.has(src.parentDirection)) next.parentDirection = src.parentDirection;
  if (typeof src.hoverPreviewEnabled === 'boolean') next.hoverPreviewEnabled = src.hoverPreviewEnabled;
  if (src.hoverPreviewDelayMs !== undefined) {
    const ms = Math.round(Number(src.hoverPreviewDelayMs));
    if (Number.isFinite(ms) && ms >= 0 && ms <= 1500) next.hoverPreviewDelayMs = ms;
  }
  if (typeof src.videoPreviewAnimated === 'boolean') next.videoPreviewAnimated = src.videoPreviewAnimated;
  if (typeof src.richDocPreviewEnabled === 'boolean') next.richDocPreviewEnabled = src.richDocPreviewEnabled;
  if (VALID_DOC_STRATEGIES.has(src.richDocAutoStrategy)) next.richDocAutoStrategy = src.richDocAutoStrategy;
  if (typeof src.richDocPaperMode === 'boolean') next.richDocPaperMode = src.richDocPaperMode;
  if (Array.isArray(src.categoryRules)) {
    next.categoryRules = sanitizeCategoryRules(src.categoryRules, next.categoryRules);
  }
  if (typeof src.scanWorkspace === 'boolean') next.scanWorkspace = src.scanWorkspace;
  if (typeof src.scanArtifacts === 'boolean') next.scanArtifacts = src.scanArtifacts;
  if (Array.isArray(src.extraScanDirs)) {
    next.extraScanDirs = Array.from(
      new Set(
        src.extraScanDirs
          .map((d) => normalizeFilePath(String(d || '').trim()))
          .filter((d) => d && path.isAbsolute(d))
      )
    ).slice(0, 20);
  }
  if (typeof src.encodingAutoDetect === 'boolean') next.encodingAutoDetect = src.encodingAutoDetect;
  if (typeof src.foldChildTabsInNativeBar === 'boolean') next.foldChildTabsInNativeBar = src.foldChildTabsInNativeBar;
  if (typeof src.preventPreviewTabOverwrite === 'boolean') next.preventPreviewTabOverwrite = src.preventPreviewTabOverwrite;
  if (typeof src.rightPaneSelectionMenuEnabled === 'boolean') next.rightPaneSelectionMenuEnabled = src.rightPaneSelectionMenuEnabled;
  if (typeof src.docCodeExtsSeeded === 'boolean') next.docCodeExtsSeeded = src.docCodeExtsSeeded;
  if (typeof src.autoCheckUpdates === 'boolean') next.autoCheckUpdates = src.autoCheckUpdates;
  if (typeof src.ignoredUpdateVersion === 'string') {
    const cleanVer = src.ignoredUpdateVersion.trim().replace(/^v/i, '').slice(0, 32);
    next.ignoredUpdateVersion = /^[0-9A-Za-z._-]{1,32}$/.test(cleanVer) ? cleanVer : '';
  }
  if (VALID_THEMES.has(src.theme)) next.theme = src.theme;
  if (src.wheelSoundwaveByTheme && typeof src.wheelSoundwaveByTheme === 'object' && !Array.isArray(src.wheelSoundwaveByTheme)) {
    next.wheelSoundwaveByTheme = sanitizeWheelSoundwaveByTheme(src.wheelSoundwaveByTheme, next.wheelSoundwaveByTheme);
  }
  if (typeof src.wheelSoundwaveEnabled === 'boolean') {
    next.wheelSoundwaveEnabled = src.wheelSoundwaveEnabled;
    if (!src.wheelSoundwaveByTheme && next.theme !== 'soundwave') {
      next.wheelSoundwaveByTheme = {
        ...next.wheelSoundwaveByTheme,
        [next.theme || 'auto']: src.wheelSoundwaveEnabled,
      };
    }
  }
  if (next.theme === 'soundwave') {
    next.wheelSoundwaveEnabled = true;
  } else if (
    (src.wheelSoundwaveByTheme !== undefined || src.theme !== undefined) &&
    src.wheelSoundwaveEnabled === undefined
  ) {
    next.wheelSoundwaveEnabled = Boolean(next.wheelSoundwaveByTheme[next.theme || 'auto']);
  }
  return next;
}

/**
 * Checks whether setting parentByKey[childKey] = parentKey would create a cycle
 * (e.g. when childKey is already an ancestor of parentKey or equals parentKey).
 */
export function wouldCreateCycle(parentByKey, childKey, parentKey) {
  if (!childKey || !parentKey) return true;
  if (childKey === parentKey) return true;
  const map = parentByKey && typeof parentByKey === 'object' ? parentByKey : {};
  let cur = parentKey;
  const visited = new Set([childKey]);
  for (let depth = 0; depth < 16 && cur; depth++) {
    if (visited.has(cur)) return true;
    visited.add(cur);
    cur = map[cur]?.parentKey || '';
  }
  return false;
}

/**
 * Resolves up to `maxDepth` ancestors for `filePath` ordered top-down [grandparent?, parent?].
 * Consults explicit lineage first and falls back to Priority Anchor groups.
 */
export function resolveAncestors(sess, filePath, maxDepth = 4) {
  const norm = normalizeFilePath(filePath);
  if (!norm || !sess) return [];
  const startKey = canonicalKey(norm);
  const parentMap = sess.lineage?.parentByKey || {};
  const groups = Array.isArray(sess.groups) ? sess.groups : [];
  const chainBottomUp = [];
  const seen = new Set([startKey]);
  let curKey = startKey;

  for (let depth = 0; depth < maxDepth; depth++) {
    const rec = parentMap[curKey];
    let pPath = rec?.parentPath || '';
    let pTitle = rec?.parentTitle || '';
    let pKey = rec?.parentKey || (pPath ? canonicalKey(pPath) : '');

    if (!pKey) {
      const grp = groups.find(
        (g) => canonicalKey(g.anchorPath) !== curKey && (g.children || []).some((c) => canonicalKey(c.path) === curKey)
      );
      if (grp?.anchorPath) {
        pPath = grp.anchorPath;
        pTitle = grp.anchorTitle || path.basename(pPath);
        pKey = canonicalKey(pPath);
      }
    }

    if (!pKey || !pPath || seen.has(pKey)) break;
    seen.add(pKey);
    const matchedGroup = !rec
      ? groups.find((g) => canonicalKey(g.anchorPath) === pKey)
      : null;
    chainBottomUp.push({
      path: pPath,
      key: pKey,
      title: pTitle || path.basename(pPath),
      isDirectory: Boolean(rec?.parentIsDirectory || matchedGroup?.anchorIsDirectory),
    });
    curKey = pKey;
  }

  return chainBottomUp.reverse();
}

/**
 * Pure LRU eviction for a Priority Anchor Group.
 * Protects the anchor file itself and any child with `locked === true`.
 */
export function evictOverflowChildren(group, defaultMax = 6) {
  if (!group || !Array.isArray(group.children)) {
    return { group, evicted: [] };
  }
  const limit = Math.max(1, Math.round(Number(group.maxChildren ?? defaultMax) || 6));
  const anchorKey = canonicalKey(group.anchorPath || '');

  const protectedChildren = [];
  const unlockedChildren = [];
  for (const ch of group.children) {
    if (!ch || !ch.path) continue;
    const key = canonicalKey(ch.path);
    if (key === anchorKey) continue;
    if (ch.locked) protectedChildren.push(ch);
    else unlockedChildren.push(ch);
  }

  if (unlockedChildren.length <= limit) {
    return { group: { ...group, children: [...protectedChildren, ...unlockedChildren] }, evicted: [] };
  }

  // Sort unlocked children oldest-accessed first (tie-break by addedAt)
  const byOldest = [...unlockedChildren].sort((a, b) => {
    const diff = (a.lastAccessedAt || 0) - (b.lastAccessedAt || 0);
    if (diff !== 0) return diff;
    return (a.addedAt || 0) - (b.addedAt || 0);
  });

  const evictCount = unlockedChildren.length - limit;
  const evicted = byOldest.slice(0, evictCount);
  const evictedKeys = new Set(evicted.map((c) => canonicalKey(c.path)));

  // Preserve original relative order for surviving items
  const kept = group.children.filter((ch) => {
    if (!ch || !ch.path) return false;
    const k = canonicalKey(ch.path);
    if (k === anchorKey) return false;
    return !evictedKeys.has(k);
  });

  return {
    group: { ...group, children: kept },
    evicted,
  };
}

export function pushHistory(historyState, entry, maxLen = 60) {
  const state = historyState && Array.isArray(historyState.entries)
    ? { entries: historyState.entries.map((e) => ({ ...e })), index: Number(historyState.index ?? -1) }
    : { entries: [], index: -1 };

  if (!entry || !entry.path) return state;
  const normPath = normalizeFilePath(entry.path);
  const key = canonicalKey(normPath);
  const nextEntry = {
    path: normPath,
    key,
    title: String(entry.title || path.basename(normPath)),
    scrollTop: Number(entry.scrollTop || 0),
    line: entry.line ? Number(entry.line) : null,
    tabId: entry.tabId ? String(entry.tabId) : '',
    isDirectory: Boolean(entry.isDirectory),
    timestamp: Number(entry.timestamp || Date.now()),
  };

  if (state.index >= 0 && state.index < state.entries.length) {
    const cur = state.entries[state.index];
    if (cur && canonicalKey(cur.path) === key) {
      state.entries[state.index] = {
        ...cur,
        ...nextEntry,
        scrollTop: entry.scrollTop !== undefined ? Number(entry.scrollTop) : cur.scrollTop,
      };
      return state;
    }
  }

  const branch = state.index >= 0 ? state.entries.slice(0, state.index + 1) : [];
  branch.push(nextEntry);
  const trimmed = branch.length > maxLen ? branch.slice(branch.length - maxLen) : branch;
  return {
    entries: trimmed,
    index: trimmed.length - 1,
  };
}

export function stepHistory(historyState, delta) {
  if (!historyState || !Array.isArray(historyState.entries) || !historyState.entries.length) {
    return { historyState: historyState || { entries: [], index: -1 }, targetEntry: null };
  }
  const nextIdx = historyState.index + delta;
  if (nextIdx < 0 || nextIdx >= historyState.entries.length) {
    return { historyState, targetEntry: null };
  }
  const nextState = {
    entries: historyState.entries,
    index: nextIdx,
  };
  return {
    historyState: nextState,
    targetEntry: nextState.entries[nextIdx],
  };
}

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const payload = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    fs.writeFileSync(filePath, payload, { encoding: 'utf8', mode: 0o600 });
  }
}

const MAX_STORED_SESSIONS = 80;
const SESSION_DEBOUNCE_MS = 250;

export class StateStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.settings = { ...DEFAULT_SETTINGS };
    this.sessions = {};
    this._sessionsDirty = false;
    this._saveTimer = null;
    this.#load();
  }

  #load() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
    } catch {}
    try {
      if (fs.existsSync(this.settingsFile)) {
        const raw = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
        this.settings = sanitizeSettings(raw, DEFAULT_SETTINGS);
        // One-time non-destructive migration: add common code/script extensions (.js, .mjs, .ts, .py...)
        // into the default '文档' category if no existing rule already claims js/mjs.
        if (raw && typeof raw === 'object' && raw.docCodeExtsSeeded !== true) {
          const rules = Array.isArray(this.settings.categoryRules) ? this.settings.categoryRules : [];
          const alreadyHasJs = rules.some(
            (r) => Array.isArray(r.extensions) && (r.extensions.includes('js') || r.extensions.includes('mjs'))
          );
          if (!alreadyHasJs) {
            const docRule = rules.find((r) => r.id === 'doc' || r.label === '文档');
            if (docRule) {
              const claimedElsewhere = new Set();
              for (const r of rules) {
                if (r !== docRule && Array.isArray(r.extensions)) {
                  for (const ext of r.extensions) claimedElsewhere.add(ext);
                }
              }
              const merged = new Set(docRule.extensions || []);
              for (const ext of DOC_CODE_SEED_EXTS) {
                if (!claimedElsewhere.has(ext)) merged.add(ext);
              }
              docRule.extensions = Array.from(merged);
            }
          }
          this.settings.docCodeExtsSeeded = true;
          this.#saveSettings();
        }
      }
    } catch {}
    try {
      if (fs.existsSync(this.sessionsFile)) {
        const raw = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          this.sessions = raw;
        }
      }
    } catch {}
  }

  #pruneOldSessionsIfNeeded() {
    const keys = Object.keys(this.sessions);
    if (keys.length <= MAX_STORED_SESSIONS) return;
    // Prefer evicting oldest conversations without pinned groups first
    keys.sort((a, b) => {
      const sa = this.sessions[a];
      const sb = this.sessions[b];
      const aHasGroups = Array.isArray(sa?.groups) && sa.groups.length > 0 ? 1 : 0;
      const bHasGroups = Array.isArray(sb?.groups) && sb.groups.length > 0 ? 1 : 0;
      if (aHasGroups !== bHasGroups) return aHasGroups - bHasGroups;
      return Number(sa?.updatedAt || 0) - Number(sb?.updatedAt || 0);
    });
    const toRemove = keys.slice(0, keys.length - MAX_STORED_SESSIONS);
    for (const k of toRemove) {
      if (k !== 'default') delete this.sessions[k];
    }
  }

  #saveSettings() {
    atomicWriteJson(this.settingsFile, this.settings);
  }

  #saveSessions({ immediate = true } = {}) {
    this.#pruneOldSessionsIfNeeded();
    if (immediate) {
      if (this._saveTimer) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
      }
      this._sessionsDirty = false;
      atomicWriteJson(this.sessionsFile, this.sessions);
      return;
    }
    this._sessionsDirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (!this._sessionsDirty) return;
      this._sessionsDirty = false;
      try {
        atomicWriteJson(this.sessionsFile, this.sessions);
      } catch {}
    }, SESSION_DEBOUNCE_MS);
    this._saveTimer.unref?.();
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._sessionsDirty) {
      this._sessionsDirty = false;
      try {
        atomicWriteJson(this.sessionsFile, this.sessions);
      } catch {}
    }
  }

  getSettings() {
    return {
      ...this.settings,
      extraScanDirs: [...this.settings.extraScanDirs],
      categoryRules: (this.settings.categoryRules || []).map((r) => ({ ...r, extensions: [...(r.extensions || [])] })),
      mainChatLayoutSlots: sanitizeMainChatLayoutSlots(this.settings.mainChatLayoutSlots, DEFAULT_MAIN_CHAT_LAYOUT_SLOTS),
      wheelSoundwaveByTheme: sanitizeWheelSoundwaveByTheme(this.settings.wheelSoundwaveByTheme, DEFAULT_WHEEL_SOUNDWAVE_BY_THEME),
    };
  }

  updateSettings(patch) {
    this.settings = sanitizeSettings(patch, this.settings);
    this.#saveSettings();
    return this.getSettings();
  }

  #ensureSession(conversationId) {
    const cid = String(conversationId || 'default').trim() || 'default';
    if (!this.sessions[cid] || typeof this.sessions[cid] !== 'object') {
      this.sessions[cid] = {
        conversationId: cid,
        groups: [],
        activeGroupId: null,
        history: { entries: [], index: -1 },
        recentlyEvicted: [],
        lineage: { parentByKey: {} },
        updatedAt: Date.now(),
      };
    }
    const sess = this.sessions[cid];
    if (!Array.isArray(sess.groups)) sess.groups = [];
    if (!sess.history || !Array.isArray(sess.history.entries)) sess.history = { entries: [], index: -1 };
    if (!Array.isArray(sess.recentlyEvicted)) sess.recentlyEvicted = [];
    if (!sess.lineage || typeof sess.lineage !== 'object') sess.lineage = { parentByKey: {} };
    if (!sess.lineage.parentByKey || typeof sess.lineage.parentByKey !== 'object') sess.lineage.parentByKey = {};
    return sess;
  }

  #setLineageEdge(sess, { parentPath, parentTitle, parentIsDirectory = false, childPath, childTitle, childIsDirectory = false }) {
    const pNorm = normalizeFilePath(parentPath);
    const cNorm = normalizeFilePath(childPath);
    if (!pNorm || !cNorm) return false;
    const pKey = canonicalKey(pNorm);
    const cKey = canonicalKey(cNorm);
    if (!pKey || !cKey || pKey === cKey) return false;
    const map = sess.lineage.parentByKey;
    if (wouldCreateCycle(map, cKey, pKey)) return false;
    map[cKey] = {
      parentPath: pNorm,
      parentKey: pKey,
      parentTitle: String(parentTitle || path.basename(pNorm)),
      parentIsDirectory: Boolean(parentIsDirectory),
      childPath: cNorm,
      childKey: cKey,
      childTitle: String(childTitle || path.basename(cNorm)),
      childIsDirectory: Boolean(childIsDirectory),
      openedAt: Date.now(),
    };
    const keys = Object.keys(map);
    if (keys.length > 260) {
      keys.sort((a, b) => (map[a]?.openedAt || 0) - (map[b]?.openedAt || 0));
      for (const oldKey of keys.slice(0, keys.length - 260)) {
        delete map[oldKey];
      }
    }
    return true;
  }

  recordLineage(conversationId, { parentPath, parentTitle, parentIsDirectory = false, childPath, childTitle, childIsDirectory = false }) {
    const sess = this.#ensureSession(conversationId);
    if (this.#setLineageEdge(sess, { parentPath, parentTitle, parentIsDirectory, childPath, childTitle, childIsDirectory })) {
      sess.updatedAt = Date.now();
      this.#saveSessions();
    }
    return this.getSession(conversationId);
  }

  getSession(conversationId) {
    const sess = this.#ensureSession(conversationId);
    return JSON.parse(JSON.stringify(sess));
  }

  #findGroup(sess, { groupId, anchorPath }) {
    if (groupId) {
      const byId = sess.groups.find((g) => g.id === groupId);
      if (byId) return byId;
    }
    if (anchorPath) {
      const ak = canonicalKey(anchorPath);
      const byAnchor = sess.groups.find((g) => canonicalKey(g.anchorPath) === ak);
      if (byAnchor) return byAnchor;
    }
    if (sess.activeGroupId) {
      const byActive = sess.groups.find((g) => g.id === sess.activeGroupId);
      if (byActive) return byActive;
    }
    return sess.groups[0] || null;
  }

  #recordEvicted(sess, evictedList, groupId, anchorTitle) {
    if (!evictedList || !evictedList.length) return;
    for (const item of evictedList) {
      const key = canonicalKey(item.path);
      sess.recentlyEvicted = sess.recentlyEvicted.filter((r) => canonicalKey(r.path) !== key);
      sess.recentlyEvicted.unshift({
        path: item.path,
        title: item.title || path.basename(item.path),
        groupId,
        anchorTitle,
        evictedAt: Date.now(),
      });
    }
    if (sess.recentlyEvicted.length > 30) {
      sess.recentlyEvicted = sess.recentlyEvicted.slice(0, 30);
    }
  }

  pinAnchor(conversationId, { path: anchorRawPath, title, tabId, maxChildren, isDirectory = false }) {
    const sess = this.#ensureSession(conversationId);
    const normPath = normalizeFilePath(anchorRawPath);
    if (!normPath) return this.getSession(conversationId);
    const ak = canonicalKey(normPath);

    let group = sess.groups.find((g) => canonicalKey(g.anchorPath) === ak);
    if (!group) {
      group = {
        id: `grp_${crypto.randomBytes(5).toString('hex')}`,
        anchorPath: normPath,
        anchorKey: ak,
        anchorTitle: String(title || path.basename(normPath)),
        anchorTabId: tabId ? String(tabId) : '',
        anchorIsDirectory: Boolean(isDirectory),
        maxChildren: maxChildren ? Math.max(1, Math.round(Number(maxChildren))) : null,
        createdAt: Date.now(),
        children: [],
      };
      sess.groups.unshift(group);
    } else {
      if (title) group.anchorTitle = String(title);
      if (tabId) group.anchorTabId = String(tabId);
      if (isDirectory) group.anchorIsDirectory = true;
      if (maxChildren !== undefined) {
        group.maxChildren = maxChildren === null ? null : Math.max(1, Math.round(Number(maxChildren)));
      }
    }
    sess.activeGroupId = group.id;
    sess.updatedAt = Date.now();
    this.#saveSessions();
    return this.getSession(conversationId);
  }

  unpinGroup(conversationId, groupId) {
    const sess = this.#ensureSession(conversationId);
    const target = this.#findGroup(sess, { groupId });
    if (!target) return this.getSession(conversationId);
    sess.groups = sess.groups.filter((g) => g.id !== target.id);
    if (sess.activeGroupId === target.id) {
      sess.activeGroupId = sess.groups[0]?.id || null;
    }
    sess.updatedAt = Date.now();
    this.#saveSessions();
    return this.getSession(conversationId);
  }

  adoptChild(
    conversationId,
    {
      groupId,
      anchorPath,
      anchorIsDirectory = false,
      directParentPath,
      directParentTitle,
      directParentIsDirectory = false,
      childPath,
      childTitle,
      childIsDirectory = false,
      tabId,
      lock = false,
    }
  ) {
    const sess = this.#ensureSession(conversationId);
    const normChild = normalizeFilePath(childPath);
    if (!normChild) return { session: this.getSession(conversationId), evicted: [] };

    let group = this.#findGroup(sess, { groupId, anchorPath });
    if (!group && anchorPath) {
      const normAnchor = normalizeFilePath(anchorPath);
      group = {
        id: `grp_${crypto.randomBytes(5).toString('hex')}`,
        anchorPath: normAnchor,
        anchorKey: canonicalKey(normAnchor),
        anchorTitle: path.basename(normAnchor),
        anchorTabId: '',
        anchorIsDirectory: Boolean(anchorIsDirectory),
        maxChildren: null,
        createdAt: Date.now(),
        children: [],
      };
      sess.groups.unshift(group);
      sess.activeGroupId = group.id;
    }
    if (!group) return { session: this.getSession(conversationId), evicted: [] };

    const childKey = canonicalKey(normChild);
    if (childKey === canonicalKey(group.anchorPath)) {
      sess.activeGroupId = group.id;
      this.#saveSessions();
      return { session: this.getSession(conversationId), evicted: [] };
    }

    const now = Date.now();
    const existing = group.children.find((c) => canonicalKey(c.path) === childKey);
    if (existing) {
      existing.lastAccessedAt = now;
      if (childTitle) existing.title = String(childTitle);
      if (tabId) existing.tabId = String(tabId);
      if (lock) existing.locked = true;
      if (childIsDirectory) existing.isDirectory = true;
    } else {
      group.children.push({
        path: normChild,
        key: childKey,
        title: String(childTitle || path.basename(normChild)),
        tabId: tabId ? String(tabId) : '',
        isDirectory: Boolean(childIsDirectory),
        addedAt: now,
        lastAccessedAt: now,
        locked: Boolean(lock),
      });
    }

    sess.recentlyEvicted = sess.recentlyEvicted.filter((r) => canonicalKey(r.path) !== childKey);
    const { group: nextGroup, evicted } = evictOverflowChildren(group, this.settings.maxChildrenPerGroup);
    const idx = sess.groups.findIndex((g) => g.id === group.id);
    if (idx !== -1) sess.groups[idx] = nextGroup;
    this.#recordEvicted(sess, evicted, nextGroup.id, nextGroup.anchorTitle);

    const linParentPath = directParentPath || group.anchorPath;
    const linParentTitle = directParentTitle || group.anchorTitle;
    const linParentIsDir = directParentPath ? Boolean(directParentIsDirectory) : Boolean(group.anchorIsDirectory);
    if (directParentPath || !sess.lineage.parentByKey[childKey]) {
      this.#setLineageEdge(sess, {
        parentPath: linParentPath,
        parentTitle: linParentTitle,
        parentIsDirectory: linParentIsDir,
        childPath: normChild,
        childTitle: childTitle || path.basename(normChild),
        childIsDirectory: Boolean(childIsDirectory),
      });
    }

    sess.activeGroupId = nextGroup.id;
    sess.updatedAt = now;
    this.#saveSessions();
    return { session: this.getSession(conversationId), evicted };
  }

  touchChild(conversationId, { groupId, path: childRawPath }) {
    const sess = this.#ensureSession(conversationId);
    const key = canonicalKey(childRawPath);
    for (const g of sess.groups) {
      if (groupId && g.id !== groupId) continue;
      if (canonicalKey(g.anchorPath) === key) {
        sess.activeGroupId = g.id;
        this.#saveSessions({ immediate: false });
        return this.getSession(conversationId);
      }
      const ch = g.children.find((c) => canonicalKey(c.path) === key);
      if (ch) {
        ch.lastAccessedAt = Date.now();
        sess.activeGroupId = g.id;
        sess.updatedAt = Date.now();
        this.#saveSessions({ immediate: false });
        return this.getSession(conversationId);
      }
    }
    return this.getSession(conversationId);
  }

  toggleChildLock(conversationId, { groupId, path: childRawPath }) {
    const sess = this.#ensureSession(conversationId);
    const group = this.#findGroup(sess, { groupId });
    if (!group) return this.getSession(conversationId);
    const key = canonicalKey(childRawPath);
    const ch = group.children.find((c) => canonicalKey(c.path) === key);
    if (ch) {
      ch.locked = !ch.locked;
      sess.updatedAt = Date.now();
      this.#saveSessions();
    }
    return this.getSession(conversationId);
  }

  removeChild(conversationId, { groupId, path: childRawPath, moveToEvicted = true }) {
    const sess = this.#ensureSession(conversationId);
    const group = this.#findGroup(sess, { groupId });
    if (!group) return this.getSession(conversationId);
    const key = canonicalKey(childRawPath);
    const removed = group.children.filter((c) => canonicalKey(c.path) === key);
    group.children = group.children.filter((c) => canonicalKey(c.path) !== key);
    if (moveToEvicted && removed.length) {
      this.#recordEvicted(sess, removed, group.id, group.anchorTitle);
    }
    sess.updatedAt = Date.now();
    this.#saveSessions();
    return this.getSession(conversationId);
  }

  restoreEvicted(conversationId, { groupId, path: childRawPath }) {
    const sess = this.#ensureSession(conversationId);
    const key = canonicalKey(childRawPath);
    const rec = sess.recentlyEvicted.find((r) => canonicalKey(r.path) === key);
    const targetGroupId = groupId || rec?.groupId || sess.activeGroupId;
    return this.adoptChild(conversationId, {
      groupId: targetGroupId,
      childPath: rec?.path || childRawPath,
      childTitle: rec?.title,
    });
  }

  setGroupLimit(conversationId, { groupId, maxChildren }) {
    const sess = this.#ensureSession(conversationId);
    const group = this.#findGroup(sess, { groupId });
    if (!group) return { session: this.getSession(conversationId), evicted: [] };
    group.maxChildren = maxChildren === null ? null : Math.max(1, Math.min(30, Math.round(Number(maxChildren))));
    const { group: nextGroup, evicted } = evictOverflowChildren(group, this.settings.maxChildrenPerGroup);
    const idx = sess.groups.findIndex((g) => g.id === group.id);
    if (idx !== -1) sess.groups[idx] = nextGroup;
    this.#recordEvicted(sess, evicted, nextGroup.id, nextGroup.anchorTitle);
    sess.updatedAt = Date.now();
    this.#saveSessions();
    return { session: this.getSession(conversationId), evicted };
  }

  navigateHistory(conversationId, { action, entry, delta, scrollTop }) {
    const sess = this.#ensureSession(conversationId);
    let targetEntry = null;
    if (action === 'push' && entry) {
      sess.history = pushHistory(sess.history, entry);
      targetEntry = sess.history.entries[sess.history.index] || null;
    } else if (action === 'back' || action === 'forward') {
      const step = action === 'back' ? -1 : 1;
      const res = stepHistory(sess.history, Number.isFinite(delta) ? delta : step);
      sess.history = res.historyState;
      targetEntry = res.targetEntry;
    } else if (action === 'updateScroll') {
      if (sess.history.index >= 0 && sess.history.entries[sess.history.index]) {
        sess.history.entries[sess.history.index].scrollTop = Number(scrollTop || 0);
      }
    }
    sess.updatedAt = Date.now();
    this.#saveSessions({ immediate: false });
    return { session: this.getSession(conversationId), targetEntry };
  }
}
