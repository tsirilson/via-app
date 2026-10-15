import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {
  adaptToFirmware,
  fitLegacySpeedRange,
  fromDefinition,
  fromProbe,
  prettyEffectName,
} from '../src/definitions/normalize';
import {resolveDefinition, vendorProductId} from '../src/definitions/resolve';
import {evaluateShowIf} from '../src/definitions/showIf';
import {hexToHs, hsToHex} from '../src/ui/color';

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const k8v3 = read('../public/definitions/34340280.json');
const k8v2 = read('../reference/k8_pro_ansi_rgb.json');

describe('showIf', () => {
  const k8Color =
    '{id_qmk_rgb_matrix_effect} != 0 && ( {id_qmk_rgb_matrix_effect} < 4 || {id_qmk_rgb_matrix_effect} == 18 || ({id_qmk_rgb_matrix_effect} > 17 && {id_qmk_rgb_matrix_effect} != 21) ) ';
  it("matches Keychron's color rule: effects 1,2,3,18,19,20,22", () => {
    const shown = Array.from({length: 23}, (_, i) => i).filter((i) =>
      evaluateShowIf(k8Color, {id_qmk_rgb_matrix_effect: i}),
    );
    expect(shown).toEqual([1, 2, 3, 18, 19, 20, 22]);
  });
  it('handles !, missing keys and hex', () => {
    expect(evaluateShowIf('!{a}', {})).toBe(true);
    expect(evaluateShowIf('{a} == 0x10', {a: 16})).toBe(true);
    expect(() => evaluateShowIf('{a} = 1', {})).toThrow();
  });
});

describe('K8 Pro definitions', () => {
  it('v3: one zone on channel 3 with 23 named effects', () => {
    const m = fromDefinition(k8v3, 'bundled');
    expect(m.name).toBe('Keychron K8 Pro');
    expect(m.zones).toHaveLength(1);
    const [brightness, effect, speed, color] = m.zones[0].controls;
    expect(brightness.ref).toEqual({channel: 3, valueId: 1});
    expect(effect.options).toHaveLength(23);
    expect(effect.options[16]).toEqual({label: 'Typing Heatmap', value: 16});
    expect(speed.showIf).toContain('> 1');
    expect(color.type).toBe('color');
    expect(m.genericNames).toBe(false);
  });

  it('v2 says RGBLight (channel 2); adapting to the real firmware moves it to channel 3', () => {
    const m = fromDefinition(k8v2, 'via-hosted-v2');
    expect(m.zones[0].controls.every((c) => c.ref.channel === 2)).toBe(true);
    const effect = m.zones[0].controls.find((c) => c.type === 'dropdown')!;
    expect(effect.options[16].label).toBe('Typing Heatmap');
    const adapted = adaptToFirmware(m, 'channel', [3]);
    expect(adapted.zones[0].controls.every((c) => c.ref.channel === 3)).toBe(true);
    const color = adapted.zones[0].controls.find((c) => c.type === 'color')!;
    expect(evaluateShowIf(color.showIf!, {[effect.key]: 4})).toBe(false); // Cycle All
    expect(evaluateShowIf(color.showIf!, {[effect.key]: 2})).toBe(true); // Breathing
  });

  it('legacy firmware clamps RGB speed to 0-3', () => {
    const m = adaptToFirmware(fromDefinition(k8v3, 'bundled'), 'legacy', [2]);
    const speed = m.zones[0].controls.find((c) => c.label === 'Effect Speed')!;
    expect(speed.ref.channel).toBe(2);
    expect(speed.max).toBe(3);
  });
});

describe('legacy speed range', () => {
  const legacy = () => adaptToFirmware(fromDefinition(k8v3, 'bundled'), 'legacy', [2]);
  const speedOf = (m: ReturnType<typeof legacy>) => m.zones[0].controls.find((c) => c.label === 'Effect Speed')!;
  it('widens to 0-255 when the keyboard reports a raw speed (K8 Pro factory: 127)', () => {
    const m = legacy();
    expect(speedOf(fitLegacySpeedRange(m, {[speedOf(m).key]: 127})).max).toBe(255);
  });
  it('keeps 0-3 when the keyboard reports a preset', () => {
    const m = legacy();
    expect(speedOf(fitLegacySpeedRange(m, {[speedOf(m).key]: 2})).max).toBe(3);
  });
});

describe('no definition', () => {
  it('builds generic zones from probed channels', () => {
    const m = fromProbe([1, 3], 'Some board');
    expect(m.zones.map((z) => z.label)).toEqual(['Backlight (single color)', 'Backlight (per-key RGB)']);
    expect(m.genericNames).toBe(true);
    expect(m.zones[1].controls[0].ref).toEqual({channel: 3, valueId: 1});
  });
});

describe('resolveDefinition', () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});
  const html = () => new Response('<!doctype html>', {headers: {'content-type': 'text/html'}});

  it('prefers the bundled definition', async () => {
    const urls: string[] = [];
    const fetcher = async (url: string) => {
      urls.push(url);
      if (url === '/definitions/bundled.json') {
        return json({definitions: {[vendorProductId(0x3434, 0x0280)]: {file: 'k8.json'}}});
      }
      if (url === '/definitions/k8.json') return json(k8v3);
      return html();
    };
    const r = await resolveDefinition(0x3434, 0x0280, {fetcher});
    expect(r?.source).toBe('bundled');
    expect(urls.some((u) => u.includes('usevia.app'))).toBe(false);
  });

  it("falls back to VIA's hosted v2 when only v2 exists", async () => {
    const vpid = vendorProductId(0x1234, 0x5678);
    const fetcher = async (url: string) => {
      if (url.endsWith('supported_kbs.json')) return json({vendorProductIds: {v2: [vpid], v3: []}});
      if (url.endsWith(`/v2/${vpid}.json`)) return json(k8v2);
      return html();
    };
    const r = await resolveDefinition(0x1234, 0x5678, {fetcher});
    expect(r?.source).toBe('via-hosted-v2');
  });

  it('returns undefined when nothing is found', async () => {
    const r = await resolveDefinition(1, 2, {fetcher: async () => html()});
    expect(r).toBeUndefined();
  });
});

describe('helpers', () => {
  it('prettifies effect names', () => {
    expect(prettyEffectName('RAINBOW_MOVING_CHEVRON')).toBe('Rainbow Moving Chevron');
    expect(prettyEffectName('Solid Color')).toBe('Solid Color');
  });
  it('round-trips color', () => {
    expect(hsToHex(0, 255)).toBe('#ff0000');
    expect(hexToHs('#ff0000')).toEqual([0, 255]);
    const [h, s] = hexToHs(hsToHex(85, 200));
    expect(Math.abs(h - 85)).toBeLessThanOrEqual(1);
    expect(Math.abs(s - 200)).toBeLessThanOrEqual(1);
  });
});
