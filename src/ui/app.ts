import {ViaClient, type LogEntry} from '../protocol/client';
import {CHANNEL, decodeNumber, encodeNumber, hex} from '../protocol/encoding';
import {MockFirmware} from '../protocol/mockFirmware';
import {WebHidTransport, isWebHidAvailable} from '../protocol/transport';
import {channelsOf, dataLength, type Control, type LightingModel, type Zone} from '../definitions/model';
import {adaptToFirmware, fitLegacySpeedRange, fromDefinition, fromProbe} from '../definitions/normalize';
import {definitionMatches, resolveDefinition, vendorProductId} from '../definitions/resolve';
import {evaluateShowIf} from '../definitions/showIf';
import {hexToHs, hsToHex} from './color';

const SOURCE_LABEL: Record<LightingModel['source'], string> = {
  vial: 'From the keyboard (Vial)',
  bundled: 'Bundled with this app',
  'via-hosted-v3': "VIA's library (v3)",
  'via-hosted-v2': "VIA's library (v2)",
  file: 'Loaded from file',
  probe: 'None found — generic controls',
};

/** Quick colors, as QMK hue/saturation (0-255). */
const SWATCHES: {name: string; hs: [number, number]}[] = [
  {name: 'Red', hs: [0, 255]},
  {name: 'Orange', hs: [21, 255]},
  {name: 'Yellow', hs: [43, 255]},
  {name: 'Green', hs: [85, 255]},
  {name: 'Cyan', hs: [128, 255]},
  {name: 'Blue', hs: [170, 255]},
  {name: 'Purple', hs: [191, 255]},
  {name: 'Pink', hs: [234, 200]},
  {name: 'White', hs: [0, 0]},
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & {class?: string} = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const {class: cls, ...rest} = props;
  if (cls) node.className = cls;
  Object.assign(node, rest);
  node.append(...children);
  return node;
}

type ColorMap = Record<string, [number, number]>;

interface Session {
  client: ViaClient;
  channels: number[];
  vial?: {vialVersion: number; vialRgb: boolean};
  firmwareVersion?: number;
  model: LightingModel;
  /** Numeric values by value_key (colors store hue here for showIf). */
  values: Record<string, number>;
  colors: ColorMap;
  warnings: string[];
  /** Last known saved state (on connect, then after each Save), for Undo. */
  original: {values: Record<string, number>; colors: ColorMap};
  dirty: boolean;
}

export class App {
  private session?: Session;
  private connection = el('div', {class: 'connection'});
  private status = el('div', {class: 'status', role: 'status'});
  private main = el('main');
  private actionbar = el('footer', {class: 'actionbar', hidden: true});
  private log = el('pre', {class: 'log'});
  private logLines: string[] = [];
  private pending = new Map<string, number[]>();
  private inFlight = new Set<string>();
  private statusTimer?: number;

  constructor(private root: HTMLElement) {}

  start() {
    this.root.append(
      el('header', {class: 'topbar'},
        el('div', {class: 'brand'}, el('span', {class: 'brand-mark', ariaHidden: 'true'}), 'Keyboard Lighting'),
        this.connection,
      ),
      this.main,
      this.actionbar,
      this.status,
    );
    this.renderDisconnected();
  }

  // ---------------------------------------------------------------- status

  private setStatus(text: string, kind: 'info' | 'error' | 'success' = 'info') {
    this.status.textContent = text;
    this.status.dataset.kind = kind;
    this.status.classList.add('visible');
    clearTimeout(this.statusTimer);
    this.statusTimer = window.setTimeout(
      () => this.status.classList.remove('visible'),
      kind === 'error' ? 7000 : 3000,
    );
  }

  private setConnection(state: 'disconnected' | 'connecting' | 'connected', label: string) {
    this.connection.dataset.state = state;
    this.connection.replaceChildren(el('span', {class: 'dot'}), el('span', {}, label));
  }

  private appendLog(e: LogEntry) {
    const arrow = e.direction === 'out' ? '→' : '←';
    const bytes = hex(e.bytes).replace(/( 00)+$/, ' …');
    this.logLines.push(`${arrow} ${bytes}${e.note ? `   (${e.note})` : ''}`);
    if (this.logLines.length > 300) this.logLines.shift();
    this.log.textContent = this.logLines.join('\n');
  }

  // ---------------------------------------------------------- disconnected

  private renderDisconnected() {
    this.actionbar.hidden = true;
    this.setConnection('disconnected', 'Not connected');
    const art = el('div', {class: 'empty-art', ariaHidden: 'true'}, el('div', {class: 'keycap'}));

    if (!isWebHidAvailable()) {
      this.main.replaceChildren(
        el('section', {class: 'empty'}, art,
          el('h1', {}, 'This browser can’t talk to keyboards'),
          el('p', {}, 'Open this page in Chrome or Edge on a desktop computer, or use the desktop app.')),
      );
      return;
    }

    const button = el('button', {class: 'primary large', textContent: 'Connect keyboard'});
    button.addEventListener('click', () => this.connect(button));
    this.main.replaceChildren(
      el('section', {class: 'empty'}, art,
        el('h1', {}, 'Connect your keyboard'),
        el('p', {}, 'Plug it in with a USB cable, then connect. Works with keyboards running QMK with VIA or Vial.'),
        button),
    );
  }

  private async connect(button: HTMLButtonElement) {
    button.disabled = true;
    try {
      const mock = new URLSearchParams(location.search).get('mock');
      const transport = mock !== null ? mockKeyboard(mock) : await WebHidTransport.request();
      if (!transport) {
        this.setStatus('No keyboard selected.');
        return;
      }
      transport.onDisconnect(() => {
        this.session = undefined;
        this.renderDisconnected();
        this.setStatus('Keyboard disconnected.', 'error');
      });
      await this.setUp(new ViaClient(transport));
    } catch (e) {
      this.setConnection('disconnected', 'Not connected');
      this.setStatus(`Couldn't connect: ${(e as Error).message}`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  private async setUp(client: ViaClient) {
    client.onLog((e) => this.appendLog(e));
    const t = client.transport;
    this.setConnection('connecting', `Connecting to ${t.productName}…`);

    await client.handshake();
    const vial = await client.detectVial().catch(() => undefined);
    const firmwareVersion = await client.getFirmwareVersion().catch(() => undefined);
    const channels = await client.probeLightingChannels();

    const resolved = await resolveDefinition(t.vendorId, t.productId, {
      baseUrl: import.meta.env.BASE_URL,
    });
    const base = resolved
      ? fromDefinition(resolved.definition, resolved.source)
      : fromProbe(channels, t.productName);

    this.session = {
      client, channels, vial, firmwareVersion,
      model: base, values: {}, colors: {}, warnings: [],
      original: {values: {}, colors: {}}, dirty: false,
    };
    await this.applyModel(base);
  }

  private async applyModel(model: LightingModel) {
    const s = this.session!;
    const adapted = adaptToFirmware(model, s.client.format, s.channels);
    s.warnings = [];
    // Drop zones the firmware doesn't answer on (custom channel 0 can't be probed).
    const zones = adapted.zones.filter((z) => {
      const missing = z.controls.filter(
        (c) => c.ref.channel !== CHANNEL.custom && !s.channels.includes(c.ref.channel),
      );
      if (missing.length) s.warnings.push(`“${z.label}” is in the definition but the keyboard didn't respond to it.`);
      return missing.length === 0;
    });
    s.model = {...adapted, zones};
    if (!zones.length && s.channels.length === 0) {
      s.warnings.push("The keyboard didn't respond on any lighting channel. It may have no lighting VIA can control.");
    }
    await this.readValues();
    // Keep the first snapshot, so loading a definition file later doesn't
    // replace "what the keyboard had" with already-changed values.
    if (!Object.keys(s.original.values).length) this.snapshot();
    if (s.client.format === 'legacy') s.model = fitLegacySpeedRange(s.model, s.values);
    this.render();
    this.setConnection('connected', s.model.name);
    this.setStatus(`Connected to ${s.model.name}.`, 'success');
  }

  private snapshot() {
    const s = this.session!;
    s.original = {values: {...s.values}, colors: {...s.colors}};
  }

  private async readValues() {
    const s = this.session!;
    s.values = {};
    s.colors = {};
    for (const z of s.model.zones) {
      for (const c of z.controls) {
        try {
          const data = await s.client.getValue(c.ref, dataLength(c));
          if (c.type === 'color') {
            s.colors[c.key] = [data[0], data[1]];
            s.values[c.key] = data[0];
          } else {
            s.values[c.key] = decodeNumber(data, c.max);
          }
        } catch {
          s.values[c.key] = c.min;
        }
      }
    }
  }

  // ------------------------------------------------------------- connected

  private render() {
    const s = this.session!;
    const notices = [...s.warnings];
    if (s.model.genericNames) {
      notices.push("Effect names are VIA's generic list and may not match this keyboard. Load the maker's definition file (Keyboard details below) for accurate names.");
    }

    this.main.replaceChildren(
      ...s.model.zones.map((z) => this.renderZone(z)),
      ...notices.map((n) => el('p', {class: 'notice'}, n)),
      this.renderDetails(),
    );
    this.renderActionbar();
    this.refresh();
  }

  private renderZone(zone: Zone): HTMLElement {
    const preview = el('div', {class: 'preview'},
      el('div', {class: 'preview-glow'}),
      el('div', {class: 'preview-text'},
        el('span', {class: 'preview-label'}, zone.label),
        el('strong', {class: 'preview-effect'}),
        el('span', {class: 'preview-meta'})),
    );
    const section = el('section', {class: 'zone'}, preview,
      el('div', {class: 'controls'}, ...zone.controls.map((c) => this.renderControl(c))));
    section.dataset.zone = zone.label;
    return section;
  }

  private renderControl(c: Control): HTMLElement {
    const s = this.session!;
    const wrap = el('div', {class: `control control-${c.type}`});
    wrap.dataset.key = c.key;
    const label = el('span', {class: 'control-label'}, c.label);
    const value = el('span', {class: 'control-value'});
    const head = el('div', {class: 'control-head'}, label, value);

    if (c.type === 'dropdown') {
      const current = s.values[c.key] ?? 0;
      const options = c.options.some((o) => o.value === current)
        ? c.options
        : [...c.options, {label: `Unknown (${current})`, value: current}];
      const isEffect = /effect/i.test(c.key) || /effect/i.test(c.label);
      if (isEffect || options.length <= 8) {
        const grid = el('div', {class: 'chips', role: 'radiogroup', ariaLabel: c.label});
        for (const o of options) {
          const chip = el('button', {
            class: 'chip',
            type: 'button',
            role: 'radio',
            textContent: isEffect && o.value === 0 ? 'Off' : o.label,
          });
          chip.dataset.value = String(o.value);
          chip.addEventListener('click', () => this.change(c, o.value));
          grid.append(chip);
        }
        wrap.append(head, grid);
      } else {
        const select = el('select', {ariaLabel: c.label});
        select.append(...options.map((o) => el('option', {value: String(o.value), textContent: o.label})));
        select.value = String(current);
        select.addEventListener('change', () => this.change(c, Number(select.value)));
        wrap.append(head, select);
      }
    } else if (c.type === 'color') {
      const row = el('div', {class: 'swatches'});
      for (const sw of SWATCHES) {
        const b = el('button', {class: 'swatch', type: 'button', title: sw.name, ariaLabel: sw.name});
        b.style.setProperty('--swatch', hsToHex(...sw.hs));
        b.dataset.hs = sw.hs.join(',');
        b.addEventListener('click', () => this.setColor(c, sw.hs));
        row.append(b);
      }
      const picker = el('input', {type: 'color', ariaLabel: 'Custom color'});
      picker.addEventListener('input', () => this.setColor(c, hexToHs(picker.value)));
      row.append(el('label', {class: 'swatch custom', title: 'Custom color'}, picker));
      wrap.append(head, row);
    } else if (c.type === 'toggle') {
      const box = el('input', {type: 'checkbox', role: 'switch', ariaLabel: c.label});
      box.addEventListener('change', () => this.change(c, box.checked ? c.max : c.min));
      wrap.append(el('label', {class: 'switch'}, label, box));
    } else {
      const range = el('input', {
        type: 'range', min: String(c.min), max: String(c.max), ariaLabel: c.label,
      });
      range.addEventListener('input', () => this.change(c, Number(range.value)));
      wrap.append(head, range);
    }
    return wrap;
  }

  private renderDetails(): HTMLElement {
    const s = this.session!;
    const t = s.client.transport;
    const firmware = s.vial
      ? `Vial (VIA protocol ${s.client.protocolVersion}${s.vial.vialRgb ? ', VialRGB' : ''})`
      : `VIA protocol ${s.client.protocolVersion} (${s.client.format} format)`;

    const identify = el('button', {type: 'button', textContent: 'Identify'});
    identify.title = 'Flash the keyboard’s lights';
    identify.addEventListener('click', async () => {
      identify.disabled = true;
      const ok = await s.client.identify().catch(() => false);
      identify.disabled = false;
      if (!ok) this.setStatus("This keyboard doesn't support Identify.", 'error');
    });

    const fileInput = el('input', {type: 'file', accept: '.json,application/json', hidden: true});
    fileInput.addEventListener('change', () => this.loadFile(fileInput.files?.[0]));
    const loadButton = el('button', {type: 'button', textContent: 'Load definition file…'});
    loadButton.addEventListener('click', () => fileInput.click());

    return el('details', {class: 'details'},
      el('summary', {}, 'Keyboard details'),
      el('dl', {},
        el('dt', {}, 'Device'), el('dd', {}, `${t.productName} · ${vid(t.vendorId)}:${vid(t.productId)} (VPID ${vendorProductId(t.vendorId, t.productId)})`),
        el('dt', {}, 'Firmware'), el('dd', {}, firmware),
        el('dt', {}, 'Lighting'), el('dd', {}, s.channels.length
          ? s.channels.map((ch) => channelName(ch, s.client.format === 'legacy')).join(', ')
          : 'none'),
        el('dt', {}, 'Definition'), el('dd', {}, SOURCE_LABEL[s.model.source]),
      ),
      el('div', {class: 'row'}, identify, loadButton, fileInput),
      el('details', {class: 'log-panel'}, el('summary', {}, 'Raw HID log'), this.log),
    );
  }

  private renderActionbar() {
    const undo = el('button', {type: 'button', textContent: 'Undo changes'});
    undo.addEventListener('click', () => this.undo(undo));
    const save = el('button', {type: 'button', class: 'primary', textContent: 'Save to keyboard'});
    save.addEventListener('click', () => this.save(save));
    this.actionbar.replaceChildren(
      el('div', {class: 'actionbar-text'}, el('strong'), el('span')),
      el('div', {class: 'row'}, undo, save),
    );
    this.actionbar.hidden = !this.session?.model.zones.length;
  }

  /** Syncs every control, the previews and the action bar with session state. */
  private refresh() {
    const s = this.session!;
    for (const z of s.model.zones) {
      for (const c of z.controls) {
        const node = this.main.querySelector<HTMLElement>(`[data-key="${CSS.escape(c.key)}"]`);
        if (!node) continue;
        let visible = true;
        try {
          visible = c.showIf ? evaluateShowIf(c.showIf, s.values) : true;
        } catch {
          visible = true;
        }
        node.hidden = !visible;
        this.syncControl(c, node);
      }
      this.syncPreview(z);
    }

    const [title, detail] = this.actionbar.querySelectorAll<HTMLElement>('.actionbar-text > *');
    const buttons = this.actionbar.querySelectorAll<HTMLButtonElement>('button');
    this.actionbar.classList.toggle('dirty', s.dirty);
    if (title) {
      title.textContent = s.dirty ? 'Unsaved changes' : 'Saved on the keyboard';
      detail.textContent = s.dirty
        ? 'Lost when unplugged. Pressing the keyboard’s own lighting keys also saves them.'
        : 'What you see is what the keyboard keeps.';
    }
    buttons.forEach((b) => (b.disabled = !s.dirty));
  }

  private syncControl(c: Control, node: HTMLElement) {
    const s = this.session!;
    const v = s.values[c.key] ?? c.min;
    const value = node.querySelector<HTMLElement>('.control-value');
    if (c.type === 'range') {
      const range = node.querySelector<HTMLInputElement>('input[type=range]')!;
      if (Number(range.value) !== v) range.value = String(v);
      const pct = c.max > c.min ? ((v - c.min) / (c.max - c.min)) * 100 : 0;
      range.style.setProperty('--pct', `${pct}%`);
      if (value) value.textContent = c.max === 255 ? `${Math.round(pct)}%` : String(v);
    } else if (c.type === 'dropdown') {
      node.querySelectorAll<HTMLButtonElement>('.chip').forEach((chip) =>
        chip.setAttribute('aria-checked', String(Number(chip.dataset.value) === v)),
      );
      const select = node.querySelector('select');
      if (select) select.value = String(v);
      if (value) value.textContent = '';
    } else if (c.type === 'color') {
      const [h, sat] = s.colors[c.key] ?? [0, 255];
      node.querySelectorAll<HTMLButtonElement>('.swatch[data-hs]').forEach((b) => {
        const [bh, bs] = b.dataset.hs!.split(',').map(Number);
        const match = (bs === 0 && sat < 12) || (Math.abs(bh - h) <= 3 && Math.abs(bs - sat) <= 12);
        b.setAttribute('aria-pressed', String(match));
      });
      const picker = node.querySelector<HTMLInputElement>('input[type=color]')!;
      picker.value = hsToHex(h, sat);
      node.querySelector<HTMLElement>('.swatch.custom')!.style.setProperty('--swatch', hsToHex(h, sat));
      if (value) value.textContent = colorName(h, sat);
    } else if (c.type === 'toggle') {
      node.querySelector<HTMLInputElement>('input')!.checked = v === c.max;
    }
  }

  /** The glowing preview card: color, effect name, brightness/speed summary. */
  private syncPreview(zone: Zone) {
    const s = this.session!;
    const section = this.main.querySelector<HTMLElement>(`[data-zone="${CSS.escape(zone.label)}"]`);
    if (!section) return;
    const find = (re: RegExp, type?: string) =>
      zone.controls.find((c) => re.test(c.key) && (!type || c.type === type));
    const effect = find(/effect$/, 'dropdown') ?? zone.controls.find((c) => c.type === 'dropdown');
    const brightness = find(/brightness/, 'range');
    const speed = find(/speed/, 'range');
    const color = zone.controls.find((c) => c.type === 'color');

    const effectValue = effect ? s.values[effect.key] ?? 0 : 1;
    const off = effect !== undefined && effectValue === 0;
    const effectName = effect?.options.find((o) => o.value === effectValue)?.label ?? `Effect ${effectValue}`;
    const visible = (c?: Control) => {
      if (!c) return false;
      try {
        return c.showIf ? evaluateShowIf(c.showIf, s.values) : true;
      } catch {
        return true;
      }
    };
    const pct = (c?: Control) =>
      c ? Math.round(((s.values[c.key] ?? c.min) - c.min) / Math.max(1, c.max - c.min) * 100) : 100;

    const solid = color && visible(color);
    const [h, sat] = color ? s.colors[color.key] ?? [0, 255] : [0, 0];
    section.style.setProperty('--glow', solid ? hsToHex(h, sat) : 'transparent');
    section.style.setProperty('--glow-strength', String(off ? 0 : 0.25 + (pct(brightness) / 100) * 0.75));
    section.style.setProperty('--spin', `${Math.max(2, 16 - (pct(speed) / 100) * 14)}s`);
    section.classList.toggle('rainbow', !off && !solid);
    section.classList.toggle('off', off);

    section.querySelector('.preview-effect')!.textContent = off ? 'Lights off' : effectName;
    const meta: string[] = [];
    if (brightness && !off) meta.push(`Brightness ${pct(brightness)}%`);
    if (speed && visible(speed) && !off) meta.push(`Speed ${pct(speed)}%`);
    section.querySelector('.preview-meta')!.textContent = meta.join(' · ');
  }

  // --------------------------------------------------------------- actions

  private setColor(c: Control, hs: [number, number]) {
    this.session!.colors[c.key] = hs;
    this.change(c, hs[0], hs);
  }

  /** Live apply: always send the latest value, never more than one in flight per control. */
  private change(c: Control, numeric: number, color?: [number, number]) {
    const s = this.session!;
    s.values[c.key] = numeric;
    s.dirty = true;
    this.refresh();
    this.pending.set(c.key, color ?? encodeNumber(numeric, c.max));
    void this.flush(c);
  }

  private async flush(c: Control) {
    if (this.inFlight.has(c.key)) return;
    const s = this.session;
    while (s && this.pending.has(c.key)) {
      const data = this.pending.get(c.key)!;
      this.pending.delete(c.key);
      this.inFlight.add(c.key);
      try {
        await s.client.setValue(c.ref, data);
      } catch (e) {
        this.setStatus(`Couldn't set ${c.label}: ${(e as Error).message}`, 'error');
      } finally {
        this.inFlight.delete(c.key);
      }
    }
  }

  /** Sends back the last saved values (as read on connect, or since the last Save). */
  private async undo(button: HTMLButtonElement) {
    const s = this.session!;
    button.disabled = true;
    try {
      for (const z of s.model.zones) {
        for (const c of z.controls) {
          const color = s.original.colors[c.key];
          const value = s.original.values[c.key];
          if (c.type === 'color' && color) await s.client.setValue(c.ref, color);
          else if (value !== undefined) await s.client.setValue(c.ref, encodeNumber(value, c.max));
        }
      }
      s.values = {...s.original.values};
      s.colors = {...s.original.colors};
      s.dirty = false;
      this.refresh();
      this.setStatus('Changes undone.', 'success');
    } catch (e) {
      this.setStatus(`Undo failed: ${(e as Error).message}`, 'error');
      button.disabled = false;
    }
  }

  private async save(button: HTMLButtonElement) {
    const s = this.session!;
    button.disabled = true;
    try {
      const channels = s.client.format === 'legacy' ? [0] : channelsOf(s.model);
      for (const ch of channels) await s.client.save(ch);
      this.snapshot();
      s.dirty = false;
      this.refresh();
      this.setStatus('Saved to the keyboard.', 'success');
    } catch (e) {
      this.setStatus(`Save failed: ${(e as Error).message}`, 'error');
      button.disabled = false;
    }
  }

  private async loadFile(file?: File) {
    const s = this.session;
    if (!file || !s) return;
    try {
      const def = JSON.parse(await file.text());
      const t = s.client.transport;
      if (!definitionMatches(def, t.vendorId, t.productId)) {
        const ok = confirm(
          `This file is for ${def.vendorId}:${def.productId}, but the keyboard is ${vid(t.vendorId)}:${vid(t.productId)}. Use it anyway?`,
        );
        if (!ok) return;
      }
      await this.applyModel(fromDefinition(def, 'file'));
    } catch (e) {
      this.setStatus(`Couldn't read that file: ${(e as Error).message}`, 'error');
    }
  }
}

/**
 * Demo keyboards for trying the UI without hardware:
 *   ?mock          K8 Pro, protocol 12, per-key RGB (bundled definition)
 *   ?mock=legacy   K8 Pro factory firmware, protocol 9 (as seen on real hardware)
 *   ?mock=unknown  unknown board with backlight + underglow (no definition)
 */
function mockKeyboard(kind: string): MockFirmware {
  const fw =
    kind === 'legacy' ? new MockFirmware({protocolVersion: 9, channels: [2], productName: 'Mock K8 Pro (factory firmware)'})
    : kind === 'unknown' ? new MockFirmware({protocolVersion: 13, channels: [1, 2], vendorId: 0xfeed, productId: 0x0001, productName: 'Mock Unknown Board'})
    : new MockFirmware({protocolVersion: 12, channels: [3], productName: 'Mock K8 Pro'});
  for (const ch of [1, 2, 3]) {
    fw.values.set(`${ch}:1`, [200]);
    fw.values.set(`${ch}:2`, [2]);
    fw.values.set(`${ch}:3`, [128]);
    fw.values.set(`${ch}:4`, [170, 255]);
  }
  fw.values.set('legacy:128', [200]);
  fw.values.set('legacy:129', [2]);
  fw.values.set('legacy:130', [127]);
  fw.values.set('legacy:131', [170, 255]);
  return fw;
}

function vid(n: number) {
  return '0x' + n.toString(16).padStart(4, '0').toUpperCase();
}

function channelName(ch: number, legacy: boolean) {
  if (legacy) return ch === CHANNEL.backlight ? 'Backlight' : 'RGB (legacy ids 0x80–0x83)';
  return (
    {
      [CHANNEL.backlight]: 'Backlight (1)',
      [CHANNEL.rgblight]: 'RGB underglow (2)',
      [CHANNEL.rgbMatrix]: 'Per-key RGB (3)',
      [CHANNEL.ledMatrix]: 'Per-key LED (5)',
    }[ch] ?? `Channel ${ch}`
  );
}

/** A friendly name for a QMK hue/saturation pair. */
function colorName(h: number, sat: number): string {
  if (sat < 40) return 'White';
  const names: [number, string][] = [
    [10, 'Red'], [32, 'Orange'], [55, 'Yellow'], [75, 'Lime'], [105, 'Green'],
    [140, 'Cyan'], [180, 'Blue'], [205, 'Purple'], [240, 'Pink'], [256, 'Red'],
  ];
  const name = names.find(([max]) => h < max)![1];
  return sat < 160 ? `Pale ${name.toLowerCase()}` : name;
}
