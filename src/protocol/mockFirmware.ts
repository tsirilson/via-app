// A fake keyboard that answers like QMK's via.c. Used by the unit tests and by
// the ?mock demo mode, so the app can be tried without hardware.

import {pad, type Transport} from './transport';

export interface MockOptions {
  protocolVersion: number;
  /** Channels that exist (channel format), or [1]/[2] for legacy backlight/RGB. */
  channels: number[];
  vial?: boolean;
  vendorId?: number;
  productId?: number;
  productName?: string;
}

export class MockFirmware implements Transport {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly sent: number[][] = [];
  values = new Map<string, number[]>();
  saved: number[][] = [];
  private listener?: (r: Uint8Array) => void;

  constructor(private opts: MockOptions) {
    this.vendorId = opts.vendorId ?? 0x3434;
    this.productId = opts.productId ?? 0x0280;
    this.productName = opts.productName ?? 'Mock Keyboard';
  }

  onReport(listener: (r: Uint8Array) => void) {
    this.listener = listener;
  }
  onDisconnect() {}
  async close() {}

  async send(payload: ArrayLike<number>) {
    const data = Array.from(pad(payload));
    this.sent.push(data);
    const reply = this.handle(data);
    queueMicrotask(() => this.listener?.(pad(reply)));
  }

  private legacy() {
    return this.opts.protocolVersion <= 10;
  }

  private handle(d: number[]): number[] {
    const out = [...d];
    const unhandled = () => {
      out[0] = 0xff;
      return out;
    };
    switch (d[0]) {
      case 0x01:
        out[1] = this.opts.protocolVersion >> 8;
        out[2] = this.opts.protocolVersion & 0xff;
        return out;
      case 0xfe:
        if (!this.opts.vial) return unhandled();
        return [6, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 1];
      case 0x02:
        if (d[1] === 0x04) {
          out.splice(2, 4, 0, 0, 0, 1);
          return out;
        }
        return unhandled();
      case 0x07:
      case 0x08:
      case 0x09:
        return this.legacy() ? this.handleLegacy(d, out) : this.handleChannel(d, out);
      default:
        return unhandled();
    }
  }

  private handleChannel(d: number[], out: number[]): number[] {
    const [cmd, channel, valueId] = d;
    if (!this.opts.channels.includes(channel)) {
      out[0] = 0xff;
      return out;
    }
    if (cmd === 0x09) {
      this.saved.push([channel]);
      return out;
    }
    const key = `${channel}:${valueId}`;
    if (cmd === 0x07) {
      this.values.set(key, d.slice(3, 5));
    } else {
      const v = this.values.get(key) ?? [0, 0];
      out[3] = v[0];
      out[4] = v[1];
    }
    return out;
  }

  private handleLegacy(d: number[], out: number[]): number[] {
    const [cmd, id] = d;
    if (cmd === 0x09) {
      this.saved.push([]);
      return out;
    }
    // Like real legacy firmware: 0xFF only if there's no lighting handler at
    // all; ids the handler doesn't know are echoed back unchanged.
    if (this.opts.channels.length === 0) {
      out[0] = 0xff;
      return out;
    }
    const isRgb = id >= 0x80 && id <= 0x83;
    const isBacklight = id === 0x09 || id === 0x0a;
    if ((isRgb && !this.opts.channels.includes(2)) || (isBacklight && !this.opts.channels.includes(1))) {
      return out;
    }
    const key = `legacy:${id}`;
    if (cmd === 0x07) {
      this.values.set(key, d.slice(2, 4));
    } else {
      const v = this.values.get(key) ?? [0, 0];
      out[2] = v[0];
      out[3] = v[1];
    }
    return out;
  }
}
