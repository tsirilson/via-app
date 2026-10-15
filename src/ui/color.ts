// QMK stores color as hue + saturation, each 0-255. Brightness ("value") is a
// separate control, so the picker always previews at full value.

export function hsToHex(hue: number, sat: number): string {
  const h = (hue / 255) * 6;
  const s = sat / 255;
  const c = s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = 1 - c;
  const [r, g, b] =
    h < 1 ? [c, x, 0]
    : h < 2 ? [x, c, 0]
    : h < 3 ? [0, c, x]
    : h < 4 ? [0, x, c]
    : h < 5 ? [x, 0, c]
    : [c, 0, x];
  return (
    '#' +
    [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')
  );
}

export function hexToHs(hex: string): [number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    if (h < 0) h += 6;
  }
  const s = max === 0 ? 0 : d / max;
  return [Math.round((h / 6) * 255) % 256, Math.round(s * 255)];
}
