// Unified Settings & Reactive Interactive Visual Guide Modal (shared by Mode 1 & Mode 2)
(function (root, factory) {
  const api = factory(
    typeof module !== 'undefined' && module.exports ? require('./nav_shared.js') : root.AnchorWheelNavShared
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AnchorWheelSettingsModal = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (Shared) {
  'use strict';

  const CARD_META = Object.freeze([
    {
      key: 'bilateral_wheel',
      title: '双侧分类轮盘',
      desc: '支持按住鼠标按键（可加修饰键避冲突）或按住自定义快捷键呼出：圆心固定为当前页，一侧回母页，另一侧按分类展开子页。',
    },
    {
      key: 'ae_tree',
      title: '竖向层级树',
      desc: '推荐快捷键呼出：纵向串联「祖父页 → 母页 → 当前页」，右侧排布各自子页；悬停点亮整条路径并显示内容预览，更多子项可展开查看。',
    },
    {
      key: 'classic_wheel',
      title: '母页分组轮盘',
      desc: '圆心固定为本组母页，周围扇区展示组内子页；按住触发键划选扇区或中心松手打开，移到圈外自动取消。',
    },
  ]);

  const FOOTER_HINTS = Object.freeze({
    modes: '仅当前查看通道所选的模式卡片全亮，悬停其余卡片可预览动态效果',
    categories: '按住分类左侧手柄上下拖动即可调整轮盘扇区顺序，上方图解实时同步',
    storage: '切换界面主题、音浪球动态效果或标签收纳策略，保存后立即全局生效',
  });

  const DEFAULT_MAIN_LAYOUT_SLOTS = Object.freeze({
    top_left: 'collapse_left',
    mid_left: 'expand_right',
    bottom_left: 'toggle_overview',
    top_right: 'expand_left',
    bottom_right: 'collapse_right',
  });

  const MAIN_LAYOUT_SLOT_KEYS = Object.freeze(['top_left', 'mid_left', 'bottom_left', 'top_right', 'bottom_right']);

  const MAIN_LAYOUT_ACTION_OPTIONS = Object.freeze([
    { id: 'collapse_left', label: '收起左栏' },
    { id: 'expand_left', label: '展开左栏' },
    { id: 'toggle_left', label: '切换左栏' },
    { id: 'expand_right', label: '展开右栏' },
    { id: 'collapse_right', label: '收起右栏' },
    { id: 'toggle_right', label: '切换右栏' },
    { id: 'toggle_overview', label: '概览面板' },
    { id: 'none', label: '留空（无操作）' },
  ]);

  const VALID_MAIN_LAYOUT_ACTIONS = new Set(MAIN_LAYOUT_ACTION_OPTIONS.map((o) => o.id));
  const NON_SOUNDWAVE_THEMES = Object.freeze(['auto', 'obsidian', 'warm', 'crystal', 'alabaster']);
  const LS_SOUNDWAVE_MAP_KEY = 'aw_soundwave_by_theme_v1';

  function readLocalSoundwaveMap(win) {
    try {
      const raw = win?.localStorage?.getItem?.(LS_SOUNDWAVE_MAP_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeLocalSoundwaveMap(win, map) {
    try {
      if (win?.localStorage?.setItem && map && typeof map === 'object') {
        win.localStorage.setItem(LS_SOUNDWAVE_MAP_KEY, JSON.stringify(map));
      }
    } catch {}
  }

  function normalizeDraftSoundwaveByTheme(settings, win) {
    const out = { auto: false, obsidian: false, warm: false, crystal: false, alabaster: false };
    const fromSettings =
      settings?.wheelSoundwaveByTheme &&
      typeof settings.wheelSoundwaveByTheme === 'object' &&
      !Array.isArray(settings.wheelSoundwaveByTheme)
        ? settings.wheelSoundwaveByTheme
        : null;
    const fromLs = !fromSettings ? readLocalSoundwaveMap(win) : null;
    const src = fromSettings || fromLs;
    if (src) {
      for (const k of NON_SOUNDWAVE_THEMES) {
        if (typeof src[k] === 'boolean') out[k] = src[k];
      }
    } else if (
      settings &&
      settings.theme &&
      settings.theme !== 'soundwave' &&
      typeof settings.wheelSoundwaveEnabled === 'boolean'
    ) {
      const t = NON_SOUNDWAVE_THEMES.includes(settings.theme) ? settings.theme : 'auto';
      out[t] = settings.wheelSoundwaveEnabled;
    }
    return out;
  }

  function isSoundwaveCheckedForDraft(draftObj) {
    if (!draftObj) return false;
    const t = draftObj.theme || 'auto';
    if (t === 'soundwave') return true;
    return Boolean(draftObj.wheelSoundwaveByTheme?.[t]);
  }

  function normalizeDraftLayoutSlots(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = {};
    for (const k of MAIN_LAYOUT_SLOT_KEYS) {
      out[k] = VALID_MAIN_LAYOUT_ACTIONS.has(src[k]) ? src[k] : DEFAULT_MAIN_LAYOUT_SLOTS[k];
    }
    return out;
  }

  function isDefaultLayoutSlots(slots) {
    const norm = normalizeDraftLayoutSlots(slots);
    return MAIN_LAYOUT_SLOT_KEYS.every((k) => norm[k] === DEFAULT_MAIN_LAYOUT_SLOTS[k]);
  }

  function buildLayoutSlotRowHtml(slotKey, dirLabel, currentVal) {
    const opts = MAIN_LAYOUT_ACTION_OPTIONS.map(
      (o) => `<option value="${o.id}" ${currentVal === o.id ? 'selected' : ''}>${o.label}</option>`
    ).join('');
    return `
      <label class="aw-layout-slot-row">
        <span class="aw-layout-slot-tag">${dirLabel}</span>
        <select class="aw-select aw-layout-slot-sel" data-aw-layout-slot="${slotKey}" aria-label="${dirLabel}扇区动作">${opts}</select>
      </label>
    `;
  }

  function createSettingsModal(options = {}) {
    const doc = options.document || document;
    const mountRoot = options.mountRoot || doc.body;
    const S = Shared || globalThis.AnchorWheelNavShared;

    let backdropEl = null;
    let activeTab = 'modes';
    let activeCatPreview = 'bilateral'; // 'bilateral' | 'tree' (used on narrow screens)
    let focusChannel = 'middle'; // 'middle' | 'tab'
    let initialSavedTheme = 'auto';
    let draft = null;
    let editingRules = [];
    let currentCallbacks = null;
    let isRecordingHotkey = false;
    let hotkeyFeedback = '';
    let hotkeyFeedbackTimer = null;
    let advTriggerExpanded = false;

    function clearHotkeyFeedback() {
      clearTimeout(hotkeyFeedbackTimer);
      hotkeyFeedbackTimer = null;
      hotkeyFeedback = '';
    }

    function setHotkeyFeedback(msg, modalEl) {
      clearTimeout(hotkeyFeedbackTimer);
      hotkeyFeedback = msg;
      updateLiveGuides(modalEl);
      if (msg) {
        hotkeyFeedbackTimer = setTimeout(() => {
          hotkeyFeedback = '';
          hotkeyFeedbackTimer = null;
          if (backdropEl) updateLiveGuides(backdropEl.querySelector('.aw-settings-modal'));
        }, 2600);
      }
    }

    function stopHotkeyRecording(modalEl) {
      if (!isRecordingHotkey) return;
      isRecordingHotkey = false;
      clearHotkeyFeedback();
      if (modalEl) updateLiveGuides(modalEl);
    }

    function close() {
      clearHotkeyFeedback();
      isRecordingHotkey = false;
      if (!backdropEl) return;
      doc.removeEventListener('keydown', onKeyDown, true);
      try { backdropEl.remove(); } catch {}
      backdropEl = null;
      draft = null;
      editingRules = [];
      currentCallbacks = null;
    }

    function onKeyDown(ev) {
      if (!backdropEl) return;
      const modalEl = backdropEl.querySelector('.aw-settings-modal');
      if (isRecordingHotkey) {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation?.();
        const res = S.eventToHotkeyString ? S.eventToHotkeyString(ev) : { ok: false, reason: 'unsupported' };
        if (res.ok && res.hotkey) {
          isRecordingHotkey = false;
          clearHotkeyFeedback();
          if (draft) {
            draft.tabCustomHotkey = res.hotkey;
            draft.tabTriggerEnabled = true;
          }
          focusChannel = 'tab';
          const tabEn = modalEl?.querySelector('#aw-sm-tab-en');
          if (tabEn) tabEn.checked = true;
          updateLiveGuides(modalEl);
          return;
        }
        if (res.reason === 'cancel') {
          stopHotkeyRecording(modalEl);
          return;
        }
        if (res.reason === 'modifier_only') {
          return;
        }
        if (res.reason === 'need_modifier') {
          setHotkeyFeedback('字母或空格键容易误触，请搭配 Alt / Ctrl / Shift，或改用 Tab / ` / F1-F12', modalEl);
          return;
        }
        setHotkeyFeedback('该按键暂不支持绑定，请换用常用功能键或组合键', modalEl);
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        close();
      }
    }

    function applyThemePreview(themeVal) {
      if (!backdropEl) return;
      if (themeVal && themeVal !== 'auto') {
        backdropEl.setAttribute('data-aw-theme', themeVal);
        return;
      }
      const hostTheme = currentCallbacks?.resolveHostTheme?.() || options.resolveHostTheme?.() || '';
      if (hostTheme && hostTheme !== 'auto') {
        backdropEl.setAttribute('data-aw-theme', hostTheme);
        return;
      }
      // When opened in 'auto' mode, inherit the active document theme directly without clobbering it.
      // Only synthesize a host fallback when previewing a switch BACK from a previously saved explicit theme.
      if (initialSavedTheme === 'auto' || !doc.documentElement?.hasAttribute?.('data-aw-theme')) {
        backdropEl.removeAttribute('data-aw-theme');
      } else {
        const prefersLight = Boolean(doc.defaultView?.matchMedia?.('(prefers-color-scheme: light)')?.matches);
        backdropEl.setAttribute('data-aw-theme', prefersLight ? 'crystal' : 'obsidian');
      }
    }

    function parseExtRaw(extRaw) {
      return Array.from(
        new Set(
          String(extRaw || '')
            .split(/[,;\s]+/)
            .map((x) => x.replace(/^\.+/, '').trim().toLowerCase())
            .filter((x) => x && /^[a-z0-9]{1,16}$/.test(x))
        )
      );
    }

    function compileValidRulesFromEditing() {
      const valid = [];
      const seen = new Set();
      for (let i = 0; i < editingRules.length && valid.length < 8; i++) {
        const r = editingRules[i];
        const label = String(r?.label || '').trim().slice(0, 12);
        if (!label || label === '其他') continue;
        const rawId = String(r?.id || `cat_${i + 1}`).toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const id = rawId && rawId !== 'other' && !seen.has(rawId) ? rawId : `cat_${valid.length + 1}`;
        seen.add(id);
        valid.push({ id, label, extensions: parseExtRaw(r.extensionsRaw) });
      }
      return valid;
    }

    function getActiveCardKey() {
      if (!draft) return 'bilateral_wheel';
      if (focusChannel === 'tab') {
        return draft.tabTriggerEnabled !== false && draft.tabMode && draft.tabMode !== 'off'
          ? draft.tabMode
          : '';
      }
      return draft.middleMode && draft.middleMode !== 'off' ? draft.middleMode : '';
    }

    function syncDraftFromDom(modalEl) {
      if (!modalEl || !draft) return;
      const g = (sel) => modalEl.querySelector(sel);
      if (g('#aw-sm-middle')) draft.middleMode = g('#aw-sm-middle').value;
      const prevBtn = draft.wheelTriggerButton || 'middle';
      const prevMod = draft.wheelTriggerModifier || 'none';
      if (g('#aw-sm-trigger-btn')) draft.wheelTriggerButton = g('#aw-sm-trigger-btn').value;
      if (g('#aw-sm-trigger-mod')) draft.wheelTriggerModifier = g('#aw-sm-trigger-mod').value;
      if (draft.wheelTriggerButton === 'left' && draft.wheelTriggerModifier === 'none') {
        if (prevBtn !== 'left') {
          draft.wheelTriggerModifier = 'alt';
          if (g('#aw-sm-trigger-mod')) g('#aw-sm-trigger-mod').value = 'alt';
        } else if (prevMod !== 'none') {
          draft.wheelTriggerButton = 'middle';
          if (g('#aw-sm-trigger-btn')) g('#aw-sm-trigger-btn').value = 'middle';
        } else {
          draft.wheelTriggerModifier = 'alt';
          if (g('#aw-sm-trigger-mod')) g('#aw-sm-trigger-mod').value = 'alt';
        }
      }
      if (g('#aw-sm-pdir')) draft.parentDirection = g('#aw-sm-pdir').value;
      if (g('#aw-sm-main-layout-wheel')) draft.mainChatLayoutWheelEnabled = Boolean(g('#aw-sm-main-layout-wheel').checked);
      const slotSels = modalEl.querySelectorAll('.aw-layout-slot-sel[data-aw-layout-slot]');
      if (slotSels.length) {
        const nextSlots = normalizeDraftLayoutSlots(draft.mainChatLayoutSlots);
        slotSels.forEach((sel) => {
          const sk = sel.getAttribute('data-aw-layout-slot');
          if (sk && VALID_MAIN_LAYOUT_ACTIONS.has(sel.value)) nextSlots[sk] = sel.value;
        });
        draft.mainChatLayoutSlots = nextSlots;
      }
      if (g('#aw-sm-tab-en')) draft.tabTriggerEnabled = Boolean(g('#aw-sm-tab-en').checked);
      if (g('#aw-sm-tab-mode')) draft.tabMode = g('#aw-sm-tab-mode').value;
      if (g('#aw-sm-tab-close')) draft.tabCloseOnSelect = Boolean(g('#aw-sm-tab-close').checked);

      if (g('#aw-sm-scope')) draft.childSourceScope = g('#aw-sm-scope').value;
      if (g('#aw-sm-prev-en')) draft.hoverPreviewEnabled = Boolean(g('#aw-sm-prev-en').checked);
      if (g('#aw-sm-prev-delay')) draft.hoverPreviewDelayMs = Number(g('#aw-sm-prev-delay').value);
      if (g('#aw-sm-prev-anim')) draft.videoPreviewAnimated = Boolean(g('#aw-sm-prev-anim').checked);
      if (g('#aw-sm-rich-doc')) draft.richDocPreviewEnabled = Boolean(g('#aw-sm-rich-doc').checked);
      if (g('#aw-sm-rich-strategy')) draft.richDocAutoStrategy = g('#aw-sm-rich-strategy').value;
      if (g('#aw-sm-rich-paper')) draft.richDocPaperMode = Boolean(g('#aw-sm-rich-paper').checked);
      if (g('#aw-sm-sel-menu')) draft.rightPaneSelectionMenuEnabled = Boolean(g('#aw-sm-sel-menu').checked);

      const ruleRows = modalEl.querySelectorAll('[data-aw-rule-idx]');
      if (ruleRows.length) {
        const nextEditing = [];
        ruleRows.forEach((row, i) => {
          const id = row.getAttribute('data-aw-rule-id') || `cat_${i + 1}`;
          const label = row.querySelector('.aw-sm-rule-label')?.value ?? '';
          const extensionsRaw = row.querySelector('.aw-sm-rule-exts')?.value ?? '';
          nextEditing.push({ id, label, extensionsRaw });
        });
        editingRules = nextEditing;
        const compiled = compileValidRulesFromEditing();
        if (compiled.length) draft.categoryRules = compiled;
      }

      if (g('#aw-sm-max')) draft.maxChildrenPerGroup = Math.max(1, Math.min(30, Number(g('#aw-sm-max').value || 6)));
      if (g('#aw-sm-fold')) draft.foldChildTabsInNativeBar = Boolean(g('#aw-sm-fold').checked);
      if (g('#aw-sm-preserve-tabs')) draft.preventPreviewTabOverwrite = Boolean(g('#aw-sm-preserve-tabs').checked);
      if (g('#aw-sm-auto')) draft.autoAnchorSummaryMd = Boolean(g('#aw-sm-auto').checked);
      if (g('#aw-sm-auto-update')) draft.autoCheckUpdates = Boolean(g('#aw-sm-auto-update').checked);
      if (g('#aw-sm-sectors')) draft.wheelSectors = Number(g('#aw-sm-sectors').value || 8);
      const prevTheme = draft.theme || 'auto';
      const themeSel = g('#aw-sm-theme');
      const swCheckbox = g('#aw-sm-soundwave');
      if (!draft.wheelSoundwaveByTheme || typeof draft.wheelSoundwaveByTheme !== 'object') {
        draft.wheelSoundwaveByTheme = normalizeDraftSoundwaveByTheme(draft, doc.defaultView);
      }
      if (themeSel) {
        const nextTheme = themeSel.value || 'auto';
        if (nextTheme !== prevTheme) {
          draft.theme = nextTheme;
          applyThemePreview(draft.theme);
          if (swCheckbox) {
            if (nextTheme === 'soundwave') {
              swCheckbox.checked = true;
              swCheckbox.disabled = true;
            } else {
              const remembered = Boolean(draft.wheelSoundwaveByTheme[nextTheme]);
              swCheckbox.disabled = false;
              swCheckbox.checked = remembered;
            }
          }
        } else {
          applyThemePreview(draft.theme);
          if (swCheckbox && nextTheme !== 'soundwave' && !swCheckbox.disabled) {
            draft.wheelSoundwaveByTheme[nextTheme] = Boolean(swCheckbox.checked);
          }
        }
      } else if (swCheckbox && prevTheme !== 'soundwave' && !swCheckbox.disabled) {
        draft.wheelSoundwaveByTheme[prevTheme] = Boolean(swCheckbox.checked);
      }
      draft.wheelSoundwaveEnabled = isSoundwaveCheckedForDraft(draft);
      if (g('#aw-sm-extra')) {
        draft.extraScanDirs = String(g('#aw-sm-extra').value || '')
          .split(/[,;\n]/)
          .map((x) => x.trim())
          .filter(Boolean);
      }
    }

    function updateLiveGuides(modalEl) {
      if (!modalEl || !draft) return;
      const activeKey = getActiveCardKey();
      const trigMeta = S.resolveWheelTriggerButton ? S.resolveWheelTriggerButton(draft) : { id: 'middle', shortLabel: '中键', label: '鼠标中键' };
      const hkRaw = draft.tabCustomHotkey || 'Tab';
      const hkDisplay = S.formatHotkeyLabel ? S.formatHotkeyLabel(hkRaw) : hkRaw;
      const otherMode =
        focusChannel === 'middle'
          ? (draft.tabTriggerEnabled !== false ? draft.tabMode : '')
          : draft.middleMode;
      const otherLabel = focusChannel === 'middle' ? `${hkDisplay} 已绑定` : `${trigMeta.shortLabel}已绑定`;

      modalEl.querySelectorAll('[data-aw-focus-ch]').forEach((btn) => {
        const ch = btn.getAttribute('data-aw-focus-ch');
        btn.setAttribute('data-active', ch === focusChannel ? '1' : '0');
        if (ch === 'middle') {
          btn.textContent = `鼠标呼出（${trigMeta.shortLabel}）`;
        } else if (ch === 'tab') {
          btn.textContent = `快捷键呼出（${hkDisplay}）`;
        }
      });

      const trigHint = modalEl.querySelector('#aw-sm-middle-label');
      if (trigHint) {
        const hasAsciiPrefix = /^[A-Za-z]/.test(trigMeta.label || '');
        trigHint.textContent = hasAsciiPrefix
          ? `按住 ${trigMeta.label} 呼出模式（松手即确认）`
          : `按住${trigMeta.label}呼出模式（松手即确认）`;
      }
      const trigSub = modalEl.querySelector('#aw-sm-trigger-btn-sub');
      if (trigSub) {
        if (trigMeta.id === 'left') {
          trigSub.textContent = `在空白处按住 ${trigMeta.label} 呼出（适配触控板与无中键设备；点链接仍保留原行为）`;
        } else if (trigMeta.modifier && trigMeta.modifier !== 'none') {
          trigSub.textContent = `按住 ${trigMeta.label} 呼出，完全避开 Quicker、鼠标手势与常规右键菜单`;
        } else if (trigMeta.id === 'right') {
          trigSub.textContent = '按住或拖动呼出轮盘；短按保留菜单，按住 Shift + 右键强制打开原生菜单';
        } else if (trigMeta.id === 'side_back' || trigMeta.id === 'side_forward') {
          trigSub.textContent = '在右侧栏按住对应侧键即呼出轮盘，另一颗侧键照常翻页';
        } else {
          trigSub.textContent = '默认中键按住呼出（与 Quicker 冲突时，可加修饰键或改用侧键 / 右键 / 下方快捷键）';
        }
      }

      const tabHold = draft.tabTriggerAction === 'hold';
      const recBtn = modalEl.querySelector('#aw-sm-hotkey-rec');
      if (recBtn) {
        recBtn.setAttribute('data-recording', isRecordingHotkey ? '1' : '0');
        recBtn.textContent = isRecordingHotkey ? '请按下按键…' : hkDisplay;
      }
      const resetBtn = modalEl.querySelector('#aw-sm-hotkey-reset');
      if (resetBtn) {
        resetBtn.hidden = hkRaw === 'Tab' || isRecordingHotkey;
      }
      const hkSub = modalEl.querySelector('#aw-sm-hotkey-sub');
      if (hkSub) {
        if (hotkeyFeedback) {
          hkSub.textContent = hotkeyFeedback;
          hkSub.setAttribute('data-tone', 'warn');
        } else if (isRecordingHotkey) {
          hkSub.textContent = '直接按下目标按键或组合键即可录入，按 Esc 取消录制';
          hkSub.setAttribute('data-tone', 'accent');
        } else if (tabHold) {
          hkSub.textContent = `按住 ${hkDisplay} 原地呼出，滑动光标选好目标后松开即打开（零鼠标按键冲突）`;
          hkSub.removeAttribute('data-tone');
        } else {
          hkSub.textContent = '点击右侧键帽直接按键录入（支持 Tab / ` / F1-F12 或修饰组合键）';
          hkSub.removeAttribute('data-tone');
        }
      }

      modalEl.querySelectorAll('[data-aw-tab-action]').forEach((btn) => {
        const val = btn.getAttribute('data-aw-tab-action');
        btn.setAttribute('data-active', (tabHold ? 'hold' : 'toggle') === val ? '1' : '0');
      });

      const sensId = trigMeta.sensitivity || 'balanced';
      const sensNames = { fast: '跟手', balanced: '均衡', safe: '防误触' };
      modalEl.querySelectorAll('[data-aw-sens]').forEach((btn) => {
        btn.setAttribute('data-active', btn.getAttribute('data-aw-sens') === sensId ? '1' : '0');
      });
      const advSummary = modalEl.querySelector('#aw-sm-adv-trigger-summary');
      const mainLayoutOn = Boolean(draft.mainChatLayoutWheelEnabled);
      if (advSummary) {
        advSummary.textContent = `进阶手势、防冲突与主对话布局轮盘（灵敏度：${sensNames[sensId] || '均衡'}${mainLayoutOn ? ' · 主对话轮盘已开启' : ''}）`;
      }
      const sensSub = modalEl.querySelector('#aw-sm-sens-sub');
      if (sensSub) {
        sensSub.textContent = `当前 ${trigMeta.shortLabel}：按住 ${trigMeta.holdMs}ms 或拖动 ${trigMeta.dragPx}px 即呼出`;
      }
      const mainLayoutSub = modalEl.querySelector('#aw-sm-main-layout-sub');
      if (mainLayoutSub) {
        const bareMiddle = trigMeta.id === 'middle' && (!trigMeta.modifier || trigMeta.modifier === 'none');
        mainLayoutSub.textContent = bareMiddle
          ? `在主对话空白处按住 ${trigMeta.shortLabel} 呼出 5 向布局轮盘（与右侧文档轮盘独立，自动避让输入框与按钮；使用中键将替代主对话中键自动滚屏，如需保留建议改用 Alt+右键或侧键）`
          : `在主对话空白处按住 ${trigMeta.shortLabel} 呼出 5 向布局轮盘（与右侧文档轮盘独立，自动避让输入框与按钮；仅原生窗口生效）`;
      }
      const mainLayoutMap = modalEl.querySelector('#aw-sm-main-layout-map');
      if (mainLayoutMap) {
        mainLayoutMap.hidden = !mainLayoutOn;
      }
      const layoutSlotsReset = modalEl.querySelector('#aw-sm-layout-slots-reset');
      if (layoutSlotsReset) {
        layoutSlotsReset.hidden = isDefaultLayoutSlots(draft.mainChatLayoutSlots);
      }
      const swSub = modalEl.querySelector('#aw-sm-soundwave-sub');
      if (swSub) {
        swSub.textContent =
          draft.theme === 'soundwave'
            ? '「音浪圆球」主题下默认开启且无法关闭；切换到其他主题时会按主题独立记忆开关状态'
            : '默认关闭（按主题独立记忆）：呼出轮盘后圆心保持平稳动态，光标偏向哪一侧即在对应方向涌起音浪';
      }
      const swCtrl = modalEl.querySelector('#aw-sm-soundwave');
      if (swCtrl) {
        swCtrl.disabled = draft.theme === 'soundwave';
        swCtrl.checked = isSoundwaveCheckedForDraft(draft);
      }

      const focusHintEl = modalEl.querySelector('#aw-sm-focus-hint');
      if (focusHintEl) {
        focusHintEl.textContent = !activeKey
          ? '当前查看的呼出通道已关闭，点击下方任意卡片即可重新启用'
          : '点击卡片直接设为当前通道模式，悬停其余卡片可预览动态效果';
      }

      const bilateralUsed =
        draft.middleMode === 'bilateral_wheel' ||
        (draft.tabTriggerEnabled !== false && draft.tabMode === 'bilateral_wheel');
      const treeUsed =
        draft.middleMode === 'ae_tree' ||
        (draft.tabTriggerEnabled !== false && draft.tabMode === 'ae_tree');
      const classicUsed =
        draft.middleMode === 'classic_wheel' ||
        (draft.tabTriggerEnabled !== false && draft.tabMode === 'classic_wheel');

      // Dim dependent form rows when their parent toggle/channel is disabled
      const trigRow = modalEl.querySelector('#aw-sm-row-trigger-btn');
      if (trigRow) {
        trigRow.setAttribute('data-dim', draft.middleMode === 'off' && !draft.mainChatLayoutWheelEnabled ? '1' : '0');
      }
      modalEl.querySelector('#aw-sm-row-pdir')?.setAttribute('data-dim', bilateralUsed ? '0' : '1');
      modalEl.querySelector('#aw-sm-row-sectors')?.setAttribute('data-dim', classicUsed ? '0' : '1');

      const tabOff = draft.tabTriggerEnabled === false;
      for (const id of ['#aw-sm-row-tab-mode', '#aw-sm-row-tab-key']) {
        modalEl.querySelector(id)?.setAttribute('data-dim', tabOff ? '1' : '0');
      }
      modalEl.querySelector('#aw-sm-row-tab-close')?.setAttribute('data-dim', tabOff || tabHold ? '1' : '0');
      const prevOff = draft.hoverPreviewEnabled === false;
      for (const id of ['#aw-sm-row-prev-delay', '#aw-sm-row-prev-anim']) {
        modalEl.querySelector(id)?.setAttribute('data-dim', prevOff ? '1' : '0');
      }
      const docOff = draft.richDocPreviewEnabled === false;
      modalEl.querySelector('#aw-sm-row-rich-strategy')?.setAttribute('data-dim', docOff ? '1' : '0');
      modalEl.querySelector('#aw-sm-row-rich-paper')?.setAttribute('data-dim', docOff ? '1' : '0');

      modalEl.querySelectorAll('[data-aw-guide-card]').forEach((card) => {
        const key = card.getAttribute('data-aw-guide-card');
        const isPrimary = key === activeKey;
        card.setAttribute('data-card-state', isPrimary ? 'active' : 'dimmed');
        card.setAttribute('aria-pressed', isPrimary ? 'true' : 'false');

        const chip = card.querySelector('.aw-guide-chip');
        if (chip) {
          if (isPrimary) {
            chip.textContent = focusChannel === 'middle' ? `${trigMeta.shortLabel}使用中` : `${hkDisplay} 使用中`;
            chip.setAttribute('data-tone', 'active');
            chip.hidden = false;
          } else if (key === otherMode && otherMode !== 'off') {
            chip.textContent = otherLabel;
            chip.setAttribute('data-tone', 'secondary');
            chip.hidden = false;
          } else {
            chip.hidden = true;
          }
        }

        const svgHost = card.querySelector('.aw-guide-svg-host');
        if (svgHost) svgHost.innerHTML = S.renderModeGuideSvg(key, draft);
      });

      // Live mini previews on categories tab (mark unused mode visibly so it never misleads)
      const catMini = modalEl.querySelector('#aw-sm-cat-live-preview');
      if (catMini) {
        catMini.setAttribute('data-narrow-active', activeCatPreview);
        const biCol = catMini.querySelector('[data-aw-mini-col="bilateral"]');
        const trCol = catMini.querySelector('[data-aw-mini-col="tree"]');
        if (biCol) {
          biCol.setAttribute('data-unused', bilateralUsed ? '0' : '1');
          biCol.innerHTML = S.renderModeGuideSvg('bilateral_wheel', draft);
        }
        if (trCol) {
          trCol.setAttribute('data-unused', treeUsed ? '0' : '1');
          trCol.innerHTML = S.renderModeGuideSvg('ae_tree', draft);
        }
      }
    }

    function buildCategoryRuleRowsHtml() {
      const canDel = editingRules.length > 1;
      const canReorder = editingRules.length > 1;
      return (
        editingRules
          .map(
            (r, i) => `
          <div class="aw-rule-row" data-aw-rule-idx="${i}" data-aw-rule-id="${S.esc(r.id)}">
            <button type="button" class="aw-rule-drag-handle" data-drag-idx="${i}" aria-label="拖动调整分类顺序" title="按住上下拖动调整轮盘分类顺序（或按 Alt+↑ / Alt+↓）" ${canReorder ? '' : 'disabled'}>${S.ICONS.grip || '⋮⋮'}</button>
            <input type="text" class="aw-input aw-sm-rule-label aw-reactive-ctrl" value="${S.esc(r.label)}" maxlength="12" placeholder="分类名" />
            <input type="text" class="aw-input aw-sm-rule-exts aw-reactive-ctrl" value="${S.esc(r.extensionsRaw)}" placeholder="扩展名，如 png, jpg, svg" />
            <button type="button" class="aw-tray-btn aw-sm-del-rule" data-del-idx="${i}" title="删除此分类" ${canDel ? '' : 'disabled'}>${S.ICONS.trash}</button>
          </div>`
          )
          .join('') +
        `<div class="aw-rule-row aw-rule-locked">
          <span class="aw-rule-drag-spacer" aria-hidden="true"></span>
          <input type="text" class="aw-input" value="其他" disabled />
          <input type="text" class="aw-input" value="未归入上述分类的全部文件与文件夹（固定在末尾）" disabled />
          <span class="aw-link-row-badge">固定</span>
        </div>`
      );
    }

    function reindexRuleRowsInDom(listEl) {
      if (!listEl) return;
      const rows = listEl.querySelectorAll('.aw-rule-row[data-aw-rule-idx]');
      rows.forEach((row, idx) => {
        row.setAttribute('data-aw-rule-idx', String(idx));
        const h = row.querySelector('.aw-rule-drag-handle');
        if (h) h.setAttribute('data-drag-idx', String(idx));
        const d = row.querySelector('.aw-sm-del-rule');
        if (d) d.setAttribute('data-del-idx', String(idx));
      });
    }

    function swapRuleOrder(modalEl, fromIdx, toIdx, { rerenderDom = true, focusRowIdx = -1 } = {}) {
      if (fromIdx === toIdx) return false;
      if (fromIdx < 0 || toIdx < 0 || fromIdx >= editingRules.length || toIdx >= editingRules.length) return false;
      const [moved] = editingRules.splice(fromIdx, 1);
      editingRules.splice(toIdx, 0, moved);
      const compiled = compileValidRulesFromEditing();
      if (compiled.length && draft) draft.categoryRules = compiled;
      if (rerenderDom) {
        renderCategoryRulesDom(modalEl, { focusLast: false });
        if (focusRowIdx >= 0) {
          const targetHandle = modalEl.querySelector(`.aw-rule-row[data-aw-rule-idx="${focusRowIdx}"] .aw-rule-drag-handle`);
          targetHandle?.focus();
        }
      } else {
        updateLiveGuides(modalEl);
      }
      return true;
    }

    function bindRuleRowEvents(modalEl) {
      const listEl = modalEl.querySelector('.aw-rule-list');
      modalEl.querySelectorAll('.aw-rule-list .aw-reactive-ctrl').forEach((ctrl) => {
        ctrl.addEventListener('input', () => {
          syncDraftFromDom(modalEl);
          updateLiveGuides(modalEl);
        });
      });
      modalEl.querySelectorAll('.aw-rule-row[data-aw-rule-idx]').forEach((row) => {
        row.addEventListener('keydown', (e) => {
          if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
          e.preventDefault();
          e.stopPropagation();
          syncDraftFromDom(modalEl);
          const idx = Number(row.getAttribute('data-aw-rule-idx'));
          const nextIdx = e.key === 'ArrowUp' ? idx - 1 : idx + 1;
          swapRuleOrder(modalEl, idx, nextIdx, { rerenderDom: true, focusRowIdx: nextIdx });
        });
      });
      modalEl.querySelectorAll('.aw-rule-drag-handle').forEach((handle) => {
        handle.addEventListener('pointerdown', (e) => {
          if (e.button !== 0 || editingRules.length <= 1 || !listEl) return;
          const row = handle.closest('.aw-rule-row[data-aw-rule-idx]');
          if (!row) return;
          e.preventDefault();
          e.stopPropagation();
          syncDraftFromDom(modalEl);

          let curIdx = Number(row.getAttribute('data-aw-rule-idx'));
          row.setAttribute('data-dragging', '1');
          listEl.setAttribute('data-reordering', '1');
          try { handle.setPointerCapture?.(e.pointerId); } catch {}

          const onMove = (mv) => {
            mv.preventDefault();
            const customRows = Array.from(listEl.querySelectorAll('.aw-rule-row[data-aw-rule-idx]'));
            if (curIdx > 0) {
              const prevRow = customRows[curIdx - 1];
              const prevRect = prevRow?.getBoundingClientRect();
              if (prevRect && mv.clientY < prevRect.top + prevRect.height * 0.52) {
                listEl.insertBefore(row, prevRow);
                reindexRuleRowsInDom(listEl);
                swapRuleOrder(modalEl, curIdx, curIdx - 1, { rerenderDom: false });
                curIdx -= 1;
                return;
              }
            }
            if (curIdx < customRows.length - 1) {
              const nextRow = customRows[curIdx + 1];
              const nextRect = nextRow?.getBoundingClientRect();
              if (nextRect && mv.clientY > nextRect.top + nextRect.height * 0.48) {
                listEl.insertBefore(nextRow, row);
                reindexRuleRowsInDom(listEl);
                swapRuleOrder(modalEl, curIdx, curIdx + 1, { rerenderDom: false });
                curIdx += 1;
              }
            }
          };

          const finishDrag = () => {
            doc.removeEventListener('pointermove', onMove, true);
            doc.removeEventListener('pointerup', finishDrag, true);
            doc.removeEventListener('pointercancel', finishDrag, true);
            row.removeAttribute('data-dragging');
            listEl.removeAttribute('data-reordering');
            try { handle.releasePointerCapture?.(e.pointerId); } catch {}
            syncDraftFromDom(modalEl);
            updateLiveGuides(modalEl);
          };

          doc.addEventListener('pointermove', onMove, true);
          doc.addEventListener('pointerup', finishDrag, true);
          doc.addEventListener('pointercancel', finishDrag, true);
        });
      });
      modalEl.querySelectorAll('.aw-sm-del-rule').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          syncDraftFromDom(modalEl);
          const idx = Number(btn.getAttribute('data-del-idx'));
          if (editingRules.length > 1 && idx >= 0 && idx < editingRules.length) {
            editingRules.splice(idx, 1);
            const compiled = compileValidRulesFromEditing();
            if (compiled.length) draft.categoryRules = compiled;
            renderCategoryRulesDom(modalEl, { focusLast: false });
          }
        });
      });
    }

    function renderCategoryRulesDom(modalEl, { focusLast = false } = {}) {
      const listEl = modalEl.querySelector('.aw-rule-list');
      const bodyEl = modalEl.querySelector('.aw-settings-body');
      const prevScroll = bodyEl ? bodyEl.scrollTop : 0;
      if (listEl) {
        listEl.innerHTML = buildCategoryRuleRowsHtml();
        bindRuleRowEvents(modalEl);
      }
      const addBtn = modalEl.querySelector('#aw-sm-add-rule');
      if (addBtn) {
        addBtn.disabled = editingRules.length >= 8;
      }
      const countBadge = modalEl.querySelector('#aw-sm-rule-count');
      if (countBadge) {
        countBadge.textContent = `${editingRules.length}/8 类 + 兜底`;
      }
      updateLiveGuides(modalEl);
      if (bodyEl) {
        bodyEl.scrollTop = prevScroll;
      }
      if (focusLast && listEl) {
        const inputs = listEl.querySelectorAll('.aw-sm-rule-label');
        const lastInput = inputs[inputs.length - 1];
        if (lastInput) {
          lastInput.focus();
          lastInput.select();
          lastInput.scrollIntoView({ block: 'nearest' });
        }
      }
    }

    function renderUpdateBoxHtml(upd, pluginVer, fallbackReleasesUrl, ignoredVer = '') {
      const releasesUrl = upd?.releasesUrl || fallbackReleasesUrl || 'https://github.com/Curelove/agy-anchor-wheel/releases';
      if (!upd) {
        return `
          <div class="aw-update-status-row">
            <span>当前版本 <strong>v${S.esc(pluginVer)}</strong> · 点击右侧按钮即可从 GitHub Releases 检查新版</span>
            <a class="aw-inline-link" href="${S.esc(releasesUrl)}" target="_blank" rel="noopener">查看 Releases</a>
          </div>
        `;
      }
      if (!upd.ok) {
        return `
          <div class="aw-update-status-row">
            <span>${S.esc(upd.error || '更新检查暂不可用')}</span>
            <a class="aw-inline-link" href="${S.esc(upd.releaseUrl || releasesUrl)}" target="_blank" rel="noopener">前往 Releases 页</a>
          </div>
        `;
      }
      const dateStr = upd.publishedAt ? String(upd.publishedAt).slice(0, 10) : '';
      const targetAgy = upd.targetAntigravity ? ` · 适配 ${S.esc(upd.targetAntigravity)}` : '';
      const st = S.computeUpdateStateClient
        ? S.computeUpdateStateClient(upd, ignoredVer)
        : { updateAvailable: Boolean(upd.updateAvailable), isIgnored: Boolean(upd.isIgnored), ignoredVersion: ignoredVer };

      if (st.updateAvailable) {
        return `
          <div class="aw-update-status-row">
            <span><strong>发现新版本 v${S.esc(upd.latestVersion)}</strong>（当前 v${S.esc(upd.currentVersion)}${dateStr ? ` · ${S.esc(dateStr)}` : ''}${targetAgy}）</span>
            ${st.isIgnored ? `<span class="aw-update-ignored-tag">已忽略 v${S.esc(upd.latestVersion)} · 更高版本发布时恢复提醒</span>` : ''}
          </div>
          ${upd.bodySnippet ? `<div class="aw-update-notes">${S.esc(upd.bodySnippet)}</div>` : ''}
          <div class="aw-update-actions">
            <a class="aw-primary-btn aw-inline-link" href="${S.esc(upd.releaseUrl || releasesUrl)}" target="_blank" rel="noopener">下载 v${S.esc(upd.latestVersion)}</a>
            ${
              st.isIgnored
                ? `<button type="button" class="aw-ghost-btn" id="aw-sm-unignore-update">取消忽略</button>`
                : `<button type="button" class="aw-ghost-btn" id="aw-sm-ignore-update" data-aw-ignore-ver="${S.esc(upd.latestVersion)}">忽略此版本</button>`
            }
            <button type="button" class="aw-ghost-btn" id="aw-sm-copy-update-cmd">复制更新命令</button>
          </div>
        `;
      }
      return `
        <div class="aw-update-status-row">
          <span><strong>已是最新版本 v${S.esc(upd.currentVersion || pluginVer)}</strong>${dateStr ? `（最新 Release 发布于 ${S.esc(dateStr)}${targetAgy}）` : ''}</span>
          <a class="aw-inline-link" href="${S.esc(upd.releaseUrl || releasesUrl)}" target="_blank" rel="noopener">查看更新日志</a>
        </div>
      `;
    }

    function bindUpdateBoxButtons(modalEl) {
      const box = modalEl.querySelector('#aw-sm-update-box');
      const pluginVer = currentCallbacks?.versionInfo?.version || '';
      const fallbackRel = currentCallbacks?.versionInfo?.releasesUrl || 'https://github.com/Curelove/agy-anchor-wheel/releases';

      const ignoreBtn = modalEl.querySelector('#aw-sm-ignore-update');
      if (ignoreBtn) {
        ignoreBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const ver = ignoreBtn.getAttribute('data-aw-ignore-ver') || currentCallbacks?.updateInfo?.latestVersion || '';
          if (!ver) return;
          if (draft) draft.ignoredUpdateVersion = ver;
          if (currentCallbacks?.onIgnoreUpdate) {
            const res = await currentCallbacks.onIgnoreUpdate(ver);
            if (res?.updateInfo || res?.update) {
              currentCallbacks.updateInfo = res.updateInfo || res.update;
            }
          }
          if (box) {
            box.innerHTML = renderUpdateBoxHtml(currentCallbacks?.updateInfo || null, pluginVer, fallbackRel, draft?.ignoredUpdateVersion || ver);
            bindUpdateBoxButtons(modalEl);
          }
        });
      }

      const unignoreBtn = modalEl.querySelector('#aw-sm-unignore-update');
      if (unignoreBtn) {
        unignoreBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (draft) draft.ignoredUpdateVersion = '';
          if (currentCallbacks?.onIgnoreUpdate) {
            const res = await currentCallbacks.onIgnoreUpdate('');
            if (res?.updateInfo || res?.update) {
              currentCallbacks.updateInfo = res.updateInfo || res.update;
            }
          }
          if (box) {
            box.innerHTML = renderUpdateBoxHtml(currentCallbacks?.updateInfo || null, pluginVer, fallbackRel, '');
            bindUpdateBoxButtons(modalEl);
          }
        });
      }

      const copyBtn = modalEl.querySelector('#aw-sm-copy-update-cmd');
      if (copyBtn) {
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const cmd = 'git pull && npm run install:plugin';
          try {
            doc.defaultView?.navigator?.clipboard?.writeText?.(cmd);
            copyBtn.textContent = '已复制命令';
            setTimeout(() => { copyBtn.textContent = '复制更新命令'; }, 1600);
          } catch {
            copyBtn.textContent = cmd;
          }
        });
      }
    }

    function applyCardSelection(modalEl, key) {
      if (!draft) return;
      if (key === 'ae_tree') {
        focusChannel = 'tab';
        draft.tabTriggerEnabled = true;
        draft.tabMode = 'ae_tree';
      } else if (focusChannel === 'tab') {
        draft.tabTriggerEnabled = true;
        draft.tabMode = key;
      } else {
        draft.middleMode = key;
      }

      const midSel = modalEl.querySelector('#aw-sm-middle');
      const tabEn = modalEl.querySelector('#aw-sm-tab-en');
      const tabSel = modalEl.querySelector('#aw-sm-tab-mode');
      if (midSel) midSel.value = draft.middleMode || 'bilateral_wheel';
      if (tabEn) tabEn.checked = draft.tabTriggerEnabled !== false;
      if (tabSel) tabSel.value = draft.tabMode || 'ae_tree';
      updateLiveGuides(modalEl);
    }

    function render() {
      if (!backdropEl || !draft) return;
      const modal = backdropEl.querySelector('.aw-settings-modal');
      if (!modal) return;

      const s = draft;
      const evicted = Array.isArray(currentCallbacks?.evicted) ? currentCallbacks.evicted : [];
      const cdp = currentCallbacks?.cdpStatus || null;

      let tabBody = '';
      if (activeTab === 'modes') {
        tabBody = `
          <div class="aw-focus-bar">
            <div class="aw-tray">
              <button type="button" class="aw-tray-btn" data-aw-focus-ch="middle" data-active="${focusChannel === 'middle' ? '1' : '0'}">鼠标呼出（中键）</button>
              <button type="button" class="aw-tray-btn" data-aw-focus-ch="tab" data-active="${focusChannel === 'tab' ? '1' : '0'}">快捷键呼出（Tab）</button>
            </div>
            <span class="aw-focus-hint" id="aw-sm-focus-hint">点击卡片直接设为当前通道模式，悬停其余卡片可预览动态效果</span>
          </div>

          <div class="aw-guide-grid">
            ${CARD_META.map(
              (c) => `
              <button type="button" class="aw-guide-card" data-aw-guide-card="${c.key}" data-card-state="dimmed">
                <div class="aw-guide-head">
                  <strong>${c.title}</strong>
                  <span class="aw-guide-chip" hidden></span>
                </div>
                <div class="aw-guide-svg-host">${S.renderModeGuideSvg(c.key, s)}</div>
                <div class="aw-guide-meta">
                  <span>${c.desc}</span>
                </div>
              </button>`
            ).join('')}
          </div>

          <div class="aw-settings-group">
            <div class="aw-settings-group-title">呼出方式与布局参数</div>
            <div class="aw-form-row">
              <div class="aw-form-label">
                <strong id="aw-sm-middle-label">按住鼠标中键呼出模式（松手即确认）</strong>
                <span>仅呈现可划选目标，移到空白或圈外松手取消</span>
              </div>
              <select id="aw-sm-middle" class="aw-select aw-reactive-ctrl">
                <option value="bilateral_wheel" ${s.middleMode === 'bilateral_wheel' ? 'selected' : ''}>双侧分类轮盘</option>
                <option value="classic_wheel" ${s.middleMode === 'classic_wheel' ? 'selected' : ''}>母页分组轮盘</option>
                <option value="off" ${s.middleMode === 'off' ? 'selected' : ''}>关闭鼠标呼出</option>
              </select>
            </div>
            <div class="aw-form-row" id="aw-sm-row-trigger-btn">
              <div class="aw-form-label">
                <strong>鼠标触发按键</strong>
                <span id="aw-sm-trigger-btn-sub">默认中键按住呼出（与 Quicker 冲突时，可加修饰键或改用侧键 / 右键 / 下方快捷键）</span>
              </div>
              <div class="aw-combo-ctrl">
                <select id="aw-sm-trigger-mod" class="aw-select aw-reactive-ctrl" aria-label="修饰键">
                  <option value="none" ${(s.wheelTriggerModifier || 'none') === 'none' ? 'selected' : ''}>无修饰</option>
                  <option value="alt" ${s.wheelTriggerModifier === 'alt' ? 'selected' : ''}>${S.isMacPlatform?.() ? 'Option' : 'Alt'}</option>
                  <option value="shift" ${s.wheelTriggerModifier === 'shift' ? 'selected' : ''}>Shift</option>
                  <option value="ctrl" ${s.wheelTriggerModifier === 'ctrl' ? 'selected' : ''}>Ctrl</option>
                </select>
                <span class="aw-combo-plus" aria-hidden="true">+</span>
                <select id="aw-sm-trigger-btn" class="aw-select aw-reactive-ctrl" aria-label="鼠标按键">
                  <option value="middle" ${(s.wheelTriggerButton || 'middle') === 'middle' ? 'selected' : ''}>鼠标中键</option>
                  <option value="right" ${s.wheelTriggerButton === 'right' ? 'selected' : ''}>鼠标右键</option>
                  <option value="side_back" ${s.wheelTriggerButton === 'side_back' ? 'selected' : ''}>侧键 1（后退）</option>
                  <option value="side_forward" ${s.wheelTriggerButton === 'side_forward' ? 'selected' : ''}>侧键 2（前进）</option>
                  <option value="left" ${s.wheelTriggerButton === 'left' ? 'selected' : ''}>鼠标左键（空白区）</option>
                </select>
              </div>
            </div>
            <div class="aw-form-row" id="aw-sm-row-pdir">
              <div class="aw-form-label">
                <strong>双侧轮盘中「母页」所在方向</strong>
                <span>调节后上方双侧轮盘示意图立即同步旋转</span>
              </div>
              <select id="aw-sm-pdir" class="aw-select aw-reactive-ctrl">
                <option value="left" ${s.parentDirection === 'left' ? 'selected' : ''}>左侧返回母页（右侧展开子页）</option>
                <option value="right" ${s.parentDirection === 'right' ? 'selected' : ''}>右侧返回母页（左侧展开子页）</option>
                <option value="top" ${s.parentDirection === 'top' ? 'selected' : ''}>上方返回母页（下方展开子页）</option>
                <option value="bottom" ${s.parentDirection === 'bottom' ? 'selected' : ''}>下方返回母页（上方展开子页）</option>
              </select>
            </div>
            <div class="aw-form-row" id="aw-sm-row-sectors">
              <div class="aw-form-label">
                <strong>母页分组轮盘每页扇区数</strong>
                <span>仅在启用「母页分组轮盘」时生效，上方右侧卡片实时同步</span>
              </div>
              <select id="aw-sm-sectors" class="aw-select aw-reactive-ctrl">
                <option value="4" ${Number(s.wheelSectors) === 4 ? 'selected' : ''}>4 扇区</option>
                <option value="6" ${Number(s.wheelSectors) === 6 ? 'selected' : ''}>6 扇区</option>
                <option value="8" ${Number(s.wheelSectors || 8) === 8 ? 'selected' : ''}>8 扇区</option>
              </select>
            </div>
            <div class="aw-form-row">
              <div class="aw-form-label">
                <strong>启用快捷键呼出导览</strong>
                <span>阅读文档时生效，聊天框、搜索框与代码编辑框内自动放行</span>
              </div>
              <input type="checkbox" id="aw-sm-tab-en" class="aw-reactive-ctrl" ${s.tabTriggerEnabled !== false ? 'checked' : ''} />
            </div>
            <div class="aw-form-row" id="aw-sm-row-tab-mode">
              <div class="aw-form-label">
                <strong>快捷键呼出的视图样式</strong>
                <span>可配合下方「按住松手」实现零鼠标冲突轮盘划选</span>
              </div>
              <select id="aw-sm-tab-mode" class="aw-select aw-reactive-ctrl">
                <option value="ae_tree" ${s.tabMode === 'ae_tree' ? 'selected' : ''}>竖向层级树</option>
                <option value="bilateral_wheel" ${s.tabMode === 'bilateral_wheel' ? 'selected' : ''}>双侧分类轮盘</option>
                <option value="classic_wheel" ${s.tabMode === 'classic_wheel' ? 'selected' : ''}>母页分组轮盘</option>
              </select>
            </div>
            <div class="aw-form-row" id="aw-sm-row-tab-key">
              <div class="aw-form-label">
                <strong>快捷键与呼出方式</strong>
                <span id="aw-sm-hotkey-sub">点击右侧键帽直接按键录入（支持 Tab / \` / F1-F12 或修饰组合键）</span>
              </div>
              <div class="aw-hotkey-ctrl">
                <button type="button" id="aw-sm-hotkey-rec" class="aw-hotkey-btn" data-recording="0" title="点击后直接按下新快捷键，Esc 取消">${S.esc(S.formatHotkeyLabel ? S.formatHotkeyLabel(s.tabCustomHotkey || 'Tab') : (s.tabCustomHotkey || 'Tab'))}</button>
                <button type="button" id="aw-sm-hotkey-reset" class="aw-hotkey-reset" title="恢复为默认 Tab 键" ${(s.tabCustomHotkey || 'Tab') === 'Tab' ? 'hidden' : ''}>恢复</button>
                <div class="aw-tray" role="group" aria-label="快捷键呼出方式">
                  <button type="button" class="aw-tray-btn" data-aw-tab-action="toggle" data-active="${s.tabTriggerAction !== 'hold' ? '1' : '0'}">按一下开关</button>
                  <button type="button" class="aw-tray-btn" data-aw-tab-action="hold" data-active="${s.tabTriggerAction === 'hold' ? '1' : '0'}">按住松手</button>
                </div>
              </div>
            </div>
            <div class="aw-form-row" id="aw-sm-row-tab-close">
              <div class="aw-form-label">
                <strong>点选跳转后自动收起浮层</strong>
                <span>关闭时可连续点选多个文档对比，直到再按快捷键关闭</span>
              </div>
              <input type="checkbox" id="aw-sm-tab-close" class="aw-reactive-ctrl" ${s.tabCloseOnSelect ? 'checked' : ''} />
            </div>
            <details class="aw-settings-fold" id="aw-sm-adv-trigger" ${advTriggerExpanded ? 'open' : ''}>
              <summary id="aw-sm-adv-trigger-summary">进阶手势、防冲突与主对话布局轮盘（灵敏度：均衡）</summary>
              <div class="aw-settings-fold-body">
                <div class="aw-form-row">
                  <div class="aw-form-label">
                    <strong>鼠标按住触发灵敏度</strong>
                    <span id="aw-sm-sens-sub">当前中键：按住 115ms 或拖动 8px 即呼出</span>
                  </div>
                  <div class="aw-tray" role="group" aria-label="触发灵敏度">
                    <button type="button" class="aw-tray-btn" data-aw-sens="fast" data-active="${s.wheelHoldSensitivity === 'fast' ? '1' : '0'}">跟手</button>
                    <button type="button" class="aw-tray-btn" data-aw-sens="balanced" data-active="${(s.wheelHoldSensitivity || 'balanced') === 'balanced' ? '1' : '0'}">均衡</button>
                    <button type="button" class="aw-tray-btn" data-aw-sens="safe" data-active="${s.wheelHoldSensitivity === 'safe' ? '1' : '0'}">防误触</button>
                  </div>
                </div>
                <div class="aw-form-row">
                  <div class="aw-form-label">
                    <strong>启用主对话窗口 5 向布局轮盘（默认关闭）</strong>
                    <span id="aw-sm-main-layout-sub">在主对话空白处按住中键呼出 5 向布局轮盘（与右侧文档轮盘独立，自动避让输入框与按钮；仅原生窗口生效）</span>
                  </div>
                  <input type="checkbox" id="aw-sm-main-layout-wheel" class="aw-reactive-ctrl" ${s.mainChatLayoutWheelEnabled ? 'checked' : ''} />
                </div>
                <div class="aw-layout-slot-editor" id="aw-sm-main-layout-map" ${s.mainChatLayoutWheelEnabled ? '' : 'hidden'}>
                  <div class="aw-layout-slot-head">
                    <span>5 向扇区自定义（选已用项自动对调）</span>
                    <button type="button" class="aw-hotkey-reset" id="aw-sm-layout-slots-reset" ${isDefaultLayoutSlots(s.mainChatLayoutSlots) ? 'hidden' : ''}>恢复默认</button>
                  </div>
                  <div class="aw-layout-slot-grid">
                    <div class="aw-layout-slot-col">
                      ${buildLayoutSlotRowHtml('top_left', '左上', normalizeDraftLayoutSlots(s.mainChatLayoutSlots).top_left)}
                      ${buildLayoutSlotRowHtml('mid_left', '左中', normalizeDraftLayoutSlots(s.mainChatLayoutSlots).mid_left)}
                      ${buildLayoutSlotRowHtml('bottom_left', '左下', normalizeDraftLayoutSlots(s.mainChatLayoutSlots).bottom_left)}
                    </div>
                    <div class="aw-layout-slot-col">
                      ${buildLayoutSlotRowHtml('top_right', '右上', normalizeDraftLayoutSlots(s.mainChatLayoutSlots).top_right)}
                      ${buildLayoutSlotRowHtml('bottom_right', '右下', normalizeDraftLayoutSlots(s.mainChatLayoutSlots).bottom_right)}
                    </div>
                  </div>
                </div>
                <div class="aw-fold-note">与 Quicker / MouseInc / WGestures 等全局工具共存时，可改用修饰键组合，或用「按住快捷键松手」（快捷键仅作用于右侧文档导览）；也支持在 Quicker / 鼠标宏中向 Antigravity 发送上方自定义快捷键实现联动。</div>
              </div>
            </details>
          </div>
        `;
      } else if (activeTab === 'categories') {
        tabBody = `
          <div class="aw-mini-preview-narrow-bar">
            <span class="aw-focus-hint">分类与预览实时示意图</span>
            <div class="aw-tray">
              <button type="button" class="aw-tray-btn" data-aw-cat-prev="bilateral" data-active="${activeCatPreview === 'bilateral' ? '1' : '0'}">双侧轮盘</button>
              <button type="button" class="aw-tray-btn" data-aw-cat-prev="tree" data-active="${activeCatPreview === 'tree' ? '1' : '0'}">层级树</button>
            </div>
          </div>
          <div class="aw-mini-preview-strip" id="aw-sm-cat-live-preview" data-narrow-active="${activeCatPreview}">
            <div class="aw-mini-preview-col" data-aw-mini-col="bilateral">${S.renderModeGuideSvg('bilateral_wheel', s)}</div>
            <div class="aw-mini-preview-col" data-aw-mini-col="tree">${S.renderModeGuideSvg('ae_tree', s)}</div>
          </div>

          <div class="aw-settings-group">
            <div class="aw-settings-group-title">双侧轮盘自定义分类规则</div>
            <div class="aw-rule-header">
              <div style="display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap">
                <span class="aw-focus-hint">按住每行左侧 ⋮⋮ 手柄上下拖动即可调整扇区顺序</span>
                <span class="aw-link-row-badge" id="aw-sm-rule-count">${editingRules.length}/8 类 + 兜底</span>
              </div>
              <button type="button" class="aw-ghost-btn" id="aw-sm-add-rule" ${editingRules.length >= 8 ? 'disabled' : ''}>${S.ICONS.plus} 新增分类</button>
            </div>
            <div class="aw-rule-list">${buildCategoryRuleRowsHtml()}</div>
          </div>

          <div class="aw-settings-group">
            <div class="aw-settings-group-title">子页范围、内容预览与右键菜单</div>
            <div class="aw-form-row">
              <div class="aw-form-label">
                <strong>默认展示的子页范围</strong>
                <span>浮层顶部仍可随时一键切换</span>
              </div>
              <select id="aw-sm-scope" class="aw-select aw-reactive-ctrl">
                <option value="opened_and_outlinks" ${s.childSourceScope !== 'opened_only' ? 'selected' : ''}>已打开子标签 + 文中本地链接（已打开置顶）</option>
                <option value="opened_only" ${s.childSourceScope === 'opened_only' ? 'selected' : ''}>仅显示已打开或归入分组的子标签</option>
              </select>
            </div>
            <div class="aw-form-row">
              <div class="aw-form-label">
                <strong>右侧栏选中文字时启用快捷右键菜单</strong>
                <span>提供复制、引用选中片段到对话框、进入侧栏编辑并定位（不影响左侧聊天与文件胶囊右键菜单）</span>
              </div>
              <input type="checkbox" id="aw-sm-sel-menu" class="aw-reactive-ctrl" ${s.rightPaneSelectionMenuEnabled !== false ? 'checked' : ''} />
            </div>
            <div class="aw-form-row">
              <div class="aw-form-label">
                <strong>开启光标悬停内容预览</strong>
                <span>显示文档开头摘要、图片缩略图与视频开头画面</span>
              </div>
              <input type="checkbox" id="aw-sm-prev-en" class="aw-reactive-ctrl" ${s.hoverPreviewEnabled !== false ? 'checked' : ''} />
            </div>
            <div class="aw-form-row" id="aw-sm-row-prev-delay">
              <div class="aw-form-label">
                <strong>悬停触发延迟</strong>
                <span>减少快速扫过时的干扰</span>
              </div>
              <select id="aw-sm-prev-delay" class="aw-select aw-reactive-ctrl">
                <option value="120" ${Number(s.hoverPreviewDelayMs) <= 150 ? 'selected' : ''}>120 毫秒（灵敏）</option>
                <option value="250" ${Number(s.hoverPreviewDelayMs) > 150 && Number(s.hoverPreviewDelayMs) <= 320 ? 'selected' : ''}>250 毫秒（推荐）</option>
                <option value="450" ${Number(s.hoverPreviewDelayMs) > 320 ? 'selected' : ''}>450 毫秒（稳重）</option>
              </select>
            </div>
            <div class="aw-form-row" id="aw-sm-row-prev-anim">
              <div class="aw-form-label">
                <strong>视频跳过黑帧生成 3 秒动态预览</strong>
                <span>先秒出非黑帧截图，后台异步缓存压缩动态图</span>
              </div>
              <input type="checkbox" id="aw-sm-prev-anim" class="aw-reactive-ctrl" ${s.videoPreviewAnimated !== false ? 'checked' : ''} />
            </div>
            <div class="aw-form-row">
              <div class="aw-form-label">
                <strong>启用右侧栏多格式文件与视频预览</strong>
                <span>支持 MOV / MKV / AVI 等多格式视频、Word / Excel / PPT 真实画布、Notebook、SQLite、三维模型与压缩包</span>
              </div>
              <input type="checkbox" id="aw-sm-rich-doc" class="aw-reactive-ctrl" ${s.richDocPreviewEnabled !== false ? 'checked' : ''} />
            </div>
            <div class="aw-form-row" id="aw-sm-row-rich-strategy">
              <div class="aw-form-label">
                <strong>与 Antigravity 官方视图的优先关系</strong>
                <span>官方优先模式下，文本代码等默认保持官方页面，仅在官方无法预览该格式时接管</span>
              </div>
              <select id="aw-sm-rich-strategy" class="aw-select aw-reactive-ctrl">
                <option value="auto_yield" ${(s.richDocAutoStrategy || 'auto_yield') === 'auto_yield' ? 'selected' : ''}>官方优先（推荐：仅在官方无法预览时接管）</option>
                <option value="always_plugin" ${s.richDocAutoStrategy === 'always_plugin' ? 'selected' : ''}>始终使用插件预览</option>
                <option value="manual_only" ${s.richDocAutoStrategy === 'manual_only' ? 'selected' : ''}>仅手动点击时开启</option>
              </select>
            </div>
            <div class="aw-form-row" id="aw-sm-row-rich-paper">
              <div class="aw-form-label">
                <strong>Word 等文稿默认采用纸面原稿外观</strong>
                <span>关闭时与 Antigravity 官方平铺底色一致；开启则显示白纸黑字页框</span>
              </div>
              <input type="checkbox" id="aw-sm-rich-paper" class="aw-reactive-ctrl" ${s.richDocPaperMode ? 'checked' : ''} />
            </div>
          </div>
        `;
      } else {
        tabBody = `
          <div class="aw-settings-group">
            <div class="aw-settings-group-title">界面外观</div>
            <div class="aw-form-row">
              <div class="aw-form-label"><strong>界面主题（适配 obsidian-prism）</strong><span>切换后立即实时预览配色效果</span></div>
              <select id="aw-sm-theme" class="aw-select aw-reactive-ctrl">
                <option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>跟随宿主</option>
                <option value="soundwave" ${s.theme === 'soundwave' ? 'selected' : ''}>音浪圆球（深色动态）</option>
                <option value="obsidian" ${s.theme === 'obsidian' ? 'selected' : ''}>深空黑曜</option>
                <option value="warm" ${s.theme === 'warm' ? 'selected' : ''}>暖炭玄岩</option>
                <option value="crystal" ${s.theme === 'crystal' ? 'selected' : ''}>白昼冷晶</option>
                <option value="alabaster" ${s.theme === 'alabaster' ? 'selected' : ''}>暖白画册</option>
              </select>
            </div>
            <div class="aw-form-row">
              <div class="aw-form-label">
                <strong>开启轮盘音浪球动态效果</strong>
                <span id="aw-sm-soundwave-sub">${
                  s.theme === 'soundwave'
                    ? '「音浪圆球」主题下默认开启且无法关闭；切换到其他主题时会按主题独立记忆开关状态'
                    : '默认关闭（按主题独立记忆）：呼出轮盘后圆心保持平稳动态，光标偏向哪一侧即在对应方向涌起音浪'
                }</span>
              </div>
              <input type="checkbox" id="aw-sm-soundwave" class="aw-reactive-ctrl" ${isSoundwaveCheckedForDraft(s) ? 'checked' : ''} ${s.theme === 'soundwave' ? 'disabled' : ''} />
            </div>
          </div>

          <div class="aw-settings-group">
            <div class="aw-settings-group-title">标签组收纳与扫描目录</div>
            ${
              cdp !== null
                ? `<div class="aw-form-row">
                    <div class="aw-form-label"><strong>原生侧栏连接状态</strong><span>${cdp.connected ? `已连接主窗口（端口 ${cdp.port}）` : '当前未连接调试端口'}</span></div>
                    ${!cdp.connected && currentCallbacks?.onGenerateLauncher ? '<button type="button" id="aw-sm-launcher" class="aw-ghost-btn">生成调试启动器</button>' : `<span class="aw-link-row-badge">${cdp.connected ? '已在线' : '离线'}</span>`}
                  </div>`
                : ''
            }
            <div class="aw-form-row">
              <div class="aw-form-label"><strong>每组保留子文件上限</strong><span>超出后自动清理最早未读且未加锁项</span></div>
              <input type="number" id="aw-sm-max" class="aw-input" style="width:72px" min="1" max="30" value="${s.maxChildrenPerGroup ?? 6}" />
            </div>
            <div class="aw-form-row">
              <div class="aw-form-label"><strong>原生顶栏自动折叠子标签</strong><span>把子文件收入母页数字徽章，腾出标签栏空间</span></div>
              <input type="checkbox" id="aw-sm-fold" ${s.foldChildTabsInNativeBar !== false ? 'checked' : ''} />
            </div>
            <div class="aw-form-row">
              <div class="aw-form-label"><strong>点击对话文件时不覆盖当前标签页</strong><span>自动保留右侧栏临时预览标签，连续打开多个文件时逐个并列打开</span></div>
              <input type="checkbox" id="aw-sm-preserve-tabs" ${s.preventPreviewTabOverwrite !== false ? 'checked' : ''} />
            </div>
            <div class="aw-form-row">
              <div class="aw-form-label"><strong>汇总型文档自动设为母页</strong><span>含 3 个以上本地链接的 Markdown 文档自动建立分组</span></div>
              <input type="checkbox" id="aw-sm-auto" ${s.autoAnchorSummaryMd ? 'checked' : ''} />
            </div>
            <div class="aw-form-row" style="flex-direction:column;align-items:stretch;gap:6px">
              <div class="aw-form-label"><strong>额外扫描目录（逗号分隔）</strong><span>纳入工作区外的 Obsidian 库等双向链接索引</span></div>
              <input type="text" id="aw-sm-extra" class="aw-input" value="${S.esc((s.extraScanDirs || []).join(', '))}" placeholder="例如 C:\\Users\\...\\Obsidian 或 /Users/.../Obsidian" />
            </div>
          </div>

          <div class="aw-settings-group">
            <div class="aw-settings-group-title">版本更新与 Antigravity 适配</div>
            ${(() => {
              const pluginVer = currentCallbacks?.versionInfo?.version || '';
              const fallbackRel = currentCallbacks?.versionInfo?.releasesUrl || 'https://github.com/Curelove/agy-anchor-wheel/releases';
              const compat = currentCallbacks?.compatInfo || {};
              const localAgy = compat?.localAntigravity || currentCallbacks?.updateInfo?.localAntigravity || null;
              const agyVerText = localAgy?.installedVersion ? `Antigravity ${localAgy.installedVersion}` : '未自动识别（便携版或自定义路径）';
              const testedRange = compat?.testedRange || 'Antigravity 2.34.x';
              const level = localAgy?.compatLevel || 'unknown';
              const levelLabel =
                level === 'verified'
                  ? '已验证适配'
                  : level === 'same_major'
                  ? '同大版本待测'
                  : level === 'untested'
                  ? '跨版本提醒'
                  : '参考基准';
              const levelTone = level === 'verified' ? 'verified' : 'warn';
              const diag = currentCallbacks?.hostDiag || null;
              const diagOk = diag && diag.hasRedux && diag.hasBrowserCtx && diag.hasRightPane && diag.hasContentWrap;
              const missingHooks = diag
                ? [
                    !diag.hasRedux && '状态同步',
                    !diag.hasBrowserCtx && '文件上下文',
                    !diag.hasRouter && '页面跳转',
                    !diag.hasRightPane && '右侧栏容器',
                    !diag.hasContentWrap && '文档内容区',
                  ].filter(Boolean)
                : [];
              return `
                <div class="aw-compat-grid">
                  <div class="aw-compat-item">
                    <span>插件版本 / 已验证宿主</span>
                    <strong>${pluginVer ? `v${S.esc(pluginVer)} · ` : ''}${S.esc(testedRange)}</strong>
                  </div>
                  <div class="aw-compat-item">
                    <span>本机 Antigravity 状态</span>
                    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                      <strong>${S.esc(agyVerText)}</strong>
                      <span class="aw-compat-pill" data-level="${levelTone}">${levelLabel}</span>
                    </div>
                  </div>
                </div>
                ${
                  diag
                    ? `<div class="aw-compat-diag">${
                        diagOk
                          ? '原生侧边栏连接自检：文档面板、标签切换与侧栏容器均正常就绪。'
                          : `原生侧边栏部分连接未就绪（${S.esc(missingHooks.join('、') || '侧栏容器')}）：若软件刚升级导致侧栏异常，可使用官方侧栏「锚点轮盘工作台」并检查插件更新。`
                      }</div>`
                    : `<div class="aw-compat-diag">${S.esc(
                        compat?.nativeEnhancerNotice ||
                          '原生侧栏增强依赖窗口调试接口，Antigravity 大版本升级后可能需要随插件同步更新；独立侧栏「锚点轮盘工作台」基于官方接口，跨版本更稳定。'
                      )}</div>`
                }
                <div class="aw-form-row">
                  <div class="aw-form-label"><strong>启动时与后台静默检查 GitHub 更新</strong><span>发现未忽略的新版本时温和推送提醒；可跳过某一版本，待下个新版发布再恢复提示</span></div>
                  <input type="checkbox" id="aw-sm-auto-update" ${s.autoCheckUpdates !== false ? 'checked' : ''} />
                </div>
                <div class="aw-form-row">
                  <div class="aw-form-label"><strong>检查 GitHub Releases 最新版本</strong><span>支持下载打包好的安装包直接覆盖升级，保留全部个人配置</span></div>
                  <button type="button" id="aw-sm-check-update" class="aw-ghost-btn">${currentCallbacks?.onCheckUpdate ? '立即检查更新' : '打开 Releases'}</button>
                </div>
                <div class="aw-update-box" id="aw-sm-update-box">
                  ${renderUpdateBoxHtml(currentCallbacks?.updateInfo || null, pluginVer, fallbackRel, s.ignoredUpdateVersion || '')}
                </div>
              `;
            })()}
          </div>

          <div class="aw-settings-group">
            <div class="aw-settings-group-title">最近自动清理的文件（点击恢复）</div>
            ${
              evicted.length
                ? evicted
                    .slice(0, 5)
                    .map(
                      (r) => `
                  <button type="button" class="aw-link-row" data-aw-sm-restore="${S.esc(r.path)}" data-aw-sm-rgrp="${S.esc(r.groupId || '')}">
                    <div class="aw-link-row-top">
                      <span class="aw-link-row-title">${S.esc(r.title)}</span>
                      <span class="aw-link-row-badge">恢复</span>
                    </div>
                  </button>`
                    )
                    .join('')
                : '<div class="aw-link-row-snippet">暂无被自动清理的文件。</div>'
            }
          </div>
        `;
      }

      const footHintText = FOOTER_HINTS[activeTab] || FOOTER_HINTS.modes;

      modal.innerHTML = `
        <div class="aw-settings-head">
          <div style="display:flex;align-items:center;gap:8px;min-width:0">
            ${S.ICONS.wheel}
            <span class="aw-popover-title">锚点轮盘设置与交互图解</span>
          </div>
          <div class="aw-tray" style="flex-wrap:wrap">
            <button type="button" class="aw-tray-btn" data-aw-sm-tab="modes" data-active="${activeTab === 'modes' ? '1' : '0'}">交互模式与图解</button>
            <button type="button" class="aw-tray-btn" data-aw-sm-tab="categories" data-active="${activeTab === 'categories' ? '1' : '0'}">分类与预览</button>
            <button type="button" class="aw-tray-btn" data-aw-sm-tab="storage" data-active="${activeTab === 'storage' ? '1' : '0'}">收纳与高级</button>
          </div>
          <button type="button" class="aw-tray-btn" id="aw-sm-close" title="关闭">${S.ICONS.close}</button>
        </div>
        <div class="aw-settings-body">${tabBody}</div>
        <div class="aw-settings-foot">
          <span class="aw-settings-foot-hint">${S.esc(footHintText)}</span>
          <div class="aw-settings-foot-actions">
            <button type="button" class="aw-ghost-btn" id="aw-sm-cancel">取消</button>
            <button type="button" class="aw-primary-btn" id="aw-sm-save">保存并应用</button>
          </div>
        </div>
      `;

      // Apply strict single-active / rest-dimmed tri-state right after mount
      updateLiveGuides(modal);

      modal.querySelectorAll('[data-aw-focus-ch]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          syncDraftFromDom(modal);
          focusChannel = btn.getAttribute('data-aw-focus-ch') || 'middle';
          updateLiveGuides(modal);
        });
      });

      modal.querySelectorAll('[data-aw-cat-prev]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          activeCatPreview = btn.getAttribute('data-aw-cat-prev') || 'bilateral';
          modal.querySelectorAll('[data-aw-cat-prev]').forEach((b) => {
            b.setAttribute('data-active', b.getAttribute('data-aw-cat-prev') === activeCatPreview ? '1' : '0');
          });
          modal.querySelector('#aw-sm-cat-live-preview')?.setAttribute('data-narrow-active', activeCatPreview);
        });
      });

      modal.querySelectorAll('[data-aw-guide-card]').forEach((card) => {
        card.addEventListener('click', (e) => {
          e.stopPropagation();
          syncDraftFromDom(modal);
          applyCardSelection(modal, card.getAttribute('data-aw-guide-card'));
        });
      });

      modal.querySelectorAll('.aw-reactive-ctrl').forEach((ctrl) => {
        if (ctrl.closest('.aw-rule-list')) return; // bound by bindRuleRowEvents
        const evtName = ctrl.tagName === 'INPUT' && (ctrl.type === 'text' || ctrl.type === 'number') ? 'input' : 'change';
        ctrl.addEventListener(evtName, () => {
          stopHotkeyRecording(modal);
          syncDraftFromDom(modal);
          if (['aw-sm-middle', 'aw-sm-trigger-btn', 'aw-sm-trigger-mod'].includes(ctrl.id)) focusChannel = 'middle';
          else if (['aw-sm-tab-mode', 'aw-sm-tab-en', 'aw-sm-tab-close'].includes(ctrl.id)) focusChannel = 'tab';
          updateLiveGuides(modal);
        });
      });

      modal.querySelector('#aw-sm-hotkey-rec')?.addEventListener('click', (e) => {
        e.stopPropagation();
        syncDraftFromDom(modal);
        focusChannel = 'tab';
        if (isRecordingHotkey) {
          stopHotkeyRecording(modal);
        } else {
          clearHotkeyFeedback();
          isRecordingHotkey = true;
          updateLiveGuides(modal);
        }
      });

      modal.querySelector('#aw-sm-hotkey-reset')?.addEventListener('click', (e) => {
        e.stopPropagation();
        stopHotkeyRecording(modal);
        if (draft) draft.tabCustomHotkey = 'Tab';
        focusChannel = 'tab';
        updateLiveGuides(modal);
      });

      modal.querySelectorAll('[data-aw-tab-action]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          stopHotkeyRecording(modal);
          syncDraftFromDom(modal);
          if (draft) draft.tabTriggerAction = btn.getAttribute('data-aw-tab-action') === 'hold' ? 'hold' : 'toggle';
          focusChannel = 'tab';
          updateLiveGuides(modal);
        });
      });

      modal.querySelectorAll('[data-aw-sens]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          stopHotkeyRecording(modal);
          syncDraftFromDom(modal);
          const val = btn.getAttribute('data-aw-sens');
          if (draft && ['fast', 'balanced', 'safe'].includes(val)) draft.wheelHoldSensitivity = val;
          focusChannel = 'middle';
          updateLiveGuides(modal);
        });
      });

      modal.querySelector('#aw-sm-adv-trigger')?.addEventListener('toggle', (e) => {
        advTriggerExpanded = Boolean(e.currentTarget?.open);
      });

      modal.querySelectorAll('.aw-layout-slot-sel[data-aw-layout-slot]').forEach((sel) => {
        sel.addEventListener('change', () => {
          stopHotkeyRecording(modal);
          if (!draft) return;
          const slotKey = sel.getAttribute('data-aw-layout-slot');
          const nextVal = sel.value;
          if (!slotKey || !VALID_MAIN_LAYOUT_ACTIONS.has(nextVal)) return;
          const slots = normalizeDraftLayoutSlots(draft.mainChatLayoutSlots);
          const prevVal = slots[slotKey];
          if (nextVal !== 'none' && nextVal !== prevVal) {
            const dupKey = MAIN_LAYOUT_SLOT_KEYS.find((k) => k !== slotKey && slots[k] === nextVal);
            if (dupKey) {
              slots[dupKey] = prevVal;
              const dupSel = modal.querySelector(`.aw-layout-slot-sel[data-aw-layout-slot="${dupKey}"]`);
              if (dupSel) dupSel.value = prevVal;
            }
          }
          slots[slotKey] = nextVal;
          draft.mainChatLayoutSlots = slots;
          const resetBtnEl = modal.querySelector('#aw-sm-layout-slots-reset');
          if (resetBtnEl) resetBtnEl.hidden = isDefaultLayoutSlots(slots);
        });
      });

      modal.querySelector('#aw-sm-layout-slots-reset')?.addEventListener('click', (e) => {
        e.stopPropagation();
        stopHotkeyRecording(modal);
        if (!draft) return;
        const fresh = { ...DEFAULT_MAIN_LAYOUT_SLOTS };
        draft.mainChatLayoutSlots = fresh;
        modal.querySelectorAll('.aw-layout-slot-sel[data-aw-layout-slot]').forEach((sel) => {
          const sk = sel.getAttribute('data-aw-layout-slot');
          if (sk && fresh[sk]) sel.value = fresh[sk];
        });
        const resetBtnEl = modal.querySelector('#aw-sm-layout-slots-reset');
        if (resetBtnEl) resetBtnEl.hidden = true;
      });

      if (activeTab === 'categories') {
        bindRuleRowEvents(modal);
      }

      modal.querySelectorAll('[data-aw-sm-tab]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          stopHotkeyRecording(modal);
          syncDraftFromDom(modal);
          activeTab = btn.getAttribute('data-aw-sm-tab');
          render();
        });
      });

      modal.querySelector('#aw-sm-add-rule')?.addEventListener('click', (e) => {
        e.stopPropagation();
        syncDraftFromDom(modal);
        if (editingRules.length < 8) {
          const nextNum = editingRules.length + 1;
          editingRules.push({
            id: `custom_${Date.now().toString(36).slice(-4)}_${nextNum}`,
            label: `分类${nextNum}`,
            extensionsRaw: 'log',
          });
          const compiled = compileValidRulesFromEditing();
          if (compiled.length) draft.categoryRules = compiled;
          renderCategoryRulesDom(modal, { focusLast: true });
        }
      });

      bindUpdateBoxButtons(modal);

      modal.querySelector('#aw-sm-check-update')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        const box = modal.querySelector('#aw-sm-update-box');
        const pluginVer = currentCallbacks?.versionInfo?.version || '';
        const fallbackRel = currentCallbacks?.versionInfo?.releasesUrl || 'https://github.com/Curelove/agy-anchor-wheel/releases';
        if (!currentCallbacks?.onCheckUpdate) {
          doc.defaultView?.open?.(fallbackRel, '_blank', 'noopener');
          return;
        }
        btn.disabled = true;
        const prevText = btn.textContent;
        btn.textContent = '检查中...';
        try {
          const res = await currentCallbacks.onCheckUpdate(true);
          if (currentCallbacks) currentCallbacks.updateInfo = res;
          if (box) {
            box.innerHTML = renderUpdateBoxHtml(res, pluginVer, fallbackRel, draft?.ignoredUpdateVersion || '');
            bindUpdateBoxButtons(modal);
          }
        } catch (err) {
          if (box) {
            box.innerHTML = renderUpdateBoxHtml({ ok: false, error: String(err?.message || err) }, pluginVer, fallbackRel, draft?.ignoredUpdateVersion || '');
          }
        } finally {
          btn.disabled = false;
          btn.textContent = prevText;
        }
      });

      modal.querySelector('#aw-sm-launcher')?.addEventListener('click', async () => {
        await currentCallbacks?.onGenerateLauncher?.();
      });

      modal.querySelectorAll('[data-aw-sm-restore]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const p = btn.getAttribute('data-aw-sm-restore');
          const gid = btn.getAttribute('data-aw-sm-rgrp');
          close();
          await currentCallbacks?.onRestoreEvicted?.(p, gid);
        });
      });

      modal.querySelector('#aw-sm-close')?.addEventListener('click', close);
      modal.querySelector('#aw-sm-cancel')?.addEventListener('click', close);
      modal.querySelector('#aw-sm-save')?.addEventListener('click', async () => {
        syncDraftFromDom(modal);
        const compiled = compileValidRulesFromEditing();
        if (compiled.length) draft.categoryRules = compiled;
        writeLocalSoundwaveMap(doc.defaultView, draft.wheelSoundwaveByTheme);
        const payload = {
          ...draft,
          wheelSoundwaveByTheme: { ...(draft.wheelSoundwaveByTheme || {}) },
        };
        const cb = currentCallbacks?.onSave;
        close();
        await cb?.(payload);
      });
    }

    function open({
      settings,
      evicted = [],
      cdpStatus = null,
      versionInfo = null,
      compatInfo = null,
      hostDiag = null,
      updateInfo = null,
      initialTab = 'modes',
      initialFocusChannel = 'middle',
      focusUpdateSection = false,
      resolveHostTheme = null,
      onSave,
      onRestoreEvicted,
      onGenerateLauncher,
      onCheckUpdate,
      onIgnoreUpdate,
    }) {
      close();
      activeTab = initialTab || 'modes';
      activeCatPreview = 'bilateral';
      focusChannel = initialFocusChannel === 'tab' ? 'tab' : 'middle';
      advTriggerExpanded = false;
      isRecordingHotkey = false;
      clearHotkeyFeedback();
      initialSavedTheme = settings?.theme || options.theme || 'auto';
      const sanitizedRules = S.sanitizeRulesClient(settings?.categoryRules).map((r) => ({ ...r, extensions: [...r.extensions] }));
      editingRules = sanitizedRules.map((r) => ({
        id: r.id,
        label: r.label,
        extensionsRaw: (r.extensions || []).join(', '),
      }));
      const soundwaveByTheme = normalizeDraftSoundwaveByTheme(settings, doc.defaultView);
      draft = {
        ...settings,
        categoryRules: sanitizedRules,
        extraScanDirs: [...(settings?.extraScanDirs || [])],
        mainChatLayoutSlots: normalizeDraftLayoutSlots(settings?.mainChatLayoutSlots),
        wheelSoundwaveByTheme: soundwaveByTheme,
      };
      draft.wheelSoundwaveEnabled = isSoundwaveCheckedForDraft(draft);
      currentCallbacks = {
        evicted,
        cdpStatus,
        versionInfo,
        compatInfo,
        hostDiag,
        updateInfo,
        resolveHostTheme,
        onSave,
        onRestoreEvicted,
        onGenerateLauncher,
        onCheckUpdate,
        onIgnoreUpdate,
      };

      backdropEl = S.markNode(doc.createElement('div'));
      backdropEl.className = 'aw-settings-backdrop';
      applyThemePreview(settings?.theme || options.theme || 'auto');
      backdropEl.addEventListener('click', (e) => {
        if (e.target === backdropEl) close();
      });

      const modal = S.markNode(doc.createElement('div'));
      modal.className = 'aw-settings-modal';
      modal.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isRecordingHotkey && !e.target?.closest?.('#aw-sm-hotkey-rec')) {
          stopHotkeyRecording(modal);
        }
      });
      modal.addEventListener('mousedown', (e) => e.stopPropagation());
      backdropEl.appendChild(modal);
      mountRoot.appendChild(backdropEl);
      render();
      if (focusUpdateSection) {
        requestAnimationFrame(() => {
          modal.querySelector('#aw-sm-update-box')?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
        });
      }
      doc.addEventListener('keydown', onKeyDown, true);
    }

    return {
      open,
      close,
      isOpen: () => Boolean(backdropEl),
    };
  }

  return { createSettingsModal };
});
