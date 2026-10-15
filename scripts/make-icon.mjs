// Renders the icons from SVG:
//   build/icons/icon.png        1024px app icon (electron-builder makes .ico/.icns from it)
//   electron/assets/tray*.png   Windows/Linux tray (color)
//   electron/assets/trayTemplate*.png  macOS menu bar (template = black + alpha)
import {readFileSync, writeFileSync} from 'node:fs';
import {Resvg} from '@resvg/resvg-js';

const root = new URL('..', import.meta.url);
const render = (svgPath, width, outPath) => {
  const svg = readFileSync(new URL(svgPath, root));
  const png = new Resvg(svg, {fitTo: {mode: 'width', value: width}}).render().asPng();
  writeFileSync(new URL(outPath, root), png);
  console.log(`${outPath}: ${width}px`);
};

render('build/icons/icon.svg', 1024, 'build/icons/icon.png');
render('build/icons/icon.svg', 16, 'electron/assets/tray.png');
render('build/icons/icon.svg', 32, 'electron/assets/tray@2x.png');
render('build/icons/icon.svg', 48, 'electron/assets/tray@3x.png');
render('build/icons/icon.svg', 64, 'electron/assets/tray-linux.png');
render('build/icons/tray-template.svg', 16, 'electron/assets/trayTemplate.png');
render('build/icons/tray-template.svg', 32, 'electron/assets/trayTemplate@2x.png');
