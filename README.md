# Keyboard Lighting (via-app)

Control the lighting on any keyboard running QMK with VIA, as a desktop app
(Windows, macOS, Linux) or in Chrome/Edge.

Plug the keyboard in **with a USB cable**, click **Connect keyboard**, and pick
it. Close the official VIA app or other configurators first so two apps don't
send commands to the keyboard at the same time.

## Use it in the browser

https://tsirilson.github.io/via-app/ in **Chrome or Edge** (Firefox and Safari
don't support WebHID). Deployed automatically on every push to `main`.

## Install the desktop app

Download the installer for your system from the
[latest release](https://github.com/tsirilson/via-app/releases/latest).

The app keeps running in the background: on Windows and Linux, closing or
minimizing it hides it to the system tray; on macOS it lives in the menu bar
(no Dock icon). Use **Quit** in the tray/menu-bar menu to exit.

| OS | File | Notes |
|----|------|-------|
| Windows | `Keyboard-Lighting-<version>-win-x64.exe` | Unsigned: SmartScreen shows "Windows protected your PC" → **More info → Run anyway**. |
| macOS | `Keyboard-Lighting-<version>-mac-universal.dmg` (Apple Silicon and Intel) | Not notarized yet, so macOS says it "could not verify" the app. Try to open it once, click **Done**, then go to **System Settings → Privacy & Security**, click **Open Anyway** next to Keyboard Lighting and confirm. |
| Linux | `.deb` (Debian/Ubuntu) or `.AppImage` | The `.deb` installs a udev rule so the app can access keyboards. For the AppImage, add it yourself (below). On Ubuntu 24.04+ the AppImage may need `--no-sandbox` (the `.deb` doesn't). GNOME needs the AppIndicator extension for the tray icon. |

Linux keyboard access for the AppImage (one time):

```bash
echo 'KERNEL=="hidraw*", SUBSYSTEM=="hidraw", MODE="0660", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/50-keyboard-lighting.rules && sudo udevadm control --reload-rules && sudo udevadm trigger
```

## Develop

```bash
npm install
npm run dev
```

Open http://localhost:5173 in **Chrome or Edge** (Firefox and Safari don't
support WebHID).

### Try it without a keyboard

| URL | Simulates |
|-----|-----------|
| http://localhost:5173/?mock | Keychron K8 Pro, current firmware (protocol 12) |
| http://localhost:5173/?mock=legacy | K8 Pro factory firmware (protocol 9) |
| http://localhost:5173/?mock=unknown | An unknown board with backlight + underglow, no definition |

### Commands

```bash
npm test                    # protocol + definition tests
npm run typecheck
npm run build               # static web app in dist/ (works on any web host)
npm run electron:dev        # run the desktop app from dist/
npm run electron:smoke      # start the desktop app against the simulated keyboard
npm run dist:win            # Windows installer → release/
npm run dist:mac            # macOS .dmg (must run on a Mac)
npm run dist:linux          # Linux AppImage + .deb (on Linux)
npm run dist:linux:docker   # Linux AppImage + .deb from Windows/macOS via Docker
npm run icon                # re-render the app and tray icons from SVG
npm run release:patch       # bump version, tag, push → GitHub builds a release
```

### Releasing

`npm run release:patch` (or `release:minor`) bumps the version in
`package.json`, commits, tags it (e.g. `v0.2.1`) and pushes. The
[Build installers](.github/workflows/build.yml) workflow then builds and
smoke-tests all three platforms and publishes a GitHub Release with the
installers and auto-generated notes. Builds on plain pushes to `main` are
available as workflow artifacts.

The desktop app is the same web app inside Electron
([electron/main.cjs](electron/main.cjs)): it serves `dist/` from a private
`app://` origin and replaces the browser's device prompt with a native one.

## If something goes wrong on the keyboard

- **Undo changes** restores what the keyboard had when you connected.
- Changes aren't saved until you click **Save**, **but** pressing the keyboard's
  own lighting keys saves everything, including the app's changes.
- Keychron K Pro boards: hold **Fn + J + Z** for a few seconds to factory-reset.
