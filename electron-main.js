// electron-main.js — IMARA LINKS Desktop App
// This file lives in the project ROOT and is the Electron entry point.

const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path    = require('path');
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');

// ── Environment setup ─────────────────────────────────────────────────────────
// In a packaged app .env doesn't exist — set required vars programmatically
// so the app works without any config file on the user's machine.
if (!process.env.JWT_SECRET) {
  // Derive a stable per-machine secret from the machine's userData path.
  // This means tokens are valid across restarts on the same machine.
  const crypto = require('crypto');
  const seed   = app.getPath('userData') + 'imara-links-v2';
  process.env.JWT_SECRET = crypto.createHash('sha256').update(seed).digest('hex');
}
process.env.DATABASE_TYPE = process.env.DATABASE_TYPE || 'local';
process.env.NODE_ENV       = process.env.NODE_ENV       || 'production';

const { initDb } = require('./backend/db');

// Try loading .env for dev overrides (silently ignored if not present)
try { require('dotenv').config(); } catch (_) {}

let mainWindow;
let backendServer;
let serverPort = 9000;

// ── Auto-updater (safe — crashes are silently caught) ─────────────────────────
let autoUpdater;
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  autoUpdater.on('update-available',  () => mainWindow?.webContents.send('update-available'));
  autoUpdater.on('update-downloaded', () => mainWindow?.webContents.send('update-downloaded'));
} catch (_) { /* unsigned/dev builds — updater not available */ }

ipcMain.on('install-update', () => { try { autoUpdater?.quitAndInstall(); } catch (_) {} });

// ── Find a free port (fallback if 9000 is taken) ─────────────────────────────
function findFreePort(preferred) {
  return new Promise((resolve) => {
    const net = require('net');
    const server = net.createServer();
    server.listen(preferred, '127.0.0.1', () => {
      server.close(() => resolve(preferred));
    });
    server.on('error', () => {
      // preferred port busy — let OS pick one
      const s2 = net.createServer();
      s2.listen(0, '127.0.0.1', () => {
        const port = s2.address().port;
        s2.close(() => resolve(port));
      });
    });
  });
}

// ── Splash screen ─────────────────────────────────────────────────────────────
function createSplash() {
  const splash = new BrowserWindow({
    width: 400, height: 300,
    frame: false, transparent: true, alwaysOnTop: true,
    resizable: false, skipTaskbar: true,
    webPreferences: { nodeIntegration: false }
  });
  splash.loadURL(`data:text/html,
    <html><body style="margin:0;background:linear-gradient(135deg,#1a1a2e,#16213e);
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      height:100vh;font-family:sans-serif;color:#fff;border-radius:12px;">
      <div style="font-size:2.5rem;margin-bottom:8px;">🔗</div>
      <div style="font-size:1.4rem;font-weight:700;letter-spacing:2px;">IMARA LINKS</div>
      <div style="font-size:.8rem;color:#94a3b8;margin-top:6px;">Starting up…</div>
    </body></html>`);
  return splash;
}

// ── Backend server ────────────────────────────────────────────────────────────
async function startBackendServer() {
  serverPort = await findFreePort(9000);

  const backendApp = express();

  await initDb();

  backendApp.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  backendApp.use(cors({ origin: true, credentials: true }));
  backendApp.use(express.json({ limit: '2mb' }));

  // Routes
  backendApp.use('/api/auth',          require('./backend/routes/auth'));
  backendApp.use('/api/users',         require('./backend/routes/users'));
  backendApp.use('/api/daily',         require('./backend/routes/daily'));
  backendApp.use('/api/reconciliation',require('./backend/routes/reconciliation'));
  backendApp.use('/api/backup',        require('./backend/routes/backup'));
  backendApp.use('/api/invoices',      require('./backend/routes/invoices'));
  backendApp.use('/api/inventory',     require('./backend/routes/inventory'));
  backendApp.use('/api/dashboard',     require('./backend/routes/dashboard'));
  backendApp.use('/api',               require('./backend/routes/config'));
  backendApp.use('/api',               require('./backend/routes/reports'));

  backendApp.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Serve frontend from the correct path (works both in dev and packaged)
  const frontendPath = path.join(__dirname, 'frontend');
  backendApp.use(express.static(frontendPath));
  backendApp.get('*', (_req, res) => res.sendFile(path.join(frontendPath, 'index.html')));

  backendApp.use((err, _req, res, _next) => {
    console.error('Backend error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  await new Promise((resolve, reject) => {
    backendServer = backendApp.listen(serverPort, '127.0.0.1', resolve);
    backendServer.on('error', reject);
  });
}

// ── Main window ───────────────────────────────────────────────────────────────
async function createWindow() {
  const splash = createSplash();

  try {
    await startBackendServer();
  } catch (err) {
    splash.close();
    dialog.showErrorBox('IMARA LINKS — Startup Error',
      `Failed to start the application.\n\n${err.message}\n\nPlease restart and try again.`);
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1400, height: 900,
    minWidth: 1024, minHeight: 680,
    show: false,   // don't show until ready
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });

  mainWindow.loadURL(`http://localhost:${serverPort}`);

  // Show window only once it's fully rendered — no white flash
  mainWindow.once('ready-to-show', () => {
    splash.close();
    mainWindow.show();
    mainWindow.focus();
  });

  // Dev-only: open DevTools
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => { mainWindow = null; });

  createMenu();
}

// ── Menu ──────────────────────────────────────────────────────────────────────
function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [{ label: 'Exit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' },
        { type: 'separator' }, { role: 'toggleDevTools' },
        { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [{
        label: 'About IMARA LINKS',
        click: () => dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'About IMARA LINKS',
          message: 'IMARA LINKS v2.0.0',
          detail: 'Business management system\nRunning locally — your data stays on this machine.',
        })
      }]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  backendServer?.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => { if (!mainWindow) createWindow(); });

ipcMain.on('app-info', (event) => {
  event.reply('app-info-reply', {
    version: app.getVersion(),
    userDataPath: app.getPath('userData'),
    port: serverPort,
  });
});
