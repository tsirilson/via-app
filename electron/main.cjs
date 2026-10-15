// Electron shell for the web app in ../dist. The app itself is unchanged: it
// uses WebHID, which Electron's Chromium supports. This file only:
//  - serves dist/ from a private app:// origin (fetch() doesn't work on file://)
//  - replaces Chrome's device prompt with Electron's select-hid-device event
//  - grants HID permission to our own origin only

const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {app, BrowserWindow, dialog, net, protocol, session, shell} = require('electron');
const {isAllowedOrigin} = require('./origin.cjs');
const {setUpTray} = require('./tray.cjs');

const APP_ORIGIN = 'app://bundle';
const DIST = path.join(__dirname, '..', 'dist');
const DEV_URL = process.env.VITE_DEV_SERVER_URL; // e.g. http://localhost:5173
const SMOKE = process.env.VIA_APP_SMOKE === '1';
// VIA_APP_DEBUG=1: log HID events and the page's console to stdout.
const DEBUG = process.env.VIA_APP_DEBUG === '1';
const debug = (...args) => DEBUG && console.log('[main]', ...args);

// Only the definitions host is reachable from the page.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://usevia.app",
].join('; ');

protocol.registerSchemesAsPrivileged([
  {scheme: 'app', privileges: {standard: true, secure: true, supportFetchAPI: true}},
]);

if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();

let win;
let trayControls; // set up once the app is ready (not in smoke tests)

function serveDist() {
  protocol.handle('app', async (request) => {
    const {pathname} = new URL(request.url);
    const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
    if (file !== DIST && !file.startsWith(DIST + path.sep)) return new Response('Forbidden', {status: 403});
    const target = pathname === '/' ? path.join(DIST, 'index.html') : file;
    const res = await net.fetch(pathToFileURL(target).toString());
    const headers = new Headers(res.headers);
    if (target.endsWith('.html')) headers.set('Content-Security-Policy', CSP);
    return new Response(res.body, {status: res.status, headers});
  });
}

function isOurOrigin(origin) {
  return isAllowedOrigin(origin, DEV_URL ? [APP_ORIGIN, DEV_URL] : [APP_ORIGIN]);
}

function setUpHid(ses) {
  // Called when the page runs navigator.hid.requestDevice(). Chromium has
  // already filtered the list to VIA interfaces (usage page 0xFF60).
  ses.on('select-hid-device', async (event, details, callback) => {
    event.preventDefault();
    const devices = details.deviceList;
    debug('select-hid-device', JSON.stringify(devices));
    if (devices.length === 0) {
      await dialog.showMessageBox(win, {
        type: 'info',
        message: 'No VIA keyboard found',
        detail: 'Plug the keyboard in with a USB cable. It needs QMK firmware with VIA (or Vial) enabled.',
      });
      callback();
      return;
    }
    if (devices.length === 1) {
      callback(devices[0].deviceId);
      return;
    }
    const {response} = await dialog.showMessageBox(win, {
      type: 'question',
      message: 'Which keyboard?',
      buttons: [...devices.map((d) => d.name || `${d.vendorId}:${d.productId}`), 'Cancel'],
      cancelId: devices.length,
    });
    callback(response < devices.length ? devices[response].deviceId : undefined);
  });

  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    debug('permission check', permission, origin);
    return permission === 'hid' && isOurOrigin(origin);
  });
  ses.setDevicePermissionHandler((details) => {
    debug('device permission', details.deviceType, details.origin);
    return details.deviceType === 'hid' && isOurOrigin(details.origin);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 820,
    height: 940,
    minWidth: 420,
    minHeight: 500,
    title: 'Keyboard Lighting',
    icon: path.join(__dirname, '..', 'build', 'icons', 'icon.png'),
    autoHideMenuBar: true,
    show: !SMOKE,
    webPreferences: {contextIsolation: true, nodeIntegration: false, sandbox: true},
  });

  trayControls?.manage(win);

  // Links open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({url}) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return {action: 'deny'};
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isOurOrigin(new URL(url).origin)) event.preventDefault();
  });

  const query = SMOKE ? '?mock' : '';
  win.loadURL(DEV_URL ? `${DEV_URL}/${query}` : `${APP_ORIGIN}/index.html${query}`);
  if (SMOKE) win.webContents.once('did-finish-load', runSmokeTest);
  if (DEBUG) {
    win.webContents.on('console-message', (e) => console.log('[page]', e.message));
    if (process.env.VIA_APP_DEBUG_TRAY === '1') {
      // Close → should hide to tray, not quit; then show again from the tray.
      win.webContents.once('did-finish-load', async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        await wait(500);
        win.close();
        await wait(500);
        debug('after close', JSON.stringify({visible: win.isVisible(), destroyed: win.isDestroyed()}));
        win.minimize();
        trayControls.show();
        await wait(500);
        debug('after show', JSON.stringify({visible: win.isVisible()}));
        win.minimize();
        await wait(500);
        debug('after minimize', JSON.stringify({visible: win.isVisible()}));
        app.quit();
      });
    }
    if (process.env.VIA_APP_DEBUG_CONNECT === '1') {
      // Clicks Connect with a real user gesture, as a person would.
      win.webContents.once('did-finish-load', async () => {
        await win.webContents.executeJavaScript("document.querySelector('button.primary').click()", true);
        await new Promise((r) => setTimeout(r, 4000));
        const page = await win.webContents.executeJavaScript(
          "({status: document.querySelector('.status').textContent, info: [...document.querySelectorAll('dd')].map((d) => d.textContent)})",
        );
        debug('after connect', JSON.stringify(page));
      });
    }
  }
}

// VIA_APP_SMOKE=1: load the simulated keyboard, connect, print the result and
// exit. Lets CI check that a packaged app actually starts and works.
async function runSmokeTest() {
  try {
    const result = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('button.primary').click();
      for (let i = 0; i < 50 && !document.querySelector('.zone'); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return {
        status: document.querySelector('.status').textContent,
        zones: document.querySelectorAll('.zone').length,
        hid: 'hid' in navigator,
      };
    })()`);
    console.log('SMOKE', JSON.stringify(result));
    app.exit(result.zones > 0 && result.hid ? 0 : 1);
  } catch (e) {
    console.error('SMOKE FAILED', e);
    app.exit(1);
  }
}

app.on('second-instance', () => {
  // Launching the app again brings the hidden window back.
  if (trayControls) trayControls.show();
  else if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  serveDist();
  setUpHid(session.defaultSession);
  if (!SMOKE) trayControls = setUpTray(() => win);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else trayControls?.show();
  });
});

// With the tray, windows are hidden rather than closed, so this only runs in
// smoke tests or when quitting.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || !trayControls) app.quit();
});
