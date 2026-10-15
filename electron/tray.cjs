// Keeps the app running in the background with a tray / menu-bar icon.
//  - Windows, Linux: closing or minimizing the window hides it to the tray.
//    Left-click the icon to show the window; right-click for the menu.
//  - macOS: a menu-bar icon (template image, recolored by the OS) and no Dock
//    icon (LSUIElement in Info.plist + app.dock.hide()). Closing the window
//    keeps the app in the menu bar; clicking the icon opens the menu.

const path = require('node:path');
const {app, Menu, Tray, nativeImage} = require('electron');

const ASSETS = path.join(__dirname, 'assets');
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

function trayImage() {
  const file = isMac ? 'trayTemplate.png' : isWindows ? 'tray.png' : 'tray-linux.png';
  const image = nativeImage.createFromPath(path.join(ASSETS, file));
  if (isMac) image.setTemplateImage(true);
  return image;
}

/**
 * @param {() => import('electron').BrowserWindow | undefined} getWindow
 * @returns {{tray: Tray, show: () => void, hide: () => void, manage: (win: import('electron').BrowserWindow) => void}}
 */
function setUpTray(getWindow) {
  let quitting = false;
  let hintShown = false;
  app.on('before-quit', () => {
    quitting = true;
  });
  if (isMac) app.dock?.hide();

  const tray = new Tray(trayImage());
  tray.setToolTip('Keyboard Lighting');

  const show = () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (isMac) app.focus({steal: true});
  };

  const hide = () => {
    const win = getWindow();
    if (!win) return;
    win.hide();
    // Tell Windows users once where the app went.
    if (isWindows && !hintShown) {
      hintShown = true;
      tray.displayBalloon({
        title: 'Keyboard Lighting is still running',
        content: 'Click the tray icon to open it again. Use Quit in its menu to exit.',
        iconType: 'info',
      });
    }
  };

  const menu = Menu.buildFromTemplate([
    {label: 'Open Keyboard Lighting', click: show},
    {type: 'separator'},
    {label: 'Quit', accelerator: isMac ? 'Command+Q' : undefined, click: () => app.quit()},
  ]);

  if (isMac) {
    // Menu-bar convention: clicking the icon opens its menu.
    tray.setContextMenu(menu);
  } else {
    // Linux AppIndicator only shows a menu (no click events), so set it there
    // too; on Windows right-click shows it and left-click opens the window.
    if (isWindows) tray.on('right-click', () => tray.popUpContextMenu(menu));
    else tray.setContextMenu(menu);
    tray.on('click', () => {
      const win = getWindow();
      if (win?.isVisible() && !win.isMinimized()) win.focus();
      else show();
    });
  }

  /** Wires a window so closing/minimizing hides it instead of quitting. */
  const manage = (win) => {
    win.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      hide();
    });
    if (!isMac) win.on('minimize', () => hide());
  };

  return {tray, show, hide, manage};
}

module.exports = {setUpTray};
