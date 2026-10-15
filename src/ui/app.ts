import {ViaClient, type LogEntry} from '../protocol/client';
import {CHANNEL, decodeNumber, encodeNumber, hex} from '../protocol/encoding';
import {MockFirmware} from '../protocol/mockFirmware';
import {WebHidTransport, isWebHidAvailable} from '../protocol/transport';
import {channelsOf, dataLength, type Control, type LightingModel} from '../definitions/model';
import {adaptToFirmware, fitLegacySpeedRange, fromDefinition, fromProbe} from '../definitions/normalize';
import {definitionMatches, resolveDefinition, vendorProductId} from '../definitions/resolve';
import {evaluateShowIf} from '../definitions/showIf';
import {hexToHs, hsToHex} from './color';

const SOURCE_LABEL: Record<LightingModel['source'], string> = {
  vial: 'from the keyboard (Vial)',
  bundled: 'bundled with this app',
  'via-hosted-v3': "VIA's library (v3)",
  'via-hosted-v2': "VIA's library (v2)",
  file: 'loaded from file',
  probe: 'none found — generic controls',
};

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

interface Session {
  client: ViaClient;
  channels: number[];
  vial?: {vialVersion: number; vialRgb: boolean};
  firmwareVersion?: number;
  model: LightingModel;
  /** Numeric values by value_key (colors store hue here for showIf). */
  values: Record<string, number>;
  colors: Record<string, [number, number]>;
  warnings: string[];
  /** What the keyboard had when connected, for Undo. */
  original: {values: Record<string, number>; colors: Record<string, [number, number]>};
}

export class App {
  private session?: Session;
  private status = el('p', {class: 'status'});
  private main = el('main');
  private log = el('pre', {class: 'log'});
  private logLines: string[] = [];
  private pending = new Map<string, number[]>();
  private inFlight = new Set<string>();

  constructor(private root: HTMLElement) {}

  start() {
    this.root.append(
      el('header', {}, el('h1', {}, 'Keyboard Lighting'), this.status),
      this.main,
      el('details', {class: 'log-panel'}, el('summary', {}, 'Raw HID log'), this.log),
    );
    this.renderDisconnected();
  }

  private setStatus(text: string, kind: 'info' | 'error' = 'info') {
    this.status.textContent = text;
    this.status.dataset.kind = kind;
  }

  private appendLog(e: LogEntry) {
    const arrow = e.direction === 'out' ? '→' : '←';
    const bytes = hex(e.bytes).replace(/( 00)+$/, ' …');
    this.logLines.push(`${arrow} ${bytes}${e.note ? `   (${e.note})` : ''}`);
    if (this.logLines.length > 300) this.logLines.shift();
    this.log.textContent = this.logLines.join('\n');
  }

  private renderDisconnected() {
    this.main.replaceChildren();
    if (!isWebHidAvailable()) {
      this.setStatus('This browser has no WebHID. Use Chrome or Edge on desktop.', 'error');
      return;
    }
    this.setStatus('Plug your keyboard in with a USB cable, then connect.');
    const button = el('button', {class: 'primary', textContent: 'Connect keyboard'});
    button.addEventListener('click', () => this.connect());
    this.main.append(
      el('section', {class: 'card center'}, button,
        el('p', {class: 'hint'}, 'Works with keyboards running QMK with VIA or Vial enabled.')),
    );
  }

  private async connect() {
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
      this.setStatus(`Couldn't connect: ${(e as Error).message}`, 'error');
    }
  }

  private async setUp(client: ViaClient) {
    client.onLog((e) => this.appendLog(e));
    const t = client.transport;
    this.setStatus(`Talking to ${t.productName}…`);

    await client.handshake();
    const vial = await client.detectVial().catch(() => undefined);
    const firmwareVersion = await client.getFirmwareVersion().catch(() => undefined);
    const channels = await client.probeLightingChannels();

    this.setStatus('Looking for a keyboard definition…');
    const resolved = await resolveDefinition(t.vendorId, t.productId, {
      baseUrl: import.meta.env.BASE_URL,
    });
    const base = resolved
      ? fromDefinition(resolved.definition, resolved.source)
      : fromProbe(channels, t.productName);

    this.session = {
      client, channels, vial, firmwareVersion,
      model: base, values: {}, colors: {}, warnings: [], original: {values: {}, colors: {}},
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
    if (!Object.keys(s.original.values).length) {
      s.original = {values: {...s.values}, colors: {...s.colors}};
    }
    if (s.client.format === 'legacy') s.model = fitLegacySpeedRange(s.model, s.values);
    this.render();
    this.setStatus(`Connected to ${s.model.name}.`);
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

  private render() {
    const s = this.session!;
    const t = s.client.transport;
    const firmware = s.vial
      ? `Vial (VIA protocol ${s.client.protocolVersion}${s.vial.vialRgb ? ', VialRGB' : ''})`
      : `VIA protocol ${s.client.protocolVersion} (${s.client.format} format)`;

    const identify = el('button', {textContent: 'Identify'});
    identify.addEventListener('click', async () => {
      identify.disabled = true;
      const ok = await s.client.identify().catch(() => false);
      identify.disabled = false;
      if (!ok) this.setStatus("This keyboard doesn't support Identify.", 'error');
    });

    const fileInput = el('input', {type: 'file', accept: '.json,application/json', hidden: true});
    fileInput.addEventListener('change', () => this.loadFile(fileInput.files?.[0]));
    const loadButton = el('button', {textContent: 'Load definition file…'});
    loadButton.addEventListener('click', () => fileInput.click());

    const info = el('section', {class: 'card'},
      el('h2', {}, s.model.name),
      el('dl', {},
        el('dt', {}, 'Device'), el('dd', {}, `${t.productName} · ${vid(t.vendorId)}:${vid(t.productId)} (VPID ${vendorProductId(t.vendorId, t.productId)})`),
        el('dt', {}, 'Firmware'), el('dd', {}, firmware),
        el('dt', {}, 'Lighting channels'), el('dd', {}, s.channels.length
          ? s.channels.map((ch) => channelName(ch, s.client.format === 'legacy')).join(', ')
          : 'none'),
        el('dt', {}, 'Definition'), el('dd', {}, SOURCE_LABEL[s.model.source]),
      ),
      el('div', {class: 'row'}, identify, loadButton, fileInput),
    );

    const notices = [...s.warnings];
    if (s.model.genericNames) {
      notices.push("Effect names are VIA's generic list and may not match this keyboard. Load the maker's definition file for accurate names.");
    }

    const zones = s.model.zones.map((z) =>
      el('section', {class: 'card zone'}, el('h3', {}, z.label), ...z.controls.map((c) => this.renderControl(c))),
    );

    const save = el('button', {class: 'primary', textContent: 'Save to keyboard'});
    save.addEventListener('click', () => this.save(save));
    const undo = el('button', {textContent: 'Undo changes'});
    undo.addEventListener('click', () => this.undo(undo));

    this.main.replaceChildren(
      info,
      ...notices.map((n) => el('p', {class: 'notice'}, n)),
      ...zones,
      ...(zones.length ? [el('div', {class: 'row end'},
        el('span', {class: 'hint'},
          "Changes apply instantly and aren't saved until you click Save. But pressing the keyboard's own lighting keys saves everything, including these changes."),
        undo, save)] : []),
    );
    this.updateVisibility();
  }

  private renderControl(c: Control): HTMLElement {
    const s = this.session!;
    const wrap = el('label', {class: 'control'});
    wrap.dataset.key = c.key;
    const name = el('span', {class: 'label'}, c.label);
    const value = el('span', {class: 'value'});

    let input: HTMLInputElement | HTMLSelectElement;
    if (c.type === 'dropdown') {
      const select = el('select');
      const current = s.values[c.key] ?? 0;
      const options = c.options.some((o) => o.value === current)
        ? c.options
        : [...c.options, {label: `Unknown (${current})`, value: current}];
      select.append(...options.map((o) => el('option', {value: String(o.value), textContent: o.label})));
      select.value = String(current);
      select.addEventListener('change', () => this.change(c, Number(select.value)));
      input = select;
    } else if (c.type === 'color') {
      const [h, sat] = s.colors[c.key] ?? [0, 255];
      const picker = el('input', {type: 'color', value: hsToHex(h, sat)});
      value.textContent = `H ${h} · S ${sat}`;
      picker.addEventListener('input', () => {
        const [nh, ns] = hexToHs(picker.value);
        value.textContent = `H ${nh} · S ${ns}`;
        s.colors[c.key] = [nh, ns];
        this.change(c, nh, [nh, ns]);
      });
      input = picker;
    } else if (c.type === 'toggle') {
      const box = el('input', {type: 'checkbox', checked: (s.values[c.key] ?? c.min) === c.max});
      box.addEventListener('change', () => this.change(c, box.checked ? c.max : c.min));
      input = box;
    } else {
      const range = el('input', {
        type: 'range', min: String(c.min), max: String(c.max),
        value: String(s.values[c.key] ?? c.min),
      });
      const show = () => {
        const v = Number(range.value);
        value.textContent = c.max === 255 ? `${Math.round((v / 255) * 100)}%` : String(v);
      };
      show();
      range.addEventListener('input', () => {
        show();
        this.change(c, Number(range.value));
      });
      input = range;
    }
    wrap.append(el('span', {class: 'head'}, name, value), input);
    return wrap;
  }

  private updateVisibility() {
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
      }
    }
  }

  /** Live apply: always send the latest value, never more than one in flight per control. */
  private change(c: Control, numeric: number, color?: [number, number]) {
    const s = this.session!;
    s.values[c.key] = numeric;
    this.updateVisibility();
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

  /** Sends back every value the keyboard had when the app connected. */
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
      this.render();
      this.setStatus('Restored the settings the keyboard had when you connected.');
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
      this.setStatus('Saved to the keyboard.');
    } catch (e) {
      this.setStatus(`Save failed: ${(e as Error).message}`, 'error');
    } finally {
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
