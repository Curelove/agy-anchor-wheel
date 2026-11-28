// Shared Sidebar Direct Text/JSON/Markdown Editor with Auto-Save, Unclosed-JSON Guard & AI Edit History
(function (root, factory) {
  const api = factory(
    typeof module !== 'undefined' && module.exports ? require('./nav_shared.js') : root.AnchorWheelNavShared
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AnchorWheelEditor = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (Shared) {
  'use strict';

  const EDITABLE_EXT_RE =
    /\.(?:json|jsonc|json5|jsonl|ndjson|txt|md|mdx|markdown|yaml|yml|toml|ini|conf|cfg|properties|csv|tsv|xml|svg|html|htm|css|scss|less|js|mjs|cjs|ts|mts|cts|tsx|jsx|vue|svelte|astro|py|rb|php|go|rs|java|kt|swift|c|cpp|h|hpp|cs|sh|bash|zsh|bat|cmd|ps1|sql|graphql|prisma|proto|srt|ass|ssa|vtt|lrc|log|gitignore|gitattributes|editorconfig)$/i;
  const EDITABLE_BASE_RE = /^(?:license|makefile|dockerfile|procfile|readme|changelog)$/i;
  const SENSITIVE_SKIP_RE =
    /(?:^|[\\/])(?:\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|mcp_config\.json|private_vault\.json|id_rsa.*|id_ed25519.*|credentials(?:\.[^\\/]+)?|secrets?(?:\.[^\\/]+)?)$/i;

  const EDITOR_ICONS = Object.freeze({
    edit: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    search: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    history: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/><polyline points="12 7 12 12 15.5 14"/></svg>',
    sendAi: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><polyline points="9 10 12 13 15 10"/></svg>',
    format: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="21" y1="6" x2="3" y2="6"/><line x1="15" y1="12" x2="3" y2="12"/><line x1="17" y1="18" x2="3" y2="18"/></svg>',
    wrap: '<svg class="aw-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><polyline points="16 16 14 18 16 20"/><line x1="3" y1="18" x2="10" y2="18"/></svg>',
  });

  function isEditableTextPath(rawPath) {
    const clean = String(rawPath || '').trim().replace(/[?#].*$/, '').replace(/[\\/]+$/, '');
    if (!clean || SENSITIVE_SKIP_RE.test(clean)) return false;
    const parts = clean.split(/[\\/]/);
    const base = parts[parts.length - 1] || '';
    if (!base) return false;
    return EDITABLE_EXT_RE.test(base) || EDITABLE_BASE_RE.test(base);
  }

  function offsetToLine(text, offset) {
    const lim = Math.max(0, Math.min(text.length, Number(offset) || 0));
    let line = 1;
    for (let i = 0; i < lim; i++) {
      if (text.charCodeAt(i) === 10) line++;
    }
    return line;
  }

  function validateSyntaxClient(filePath, content) {
    const clean = String(filePath || '').trim().toLowerCase();
    const str = String(content ?? '');
    if (clean.endsWith('.json')) {
      if (!str.trim()) {
        return {
          valid: false,
          kind: 'json',
          line: 1,
          message: 'JSON 内容为空，补充完整对象或数组后自动保存',
        };
      }
      try {
        JSON.parse(str);
        return { valid: true, kind: 'json' };
      } catch (err) {
        const msg = String(err?.message || '');
        let line = null;
        const lcMatch = /line\s+(\d+)/i.exec(msg);
        const posMatch = /position\s+(\d+)/i.exec(msg);
        if (lcMatch) line = Number(lcMatch[1]);
        else if (posMatch) line = offsetToLine(str, Number(posMatch[1]));
        else if (/unexpected end of json/i.test(msg)) line = offsetToLine(str, str.length);
        return {
          valid: false,
          kind: 'json',
          line,
          message: `JSON 格式待闭合${line ? `（第 ${line} 行附近）` : ''}，补全后自动保存`,
        };
      }
    }
    if (clean.endsWith('.jsonl') || clean.endsWith('.ndjson')) {
      const lines = str.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i].trim();
        if (!ln) continue;
        try {
          JSON.parse(ln);
        } catch {
          return {
            valid: false,
            kind: 'jsonl',
            line: i + 1,
            message: `第 ${i + 1} 行 JSON 待闭合，补全后自动保存`,
          };
        }
      }
      return { valid: true, kind: 'jsonl' };
    }
    return { valid: true, kind: 'text' };
  }

  function formatClock(ts) {
    const d = new Date(ts || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function formatDateTime(ts) {
    const d = new Date(ts || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function buildAiPromptFromRecord(rec, displayPath) {
    if (!rec) return '';
    const refPath = displayPath || rec.path || '';
    const diffLines = String(rec.diffText || '').split('\n');
    const maxPreviewLines = 48;
    const clippedDiff =
      diffLines.length > maxPreviewLines
        ? diffLines.slice(0, maxPreviewLines).join('\n') + '\n... (完整差异见侧边栏编辑记录)'
        : diffLines.join('\n');
    return [
      `我刚刚在侧边栏编辑了 @${refPath}（${rec.summary || '已修改'}）：`,
      '```diff',
      clippedDiff,
      '```',
      '',
    ].join('\n');
  }

  function mountTextEditor(hostEl, initialPayload, callbacks = {}) {
    const doc = hostEl?.ownerDocument || document;
    const S = Shared || globalThis.AnchorWheelNavShared;
    const esc = (s) => (S?.esc ? S.esc(s) : String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    const mark = (el) => (S?.markNode ? S.markNode(el) : el);

    let destroyed = false;
    let sessionId = initialPayload?.sessionId || '';
    let filePath = initialPayload?.path || '';
    let syntaxKind = initialPayload?.syntaxKind || 'text';
    let lastDiskText = String(initialPayload?.text ?? '');
    let mtimeMs = initialPayload?.mtimeMs ?? null;
    let historyRecords = Array.isArray(initialPayload?.history) ? [...initialPayload.history] : [];
    let reportPath = initialPayload?.reportPath || '';
    let isNonUtf8 = Boolean(initialPayload?.isNonUtf8);
    let origEncoding = String(initialPayload?.encoding || 'utf-8');

    const preferWrapByDefault = /\.(?:md|mdx|markdown|txt|srt|ass|vtt|lrc)$/i.test(filePath);
    let wordWrap = preferWrapByDefault;
    let findOpen = false;
    let historyOpen = false;
    let exitConfirmOpen = false;
    let conflictState = null;
    let isComposing = false;
    let saveInFlight = false;
    let pendingSaveAfterFlight = false;
    let debounceTimer = null;
    let lastSavedAt = 0;
    let saveState = 'clean'; // 'clean' | 'dirty' | 'saving' | 'saved' | 'paused' | 'conflict' | 'error'
    let statusDetail = '';

    const root = mark(doc.createElement('div'));
    root.className = 'aw-editor-shell';
    root.setAttribute('data-wrap', wordWrap ? '1' : '0');

    const isJsonDoc = syntaxKind === 'json';

    root.innerHTML = `
      <div class="aw-editor-bar">
        <div class="aw-editor-status" data-state="clean" id="aw-ed-status" role="status" aria-live="polite">
          <span class="aw-editor-dot"></span>
          <span class="aw-editor-status-text" id="aw-ed-status-text">已保存 · 与原文件一致</span>
          <button type="button" class="aw-editor-inline-act" id="aw-ed-force-save" hidden>强制保存</button>
        </div>
        <div class="aw-editor-actions">
          ${isJsonDoc ? `<button type="button" class="aw-status-pill" id="aw-ed-format" title="整理 JSON 缩进格式">${EDITOR_ICONS.format}<span class="aw-ed-btn-lbl">格式化</span></button>` : ''}
          <button type="button" class="aw-status-pill" id="aw-ed-wrap" data-active="${wordWrap ? '1' : '0'}" title="切换自动换行">${EDITOR_ICONS.wrap}<span class="aw-ed-btn-lbl">换行</span></button>
          <button type="button" class="aw-status-pill" id="aw-ed-find-btn" title="查找与替换 (Ctrl+F / Ctrl+H)">${EDITOR_ICONS.search}<span class="aw-ed-btn-lbl">查找替换</span></button>
          <button type="button" class="aw-status-pill" id="aw-ed-hist-btn" title="查看此文档的编辑记录并发送给 AI">${EDITOR_ICONS.history}<span class="aw-ed-btn-lbl" id="aw-ed-hist-lbl">修改记录${historyRecords.length ? ` (${historyRecords.length})` : ''}</span></button>
          <button type="button" class="aw-ghost-btn aw-editor-exit-btn" id="aw-ed-exit">退出编辑</button>
        </div>
      </div>

      ${isNonUtf8 ? `<div class="aw-editor-subnote" id="aw-ed-enc-note">当前原文件为 <strong>${esc(origEncoding.toUpperCase())}</strong> 编码；编辑保存时会自动生成 <code>.bak.encoding</code> 原件备份并保存为标准 UTF-8。</div>` : ''}

      <div class="aw-editor-alert" id="aw-ed-conflict-bar" hidden>
        <span id="aw-ed-conflict-msg">该文件刚刚在外部发生更新，请选择处理方式：</span>
        <div class="aw-editor-alert-btns">
          <button type="button" class="aw-ghost-btn" id="aw-ed-reload-disk">加载磁盘最新版</button>
          <button type="button" class="aw-primary-btn" id="aw-ed-overwrite-disk">保留并覆盖我的修改</button>
        </div>
      </div>

      <div class="aw-editor-alert" id="aw-ed-exit-bar" hidden>
        <span id="aw-ed-exit-msg">当前存在尚未保存到磁盘的内容（如未闭合的 JSON）：</span>
        <div class="aw-editor-alert-btns">
          <button type="button" class="aw-ghost-btn" id="aw-ed-exit-continue">继续编辑</button>
          <button type="button" class="aw-ghost-btn" id="aw-ed-exit-discard">放弃未存改动并退出</button>
          <button type="button" class="aw-primary-btn" id="aw-ed-exit-force">强制保存并退出</button>
        </div>
      </div>

      <div class="aw-editor-findbar" id="aw-ed-findbar" hidden>
        <div class="aw-editor-find-row">
          <input type="text" class="aw-input aw-ed-find-in" id="aw-ed-find-q" placeholder="查找内容..." />
          <button type="button" class="aw-tray-btn" id="aw-ed-find-prev" title="上一处 (Shift+Enter)">↑</button>
          <button type="button" class="aw-tray-btn" id="aw-ed-find-next" title="下一处 (Enter)">↓</button>
          <span class="aw-editor-find-count" id="aw-ed-find-count">0 处</span>
          <button type="button" class="aw-tray-btn" id="aw-ed-find-close" title="收起查找栏">${S?.ICONS?.close || '×'}</button>
        </div>
        <div class="aw-editor-find-row">
          <input type="text" class="aw-input aw-ed-find-in" id="aw-ed-rep-q" placeholder="替换为..." />
          <button type="button" class="aw-ghost-btn" id="aw-ed-rep-one">替换</button>
          <button type="button" class="aw-ghost-btn" id="aw-ed-rep-all">全部替换</button>
        </div>
      </div>

      <div class="aw-editor-hist-drawer" id="aw-ed-hist-drawer" hidden></div>

      <div class="aw-editor-stage" id="aw-ed-stage">
        <div class="aw-editor-gutter" id="aw-ed-gutter" aria-hidden="true"></div>
        <textarea class="aw-editor-textarea" id="aw-ed-ta" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off"></textarea>
      </div>
    `;

    hostEl.innerHTML = '';
    hostEl.appendChild(root);

    const statusBox = root.querySelector('#aw-ed-status');
    const statusTextEl = root.querySelector('#aw-ed-status-text');
    const forceSaveBtn = root.querySelector('#aw-ed-force-save');
    const histBtn = root.querySelector('#aw-ed-hist-btn');
    const histLbl = root.querySelector('#aw-ed-hist-lbl');
    const histDrawer = root.querySelector('#aw-ed-hist-drawer');
    const findBar = root.querySelector('#aw-ed-findbar');
    const findInput = root.querySelector('#aw-ed-find-q');
    const repInput = root.querySelector('#aw-ed-rep-q');
    const findCountEl = root.querySelector('#aw-ed-find-count');
    const conflictBar = root.querySelector('#aw-ed-conflict-bar');
    const exitBar = root.querySelector('#aw-ed-exit-bar');
    const gutterEl = root.querySelector('#aw-ed-gutter');
    const ta = root.querySelector('#aw-ed-ta');
    ta.value = lastDiskText;

    let cachedLineCount = 0;

    function updateLineNumbers() {
      const val = ta.value || '';
      let count = 1;
      for (let i = 0; i < val.length; i++) {
        if (val.charCodeAt(i) === 10) count++;
      }
      if (count !== cachedLineCount) {
        cachedLineCount = count;
        const cap = Math.min(count, 12000);
        const nums = new Array(cap);
        for (let i = 0; i < cap; i++) nums[i] = String(i + 1);
        gutterEl.textContent = nums.join('\n');
      }
      gutterEl.scrollTop = ta.scrollTop;
    }

    function setSaveUi(nextState, detail = '') {
      saveState = nextState;
      statusDetail = detail;
      statusBox.setAttribute('data-state', nextState);
      if (nextState === 'clean') {
        statusTextEl.textContent = '已保存 · 与磁盘一致';
        forceSaveBtn.hidden = true;
      } else if (nextState === 'dirty') {
        statusTextEl.textContent = '未保存 · 输入中…';
        forceSaveBtn.hidden = true;
      } else if (nextState === 'saving') {
        statusTextEl.textContent = '正在自动保存…';
        forceSaveBtn.hidden = true;
      } else if (nextState === 'saved') {
        statusTextEl.textContent = `已自动保存 · ${formatClock(lastSavedAt)}`;
        forceSaveBtn.hidden = true;
      } else if (nextState === 'paused') {
        statusTextEl.textContent = detail || '格式待闭合，补全后自动保存';
        forceSaveBtn.hidden = false;
        forceSaveBtn.textContent = '强制保存';
      } else if (nextState === 'conflict') {
        statusTextEl.textContent = '暂未保存 · 检测到外部修改';
        forceSaveBtn.hidden = true;
      } else {
        statusTextEl.textContent = detail || '自动保存失败';
        forceSaveBtn.hidden = false;
        forceSaveBtn.textContent = '重试保存';
      }
    }

    function updateHistoryButtonCount() {
      if (histLbl) {
        histLbl.textContent = historyRecords.length ? `修改记录 (${historyRecords.length})` : '修改记录';
      }
      if (histBtn) {
        if (historyRecords.length) histBtn.setAttribute('data-has-links', '1');
        else histBtn.removeAttribute('data-has-links');
      }
      if (historyOpen) renderHistoryDrawer();
    }

    function renderHistoryDrawer() {
      if (!histDrawer) return;
      if (!historyOpen) {
        histDrawer.hidden = true;
        return;
      }
      histDrawer.hidden = false;
      const latest = historyRecords[0] || null;
      const rowsHtml = historyRecords.length
        ? historyRecords
            .map((r, idx) => {
              const diffLines = String(r.diffText || '')
                .split('\n')
                .slice(0, 60)
                .map((ln) => {
                  const cls = ln.startsWith('@@')
                    ? 'aw-diff-hunk'
                    : ln.startsWith('+')
                    ? 'aw-diff-add'
                    : ln.startsWith('-')
                    ? 'aw-diff-del'
                    : 'aw-diff-ctx';
                  return `<div class="${cls}">${esc(ln || ' ')}</div>`;
                })
                .join('');
              return `
                <div class="aw-ed-hist-card">
                  <div class="aw-ed-hist-card-head">
                    <div>
                      <strong>${idx === 0 ? '最近修改' : `历史记录 #${idx + 1}`}</strong>
                      <span class="aw-link-row-badge" style="margin-left:6px">${esc(r.summary || '')}</span>
                      <span class="aw-ed-hist-time">${esc(formatDateTime(r.updatedAt))}</span>
                    </div>
                    <div style="display:flex;gap:6px;flex-wrap:wrap">
                      <button type="button" class="aw-ghost-btn aw-ed-copy-rec" data-rec-idx="${idx}">复制记录</button>
                      <button type="button" class="aw-primary-btn aw-ed-send-rec" data-rec-idx="${idx}">${EDITOR_ICONS.sendAi}<span>发给 AI 查看</span></button>
                    </div>
                  </div>
                  <div class="aw-ed-diff-box">${diffLines}</div>
                </div>
              `;
            })
            .join('')
        : `<div class="aw-ed-hist-empty">当前文档还没有产生保存后的差异记录。直接修改上方内容并自动保存后，这里会生成清晰的改动对比，方便随时发给 AI 查看。</div>`;

      histDrawer.innerHTML = `
        <div class="aw-ed-hist-head">
          <span><strong>此文档的用户修改记录</strong>（AI 可直接读取或点击右侧按钮填入对话框）</span>
          <button type="button" class="aw-tray-btn" id="aw-ed-hist-close" title="收起修改记录">${S?.ICONS?.close || '×'}</button>
        </div>
        <div class="aw-ed-hist-list">${rowsHtml}</div>
      `;

      histDrawer.querySelector('#aw-ed-hist-close')?.addEventListener('click', () => {
        historyOpen = false;
        histDrawer.hidden = true;
      });
      histDrawer.querySelectorAll('.aw-ed-copy-rec').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-rec-idx'));
          const rec = historyRecords[idx] || latest;
          const text = buildAiPromptFromRecord(rec, callbacks.getDisplayPath?.(filePath) || filePath);
          callbacks.onCopyText?.(text, '已复制修改记录');
        });
      });
      histDrawer.querySelectorAll('.aw-ed-send-rec').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-rec-idx'));
          const rec = historyRecords[idx] || latest;
          const text = buildAiPromptFromRecord(rec, callbacks.getDisplayPath?.(filePath) || filePath);
          if (callbacks.onSendToAi) {
            callbacks.onSendToAi(text, rec, reportPath);
          } else {
            callbacks.onCopyText?.(text, '已复制修改记录，可直接粘贴给 AI');
          }
        });
      });
    }

    async function performSave({ forceSave = false, forceOverwrite = false } = {}) {
      if (destroyed) return false;
      clearTimeout(debounceTimer);
      debounceTimer = null;

      const currentVal = ta.value;
      if (!forceOverwrite && currentVal === lastDiskText && saveState !== 'error') {
        if (lastSavedAt > 0) setSaveUi('saved');
        else setSaveUi('clean');
        return true;
      }

      const localSyntax = validateSyntaxClient(filePath, currentVal);
      if (!localSyntax.valid && !forceSave) {
        setSaveUi('paused', localSyntax.message);
        return false;
      }

      if (saveInFlight) {
        pendingSaveAfterFlight = true;
        return false;
      }

      saveInFlight = true;
      setSaveUi('saving');
      try {
        const res = await callbacks.onSave?.({
          path: filePath,
          sessionId,
          content: currentVal,
          baseMtimeMs: mtimeMs,
          forceSave: Boolean(forceSave),
          forceOverwrite: Boolean(forceOverwrite),
        });
        if (destroyed) return false;

        if (res?.ok) {
          lastDiskText = currentVal;
          if (Number.isFinite(res.mtimeMs)) mtimeMs = res.mtimeMs;
          lastSavedAt = res.savedAt || Date.now();
          if (Array.isArray(res.history)) historyRecords = res.history;
          if (res.reportPath) reportPath = res.reportPath;
          if (res.convertedToUtf8) {
            isNonUtf8 = false;
            const encNote = root.querySelector('#aw-ed-enc-note');
            if (encNote) encNote.hidden = true;
          }
          conflictState = null;
          conflictBar.hidden = true;
          updateHistoryButtonCount();
          // Re-check if user typed more while RPC was in flight
          if (ta.value !== lastDiskText) {
            scheduleAutoSave();
          } else {
            setSaveUi('saved');
          }
          return true;
        }

        if (res?.syntaxPaused) {
          setSaveUi('paused', res.syntax?.message || res.error || '格式待闭合');
          return false;
        }

        if (res?.conflict) {
          conflictState = res;
          conflictBar.hidden = false;
          setSaveUi('conflict');
          return false;
        }

        setSaveUi('error', res?.error || '保存失败');
        return false;
      } catch (err) {
        if (!destroyed) setSaveUi('error', String(err?.message || err || '保存异常'));
        return false;
      } finally {
        saveInFlight = false;
        if (!destroyed && pendingSaveAfterFlight) {
          pendingSaveAfterFlight = false;
          scheduleAutoSave();
        }
      }
    }

    function scheduleAutoSave() {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      if (destroyed) return;

      const currentVal = ta.value;
      if (currentVal === lastDiskText && !conflictState) {
        if (lastSavedAt > 0) setSaveUi('saved');
        else setSaveUi('clean');
        return;
      }

      const localSyntax = validateSyntaxClient(filePath, currentVal);
      if (!localSyntax.valid) {
        setSaveUi('paused', localSyntax.message);
        return;
      }

      setSaveUi('dirty');
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (!isComposing) void performSave({ forceSave: false });
      }, 650);
    }

    // ── Search & Replace Logic ───────────────────────────────────────────────
    function collectMatchRanges(query) {
      const q = String(query || '');
      if (!q) return [];
      const hay = ta.value.toLowerCase();
      const needle = q.toLowerCase();
      const out = [];
      let pos = 0;
      while (pos <= hay.length - needle.length && out.length < 2000) {
        const hit = hay.indexOf(needle, pos);
        if (hit === -1) break;
        out.push({ start: hit, end: hit + needle.length });
        pos = hit + Math.max(1, needle.length);
      }
      return out;
    }

    function scrollTextareaToSelection() {
      const selStart = ta.selectionStart || 0;
      const lineIdx = offsetToLine(ta.value, selStart) - 1;
      const approxLineHeight = 20;
      const targetTop = Math.max(0, lineIdx * approxLineHeight - ta.clientHeight * 0.35);
      ta.scrollTop = targetTop;
      gutterEl.scrollTop = ta.scrollTop;
    }

    function stepFind(dir = 1) {
      const q = findInput.value;
      const ranges = collectMatchRanges(q);
      if (!ranges.length) {
        findCountEl.textContent = q ? '无匹配' : '0 处';
        return;
      }
      const curPos = dir > 0 ? ta.selectionEnd : ta.selectionStart;
      let chosenIdx = 0;
      if (dir > 0) {
        const nextIdx = ranges.findIndex((r) => r.start >= curPos);
        chosenIdx = nextIdx !== -1 ? nextIdx : 0;
      } else {
        let prevIdx = -1;
        for (let i = ranges.length - 1; i >= 0; i--) {
          if (ranges[i].end <= curPos) {
            prevIdx = i;
            break;
          }
        }
        chosenIdx = prevIdx !== -1 ? prevIdx : ranges.length - 1;
      }
      const hit = ranges[chosenIdx];
      ta.focus();
      ta.setSelectionRange(hit.start, hit.end);
      scrollTextareaToSelection();
      findCountEl.textContent = `${chosenIdx + 1} / ${ranges.length}`;
    }

    function updateFindCountOnly() {
      const q = findInput.value;
      if (!q) {
        findCountEl.textContent = '0 处';
        return;
      }
      const ranges = collectMatchRanges(q);
      findCountEl.textContent = ranges.length ? `共 ${ranges.length} 处` : '无匹配';
    }

    function replaceCurrentMatch() {
      const q = findInput.value;
      if (!q) return;
      const rep = repInput.value ?? '';
      const selText = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (selText.toLowerCase() !== q.toLowerCase()) {
        stepFind(1);
        const retrySel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        if (retrySel.toLowerCase() !== q.toLowerCase()) return;
      }
      const s = ta.selectionStart;
      const e = ta.selectionEnd;
      ta.setRangeText(rep, s, e, 'end');
      updateLineNumbers();
      updateFindCountOnly();
      scheduleAutoSave();
      stepFind(1);
    }

    function replaceAllMatches() {
      const q = findInput.value;
      if (!q) return;
      const rep = repInput.value ?? '';
      const ranges = collectMatchRanges(q);
      if (!ranges.length) return;
      let nextVal = '';
      let cursor = 0;
      for (const r of ranges) {
        nextVal += ta.value.slice(cursor, r.start) + rep;
        cursor = r.end;
      }
      nextVal += ta.value.slice(cursor);
      ta.value = nextVal;
      updateLineNumbers();
      updateFindCountOnly();
      scheduleAutoSave();
      callbacks.onNotify?.(`已替换全部 ${ranges.length} 处`);
    }

    // ── Event Listeners ──────────────────────────────────────────────────────
    ta.addEventListener('scroll', () => {
      gutterEl.scrollTop = ta.scrollTop;
    });
    ta.addEventListener('compositionstart', () => {
      isComposing = true;
    });
    ta.addEventListener('compositionend', () => {
      isComposing = false;
      updateLineNumbers();
      scheduleAutoSave();
    });
    ta.addEventListener('input', () => {
      exitConfirmOpen = false;
      exitBar.hidden = true;
      updateLineNumbers();
      if (!isComposing) scheduleAutoSave();
    });

    ta.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === 's') {
        ev.preventDefault();
        ev.stopPropagation();
        void performSave({ forceSave: true });
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key.toLowerCase() === 'f' || ev.key.toLowerCase() === 'h')) {
        ev.preventDefault();
        ev.stopPropagation();
        findOpen = true;
        findBar.hidden = false;
        const selected = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        if (selected && !selected.includes('\n') && selected.length <= 120) {
          findInput.value = selected;
        }
        updateFindCountOnly();
        if (ev.key.toLowerCase() === 'h') repInput.focus();
        else findInput.focus();
        return;
      }
      if (ev.key === 'Tab' && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        ev.preventDefault();
        ev.stopPropagation();
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        if (!ev.shiftKey && start === end) {
          ta.setRangeText('  ', start, end, 'end');
        } else {
          const val = ta.value;
          const lineStart = val.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
          const block = val.slice(lineStart, end);
          const lines = block.split('\n');
          const transformed = ev.shiftKey
            ? lines.map((ln) => (ln.startsWith('  ') ? ln.slice(2) : ln.startsWith('\t') ? ln.slice(1) : ln)).join('\n')
            : lines.map((ln) => '  ' + ln).join('\n');
          ta.setRangeText(transformed, lineStart, end, 'select');
        }
        updateLineNumbers();
        scheduleAutoSave();
      }
    });

    forceSaveBtn?.addEventListener('click', () => {
      void performSave({ forceSave: true });
    });

    root.querySelector('#aw-ed-format')?.addEventListener('click', () => {
      try {
        const parsed = JSON.parse(ta.value);
        const formatted = JSON.stringify(parsed, null, 2) + '\n';
        if (formatted !== ta.value) {
          ta.value = formatted;
          updateLineNumbers();
          scheduleAutoSave();
          callbacks.onNotify?.('已整理 JSON 缩进格式');
        } else {
          callbacks.onNotify?.('当前 JSON 格式已整齐');
        }
      } catch {
        callbacks.onNotify?.('请先补全未闭合的 JSON 语法再执行格式化');
      }
    });

    root.querySelector('#aw-ed-wrap')?.addEventListener('click', (e) => {
      wordWrap = !wordWrap;
      root.setAttribute('data-wrap', wordWrap ? '1' : '0');
      e.currentTarget.setAttribute('data-active', wordWrap ? '1' : '0');
    });

    root.querySelector('#aw-ed-find-btn')?.addEventListener('click', () => {
      findOpen = !findOpen;
      findBar.hidden = !findOpen;
      if (findOpen) {
        const selected = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        if (selected && !selected.includes('\n') && selected.length <= 120) {
          findInput.value = selected;
        }
        updateFindCountOnly();
        findInput.focus();
      } else {
        ta.focus();
      }
    });

    root.querySelector('#aw-ed-find-close')?.addEventListener('click', () => {
      findOpen = false;
      findBar.hidden = true;
      ta.focus();
    });
    findInput?.addEventListener('input', updateFindCountOnly);
    findInput?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        stepFind(ev.shiftKey ? -1 : 1);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        findOpen = false;
        findBar.hidden = true;
        ta.focus();
      }
    });
    repInput?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        replaceCurrentMatch();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        findOpen = false;
        findBar.hidden = true;
        ta.focus();
      }
    });
    root.querySelector('#aw-ed-find-next')?.addEventListener('click', () => stepFind(1));
    root.querySelector('#aw-ed-find-prev')?.addEventListener('click', () => stepFind(-1));
    root.querySelector('#aw-ed-rep-one')?.addEventListener('click', replaceCurrentMatch);
    root.querySelector('#aw-ed-rep-all')?.addEventListener('click', replaceAllMatches);

    histBtn?.addEventListener('click', () => {
      historyOpen = !historyOpen;
      renderHistoryDrawer();
    });

    root.querySelector('#aw-ed-reload-disk')?.addEventListener('click', async () => {
      const fresh = await callbacks.onReload?.(filePath);
      if (fresh?.ok) {
        sessionId = fresh.sessionId || sessionId;
        lastDiskText = String(fresh.text ?? '');
        mtimeMs = fresh.mtimeMs ?? mtimeMs;
        if (Array.isArray(fresh.history)) historyRecords = fresh.history;
        ta.value = lastDiskText;
        conflictState = null;
        conflictBar.hidden = true;
        updateLineNumbers();
        updateHistoryButtonCount();
        setSaveUi('clean');
        callbacks.onNotify?.('已加载磁盘最新内容');
      }
    });

    root.querySelector('#aw-ed-overwrite-disk')?.addEventListener('click', () => {
      void performSave({ forceSave: true, forceOverwrite: true });
    });

    async function handleExitRequest() {
      if (ta.value !== lastDiskText) {
        const savedOk = await performSave({ forceSave: false });
        if (!savedOk) {
          exitConfirmOpen = true;
          exitBar.hidden = false;
          return;
        }
      }
      callbacks.onExit?.({ saved: lastSavedAt > 0, latestRecord: historyRecords[0] || null });
    }

    root.querySelector('#aw-ed-exit')?.addEventListener('click', () => {
      void handleExitRequest();
    });
    root.querySelector('#aw-ed-exit-continue')?.addEventListener('click', () => {
      exitConfirmOpen = false;
      exitBar.hidden = true;
      ta.focus();
    });
    root.querySelector('#aw-ed-exit-discard')?.addEventListener('click', () => {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      callbacks.onExit?.({ saved: lastSavedAt > 0, discardedDraft: true });
    });
    root.querySelector('#aw-ed-exit-force')?.addEventListener('click', async () => {
      const ok = await performSave({ forceSave: true, forceOverwrite: Boolean(conflictState) });
      if (ok) {
        callbacks.onExit?.({ saved: true, latestRecord: historyRecords[0] || null });
      }
    });

    function locateSelection({ lineStart = null, selectionText = '' } = {}) {
      const val = ta.value || '';
      const needle = String(selectionText || '').replace(/\r\n/g, '\n');
      if (needle) {
        let searchFrom = 0;
        if (lineStart && lineStart > 1) {
          let curLn = 1;
          for (let i = 0; i < val.length; i++) {
            if (curLn >= Math.max(1, lineStart - 2)) {
              searchFrom = i;
              break;
            }
            if (val.charCodeAt(i) === 10) curLn++;
          }
        }
        let idx = val.indexOf(needle, searchFrom);
        if (idx === -1 && searchFrom > 0) idx = val.indexOf(needle);
        if (idx === -1 && needle.trim()) idx = val.indexOf(needle.trim());
        if (idx !== -1) {
          const matchLen = val.slice(idx, idx + needle.length) === needle ? needle.length : needle.trim().length;
          ta.focus();
          ta.setSelectionRange(idx, idx + matchLen);
          scrollTextareaToSelection();
          return true;
        }
      }
      if (lineStart && lineStart >= 1) {
        let curLn = 1;
        let linePos = 0;
        for (let i = 0; i < val.length; i++) {
          if (curLn === lineStart) {
            linePos = i;
            break;
          }
          if (val.charCodeAt(i) === 10) curLn++;
        }
        const lineEnd = val.indexOf('\n', linePos);
        ta.focus();
        ta.setSelectionRange(linePos, lineEnd === -1 ? val.length : lineEnd);
        scrollTextareaToSelection();
        return true;
      }
      ta.focus();
      return false;
    }

    updateLineNumbers();
    const initialSyntax = validateSyntaxClient(filePath, lastDiskText);
    if (!initialSyntax.valid) {
      setSaveUi('paused', initialSyntax.message);
    } else {
      setSaveUi('clean');
    }

    if (callbacks.initialLocate) {
      requestAnimationFrame(() => locateSelection(callbacks.initialLocate));
    }

    return {
      locateSelection,
      focus({ preventScroll = true } = {}) {
        try {
          ta.focus({ preventScroll });
        } catch {
          try { ta.focus(); } catch {}
        }
      },
      flushIfValid: () => performSave({ forceSave: false }),
      isDirty: () => ta.value !== lastDiskText,
      getScrollEl: () => ta,
      destroy() {
        destroyed = true;
        clearTimeout(debounceTimer);
        debounceTimer = null;
      },
    };
  }

  return {
    isEditableTextPath,
    validateSyntaxClient,
    buildAiPromptFromRecord,
    mountTextEditor,
    EDITOR_ICONS,
  };
});
