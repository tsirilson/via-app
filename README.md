# Keyboard Lighting (via-app)

Control the lighting on any keyboard running QMK with VIA, straight from
Chrome or Edge.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173 in **Chrome or Edge** (Firefox and Safari don't
support WebHID). Plug the keyboard in **with a USB cable**, click
**Connect keyboard**, and pick it in the browser's prompt.

## Try it without a keyboard

| URL | Simulates |
|-----|-----------|
| http://localhost:5173/?mock | Keychron K8 Pro, current firmware |
| http://localhost:5173/?mock=legacy | K8 Pro on old firmware (protocol 10) |
| http://localhost:5173/?mock=unknown | An unknown board with backlight + underglow, no definition |

## First test on the real K8 Pro (Phase 1)

1. Connect. Check the info card: it should say **VIA protocol 12**, channel
   **Per-key RGB (3)**, definition **bundled with this app**.
2. Change the effect and color; the keyboard should change instantly.
3. Click **Save to keyboard**, unplug and replug. The settings should stay.
4. Open **Raw HID log** at the bottom and copy it if anything looks wrong.

If the official VIA app or another configurator is open, close it first so
the two apps don't send commands to the keyboard at the same time.

## Other commands

```bash
npm test          # protocol + definition tests
npm run typecheck
npm run build     # static site in dist/
```
