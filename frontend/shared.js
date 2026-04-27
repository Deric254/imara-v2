// shared.js — IMARA LINKS v3 (stable auth, ACID-aware)
const API = (typeof window !== 'undefined' && window.API_BASE)
  ? window.API_BASE
  : (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
      ? 'http://localhost:3001/api'
      : 'https://imara-links-api.onrender.com/api');

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

// ── 401 handler: clear session then redirect cleanly — no modal loop ─────────
const _401Modal = { shown: false };
function handle401(path) {
  if (path === '/auth/login') return false;
  if (_401Modal.shown) return false; // Only show once per page load

  _401Modal.shown = true;
  // Clear the stale token NOW so login.html never sees it and bounces back
  Store.clear();

  // Redirect straight to login with a reason flag — no modal needed
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

// ── Core API call with retry-once on network error ────────────────────────────
// ── Active request counter for global loading indicator ──────────────────────
let _apiMutationCount = 0;

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (Store.token) opts.headers['Authorization'] = `Bearer ${Store.token}`;
  if (body !== undefined) opts.body = JSON.stringify(body);

  // POST/PUT mutations use a longer timeout (30s) to handle slow/satellite networks
  const timeoutMs = (method === 'POST' || method === 'PUT' || method === 'DELETE') ? 30000 : 15000;
  const isMutation = method === 'POST' || method === 'PUT' || method === 'DELETE';

  // Show progress bar for all mutations so users know something is happening
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
        return null; // caller checks null
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
    // Retry once on network errors (not HTTP errors), with a longer wait on slow networks
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
  const res = await fetch(API + path, {
    headers: { 'Authorization': `Bearer ${Store.token}` }
  });
  if (!res.ok) { showToast('Export failed', 'error'); return; }
  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

function fmtMoney(n, currency) {
  if (n == null || isNaN(n)) return '—';
  const cur = currency || getConfig('currency') || 'KES';
  return cur + ' ' + Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function today() { return new Date().toISOString().split('T')[0]; }

function showToast(msg, type = 'success', duration = 3500) {
  const t = document.createElement('div');
  // map 'warn' to warning style if CSS has it, otherwise fall back to 'error'
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
  const from = new Date(Date.now() - days * 86400000);
  document.getElementById(toId).value   = to.toISOString().split('T')[0];
  document.getElementById(fromId).value = from.toISOString().split('T')[0];
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
  // Always set the actual value so JS reads it correctly; also keep placeholder for UX hint
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
// Inject DOM on first use; works without any HTML changes in other pages.
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
