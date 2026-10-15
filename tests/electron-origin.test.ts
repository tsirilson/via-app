import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';

const {isAllowedOrigin} = createRequire(import.meta.url)('../electron/origin.cjs');

describe('Electron HID origin check', () => {
  const allowed = ['app://bundle'];
  it('accepts the shapes Electron actually sends', () => {
    expect(isAllowedOrigin('app://bundle', allowed)).toBe(true);
    expect(isAllowedOrigin('app://bundle/', allowed)).toBe(true); // permission check (seen in the real app)
    expect(isAllowedOrigin('app://bundle/index.html', allowed)).toBe(true);
  });
  it('rejects other origins', () => {
    expect(isAllowedOrigin('https://evil.example', allowed)).toBe(false);
    expect(isAllowedOrigin('app://other/', allowed)).toBe(false);
    expect(isAllowedOrigin('', allowed)).toBe(false);
    expect(isAllowedOrigin(undefined, allowed)).toBe(false);
  });
  it('allows the dev server when configured', () => {
    expect(isAllowedOrigin('http://localhost:5173/', ['app://bundle', 'http://localhost:5173'])).toBe(true);
  });
});
