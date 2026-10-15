import {defineConfig} from 'vitest/config';

export default defineConfig({
  // Relative paths so the same build works on a web host and inside Electron.
  base: './',
  server: {port: 5173, strictPort: true},
  test: {environment: 'node'},
});
