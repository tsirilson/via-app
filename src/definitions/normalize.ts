// Turns VIA definition files (v3 `menus`, v2 `lighting`) or a bare channel
// probe into the app's LightingModel. Definitions are untrusted JSON, so
// everything is read defensively and unknown items are skipped.

import {commonMenus} from '@the-via/reader/dist/common-menus/index.js';
import {CHANNEL, type Format} from '../protocol/encoding';
import type {Control, ControlType, DefinitionSource, LightingModel, Zone} from './model';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const SUPPORTED: ControlType[] = ['range', 'dropdown', 'color', 'toggle'];

function combineShowIf(a?: string, b?: string): string | undefined {
  if (a && b) return `(${a}) && (${b})`;
  return a ?? b;
}

function parseControl(node: Json, showIf: string | undefined): Control | undefined {
  const type = node.type as ControlType;
  if (!SUPPORTED.includes(type)) return undefined;
  const [key, channel, valueId, ...args] = node.content as [string, number, number, ...number[]];
  if (typeof key !== 'string' || typeof channel !== 'number' || typeof valueId !== 'number') {
    return undefined;
  }
  if (channel === CHANNEL.audio) return undefined; // not lighting
  const control: Control = {
    key,
    label: String(node.label ?? key),
    type,
    ref: {channel, valueId, ...(args.length ? {args: args.filter((a) => typeof a === 'number')} : {})},
    min: 0,
    max: 255,
    options: [],
    showIf: combineShowIf(showIf, typeof node.showIf === 'string' ? node.showIf : undefined),
  };
  if (type === 'range' && Array.isArray(node.options)) {
    [control.min, control.max] = node.options;
  } else if (type === 'toggle') {
    [control.min, control.max] = Array.isArray(node.options) ? node.options : [0, 1];
  } else if (type === 'dropdown' && Array.isArray(node.options)) {
    control.options = node.options.map((o: Json, i: number) =>
      Array.isArray(o) ? {label: String(o[0]), value: Number(o[1])} : {label: String(o), value: i},
    );
    control.max = Math.max(0, ...control.options.map((o) => o.value));
  }
  return control;
}

function walk(node: Json, path: string[], showIf: string | undefined, zones: Map<string, Zone>) {
  if (!node || typeof node !== 'object') return;
  const content = node.content;
  if (typeof node.type === 'string' && Array.isArray(content) && typeof content[0] === 'string') {
    const control = parseControl(node, showIf);
    if (!control) return;
    const label = path.filter((p) => p !== 'Lighting').join(' › ') || 'Lighting';
    // Keyed by channel too: VIA labels both single-color backlight and per-key
    // RGB "Backlight", and they must stay separate panels.
    const zoneKey = `${label}|${control.ref.channel}`;
    if (!zones.has(zoneKey)) zones.set(zoneKey, {label, controls: []});
    zones.get(zoneKey)!.controls.push(control);
    return;
  }
  if (Array.isArray(content)) {
    const nextPath = typeof node.label === 'string' ? [...path, node.label] : path;
    const nextShowIf = combineShowIf(showIf, typeof node.showIf === 'string' ? node.showIf : undefined);
    for (const child of content) walk(child, nextPath, nextShowIf, zones);
  }
}

function builtInMenu(name: string): Json[] {
  return (commonMenus as Record<string, Json[]>)[name] ?? [];
}

export function fromV3(def: Json, source: DefinitionSource): LightingModel {
  const zones = new Map<string, Zone>();
  for (const menu of Array.isArray(def.menus) ? def.menus : []) {
    const menus = typeof menu === 'string' ? builtInMenu(menu) : [menu];
    for (const m of menus) walk(m, [], undefined, zones);
  }
  return {name: definitionName(def), source, zones: finishZones(zones), genericNames: false};
}

/**
 * v2 definitions declare lighting by name (`"qmk_rgblight"`) or as
 * `{extends, underglowEffects}`. We start from VIA's built-in template and
 * swap in the board's own effect list when it has one.
 */
export function fromV2(def: Json, source: DefinitionSource): LightingModel {
  const lighting = def.lighting;
  const base: string | undefined = typeof lighting === 'string' ? lighting : lighting?.extends;
  const zones = new Map<string, Zone>();
  for (const m of builtInMenu(base ?? '')) walk(m, [], undefined, zones);

  const effects: Json[] | undefined = lighting?.underglowEffects;
  let genericNames = true;
  if (Array.isArray(effects) && effects.length) {
    genericNames = false;
    for (const zone of zones.values()) {
      for (const c of zone.controls) {
        if (c.type === 'dropdown' && c.ref.channel === CHANNEL.rgblight && c.ref.valueId === 2) {
          c.options = effects.map((e, i) => ({label: prettyEffectName(String(e[0])), value: i}));
          c.max = effects.length - 1;
          // The number after each name is how many colors the effect uses.
          const usesColor = effects.map((e, i) => (Number(e[1]) > 0 ? i : -1)).filter((i) => i > 0);
          const colorControl = zone.controls.find(
            (x) => x.type === 'color' && x.ref.channel === CHANNEL.rgblight,
          );
          if (colorControl) {
            colorControl.showIf = usesColor.length
              ? usesColor.map((i) => `{${c.key}} == ${i}`).join(' || ')
              : '0';
          }
        }
      }
    }
  }
  return {name: definitionName(def), source, zones: finishZones(zones), genericNames};
}

export function fromDefinition(def: Json, source: DefinitionSource): LightingModel {
  return Array.isArray(def?.menus) ? fromV3(def, source) : fromV2(def, source);
}

/** No definition: build generic controls for each channel the firmware answered on. */
export function fromProbe(channels: number[], name: string): LightingModel {
  const zones = new Map<string, Zone>();
  const templates: Record<number, string> = {
    [CHANNEL.backlight]: 'qmk_backlight',
    [CHANNEL.rgblight]: 'qmk_rgblight',
    [CHANNEL.rgbMatrix]: 'qmk_rgb_matrix',
  };
  for (const ch of channels) {
    if (templates[ch]) {
      for (const m of builtInMenu(templates[ch])) walk(m, [], undefined, zones);
    } else if (ch === CHANNEL.ledMatrix) {
      const key = 'id_qmk_led_matrix';
      zones.set('LED Matrix', {
        label: 'LED Matrix',
        controls: [
          {key: `${key}_brightness`, label: 'Brightness', type: 'range', ref: {channel: ch, valueId: 1}, min: 0, max: 255, options: []},
          {
            key: `${key}_effect`, label: 'Effect', type: 'dropdown', ref: {channel: ch, valueId: 2}, min: 0, max: 31,
            options: Array.from({length: 32}, (_, i) => ({label: i === 0 ? 'Off' : `Effect ${i}`, value: i})),
          },
          {key: `${key}_effect_speed`, label: 'Effect Speed', type: 'range', ref: {channel: ch, valueId: 3}, min: 0, max: 255, options: [], showIf: `{${key}_effect} != 0`},
        ],
      });
    }
  }
  return {name, source: 'probe', zones: finishZones(zones), genericNames: true};
}

/**
 * Adjusts a model to what the connected firmware actually does:
 * - v2 definitions often say RGBLight (channel 2) for per-key RGB boards that
 *   really answer on RGB Matrix (channel 3), e.g. the Keychron K8 Pro.
 * - Legacy firmware speed is four presets (0-3) on RGB Matrix boards.
 */
export function adaptToFirmware(
  model: LightingModel,
  format: Format,
  available: number[],
): LightingModel {
  const remap = new Map<number, number>();
  if (format === 'legacy') {
    // Legacy firmware has one RGB system on 0x80-0x83, probed as channel 2.
    remap.set(CHANNEL.rgbMatrix, CHANNEL.rgblight);
  } else {
    for (const [from, to] of [
      [CHANNEL.rgblight, CHANNEL.rgbMatrix],
      [CHANNEL.rgbMatrix, CHANNEL.rgblight],
    ]) {
      if (!available.includes(from) && available.includes(to)) remap.set(from, to);
    }
  }
  const zones = model.zones.map((z) => ({
    ...z,
    controls: z.controls.map((c) => {
      const channel = remap.get(c.ref.channel) ?? c.ref.channel;
      const next: Control = {...c, ref: {...c.ref, channel}};
      const isRgb = channel === CHANNEL.rgblight || channel === CHANNEL.rgbMatrix;
      if (format === 'legacy' && isRgb && c.ref.valueId === 3 && c.type === 'range') {
        next.min = 0;
        next.max = 3;
      }
      return next;
    }),
  }));
  return {...model, zones};
}

const CHANNEL_SUFFIX: Record<number, string> = {
  [CHANNEL.backlight]: 'single color',
  [CHANNEL.rgblight]: 'underglow',
  [CHANNEL.rgbMatrix]: 'per-key RGB',
  [CHANNEL.ledMatrix]: 'per-key LED',
};

/** Zones with the same label get the lighting type appended. */
function finishZones(zones: Map<string, Zone>): Zone[] {
  const list = [...zones.values()];
  const counts = new Map<string, number>();
  list.forEach((z) => counts.set(z.label, (counts.get(z.label) ?? 0) + 1));
  return list.map((z) => {
    if (counts.get(z.label)! < 2) return z;
    const suffix = CHANNEL_SUFFIX[z.controls[0].ref.channel] ?? `channel ${z.controls[0].ref.channel}`;
    return {...z, label: `${z.label} (${suffix})`};
  });
}

/**
 * Upstream legacy QMK reports RGB Matrix speed as 0-3, but some vendor builds
 * (the K8 Pro factory firmware, protocol 9) report the raw 0-255 value. If a
 * legacy speed reads above 3, widen that control back to 0-255.
 */
export function fitLegacySpeedRange(
  model: LightingModel,
  values: Record<string, number>,
): LightingModel {
  const zones = model.zones.map((z) => ({
    ...z,
    controls: z.controls.map((c) =>
      c.type === 'range' && c.ref.valueId === 3 && c.max === 3 && (values[c.key] ?? 0) > 3
        ? {...c, max: 255}
        : c,
    ),
  }));
  return {...model, zones};
}

function definitionName(def: Json): string {
  if (typeof def?.name === 'string') return def.name;
  if (Array.isArray(def?.name?.options)) return String(def.name.options[0]);
  return 'Unknown keyboard';
}

/** "RAINBOW_MOVING_CHEVRON" → "Rainbow Moving Chevron"; already-pretty names unchanged. */
export function prettyEffectName(name: string): string {
  if (name !== name.toUpperCase()) return name;
  return name
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
