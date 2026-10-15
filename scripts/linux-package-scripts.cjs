// Run before `electron-builder --linux`. Builds the .deb install/remove scripts as
// electron-builder's own defaults + our udev section. A custom afterInstall
// *replaces* the default, which would drop the /usr/bin link, the
// chrome-sandbox permissions and the AppArmor profile (needed on Ubuntu 24+).

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const templates = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates', 'linux');

function write(defaultName, extraName, outName) {
  const base = fs.readFileSync(path.join(templates, defaultName), 'utf8');
  const extra = fs.readFileSync(path.join(root, 'build', 'linux', extraName), 'utf8');
  fs.writeFileSync(path.join(root, 'build', 'linux', outName), `${base.trimEnd()}\n${extra}`);
}

// (A beforePack hook is too late: electron-builder reads these paths first.)
write('after-install.tpl', 'udev-install.sh', 'after-install.generated.tpl');
write('after-remove.tpl', 'udev-remove.sh', 'after-remove.generated.tpl');
console.log('Generated build/linux/after-{install,remove}.generated.tpl');
