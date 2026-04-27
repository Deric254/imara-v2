// electron-is-dev.js — Simple dev detection (compatible with Node 18+)
module.exports = !require('electron').app?.isPackaged && (
  process.defaultApp ||
  /[/\\]electron/.test(process.execPath) ||
  process.env.ELECTRON_IS_DEV !== undefined
  ? process.env.ELECTRON_IS_DEV !== '0'
  : true
);
