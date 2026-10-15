// Builds the Linux AppImage + .deb inside electron-builder's Linux image, so
// it can run on Windows or macOS with Docker. dist/ must already be built.
// Linux node_modules live in a Docker volume so they don't clash with the
// host's node_modules.
import {spawnSync} from 'node:child_process';

const result = spawnSync(
  'docker',
  [
    'run', '--rm',
    '-v', `${process.cwd()}:/project`,
    '-v', 'via-app-linux-node-modules:/project/node_modules',
    '-w', '/project',
    'electronuserland/builder:20',
    '/bin/bash', '-c', 'npm ci --ignore-scripts && npx electron-builder --linux --publish never',
  ],
  {stdio: 'inherit'},
);
process.exit(result.status ?? 1);
