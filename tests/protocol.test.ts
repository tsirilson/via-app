import {describe, expect, it} from 'vitest';
import {ViaClient} from '../src/protocol/client';
import {
  UnhandledError,
  decodeNumber,
  encodeGet,
  encodeNumber,
  encodeSave,
  encodeSet,
  formatForVersion,
  parseGet,
} from '../src/protocol/encoding';
import {MockFirmware} from '../src/protocol/mockFirmware';

const color = {channel: 3, valueId: 4};

describe('encoding', () => {
  it('picks the format by protocol version (cutoff 11)', () => {
    expect(formatForVersion(9)).toBe('legacy');
    expect(formatForVersion(10)).toBe('legacy');
    expect(formatForVersion(11)).toBe('channel');
    expect(formatForVersion(12)).toBe('channel');
    expect(formatForVersion(13)).toBe('channel');
  });

  it('builds the K8 Pro channel-format messages', () => {
    expect(encodeSet('channel', color, [0x00, 0xff])).toEqual([0x07, 0x03, 0x04, 0x00, 0xff]);
    expect(encodeSet('channel', {channel: 3, valueId: 1}, [200])).toEqual([0x07, 0x03, 0x01, 200]);
    expect(encodeGet('channel', {channel: 3, valueId: 1})).toEqual([0x08, 0x03, 0x01]);
    expect(encodeSave('channel', 3)).toEqual([0x09, 0x03]);
  });

  it('builds legacy messages (no channel byte)', () => {
    expect(encodeSet('legacy', color, [10, 20])).toEqual([0x07, 0x83, 10, 20]);
    expect(encodeSet('legacy', {channel: 2, valueId: 1}, [5])).toEqual([0x07, 0x80, 5]);
    expect(encodeSet('legacy', {channel: 1, valueId: 2}, [1])).toEqual([0x07, 0x0a, 1]);
    expect(encodeSave('legacy', 3)).toEqual([0x09]);
    expect(() => encodeSet('legacy', {channel: 5, valueId: 1}, [1])).toThrow();
  });

  it('adds extended arguments after the value id', () => {
    expect(encodeSet('channel', {channel: 0, valueId: 2, args: [7]}, [1])).toEqual([0x07, 0, 2, 7, 1]);
  });

  it('parses get replies and detects unhandled', () => {
    const reply = new Uint8Array(32);
    reply.set([0x08, 0x03, 0x01, 0x80]);
    expect(parseGet('channel', {channel: 3, valueId: 1}, reply, 1)).toEqual([0x80]);
    reply[0] = 0xff;
    expect(() => parseGet('channel', {channel: 3, valueId: 1}, reply, 1)).toThrow(UnhandledError);
  });

  it('uses two big-endian bytes above 255', () => {
    expect(encodeNumber(300, 1000)).toEqual([1, 44]);
    expect(decodeNumber([1, 44], 1000)).toBe(300);
    expect(encodeNumber(200, 255)).toEqual([200]);
  });
});

describe('ViaClient against a mock K8 Pro (protocol 12, RGB Matrix only)', () => {
  const k8 = () => new MockFirmware({protocolVersion: 0x000c, channels: [3]});

  it('handshakes, detects non-Vial, probes channel 3 only', async () => {
    const fw = k8();
    const client = new ViaClient(fw);
    expect(await client.handshake()).toBe(12);
    expect(client.format).toBe('channel');
    expect(await client.detectVial()).toBeUndefined();
    expect(await client.probeLightingChannels()).toEqual([3]);
  });

  it('sets, reads back and saves', async () => {
    const fw = k8();
    const client = new ViaClient(fw);
    await client.handshake();
    await client.setValue(color, [85, 255]);
    expect(await client.getValue(color, 2)).toEqual([85, 255]);
    await client.save(3);
    expect(fw.saved).toEqual([[3]]);
    expect(fw.sent.at(-1)!.slice(0, 2)).toEqual([0x09, 0x03]);
    expect(fw.sent.every((r) => r.length === 32)).toBe(true);
  });

  it('rejects channel 2 (RGBLight), which this board lacks', async () => {
    const client = new ViaClient(k8());
    await client.handshake();
    await expect(client.setValue({channel: 2, valueId: 1}, [10])).rejects.toThrow(UnhandledError);
  });
});

describe('ViaClient against legacy and Vial firmware', () => {
  it('uses legacy ids on protocol 10', async () => {
    const fw = new MockFirmware({protocolVersion: 10, channels: [2]});
    const client = new ViaClient(fw);
    await client.handshake();
    expect(client.format).toBe('legacy');
    expect(await client.probeLightingChannels()).toEqual([2]);
    await client.setValue({channel: 2, valueId: 2}, [4]);
    expect(fw.sent.at(-1)!.slice(0, 3)).toEqual([0x07, 0x81, 4]);
  });

  it('ignores the echoed backlight id on a protocol 9 K8 Pro', async () => {
    const fw = new MockFirmware({protocolVersion: 9, channels: [2]});
    const client = new ViaClient(fw);
    await client.handshake();
    expect(await client.probeLightingChannels()).toEqual([2]);
  });

  it('reports no lighting when legacy firmware replies 0xFF', async () => {
    const client = new ViaClient(new MockFirmware({protocolVersion: 9, channels: []}));
    await client.handshake();
    expect(await client.probeLightingChannels()).toEqual([]);
  });

  it('detects Vial with VialRGB', async () => {
    const client = new ViaClient(new MockFirmware({protocolVersion: 9, channels: [2], vial: true}));
    expect(await client.detectVial()).toEqual({vialVersion: 6, vialRgb: true});
  });
});
