// Pure functions that build and parse VIA lighting messages. No I/O here, so
// every byte can be unit-tested.

export const CMD = {
  getProtocolVersion: 0x01,
  getKeyboardValue: 0x02,
  setKeyboardValue: 0x03,
  setValue: 0x07,
  getValue: 0x08,
  save: 0x09,
  vialPrefix: 0xfe,
  unhandled: 0xff,
} as const;

export const KEYBOARD_VALUE = {
  firmwareVersion: 0x04,
  deviceIndication: 0x05,
} as const;

export const CHANNEL = {
  custom: 0,
  backlight: 1,
  rgblight: 2,
  rgbMatrix: 3,
  audio: 4,
  ledMatrix: 5,
} as const;

/** VIA protocol 11+ uses channels; 10 and below use the legacy layout. */
export const CHANNEL_FORMAT_MIN_VERSION = 11;

export type Format = 'channel' | 'legacy';

/** Where a value lives, in channel terms (as written in v3 definitions). */
export interface ValueRef {
  channel: number;
  valueId: number;
  /** Extra fixed arguments after the value id (VIA "extended command arguments"). */
  args?: number[];
}

export function formatForVersion(protocolVersion: number): Format {
  return protocolVersion >= CHANNEL_FORMAT_MIN_VERSION ? 'channel' : 'legacy';
}

/**
 * Legacy firmware (protocol <= 10) has no channel byte. Backlight uses
 * 0x09/0x0A and RGB (RGBLight or RGB Matrix) uses 0x80-0x83.
 * Returns undefined if the value has no legacy equivalent.
 */
export function legacyValueId(ref: ValueRef): number | undefined {
  if (ref.channel === CHANNEL.backlight) {
    if (ref.valueId === 1) return 0x09;
    if (ref.valueId === 2) return 0x0a;
    return undefined;
  }
  if (ref.channel === CHANNEL.rgblight || ref.channel === CHANNEL.rgbMatrix) {
    if (ref.valueId >= 1 && ref.valueId <= 4) return 0x80 + ref.valueId - 1;
  }
  return undefined;
}

function header(format: Format, command: number, ref: ValueRef): number[] {
  if (format === 'channel') return [command, ref.channel, ref.valueId, ...(ref.args ?? [])];
  const id = legacyValueId(ref);
  if (id === undefined) {
    throw new Error(
      `Channel ${ref.channel} value ${ref.valueId} isn't available on legacy (protocol <= 10) firmware`,
    );
  }
  return [command, id];
}

export function encodeSet(format: Format, ref: ValueRef, data: number[]): number[] {
  return [...header(format, CMD.setValue, ref), ...data];
}

export function encodeGet(format: Format, ref: ValueRef): number[] {
  return header(format, CMD.getValue, ref);
}

export function encodeSave(format: Format, channel: number): number[] {
  return format === 'channel' ? [CMD.save, channel] : [CMD.save];
}

export class UnhandledError extends Error {
  constructor(public readonly request: number[]) {
    super(`Keyboard didn't handle ${hex(request.slice(0, 3))}`);
  }
}

/** Extracts the data bytes from a get reply, validating the echo. */
export function parseGet(
  format: Format,
  ref: ValueRef,
  reply: Uint8Array,
  length: number,
): number[] {
  const request = encodeGet(format, ref);
  if (reply[0] === CMD.unhandled) throw new UnhandledError(request);
  for (let i = 0; i < request.length; i++) {
    if (reply[i] !== request[i]) {
      throw new Error(`Unexpected reply ${hex(reply.slice(0, 6))} to ${hex(request)}`);
    }
  }
  return Array.from(reply.slice(request.length, request.length + length));
}

export function parseProtocolVersion(reply: Uint8Array): number {
  if (reply[0] !== CMD.getProtocolVersion) {
    throw new Error(`Unexpected protocol version reply ${hex(reply.slice(0, 4))}`);
  }
  return (reply[1] << 8) | reply[2];
}

/** Values above 255 are sent as two bytes, high byte first. */
export function encodeNumber(value: number, max: number): number[] {
  const v = Math.max(0, Math.round(value));
  return max > 255 ? [(v >> 8) & 0xff, v & 0xff] : [v & 0xff];
}

export function decodeNumber(bytes: number[], max: number): number {
  return max > 255 ? (bytes[0] << 8) | bytes[1] : bytes[0];
}

export function hex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}
