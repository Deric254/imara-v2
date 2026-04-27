// electron-main.js — IMARA LINKS Desktop App
const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const isDev = require('./electron-is-dev');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { initDb } = require('./backend/db');

let mainWindow;
let backendServer;

// ── Configure Auto-Updater ────────────────────────────────────────────────────
autoUpdater.checkForUpdatesAndNotify();

autoUpdater.on('update-available', () => {
  console.log('Update available');
  mainWindow?.webContents.send('update-available');
});

autoUpdater.on('update-downloaded', () => {
  console.log('Update downloaded');
  mainWindow?.webContents.send('update-downloaded');
});

ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall();
});

// ── Backend Server Setup ──────────────────────────────────────────────────────
async function startBackendServer() {
  return new Promise((resolve, reject) => {
    const backendApp = express();
    
    // Initialize database first
    initDb()
      .then(() => {
        console.log('✅ Database initialized');
        
        // Configure middleware
        backendApp.use(helmet({
          contentSecurityPolicy: false,
          crossOriginResourcePolicy: { policy: 'cross-origin' }
        }));
        
        backendApp.use(cors({ origin: true, credentials: true }));
        backendApp.use(morgan('combined'));
        backendApp.use(express.json({ limit: '2mb' }));

        // Load routes
        try {
          backendApp.use('/api/auth', require('./backend/routes/auth'));
          backendApp.use('/api/users', require('./backend/routes/users'));
          backendApp.use('/api/daily', require('./backend/routes/daily'));
          backendApp.use('/api/reconciliation', require('./backend/routes/reconciliation'));
          backendApp.use('/api/backup', require('./backend/routes/backup'));
          backendApp.use('/api/invoices', require('./backend/routes/invoices'));
          backendApp.use('/api/inventory', require('./backend/routes/inventory'));
          backendApp.use('/api/dashboard', require('./backend/routes/dashboard'));
          backendApp.use('/api', require('./backend/routes/config'));
          backendApp.use('/api', require('./backend/routes/reports'));
        } catch (err) {
          console.error('Error loading routes:', err);
        }

        // Health check
        backendApp.get('/health', (_req, res) =>
          res.json({ status: 'ok', timestamp: new Date().toISOString() })
        );

        // Serve frontend
        backendApp.use(express.static(path.join(__dirname, 'frontend')));
        backendApp.get('/', (_req, res) =>
          res.sendFile(path.join(__dirname, 'frontend', 'index.html'))
        );

        // Error handler
        backendApp.use((err, _req, res, _next) => {
          console.error('Backend error:', err);
          res.status(500).json({ error: 'Internal server error' });
        });

        // Start server
        backendServer = backendApp.listen(9000, () => {
          console.log('✅ Backend server running on http://localhost:9000');
          resolve();
        });
      })
      .catch(err => {
        console.error('Database initialization failed:', err);
        reject(err);
      });
  });
}

// ── Create Window ─────────────────────────────────────────────────────────────
async function createWindow() {
  try {
    // Start backend server
    await startBackendServer();
  } catch (err) {
    console.error('Failed to start backend:', err);
    dialog.showErrorBox('Startup Error', 'Failed to start application. Please try again.');
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });

  const startUrl = 'http://localhost:9000';

  mainWindow.loadURL(startUrl);

  // Open DevTools in development
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Create menu
  createMenu();
}

// ── Create Menu ───────────────────────────────────────────────────────────────
function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Exit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            app.quit();
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About IMARA LINKS',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About IMARA LINKS',
              message: 'IMARA LINKS v2.0.0',
              detail: 'A complete business management system\nRunning locally with SQLite',
            });
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ── App Lifecycle ─────────────────────────────────────────────────────────────
app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (backendServer) {
      backendServer.close();
    }
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// ── IPC Handlers ──────────────────────────────────────────────────────────────
ipcMain.on('app-info', (event) => {
  event.reply('app-info-reply', {
    version: app.getVersion(),
    path: app.getAppPath(),
    userDataPath: app.getPath('userData'),
  });
});

