// shared.js — IMARA LINKS v3 (stable auth, ACID-aware)
// API base: in Electron the server runs on localhost:9000.
// In standalone browser mode it runs on localhost:3001.
// We detect by checking if we're served from port 9000 (Electron) or 3001 (standalone).
const API = (typeof window !== 'undefined' && window.API_BASE)
  ? window.API_BASE
  : (() => {
      if (typeof window === 'undefined') return 'http://localhost:9000/api';
      const port = window.location.port;
      const host = window.location.hostname;
      if (host === 'localhost' || host === '127.0.0.1') {
        // Use the same port we were served from — works for both Electron (9000) and standalone (3001)
        return `http://${host}:${port || 9000}/api`;
      }
      return 'https://imara-links-api.onrender.com/api';
    })();

const Store = {
  get token() { return localStorage.getItem('il_token'); },
  get user()  { try { return JSON.parse(localStorage.getItem('il_user')); } catch { return null; } },
  set(token, user) {
    localStorage.setItem('il_token', token);
    localStorage.setItem('il_user', JSON.stringify(user));
  },
  updateUser(user) {
    Store.set(Store.token, { ...(Store.user||{}), ...user });
  },
  clear() {
    localStorage.removeItem('il_token');
    localStorage.removeItem('il_user');
  }
};

// ── Native dialog focus fix ────────────────────────────────────────────────
// Electron quirk: after window.confirm()/prompt()/alert() (synchronous native
// dialogs) closes, real OS-level keyboard focus doesn't reliably return to the
// page — inputs accept clicks but typing does nothing until the user clicks the
// window chrome or alt-tabs. window.focus() (a DOM call) does not fix this; it
// has to be forced from the main process. We wrap the three dialog functions
// once, here, so every call site in every page gets the fix automatically —
// no need to touch each confirm()/prompt()/alert() call individually.
(function fixNativeDialogFocus() {
  if (typeof window === 'undefined') return;
  const restoreFocus = () => {
    if (window.electron && typeof window.electron.focusWindow === 'function') {
      window.electron.focusWindow();
    } else {
      window.focus();
    }
  };
  ['confirm', 'prompt', 'alert'].forEach(fnName => {
    const native = window[fnName];
    window[fnName] = function(...args) {
      const result = native.apply(window, args);
      restoreFocus();
      return result;
    };
  });
})();

// ── App confirm dialog (replaces window.confirm) ──────────────────────────
// window.confirm() is a synchronous native dialog: it blocks the whole
// renderer's JS thread until dismissed. In Electron that's what causes the
// "hang" feeling — any in-flight fetch/timer/render on this window is frozen
// until the user answers, and the native dialog itself can be slow to paint
// under load. appConfirm() replaces it with a normal DOM modal (the same
// .modal-overlay/.modal already used elsewhere in the app), so the page
// never blocks — it just awaits the user's click. Call sites change from
//   if (!confirm(msg)) return;
// to
//   if (!(await appConfirm(msg))) return;
// Supports \n line breaks (existing confirm messages use them for bullet
// lists) and an optional danger style for destructive actions.
function appConfirm(message, opts = {}) {
  const {
    title = 'Please confirm',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = true
  } = opts;

  return new Promise(resolve => {
    const existing = document.getElementById('appConfirmModal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'appConfirmModal';
    overlay.className = 'modal-overlay';

    const bodyHtml = escHtml(message).replace(/\n/g, '<br>');

    overlay.innerHTML = `
      <div class="modal" role="alertdialog" aria-modal="true">
        <div class="modal-title">${escHtml(title)}</div>
        <div style="font-size:.86rem;color:var(--ink);line-height:1.5">${bodyHtml}</div>
        <div class="modal-footer">
          <button class="btn btn-sm" id="appConfirmCancel">${escHtml(cancelLabel)}</button>
          <button class="btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}" id="appConfirmOk">${escHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const cleanup = (result) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter') cleanup(true);
    };

    overlay.querySelector('#appConfirmOk').addEventListener('click', () => cleanup(true));
    overlay.querySelector('#appConfirmCancel').addEventListener('click', () => cleanup(false));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cleanup(false); });
    document.addEventListener('keydown', onKey);

    overlay.querySelector('#appConfirmOk').focus();
  });
}

// ── 401 handler: clear session then redirect cleanly — no modal loop ─────────
const _401Modal = { shown: false };
function handle401(path) {
  if (path === '/auth/login') return false;
  if (_401Modal.shown) return false;

  _401Modal.shown = true;
  Store.clear();
  window.location.replace('login.html?reason=session_expired');
  return true;
}

// ── Error tracker (non-blocking) ──────────────────────────────────────────────
const ErrorTracker = {
  logError(error, context = {}) {
    const now = new Date();
    const errorData = {
      timestamp: now.toISOString(),
      realTime: now.getTime(),
      user: Store.user?.username || 'anonymous',
      role: Store.user?.role || 'none',
      userAgent: navigator.userAgent,
      url: window.location.href,
      error: error.error || error.message || String(error),
      context,
      severity: this.getSeverity(error),
    };
    this.storeLocalError(errorData);
    if (Store.token) this.sendErrorToServer(errorData).catch(() => {});
  },
  getSeverity(error) {
    if (error.context?.path === '/auth/login') return 'low';
    if (error.status >= 500) return 'high';
    if (error.status >= 400) return 'medium';
    return 'low';
  },
  storeLocalError(errorData) {
    try {
      const errors = JSON.parse(localStorage.getItem('system_errors') || '[]');
      errors.unshift(errorData);
      if (errors.length > 100) errors.splice(100);
      localStorage.setItem('system_errors', JSON.stringify(errors));
    } catch(_) {}
  },
  async sendErrorToServer(errorData) {
    await fetch(API + '/admin/errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Store.token}` },
      body: JSON.stringify(errorData)
    });
  },
  getLocalErrors() {
    try {
      return JSON.parse(localStorage.getItem('system_errors') || '[]')
        .filter(e => e?.timestamp && !isNaN(new Date(e.timestamp).getTime()));
    } catch { return []; }
  },
  clearLocalErrors() { localStorage.removeItem('system_errors'); },
};

// Catch anything that breaks silently in the UI — a thrown error inside an
// event handler, or a rejected promise nobody awaited — and log it the same
// way API errors are already logged (local storage + server if signed in).
// Without this, a freeze/break that happens between clicks leaves no trace;
// this makes sure it does, so a recurring problem can be diagnosed from what
// actually happened instead of a description after the fact.
window.addEventListener('error', (e) => {
  ErrorTracker.logError(
    { error: e.message || 'Unhandled error', stack: e.error?.stack },
    { kind: 'window.onerror', file: e.filename, line: e.lineno, col: e.colno }
  );
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  ErrorTracker.logError(
    { error: (reason && (reason.message || reason.error)) || String(reason), stack: reason?.stack },
    { kind: 'unhandledrejection' }
  );
});

// ── Core API call with retry-once on network error ────────────────────────────
let _apiMutationCount = 0;

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (Store.token) opts.headers['Authorization'] = `Bearer ${Store.token}`;
  if (body !== undefined) opts.body = JSON.stringify(body);

  const timeoutMs = (method === 'POST' || method === 'PUT' || method === 'DELETE') ? 30000 : 15000;
  const isMutation = method === 'POST' || method === 'PUT' || method === 'DELETE';

  if (isMutation) {
    _apiMutationCount++;
    try { PageProgress.show(20, 'Saving…'); } catch(e) {}
  }

  const doFetch = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(API + path, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 401) {
        if (path !== '/auth/login') ErrorTracker.logError({ error: 'Auth 401', status: 401 }, { path });
        handle401(path);
        return null;
      }
      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('application/json') ? await res.json() : { error: await res.text() };
      if (!res.ok) {
        if (path !== '/auth/login' || res.status !== 401) ErrorTracker.logError(data, { path, status: res.status });
        throw data;
      }
      return data;
    } catch(e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw { error: 'Request timed out — please check your connection and try again.' };
      throw e;
    }
  };

  try {
    if (isMutation) try { PageProgress.show(55, 'Saving…'); } catch(e) {}
    const result = await doFetch();
    if (isMutation) {
      _apiMutationCount = Math.max(0, _apiMutationCount - 1);
      if (_apiMutationCount === 0) try { PageProgress.done(); } catch(e) {}
    }
    return result;
  } catch (error) {
    if (isMutation) {
      _apiMutationCount = Math.max(0, _apiMutationCount - 1);
      if (_apiMutationCount === 0) try { PageProgress.error(); } catch(e) {}
    }
    if (error instanceof TypeError && error.message.includes('fetch')) {
      if (isMutation) try { PageProgress.show(70, 'Retrying…'); } catch(e) {}
      await new Promise(r => setTimeout(r, 1500));
      try {
        const result = await doFetch();
        if (isMutation) try { PageProgress.done(); } catch(e) {}
        return result;
      } catch(e2) {
        ErrorTracker.logError(e2, { path, networkError: true });
        if (isMutation) try { PageProgress.error(); } catch(e) {}
        throw { error: 'Network error — please check your internet connection and try again.' };
      }
    }
    throw error;
  }
}

// ── Streaming download (for CSV/Excel export from API) ───────────────────────
async function apiDownload(path, filename) {
  // First check the request succeeds, then trigger a real URL download
  // so Electron's will-download handler fires and saves to Downloads folder.
  const testRes = await fetch(API + path, {
    headers: { 'Authorization': `Bearer ${Store.token}` }
  });
  if (!testRes.ok) { showToast('Export failed', 'error'); return; }

  // Build a direct URL with the token as a query param so Electron can
  // fetch it as a navigation (triggering will-download) rather than a blob.
  const sep = path.includes('?') ? '&' : '?';
  const downloadUrl = API + path + sep + '_dl=' + encodeURIComponent(filename)
    + '&token=' + encodeURIComponent(Store.token);

  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function requireAuth(roles) {
  const user = Store.user;
  if (!user || !Store.token) { location.href = 'login.html'; return null; }
  if (roles) {
    const allowed = Array.isArray(roles) ? roles : [roles];
    if (!allowed.includes(user.role)) {
      document.body.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:var(--font)">
          <div style="text-align:center;padding:2rem">
            <div style="font-size:3rem;margin-bottom:1rem">🚫</div>
            <h1 style="color:var(--red);margin-bottom:1rem">Access Denied</h1>
            <p style="color:var(--muted);margin-bottom:1.5rem">Required: ${allowed.join(' or ')}<br>Your role: ${user.role}</p>
            <button onclick="location.href='dashboard.html'" style="padding:.75rem 1.5rem;background:var(--g500);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer">Go to Dashboard</button>
          </div>
        </div>`;
      return null;
    }
  }
  return user;
}

function fmt(n, dec = 0) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString('en-KE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

/** Weight formatter — auto-converts to tonnes when ≥ 1000 kg.
 *  e.g. 330 → "330 kg", 1000 → "1 t", 1500 → "1.5 t", 2750 → "2.75 t" */
function fmtKg(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  const abs = Math.abs(n);
  if (abs >= 1000) return parseFloat((n / 1000).toFixed(2)) + ' t';
  if (abs >= 1)    return parseFloat(n.toFixed(1)) + ' kg';
  return n.toFixed(2) + ' kg';
}

function fmtMoney(n, currency) {
  if (n == null || isNaN(n)) return '—';
  const cur = currency || getConfig('currency') || 'KES';
  return cur + ' ' + Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Exact, unrounded weight string for use in title="" tooltips. e.g. 1234.5678 → "1,234.5678 kg" */
function fmtKgExact(v) {
  if (v == null || isNaN(v)) return '—';
  return Number(v).toLocaleString('en-KE', { minimumFractionDigits: 3, maximumFractionDigits: 4 }) + ' kg';
}

/** Exact, unrounded money string for use in title="" tooltips. e.g. 10490.4231 → "KES 10,490.4231" */
function fmtMoneyExact(n, currency) {
  if (n == null || isNaN(n)) return '—';
  const cur = currency || getConfig('currency') || 'KES';
  return cur + ' ' + Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** Wrap a rounded display string in a span whose title="" shows the exact figure on hover. */
function tipSpan(displayHtml, exactText) {
  return `<span title="${escHtml(exactText)}" style="cursor:help;border-bottom:1px dotted currentColor">${displayHtml}</span>`;
}

function localDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function today() { return localDateString(); }

// SQLite's CURRENT_TIMESTAMP always stores UTC, as a naive string with no
// timezone marker (e.g. "2026-07-06 13:07:49"). Passed straight into
// `new Date(...)`, JS treats that as already being local time and does NOT
// shift it — so raw log/audit timestamps display several hours behind the
// real local time (exactly the browser's UTC offset). This normalizes the
// string to explicit UTC before parsing, so the browser converts it to the
// viewer's actual local time, correctly, every time.
function utcDbTimeToLocal(value) {
  if (!value) return null;
  let s = String(value).trim();
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function fmtLocalDateTime(value, opts) {
  const d = utcDbTimeToLocal(value);
  return d ? d.toLocaleString('en-KE', opts) : '—';
}

function showToast(msg, type = 'success', duration = 3500) {
  const t = document.createElement('div');
  t.className = `toast toast-${type === 'warn' ? 'warn' : type}`;
  t.innerHTML = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, duration);
}

function showErr(el, msg) {
  if (typeof el === 'string') el = document.getElementById(el);
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setPresetDates(days, fromId, toId) {
  const to   = new Date();
  const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - days);
  document.getElementById(toId).value   = localDateString(to);
  document.getElementById(fromId).value = localDateString(from);
}

// Global config cache
let _globalConfig = null;

async function loadGlobalConfig() {
  if (_globalConfig) return _globalConfig;
  try {
    _globalConfig = await api('GET', '/config');
    return _globalConfig;
  } catch(e) { console.error('Failed to load config:', e); return {}; }
}

function getConfig(key, defaultValue = null) { return _globalConfig?.[key] ?? defaultValue; }

function updateConfigField(fieldId, configKey, defaultValue = '') {
  const el = document.getElementById(fieldId);
  if (!el) return;
  const v = getConfig(configKey, defaultValue);
  el.value = (v !== null && v !== undefined && v !== '') ? v : defaultValue;
  if (el.type === 'number') el.placeholder = el.value || defaultValue;
}

// ── Loading skeleton helper ───────────────────────────────────────────────────
function showSkeleton(containerId, rows = 3, cols = 4) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const skelRow = `<tr>${Array(cols).fill(`<td><div class="skel-cell"></div></td>`).join('')}</tr>`;
  el.innerHTML = Array(rows).fill(skelRow).join('');
}

// ── Page-level loading overlay ────────────────────────────────────────────────
function showPageLoader(msg = 'Loading…') {
  let el = document.getElementById('_pageLoader');
  if (!el) {
    el = document.createElement('div');
    el.id = '_pageLoader';
    el.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(242,245,243,.85);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;backdrop-filter:blur(2px);transition:opacity .2s';
    el.innerHTML = `<div class="spinner" style="width:36px;height:36px;border-width:3px"></div><div style="font-size:.9rem;color:var(--muted);font-weight:500" id="_pageLoaderMsg">${msg}</div>`;
    document.body.appendChild(el);
  } else {
    const m = document.getElementById('_pageLoaderMsg');
    if (m) m.textContent = msg;
    el.style.opacity = '1';
    el.style.display = 'flex';
  }
}
function hidePageLoader() {
  const el = document.getElementById('_pageLoader');
  if (!el) return;
  el.style.opacity = '0';
  setTimeout(() => { el.style.display = 'none'; }, 220);
}

function refreshGlobalConfig() { _globalConfig = null; return loadGlobalConfig(); }

// ── CSV download (browser-side) ───────────────────────────────────────────────
function downloadCSV(filename, headers, rows) {
  const BOM = '\uFEFF';
  const csvContent = BOM + [headers, ...rows]
    .map(row => row.map(val => {
      const s = (val === null || val === undefined) ? '' : String(val);
      return `"${s.replace(/"/g, '""')}"`;
    }).join(',')).join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ── Global progress bar (used by all pages) ───────────────────────────────────
const PageProgress = (() => {
  let _wrap, _bar, _lbl, _t;

  function _ensure() {
    if (_wrap) return;
    const style = document.createElement('style');
    style.textContent = `
      #_ppWrap{position:fixed;top:0;left:0;right:0;z-index:99999;height:3px;
        background:transparent;pointer-events:none;opacity:0;transition:opacity .4s}
      #_ppBar{height:100%;width:0%;background:linear-gradient(90deg,#1e9a62,#34d399);
        transition:width .35s ease,background .3s;border-radius:0 2px 2px 0}
      #_ppLbl{position:fixed;top:6px;left:50%;transform:translateX(-50%);
        font-size:.72rem;font-weight:600;color:#1e9a62;
        background:rgba(255,255,255,.93);padding:.15rem .65rem;
        border-radius:99px;border:1px solid #d1fae5;
        pointer-events:none;z-index:99999;white-space:nowrap;
        opacity:0;transition:opacity .25s;letter-spacing:.02em}
    `;
    document.head.appendChild(style);
    _wrap = document.createElement('div'); _wrap.id = '_ppWrap';
    _bar  = document.createElement('div'); _bar.id  = '_ppBar';
    _lbl  = document.createElement('div'); _lbl.id  = '_ppLbl';
    _wrap.appendChild(_bar);
    document.body.prepend(_lbl);
    document.body.prepend(_wrap);
  }

  return {
    show(pct, msg) {
      _ensure();
      _wrap.style.opacity = '1';
      _bar.style.width    = Math.min(pct, 97) + '%';
      if (msg != null) { _lbl.textContent = msg; _lbl.style.opacity = '1'; }
    },
    done() {
      if (!_bar) return;
      _bar.style.width      = '100%';
      _bar.style.background = 'linear-gradient(90deg,#1e9a62,#34d399)';
      _lbl.style.opacity    = '0';
      clearTimeout(_t);
      _t = setTimeout(() => {
        _wrap.style.opacity = '0';
        setTimeout(() => { _bar.style.width = '0%'; }, 450);
      }, 380);
    },
    error() {
      if (!_bar) return;
      _bar.style.background = '#dc2626';
      _bar.style.width      = '100%';
      _lbl.style.opacity    = '0';
      clearTimeout(_t);
      _t = setTimeout(() => {
        _wrap.style.opacity = '0';
        setTimeout(() => {
          _bar.style.width      = '0%';
          _bar.style.background = 'linear-gradient(90deg,#1e9a62,#34d399)';
        }, 450);
      }, 700);
    },
  };
})();

// ── Auto-updater UI ───────────────────────────────────────────────────────────
// Listens for update events from the Electron main process (via preload.js IPC bridge)
// and shows a non-intrusive banner when an update is ready to install.
(function initUpdaterUI() {
  if (typeof window === 'undefined' || !window.electron) return;

  // Update is available and downloading in background
  window.electron.onUpdateAvailable((event, info) => {
    const version = info?.version ? ` (v${info.version})` : '';
    showToast(
      `🔄 Update${version} is downloading in the background…`,
      'info',
      6000
    );
  });

  // Update downloaded — show persistent green banner with restart button
  window.electron.onUpdateDownloaded((event, info) => {
    const version = info?.version ? ` v${info.version}` : '';

    document.getElementById('_updateBanner')?.remove();

    const banner = document.createElement('div');
    banner.id = '_updateBanner';
    banner.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0;
      z-index: 999999;
      background: linear-gradient(90deg, #1e9a62, #16a34a);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 1rem;
      padding: .6rem 1.2rem;
      font-family: var(--font, sans-serif);
      font-size: .85rem;
      font-weight: 500;
      box-shadow: 0 2px 8px rgba(0,0,0,.2);
    `;
    banner.innerHTML = `
      <span>✅ IMARA LINKS${version} is ready to install</span>
      <button id="_updateRestartBtn" style="
        background:#fff;color:#16a34a;border:none;border-radius:6px;
        padding:.35rem .9rem;font-weight:700;font-size:.82rem;cursor:pointer;
      ">Restart &amp; Update</button>
      <button id="_updateDismissBtn" style="
        background:transparent;color:rgba(255,255,255,.75);
        border:1px solid rgba(255,255,255,.35);border-radius:6px;
        padding:.3rem .7rem;font-size:.78rem;cursor:pointer;
      ">Later</button>
    `;

    document.body.prepend(banner);

    document.getElementById('_updateRestartBtn').addEventListener('click', () => {
      window.electron.installUpdate();
    });

    document.getElementById('_updateDismissBtn').addEventListener('click', () => {
      banner.remove();
      showToast('Update will install automatically when you close the app.', 'info', 5000);
    });
  });
})();
