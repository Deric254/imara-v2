// layout.js — IMARA LINKS sidebar + topbar  v3
function renderLayout(activePage) {
  const user = requireAuth();
  if (!user) return null;

  const NAV = {
    owner: [
      { href: 'dashboard.html',      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>', label: 'Dashboard'      },
      { href: 'daily.html',          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>', label: 'Daily Entry'     },
      { href: 'inventory.html',      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>', label: 'Inventory'       },
      { href: 'invoices.html',       icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>', label: 'Invoices'        },
      { href: 'reconciliation.html', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>', label: 'Reconciliation'  },
      { href: 'users.html',          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>', label: 'Users'           },
      { href: 'config.html',         icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>', label: 'Configuration'   },
      { href: 'audit.html',          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>', label: 'Audit Log'       },
      { href: 'backup.html',         icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>', label: 'Database Backup' },
    ],
    admin: [
      { href: 'system-health.html',  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>', label: 'System Health'   },
      { href: 'users.html',          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>', label: 'User Management' },
      { href: 'audit.html',          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/></svg>', label: 'Audit Log'       },
      { href: 'config.html',         icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>', label: 'System Config'   },
      { href: 'backup.html',         icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>', label: 'System Backup'   },
      { href: 'database.html',       icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><line x1="12" y1="12" x2="12" y2="19"/><polyline points="9 16 12 19 15 16"/></svg>', label: 'Database Manager'},
    ],
    knuckler: [
      { href: 'daily.html',          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>', label: 'Daily Entry'     },
    ],
    operator: [
      { href: 'daily.html',          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>', label: 'Daily Entry'     },
    ],
  };

  const items     = NAV[user.role] || NAV.knuckler;
  const navHTML   = items.map(i => `
    <a href="${i.href}" class="nav-link ${activePage === i.href ? 'active' : ''}">
      <span class="nav-icon">${i.icon}</span>${escHtml(i.label)}
    </a>`).join('');

  const pageLabel    = (items.find(i => i.href === activePage) || {}).label || 'IMARA LINKS';
  const avatarLetter = (user.full_name || user.username || '?')[0].toUpperCase();
  const roleColors   = { owner: '#22c55e', admin: '#60a5fa', knuckler: '#f97316', operator: '#a855f7' };

  document.body.innerHTML = `
    <div class="sidebar-overlay" id="sidebarOverlay" onclick="closeSidebar()"></div>
    <div class="app">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-brand">
          <div class="brand-logo">
            <img src="logo.png" alt="IMARA LINKS"
              onerror="this.style.display='none';document.getElementById('logoFallback').style.display='flex'">
            <span class="brand-logo-fallback" id="logoFallback" style="display:none">IL</span>
          </div>
          <div class="brand-name"  id="lBizName">IMARA LINKS</div>
          <div class="brand-slogan" id="lBizSlogan">Built Strong By IMARA</div>
        </div>
        <nav class="nav">${navHTML}</nav>
        <div class="sidebar-footer">
          <div class="user-chip" onclick="openProfileModal()" style="cursor:pointer" title="Edit profile">
            <div class="user-avatar" id="sidebarAvatar">${avatarLetter}</div>
            <div>
              <div class="user-name"  id="sidebarUserName">${escHtml(user.full_name || user.username)}</div>
              <div class="user-role" style="color:${roleColors[user.role]}">${user.role}</div>
            </div>
          </div>
          <a href="change-password.html" style="display:block;text-align:center;color:rgba(255,255,255,.45);font-size:.75rem;margin-bottom:.5rem;text-decoration:none;display:flex;align-items:center;justify-content:center;gap:.35rem"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;flex-shrink:0"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Change Password</a>
          <button class="btn-logout" onclick="doLogout()">Sign Out</button>
        </div>
      </aside>

      <div class="main">
        <header class="topbar">
          <button class="hamburger" onclick="openSidebar()" aria-label="Menu">
            <span></span><span></span><span></span>
          </button>
          <div class="topbar-title" id="pageTitle">${escHtml(pageLabel)}</div>
          <div style="flex:1"></div>
          <div class="topbar-date" id="topbarDate"></div>
        </header>
        <div class="page" id="pageContent"></div>
      </div>
    </div>

    <!-- Profile Modal -->
    <div class="modal-overlay" id="profileModal" style="display:none" onclick="if(event.target===this)closeProfileModal()">
      <div class="modal" style="max-width:400px">
        <div style="text-align:center;margin-bottom:1.5rem">
          <div class="user-avatar" id="modalAvatar"
            style="width:64px;height:64px;font-size:1.5rem;margin:0 auto 0.75rem;background:var(--g500)">${avatarLetter}</div>
          <div class="modal-title" style="margin-bottom:0">Account Profile</div>
          <div style="font-size:0.85rem;color:var(--muted)" id="modalSubTitle">${escHtml(user.username)}</div>
        </div>
        <div class="form-group">
          <label class="label">Full Name *</label>
          <input class="input" id="prof_name" placeholder="Your full name">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="label">Phone Number</label>
            <input class="input" id="prof_phone" placeholder="+254..." type="tel">
          </div>
          <div class="form-group">
            <label class="label">Role</label>
            <input class="input" id="prof_role" disabled
              style="opacity:.65;cursor:not-allowed;text-transform:capitalize;background:var(--g50)">
          </div>
        </div>
        <div class="form-group">
          <label class="label">Email Address</label>
          <input class="input" id="prof_email" placeholder="email@example.com" type="email">
        </div>
        <div class="form-group">
          <label class="label">Username</label>
          <input class="input" id="prof_username"
            ${user.role !== 'owner' ? 'disabled style="opacity:.65;cursor:not-allowed;background:var(--g50)"' : ''}>
          <div style="font-size:.7rem;color:var(--muted);margin-top:.3rem">
            ${user.role === 'owner' ? 'Only the Owner can change username.' : 'Username cannot be changed.'}
          </div>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label class="label">New Password <span style="color:var(--muted);font-weight:400">(leave blank to keep current)</span></label>
          <input class="input" id="prof_password" type="password" placeholder="Min 8 characters">
        </div>
        <div id="prof_err" class="err" style="margin-top:1rem;text-align:center"></div>
        <div class="modal-footer" style="margin-top:1.5rem;border-top:1px solid var(--border);padding-top:1rem">
          <button class="btn btn-secondary" onclick="closeProfileModal()">Cancel</button>
          <button class="btn btn-primary" id="prof_save_btn" onclick="saveProfile()">Update Details</button>
        </div>
      </div>
    </div>`;

  // Date
  document.getElementById('topbarDate').textContent =
    new Date().toLocaleDateString('en-KE', { weekday:'short', day:'numeric', month:'short', year:'numeric' });

  // Inject notification bell into every page's topbar
  // Use requestAnimationFrame so DOM is fully painted before injecting
  requestAnimationFrame(() => _injectGlobalBell());

  // Load branding — use public-config (no auth needed, faster, more reliable)
  // The slogan is already set to the default above; this replaces it with the saved value.
  fetch(API + '/auth/public-config')
    .then(r => r.ok ? r.json() : null)
    .then(cfg => {
      if (!cfg) return;
      const nameEl   = document.getElementById('lBizName');
      const sloganEl = document.getElementById('lBizSlogan');
      if (nameEl && cfg.business_name) {
        nameEl.textContent = cfg.business_name;
        document.title = cfg.business_name + ' — ' + pageLabel;
      }
      if (sloganEl) {
        // Always show something — saved value OR hardcoded default
        sloganEl.textContent = (cfg.business_slogan && cfg.business_slogan.trim())
          ? cfg.business_slogan.trim()
          : 'Built Strong By IMARA';
      }
    })
    .catch(() => {
      // Network failure: defaults already rendered, nothing to do
    });

  return document.getElementById('pageContent');
}

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarOverlay').classList.add('show');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('show');
}


function openProfileModal() {
  const user = Store.user || {};
  document.getElementById('prof_name').value     = user.full_name || '';
  document.getElementById('prof_phone').value    = user.phone    || '';
  document.getElementById('prof_email').value    = user.email    || '';
  document.getElementById('prof_username').value = user.username || '';
  document.getElementById('prof_role').value     = user.role     || '';
  document.getElementById('prof_password').value = '';
  showErr('prof_err', '');
  document.getElementById('profileModal').style.display = 'flex';
}
function closeProfileModal() {
  document.getElementById('profileModal').style.display = 'none';
}

async function saveProfile() {
  const full_name = document.getElementById('prof_name').value.trim();
  const phone     = document.getElementById('prof_phone').value.trim();
  const email     = document.getElementById('prof_email').value.trim();
  const username  = document.getElementById('prof_username').value.trim();
  const password  = document.getElementById('prof_password').value;
  const btn       = document.getElementById('prof_save_btn');
  const user      = Store.user || {};

  if (!full_name) return showErr('prof_err', 'Full name is required');
  if (user.role === 'owner' && (!username || username.length < 3))
    return showErr('prof_err', 'Username must be at least 3 characters');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return showErr('prof_err', 'Invalid email address');
  if (password && password.length < 8)
    return showErr('prof_err', 'Password must be at least 8 characters');

  btn.disabled = true;
  btn.textContent = 'Saving…';
  showErr('prof_err', '');

  try {
    const payload = { full_name, phone, email };
    if (user.role === 'owner') payload.username = username;
    if (password) payload.new_password = password;

    const res = await api('PATCH', '/auth/profile', payload);
    if (!res) return;
    Store.updateUser(res.user);

    const nameEl = document.getElementById('sidebarUserName');
    if (nameEl) nameEl.textContent = res.user.full_name || res.user.username;
    const newLetter = (res.user.full_name || res.user.username || '?')[0].toUpperCase();
    const sa = document.getElementById('sidebarAvatar');
    const ma = document.getElementById('modalAvatar');
    if (sa) sa.textContent = newLetter;
    if (ma) ma.textContent = newLetter;
    document.getElementById('modalSubTitle').textContent = res.user.username;

    showToast('Profile updated successfully');
    setTimeout(closeProfileModal, 500);
  } catch(e) {
    showErr('prof_err', e.error || (e.errors?.[0]?.msg) || 'Failed to save profile');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Update Details';
  }
}

function doLogout() { Store.clear(); location.href = 'login.html'; }

/* ═══════════════════════════════════════════════════════════════
   GLOBAL NOTIFICATION BELL — Alerts only, stable, DB-backed
   Items become read ONLY on explicit click or "Mark all read"
═══════════════════════════════════════════════════════════════ */
let _globalNotifs   = [];       // DB-backed alerts only
let _notifPollTimer = null;
let _gnPanelOpen    = false;

// Route an alert to its relevant page based on type
const _NOTIF_TYPE_DEST = {
  stock_low:      'inventory.html',
  stock_out:      'inventory.html',
  inventory:      'inventory.html',
  data_missing:   'daily.html',
  production:     'daily.html',
  sales:          'invoices.html',
  reconciliation: 'reconciliation.html',
  audit:          'audit.html',
  config:         'config.html',
  user:           'users.html',
  alert:          'daily.html',
  warn:           'daily.html',
};
function _notifDestUrl(n) {
  return _NOTIF_TYPE_DEST[n.category] || _NOTIF_TYPE_DEST[n.type] || null;
}

function _gnTimeAgo(ts) {
  const s = (Date.now() - new Date(ts)) / 1000;
  if (s < 60)    return 'just now';
  if (s < 3600)  return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function _renderGlobalNotifList() {
  const el = document.getElementById('_gnNotifList');
  if (!el) return;

  if (!_globalNotifs.length) {
    el.innerHTML = '<div class="notif-empty">✅ No alerts right now.</div>';
    return;
  }

  // Unread first, then newest first within each group
  const sorted = [..._globalNotifs].sort((a, b) => {
    if (!!a.read !== !!b.read) return a.read ? 1 : -1;
    return new Date(b.created_at || 0) - new Date(a.created_at || 0);
  });

  el.innerHTML = sorted.map(n => {
    const dest = _notifDestUrl(n);
    const pg   = dest ? dest.replace('.html', '').replace(/-/g, ' ') : '';
    const dotClass = n.read ? 'read-dot' : (n.type || 'info');
    return `<div class="notif-item ${n.read ? 'read' : 'unread'}"
                 data-id="${escHtml(String(n.id))}"
                 onclick="window._gnMarkRead(${JSON.stringify(n.id)}, ${JSON.stringify(dest)})">
      <div class="ndot ${dotClass}"></div>
      <div class="notif-body">
        <div class="notif-title">${escHtml(n.title || n.type || 'Alert')}</div>
        <div class="notif-msg">${escHtml(n.message || '')}</div>
        <div class="notif-time">${_gnTimeAgo(n.created_at || Date.now())}</div>
        ${dest ? `<span class="notif-goto">→ Go to ${escHtml(pg)}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

function _updateGlobalBell() {
  const btn = document.getElementById('_gnBtn');
  const bdg = document.getElementById('_gnBadge');
  if (!btn || !bdg) return;
  const unread   = _globalNotifs.filter(n => !n.read);
  const cnt      = unread.length;
  const hasAlert = unread.some(n => n.type === 'alert');
  const hasWarn  = unread.some(n => n.type === 'warn');
  btn.className  = 'notif-btn ' + (hasAlert ? 'state-alert' : hasWarn ? 'state-warn' : cnt ? 'state-info' : 'state-none');
  if (cnt) { bdg.textContent = cnt > 99 ? '99+' : cnt; bdg.style.display = 'flex'; }
  else     { bdg.style.display = 'none'; }
}

// Mark a single item read — ONLY called when user explicitly clicks the item
window._gnMarkRead = async function(id, dest) {
  const n = _globalNotifs.find(x => x.id === id);
  if (n && !n.read) {
    try { await api('PATCH', `/notifications/${id}/read`); } catch (_) {}
    n.read = 1;
    _renderGlobalNotifList();
    _updateGlobalBell();
  }
  if (dest) { location.href = dest; }
};

// Mark all read — ONLY when user explicitly clicks the button
window._gnMarkAllRead = async function() {
  const unread = _globalNotifs.filter(n => !n.read);
  if (!unread.length) { showToast('No unread alerts'); return; }
  await Promise.allSettled(unread.map(n => api('PATCH', `/notifications/${n.id}/read`)));
  _globalNotifs.forEach(n => { n.read = 1; });
  _renderGlobalNotifList();
  _updateGlobalBell();
  showToast('All alerts marked as read');
};

// Clear all read notifications — removes from DB, called only on explicit click
window._gnClearRead = async function() {
  const hasRead = _globalNotifs.some(n => n.read);
  if (!hasRead) { showToast('No read alerts to clear'); return; }
  try {
    await api('DELETE', '/notifications/read');
    _globalNotifs = _globalNotifs.filter(n => !n.read);
    _renderGlobalNotifList();
    _updateGlobalBell();
    showToast('Read alerts cleared');
  } catch(_) {
    showToast('Failed to clear alerts', 'error');
  }
};

window._gnTogglePanel = function(e) {
  e.stopPropagation();
  const p = document.getElementById('_gnPanel');
  if (!p) return;
  _gnPanelOpen = p.classList.toggle('open');
  if (_gnPanelOpen) {
    // Load fresh from server when panel opens — but do NOT auto-mark anything read
    _loadGlobalNotifs();
    setTimeout(() => document.addEventListener('click', _gnCloseOutside, { once: true }), 50);
  }
};

function _gnCloseOutside(e) {
  const p = document.getElementById('_gnPanel');
  if (p && !p.contains(e.target)) {
    p.classList.remove('open');
    _gnPanelOpen = false;
  }
}

// Fetch alerts from DB — stable, no client-side tip injection
async function _loadGlobalNotifs() {
  try {
    const raw = await api('GET', '/notifications');
    if (!Array.isArray(raw)) return;

    // Preserve local read state for items already marked read this session
    // (avoids flicker where re-poll resets optimistic local read state)
    const localReadIds = new Set(_globalNotifs.filter(n => n.read).map(n => n.id));
    _globalNotifs = raw.map(n => ({
      ...n,
      read: localReadIds.has(n.id) ? 1 : n.read,
    }));

    _renderGlobalNotifList();
    _updateGlobalBell();
  } catch (e) {
    console.warn('Notifications load failed:', e);
  }
}

function _injectGlobalBell() {
  if (document.getElementById('_gnBtn')) return; // already injected
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;
  const dateEl = document.getElementById('topbarDate');

  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;display:flex;align-items:center;flex-shrink:0';
  wrap.innerHTML = `
    <button class="notif-btn state-none" id="_gnBtn"
            onclick="window._gnTogglePanel(event)" aria-label="Alerts" title="Alerts">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      </svg>
      <span class="notif-badge" id="_gnBadge" style="display:none">0</span>
    </button>
    <div class="notif-panel" id="_gnPanel">
      <div class="notif-header">
        <h4>🔔 Alerts</h4>
        <button onclick="document.getElementById('_gnPanel').classList.remove('open');_gnPanelOpen=false;"
                style="background:none;border:none;cursor:pointer;font-size:1.4rem;color:var(--muted);line-height:1;padding:0">&times;</button>
      </div>
      <div class="notif-list" id="_gnNotifList">
        <div class="notif-empty" style="display:flex;align-items:center;justify-content:center;gap:.5rem">
          <div class="spinner"></div> Loading…
        </div>
      </div>
      <div class="notif-footer">
        <button onclick="window._gnMarkAllRead()">✓ Mark all read</button>
        <button onclick="_loadGlobalNotifs()">↺ Refresh</button>
        <button onclick="window._gnClearRead()" style="color:var(--muted)">🗑 Clear read</button>
      </div>
    </div>`;

  topbar.insertBefore(wrap, dateEl || null);
  _loadGlobalNotifs();

  // Poll every 2 minutes to pick up new stock alerts — read state preserved locally
  if (_notifPollTimer) clearInterval(_notifPollTimer);
  _notifPollTimer = setInterval(_loadGlobalNotifs, 120000);
}
