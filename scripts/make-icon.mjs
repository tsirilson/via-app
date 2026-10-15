// Renders build/icons/icon.svg to the 1024px PNG electron-builder converts
// into .ico / .icns / Linux icons.
import {readFileSync, writeFileSync} from 'node:fs';
import {Resvg} from '@resvg/resvg-js';

const svg = readFileSync(new URL('../build/icons/icon.svg', import.meta.url));
const png = new Resvg(svg, {fitTo: {mode: 'width', value: 1024}}).render().asPng();
writeFileSync(new URL('../build/icons/icon.png', import.meta.url), png);
console.log(`icon.png: ${png.length} bytes`);
