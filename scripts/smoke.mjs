// Starts the Electron app with the simulated keyboard and checks that it
// connects. Usage:
//   node scripts/smoke.mjs                 (unpackaged, runs ./dist)
//   node scripts/smoke.mjs <path-to-app> [extra args]   (a packaged executable)
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const exe = process.argv[2] ?? require('electron');
const args = process.argv[2] ? process.argv.slice(3) : ['.'];

const result = spawnSync(exe, args, {
  env: {...process.env, VIA_APP_SMOKE: '1', ELECTRON_ENABLE_LOGGING: '0'},
  encoding: 'utf8',
  timeout: 60_000,
});
const line = `${result.stdout}\n${result.stderr}`.split('\n').find((l) => l.startsWith('SMOKE'));
console.log(line ?? '(no SMOKE line)');
if (result.status !== 0) {
  console.error(`Smoke test failed (exit ${result.status ?? result.signal}).`);
  if (!line) console.error(result.stdout, result.stderr);
  process.exit(1);
}
console.log('Smoke test passed.');
