// electron-is-dev.js — Reliable dev detection for Electron
// Works in both development (npm run electron-dev) and packaged (.exe) builds.
try {
  // When packaged, app.isPackaged is true
  module.exports = !require('electron').app.isPackaged;
} catch (_) {
  // Fallback for when this module is loaded before app is ready
  module.exports = !process.resourcesPath || process.resourcesPath.includes('node_modules');
}
