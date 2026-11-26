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
      desc: '推荐鼠标按键按住呼出（默认中键，可改右键或侧键）：圆心固定为当前页，一侧回母页，另一侧按分类展开子页；超过 3 条可按住滑轨反向挑选。',
    },
    {
      key: 'ae_tree',
      title: '竖向层级树',
      desc: '推荐快捷键呼出：纵向串联「祖父页 → 母页 → 当前页」，右侧排布各自子页；悬停点亮整支与快览，叠角展开自动让位。',
    },
    {
      key: 'classic_wheel',
      title: '经典母页轮盘',
      desc: '圆心固定为优先母页，周围扇区展示组内子页；按住触发键划选扇区或中心松手打开，移到圈外自动取消。',
    },
  ]);

  const FOOTER_HINTS = Object.freeze({
    modes: '仅当前聚焦主模式卡片全亮，悬停灰显卡片可预览动效',
    categories: '增删分类规则或调整快览参数，上方图解即时同步',
    storage: '调节扇区数或四套主题立即预览，保存后全局生效',
  });

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

    function close() {
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
      if (g('#aw-sm-trigger-btn')) draft.wheelTriggerButton = g('#aw-sm-trigger-btn').value;
      if (g('#aw-sm-pdir')) draft.parentDirection = g('#aw-sm-pdir').value;
      if (g('#aw-sm-tab-en')) draft.tabTriggerEnabled = Boolean(g('#aw-sm-tab-en').checked);
      if (g('#aw-sm-tab-mode')) draft.tabMode = g('#aw-sm-tab-mode').value;
      if (g('#aw-sm-tab-key')) draft.tabCustomHotkey = g('#aw-sm-tab-key').value;
      if (g('#aw-sm-tab-close')) draft.tabCloseOnSelect = Boolean(g('#aw-sm-tab-close').checked);

      if (g('#aw-sm-scope')) draft.childSourceScope = g('#aw-sm-scope').value;
      if (g('#aw-sm-prev-en')) draft.hoverPreviewEnabled = Boolean(g('#aw-sm-prev-en').checked);
      if (g('#aw-sm-prev-delay')) draft.hoverPreviewDelayMs = Number(g('#aw-sm-prev-delay').value);
      if (g('#aw-sm-prev-anim')) draft.videoPreviewAnimated = Boolean(g('#aw-sm-prev-anim').checked);
      if (g('#aw-sm-rich-doc')) draft.richDocPreviewEnabled = Boolean(g('#aw-sm-rich-doc').checked);
      if (g('#aw-sm-rich-strategy')) draft.richDocAutoStrategy = g('#aw-sm-rich-strategy').value;
      if (g('#aw-sm-rich-paper')) draft.richDocPaperMode = Boolean(g('#aw-sm-rich-paper').checked);

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
      if (g('#aw-sm-auto')) draft.autoAnchorSummaryMd = Boolean(g('#aw-sm-auto').checked);
      if (g('#aw-sm-auto-update')) draft.autoCheckUpdates = Boolean(g('#aw-sm-auto-update').checked);
      if (g('#aw-sm-sectors')) draft.wheelSectors = Number(g('#aw-sm-sectors').value || 8);
      if (g('#aw-sm-theme')) {
        draft.theme = g('#aw-sm-theme').value;
        applyThemePreview(draft.theme);
      }
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
      const otherMode =
        focusChannel === 'middle'
          ? (draft.tabTriggerEnabled !== false ? draft.tabMode : '')
          : draft.middleMode;
      const otherLabel = focusChannel === 'middle' ? '快捷键已用' : `${trigMeta.shortLabel}已用`;

      modalEl.querySelectorAll('[data-aw-focus-ch]').forEach((btn) => {
        const ch = btn.getAttribute('data-aw-focus-ch');
        btn.setAttribute('data-active', ch === focusChannel ? '1' : '0');
        if (ch === 'middle') {
          btn.textContent = `聚焦：按住${trigMeta.shortLabel}模式`;
        }
      });

      const trigHint = modalEl.querySelector('#aw-sm-middle-label');
      if (trigHint) {
        trigHint.textContent = `按住${trigMeta.label}呼出模式（松手即确认）`;
      }
      const trigSub = modalEl.querySelector('#aw-sm-trigger-btn-sub');
      if (trigSub) {
        trigSub.textContent =
          trigMeta.id === 'right'
            ? '按住或拖移呼出轮盘并自动屏蔽右键菜单；快速短按右键仍保留原菜单'
            : trigMeta.id === 'side_back' || trigMeta.id === 'side_forward'
            ? '在右侧栏按住对应侧键即呼出轮盘（不再误触前进/后退），另一颗侧键保留翻页'
            : '默认中键按住呼出；中键短按链接仍保留后台新标签打开';
      }

      const focusHintEl = modalEl.querySelector('#aw-sm-focus-hint');
      if (focusHintEl) {
        focusHintEl.textContent = !activeKey
          ? '当前通道已关闭，点击任意模式卡片即可重新启用'
          : '点击卡片直接切换，悬停灰显卡片可预览动效';
      }

      // Dim dependent form rows when their parent toggle/channel is disabled
      const trigRow = modalEl.querySelector('#aw-sm-row-trigger-btn');
      if (trigRow) {
        trigRow.setAttribute('data-dim', draft.middleMode === 'off' ? '1' : '0');
      }
      const pdirRow = modalEl.querySelector('#aw-sm-row-pdir');
      if (pdirRow) {
        const bilateralUsed =
          draft.middleMode === 'bilateral_wheel' ||
          (draft.tabTriggerEnabled !== false && draft.tabMode === 'bilateral_wheel');
        pdirRow.setAttribute('data-dim', bilateralUsed ? '0' : '1');
      }
      const tabOff = draft.tabTriggerEnabled === false;
      for (const id of ['#aw-sm-row-tab-mode', '#aw-sm-row-tab-key', '#aw-sm-row-tab-close']) {
        modalEl.querySelector(id)?.setAttribute('data-dim', tabOff ? '1' : '0');
      }
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
            chip.textContent = focusChannel === 'middle' ? `${trigMeta.shortLabel}主用` : '快捷键主用';
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

      // Live mini previews on secondary tabs without stealing input focus
      const catMini = modalEl.querySelector('#aw-sm-cat-live-preview');
      if (catMini) {
        catMini.setAttribute('data-narrow-active', activeCatPreview);
        const biCol = catMini.querySelector('[data-aw-mini-col="bilateral"]');
        const trCol = catMini.querySelector('[data-aw-mini-col="tree"]');
        if (biCol) biCol.innerHTML = S.renderModeGuideSvg('bilateral_wheel', draft);
        if (trCol) trCol.innerHTML = S.renderModeGuideSvg('ae_tree', draft);
      }
      const advMini = modalEl.querySelector('#aw-sm-adv-live-preview');
      if (advMini) {
        advMini.innerHTML = `<div class="aw-mini-preview-col" style="max-width:340px;margin:0 auto">${S.renderModeGuideSvg('classic_wheel', draft)}</div>`;
      }
    }

    function buildCategoryRuleRowsHtml() {
      const canDel = editingRules.length > 1;
      return (
        editingRules
          .map(
            (r, i) => `
          <div class="aw-rule-row" data-aw-rule-idx="${i}" data-aw-rule-id="${S.esc(r.id)}">
            <input type="text" class="aw-input aw-sm-rule-label aw-reactive-ctrl" value="${S.esc(r.label)}" maxlength="12" placeholder="分类名" />
            <input type="text" class="aw-input aw-sm-rule-exts aw-reactive-ctrl" value="${S.esc(r.extensionsRaw)}" placeholder="扩展名，如 png, jpg, svg" />
            <button type="button" class="aw-tray-btn aw-sm-del-rule" data-del-idx="${i}" title="删除此分类" ${canDel ? '' : 'disabled'}>${S.ICONS.trash}</button>
          </div>`
          )
          .join('') +
        `<div class="aw-rule-row aw-rule-locked">
          <input type="text" class="aw-input" value="其他" disabled />
          <input type="text" class="aw-input" value="未命中上述分类的全部文件与文件夹（固定兜底）" disabled />
          <span class="aw-link-row-badge">固定</span>
        </div>`
      );
    }

    function bindRuleRowEvents(modalEl) {
      modalEl.querySelectorAll('.aw-rule-list .aw-reactive-ctrl').forEach((ctrl) => {
        ctrl.addEventListener('input', () => {
          syncDraftFromDom(modalEl);
          updateLiveGuides(modalEl);
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
              <button type="button" class="aw-tray-btn" data-aw-focus-ch="middle" data-active="${focusChannel === 'middle' ? '1' : '0'}">聚焦：按住中键模式</button>
              <button type="button" class="aw-tray-btn" data-aw-focus-ch="tab" data-active="${focusChannel === 'tab' ? '1' : '0'}">聚焦：快捷键模式</button>
            </div>
            <span class="aw-focus-hint" id="aw-sm-focus-hint">点击卡片直接切换，悬停灰显卡片可预览动效</span>
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
            <div class="aw-settings-group-title">双通道呼出与实时布局联动</div>
            <div class="aw-form-row">
              <div class="aw-form-label">
                <strong id="aw-sm-middle-label">按住鼠标中键呼出模式（松手即确认）</strong>
                <span>仅呈现可划选目标，移到空白或圈外松手取消</span>
              </div>
              <select id="aw-sm-middle" class="aw-select aw-reactive-ctrl">
                <option value="bilateral_wheel" ${s.middleMode === 'bilateral_wheel' ? 'selected' : ''}>双侧分类轮盘</option>
                <option value="classic_wheel" ${s.middleMode === 'classic_wheel' ? 'selected' : ''}>经典母页轮盘</option>
                <option value="off" ${s.middleMode === 'off' ? 'selected' : ''}>关闭鼠标呼出</option>
              </select>
            </div>
            <div class="aw-form-row" id="aw-sm-row-trigger-btn">
              <div class="aw-form-label">
                <strong>轮盘触发鼠标按键</strong>
                <span id="aw-sm-trigger-btn-sub">默认中键按住呼出；中键短按链接仍保留后台新标签打开</span>
              </div>
              <select id="aw-sm-trigger-btn" class="aw-select aw-reactive-ctrl">
                <option value="middle" ${(s.wheelTriggerButton || 'middle') === 'middle' ? 'selected' : ''}>鼠标中键（默认）</option>
                <option value="right" ${s.wheelTriggerButton === 'right' ? 'selected' : ''}>鼠标右键（按住/拖动呼出）</option>
                <option value="side_back" ${s.wheelTriggerButton === 'side_back' ? 'selected' : ''}>鼠标侧键 1（后退键）</option>
                <option value="side_forward" ${s.wheelTriggerButton === 'side_forward' ? 'selected' : ''}>鼠标侧键 2（前进键）</option>
              </select>
            </div>
            <div class="aw-form-row" id="aw-sm-row-pdir">
              <div class="aw-form-label">
                <strong>双侧轮盘中「母页」所在方向</strong>
                <span>调节后上方轮盘动画立刻跟随旋转对齐</span>
              </div>
              <select id="aw-sm-pdir" class="aw-select aw-reactive-ctrl">
                <option value="left" ${s.parentDirection === 'left' ? 'selected' : ''}>左侧返回母页（右侧展开子页）</option>
                <option value="right" ${s.parentDirection === 'right' ? 'selected' : ''}>右侧返回母页（左侧展开子页）</option>
                <option value="top" ${s.parentDirection === 'top' ? 'selected' : ''}>上方返回母页（下方展开子页）</option>
                <option value="bottom" ${s.parentDirection === 'bottom' ? 'selected' : ''}>下方返回母页（上方展开子页）</option>
              </select>
            </div>
            <div class="aw-form-row">
              <div class="aw-form-label">
                <strong>启用快捷键常驻导览（覆盖右侧栏原生 Tab）</strong>
                <span>阅读文档时拦截原生 Tab 跳页首；聊天框、搜索框与代码编辑框内自动放行</span>
              </div>
              <input type="checkbox" id="aw-sm-tab-en" class="aw-reactive-ctrl" ${s.tabTriggerEnabled !== false ? 'checked' : ''} />
            </div>
            <div class="aw-form-row" id="aw-sm-row-tab-mode">
              <div class="aw-form-label">
                <strong>快捷键呼出的视图样式</strong>
                <span>按键切换开关，页面滚动时持续停留</span>
              </div>
              <select id="aw-sm-tab-mode" class="aw-select aw-reactive-ctrl">
                <option value="ae_tree" ${s.tabMode === 'ae_tree' ? 'selected' : ''}>竖向层级树</option>
                <option value="bilateral_wheel" ${s.tabMode === 'bilateral_wheel' ? 'selected' : ''}>双侧分类轮盘（滚轮浏览）</option>
                <option value="classic_wheel" ${s.tabMode === 'classic_wheel' ? 'selected' : ''}>经典母页轮盘</option>
              </select>
            </div>
            <div class="aw-form-row" id="aw-sm-row-tab-key">
              <div class="aw-form-label">
                <strong>快捷键选择</strong>
                <span>上方层级树按键帽会实时显示当前按键</span>
              </div>
              <select id="aw-sm-tab-key" class="aw-select aw-reactive-ctrl">
                <option value="Tab" ${s.tabCustomHotkey === 'Tab' ? 'selected' : ''}>Tab 键（推荐）</option>
                <option value="Alt+Q" ${s.tabCustomHotkey === 'Alt+Q' ? 'selected' : ''}>Alt + Q</option>
                <option value="Alt+W" ${s.tabCustomHotkey === 'Alt+W' ? 'selected' : ''}>Alt + W</option>
                <option value="F2" ${s.tabCustomHotkey === 'F2' ? 'selected' : ''}>F2</option>
              </select>
            </div>
            <div class="aw-form-row" id="aw-sm-row-tab-close">
              <div class="aw-form-label">
                <strong>点选跳转后自动收起浮层</strong>
                <span>关闭时可连续点选多个文档对比，直到再按快捷键关闭</span>
              </div>
              <input type="checkbox" id="aw-sm-tab-close" class="aw-reactive-ctrl" ${s.tabCloseOnSelect ? 'checked' : ''} />
            </div>
          </div>
        `;
      } else if (activeTab === 'categories') {
        tabBody = `
          <div class="aw-mini-preview-narrow-bar">
            <span class="aw-focus-hint">实时联动图解</span>
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
            <div class="aw-settings-group-title">子页范围与悬停快览</div>
            <div class="aw-form-row">
              <div class="aw-form-label">
                <strong>默认展示的子页范围</strong>
                <span>浮层顶部仍可一键临时切换</span>
              </div>
              <select id="aw-sm-scope" class="aw-select aw-reactive-ctrl">
                <option value="opened_and_outlinks" ${s.childSourceScope !== 'opened_only' ? 'selected' : ''}>已开子标签 + 文档本地出链（已开置顶）</option>
                <option value="opened_only" ${s.childSourceScope === 'opened_only' ? 'selected' : ''}>仅显示已打开或收编的子标签</option>
              </select>
            </div>
            <div class="aw-form-row">
              <div class="aw-form-label">
                <strong>开启光标悬停快览</strong>
                <span>显示文档开头片段、图片缩略图与视频开头预览</span>
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
                <strong>与 Antigravity 原生视图的优先关系</strong>
                <span>智能退让模式下，若未来官方原生支持某格式预览将自动优先展示官方视图</span>
              </div>
              <select id="aw-sm-rich-strategy" class="aw-select aw-reactive-ctrl">
                <option value="auto_yield" ${(s.richDocAutoStrategy || 'auto_yield') === 'auto_yield' ? 'selected' : ''}>智能退让（推荐：仅在官方无法预览时接管）</option>
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

          <div class="aw-settings-group">
            <div class="aw-rule-header">
              <div style="display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap">
                <div class="aw-settings-group-title" style="margin:0">双侧轮盘自定义分类规则</div>
                <span class="aw-link-row-badge" id="aw-sm-rule-count">${editingRules.length}/8 类 + 兜底</span>
              </div>
              <button type="button" class="aw-ghost-btn" id="aw-sm-add-rule" ${editingRules.length >= 8 ? 'disabled' : ''}>${S.ICONS.plus} 新增分类</button>
            </div>
            <div class="aw-rule-list">${buildCategoryRuleRowsHtml()}</div>
          </div>
        `;
      } else {
        tabBody = `
          <div class="aw-mini-preview-strip" id="aw-sm-adv-live-preview">
            <div class="aw-mini-preview-col" style="max-width:340px;margin:0 auto">${S.renderModeGuideSvg('classic_wheel', s)}</div>
          </div>

          <div class="aw-settings-group">
            <div class="aw-settings-group-title">标签组收纳与外观</div>
            ${
              cdp !== null
                ? `<div class="aw-form-row">
                    <div class="aw-form-label"><strong>原生侧栏连接状态</strong><span>${cdp.connected ? `已附着主窗口（端口 ${cdp.port}）` : '当前未附着调试端口'}</span></div>
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
              <div class="aw-form-label"><strong>汇总型 MD 自动设为优先母页</strong><span>含 3 个以上本地链接时自动立组</span></div>
              <input type="checkbox" id="aw-sm-auto" ${s.autoAnchorSummaryMd ? 'checked' : ''} />
            </div>
            <div class="aw-form-row">
              <div class="aw-form-label"><strong>经典轮盘每页扇区数</strong><span>实时反映在上方经典轮盘结构中</span></div>
              <select id="aw-sm-sectors" class="aw-select aw-reactive-ctrl">
                <option value="4" ${Number(s.wheelSectors) === 4 ? 'selected' : ''}>4 扇区</option>
                <option value="6" ${Number(s.wheelSectors) === 6 ? 'selected' : ''}>6 扇区</option>
                <option value="8" ${Number(s.wheelSectors || 8) === 8 ? 'selected' : ''}>8 扇区</option>
              </select>
            </div>
            <div class="aw-form-row">
              <div class="aw-form-label"><strong>界面主题（适配 obsidian-prism）</strong><span>切换立即实时预览配色效果</span></div>
              <select id="aw-sm-theme" class="aw-select aw-reactive-ctrl">
                <option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>跟随宿主</option>
                <option value="obsidian" ${s.theme === 'obsidian' ? 'selected' : ''}>深空黑曜</option>
                <option value="warm" ${s.theme === 'warm' ? 'selected' : ''}>暖炭玄岩</option>
                <option value="crystal" ${s.theme === 'crystal' ? 'selected' : ''}>白昼冷晶</option>
                <option value="alabaster" ${s.theme === 'alabaster' ? 'selected' : ''}>暖白画册</option>
              </select>
            </div>
            <div class="aw-form-row" style="flex-direction:column;align-items:stretch;gap:6px">
              <div class="aw-form-label"><strong>额外扫描目录（逗号分隔）</strong><span>纳入工作区外的 Obsidian 库等双向链接索引</span></div>
              <input type="text" id="aw-sm-extra" class="aw-input" value="${S.esc((s.extraScanDirs || []).join(', '))}" placeholder="例如 C:\\Users\\...\\Obsidian" />
            </div>
          </div>

          <div class="aw-settings-group">
            <div class="aw-settings-group-title">版本更新与 Antigravity 适配</div>
            ${(() => {
              const pluginVer = currentCallbacks?.versionInfo?.version || '';
              const fallbackRel = currentCallbacks?.versionInfo?.releasesUrl || 'https://github.com/Curelove/agy-anchor-wheel/releases';
              const compat = currentCallbacks?.compatInfo || {};
              const localAgy = compat?.localAntigravity || currentCallbacks?.updateInfo?.localAntigravity || null;
              const agyVerText = localAgy?.installedVersion ? `Antigravity ${localAgy.installedVersion}` : '未自动识别（非 Windows 或便携版）';
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
                    !diag.hasRedux && 'Redux',
                    !diag.hasBrowserCtx && 'BrowserContext',
                    !diag.hasRouter && 'Router',
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
                          ? '原生侧栏钩子自检：Redux / Router / 右侧栏容器全部正常就绪。'
                          : `原生侧栏部分钩子未命中（${S.esc(missingHooks.join('、') || '宿主容器')}）：若 AGY 刚升级导致侧栏异常，可使用官方侧栏「锚点轮盘工作台」并检查插件更新。`
                      }</div>`
                    : `<div class="aw-compat-diag">${S.esc(
                        compat?.nativeEnhancerNotice ||
                          'Mode 1（原生侧栏增强）依赖调试端口与前端内部结构，AGY 大改版后可能需要随插件升级；Mode 2 工作台基于官方接口，跨版本更稳定。'
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
            <div class="aw-settings-group-title">最近自动收纳（点击捞回）</div>
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
            <button type="button" class="aw-tray-btn" data-aw-sm-tab="categories" data-active="${activeTab === 'categories' ? '1' : '0'}">分类与快览</button>
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
          syncDraftFromDom(modal);
          if (ctrl.id === 'aw-sm-middle' || ctrl.id === 'aw-sm-trigger-btn') focusChannel = 'middle';
          else if (['aw-sm-tab-mode', 'aw-sm-tab-key', 'aw-sm-tab-en', 'aw-sm-tab-close'].includes(ctrl.id)) focusChannel = 'tab';
          updateLiveGuides(modal);
        });
      });

      if (activeTab === 'categories') {
        bindRuleRowEvents(modal);
      }

      modal.querySelectorAll('[data-aw-sm-tab]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
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
        const payload = { ...draft };
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
      initialSavedTheme = settings?.theme || options.theme || 'auto';
      const sanitizedRules = S.sanitizeRulesClient(settings?.categoryRules).map((r) => ({ ...r, extensions: [...r.extensions] }));
      editingRules = sanitizedRules.map((r) => ({
        id: r.id,
        label: r.label,
        extensionsRaw: (r.extensions || []).join(', '),
      }));
      draft = {
        ...settings,
        categoryRules: sanitizedRules,
        extraScanDirs: [...(settings?.extraScanDirs || [])],
      };
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
      modal.addEventListener('click', (e) => e.stopPropagation());
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
