// electron-main.js — IMARA LINKS Desktop App
// This file lives in the project ROOT and is the Electron entry point.

const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path    = require('path');
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');

// ── Environment setup ─────────────────────────────────────────────────────────
if (!process.env.JWT_SECRET) {
  const crypto = require('crypto');
  const seed   = app.getPath('userData') + 'imara-links-v2';
  process.env.JWT_SECRET = crypto.createHash('sha256').update(seed).digest('hex');
}
process.env.DATABASE_TYPE = process.env.DATABASE_TYPE || 'local';
process.env.NODE_ENV       = process.env.NODE_ENV       || 'production';

const { initDb } = require('./backend/db');

try { require('dotenv').config(); } catch (_) {}

let mainWindow;
let backendServer;
let serverPort = 9000;

// ── Auto-updater ──────────────────────────────────────────────────────────────
// Loaded lazily after the window is ready — avoids crashes in dev/unsigned builds.
let autoUpdater = null;

function initAutoUpdater() {
  if (!app.isPackaged) return; // never run updater in dev
  try {
    autoUpdater = require('electron-updater').autoUpdater;

    // Silent background download — user only sees a prompt when it's ready to install
    autoUpdater.autoDownload        = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.logger = require('electron').require
      ? null
      : console; // log to console in packaged builds for debugging

    autoUpdater.on('update-available', (info) => {
      mainWindow?.webContents.send('update-available', {
        version: info.version,
        releaseDate: info.releaseDate,
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      mainWindow?.webContents.send('update-downloaded', {
        version: info.version,
      });
    });

    autoUpdater.on('error', (err) => {
      // Silent — don't bother users with update errors
      console.error('Auto-updater error:', err?.message || err);
    });

    // Check on startup, then every 4 hours
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 4 * 60 * 60 * 1000);

  } catch (err) {
    console.warn('Auto-updater not available:', err?.message);
  }
}

ipcMain.on('install-update', () => {
  try { autoUpdater?.quitAndInstall(false, true); } catch (_) {}
});

ipcMain.on('check-for-updates', () => {
  try { autoUpdater?.checkForUpdates().catch(() => {}); } catch (_) {}
});

// ── Find a free port (fallback if 9000 is taken) ─────────────────────────────
function findFreePort(preferred) {
  return new Promise((resolve) => {
    const net = require('net');
    const server = net.createServer();
    server.listen(preferred, '127.0.0.1', () => {
      server.close(() => resolve(preferred));
    });
    server.on('error', () => {
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
      <div id="status" style="font-size:.8rem;color:#94a3b8;margin-top:6px;">Starting up...</div>
    </body></html>`);
  return splash;
}

function updateSplashStatus(splash, message) {
  if (!splash || splash.isDestroyed()) return;
  splash.webContents.executeJavaScript(
    `document.getElementById('status').textContent = ${JSON.stringify(message)};`
  ).catch(() => {});
}

// ── Backend server ────────────────────────────────────────────────────────────
async function startBackendServer(onStatus = () => {}) {
  try {
    onStatus('Finding a local port...');
    serverPort = await findFreePort(9000);

    const backendApp = express();

    onStatus('Preparing local database...');
    await initDb();

    onStatus('Loading local services...');
    backendApp.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
    backendApp.use(cors({ origin: true, credentials: true }));
    backendApp.use(express.json({ limit: '2mb' }));

    backendApp.use('/api/auth',           require('./backend/routes/auth'));
    backendApp.use('/api/users',          require('./backend/routes/users'));
    backendApp.use('/api/daily',          require('./backend/routes/daily'));
    backendApp.use('/api/reconciliation', require('./backend/routes/reconciliation'));
    backendApp.use('/api/backup',         require('./backend/routes/backup'));
    backendApp.use('/api/invoices',       require('./backend/routes/invoices'));
    backendApp.use('/api/inventory',      require('./backend/routes/inventory'));
    backendApp.use('/api',                require('./backend/routes/reports'));

    backendApp.get('/health', (_req, res) => res.json({ status: 'ok', version: app.getVersion() }));

    const frontendPath = path.join(__dirname, 'frontend');
    backendApp.use(express.static(frontendPath));
    backendApp.get('*', (_req, res) => res.sendFile(path.join(frontendPath, 'index.html')));

    backendApp.use((err, _req, res, _next) => {
      console.error('Backend error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });

    onStatus('Starting local server...');
    await new Promise((resolve, reject) => {
      backendServer = backendApp.listen(serverPort, '127.0.0.1', resolve);
      backendServer.on('error', reject);
    });
  } catch (err) {
    console.error('Backend server startup failed:', err);
    throw new Error(`Failed to start backend: ${err.message}`);
  }
}

// ── Main window ───────────────────────────────────────────────────────────────
async function createWindow() {
  const splash = createSplash();

  try {
    await startBackendServer((message) => updateSplashStatus(splash, message));
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
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });

  updateSplashStatus(splash, 'Opening application window...');
  mainWindow.loadURL(`http://localhost:${serverPort}`);

  const startupTimeout = setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      splash.close();
      dialog.showErrorBox('IMARA LINKS — Startup Timeout',
        'The application took too long to open.\n\nPlease restart the app. If this keeps happening, contact support.');
      app.quit();
    }
  }, 45000);

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    clearTimeout(startupTimeout);
    splash.close();
    dialog.showErrorBox('IMARA LINKS — Startup Error',
      `The application window could not load.\n\n${errorDescription} (${errorCode})`);
    app.quit();
  });

  mainWindow.once('ready-to-show', () => {
    clearTimeout(startupTimeout);
    splash.close();
    mainWindow.show();
    mainWindow.focus();

    // Start updater AFTER window is visible — never blocks startup
    initAutoUpdater();
  });

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
      submenu: [
        {
          label: 'Check for Updates',
          click: () => {
            if (autoUpdater) {
              autoUpdater.checkForUpdates().catch(() => {});
              mainWindow?.webContents.send('checking-for-updates');
            } else {
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Updates',
                message: 'Auto-updates are only available in the installed version.',
              });
            }
          }
        },
        { type: 'separator' },
        {
          label: 'About IMARA LINKS',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'About IMARA LINKS',
            message: `IMARA LINKS v${app.getVersion()}`,
            detail: 'Business management system\nRunning locally — your data stays on this machine.',
          })
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Error handling ────────────────────────────────────────────────────────────
// Catch uncaught exceptions and show friendly error instead of technical dialog
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  dialog.showMessageBox({
    type: 'error',
    title: 'IMARA LINKS - Error',
    message: 'Something went wrong',
    detail: 'The application encountered an unexpected error.\n\nPlease restart the application.\n\nIf this keeps happening, contact support.',
    buttons: ['Restart', 'Exit']
  }).then((result) => {
    if (result.response === 0) {
      app.relaunch();
    }
    app.exit();
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

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
