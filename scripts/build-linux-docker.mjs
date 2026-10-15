// Builds the Linux AppImage + .deb inside electron-builder's Linux image, so
// it can run on Windows or macOS with Docker. dist/ must already be built.
// Linux node_modules live in a Docker volume so they don't clash with the
// host's node_modules. electron-builder works in the container's /tmp and only
// the finished installers are copied to release/: renaming folders inside a
// Docker Desktop bind mount on Windows fails (EACCES/EPERM) and can leave
// locked folders behind.
import {spawnSync} from 'node:child_process';

const result = spawnSync(
  'docker',
  [
    'run', '--rm',
    '-v', `${process.cwd()}:/project`,
    '-v', 'via-app-linux-node-modules:/project/node_modules',
    '-w', '/project',
    'electronuserland/builder:20',
    '/bin/bash', '-c', [
      'npm ci --ignore-scripts',
      'node scripts/linux-package-scripts.cjs',
      'npx electron-builder --linux --publish never -c.directories.output=/tmp/out',
      'mkdir -p release',
      'cp /tmp/out/*.AppImage /tmp/out/*.deb release/',
    ].join(' && '),
  ],
  {stdio: 'inherit'},
);
process.exit(result.status ?? 1);
