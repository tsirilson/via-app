import {
  CHANNEL,
  CMD,
  KEYBOARD_VALUE,
  UnhandledError,
  encodeGet,
  encodeSave,
  encodeSet,
  formatForVersion,
  hex,
  parseGet,
  parseProtocolVersion,
  type Format,
  type ValueRef,
} from './encoding';
import {pad, type Transport} from './transport';

export type LogEntry = {direction: 'out' | 'in'; bytes: Uint8Array; note?: string};

const TIMEOUT_MS = 1000;

/**
 * Talks VIA to one keyboard. Requests are strictly one at a time: send a
 * report, wait for the next report back (the firmware always replies).
 */
export class ViaClient {
  private chain: Promise<unknown> = Promise.resolve();
  private waiter?: (report: Uint8Array) => void;
  private logListeners: ((e: LogEntry) => void)[] = [];

  protocolVersion = 0;
  format: Format = 'channel';

  constructor(readonly transport: Transport) {
    transport.onReport((report) => {
      this.emit({direction: 'in', bytes: report});
      const w = this.waiter;
      this.waiter = undefined;
      w?.(report);
    });
  }

  onLog(listener: (e: LogEntry) => void) {
    this.logListeners.push(listener);
  }

  private emit(e: LogEntry) {
    this.logListeners.forEach((l) => l(e));
  }

  /** Sends one message and resolves with the keyboard's reply. */
  request(payload: number[], note?: string): Promise<Uint8Array> {
    const run = () =>
      new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiter = undefined;
          reject(new Error(`No reply to ${hex(payload.slice(0, 4))} within ${TIMEOUT_MS} ms`));
        }, TIMEOUT_MS);
        this.waiter = (report) => {
          clearTimeout(timer);
          resolve(report);
        };
        const bytes = pad(payload);
        this.emit({direction: 'out', bytes, note});
        this.transport.send(bytes).catch((err) => {
          clearTimeout(timer);
          this.waiter = undefined;
          reject(err);
        });
      });
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /** First message on connect. Also picks channel vs legacy format. */
  async handshake(): Promise<number> {
    const reply = await this.request([CMD.getProtocolVersion], 'get protocol version');
    this.protocolVersion = parseProtocolVersion(reply);
    this.format = formatForVersion(this.protocolVersion);
    return this.protocolVersion;
  }

  /** Vial boards answer FE 00 with their own protocol version; others reply FF. */
  async detectVial(): Promise<{vialVersion: number; vialRgb: boolean} | undefined> {
    const reply = await this.request([CMD.vialPrefix, 0x00], 'Vial: get keyboard id');
    if (reply[0] === CMD.unhandled || reply[0] === CMD.vialPrefix) return undefined;
    const vialVersion = reply[0] | (reply[1] << 8) | (reply[2] << 16) | (reply[3] << 24);
    return {vialVersion, vialRgb: reply[12] === 1};
  }

  async getFirmwareVersion(): Promise<number | undefined> {
    const reply = await this.request(
      [CMD.getKeyboardValue, KEYBOARD_VALUE.firmwareVersion],
      'get firmware version',
    );
    if (reply[0] !== CMD.getKeyboardValue) return undefined;
    return ((reply[2] << 24) | (reply[3] << 16) | (reply[4] << 8) | reply[5]) >>> 0;
  }

  /**
   * Makes the keyboard flash so the user can tell which one is selected.
   * Firmware toggles the lights on each call, so it's sent an even number of
   * times to end in the original state (as QMK's via.c comment describes).
   */
  async identify(): Promise<boolean> {
    for (let i = 0; i < 6; i++) {
      const reply = await this.request(
        [CMD.setKeyboardValue, KEYBOARD_VALUE.deviceIndication, i],
        'identify (device indication)',
      );
      if (reply[0] !== CMD.setKeyboardValue) return false;
      await new Promise((r) => setTimeout(r, 200));
    }
    return true;
  }

  async getValue(ref: ValueRef, length: number): Promise<number[]> {
    const reply = await this.request(encodeGet(this.format, ref), 'get');
    return parseGet(this.format, ref, reply, length);
  }

  async setValue(ref: ValueRef, data: number[]): Promise<void> {
    const request = encodeSet(this.format, ref, data);
    const reply = await this.request(request, 'set');
    if (reply[0] === CMD.unhandled) throw new UnhandledError(request);
  }

  async save(channel: number): Promise<void> {
    const request = encodeSave(this.format, channel);
    const reply = await this.request(request, 'save');
    if (reply[0] === CMD.unhandled) throw new UnhandledError(request);
  }

  /** True if the firmware answers "get brightness" on this channel. */
  async hasChannel(channel: number): Promise<boolean> {
    try {
      await this.getValue({channel, valueId: 1}, 1);
      return true;
    } catch (e) {
      if (e instanceof UnhandledError) return false;
      throw e;
    }
  }

  /** Lighting channels the firmware actually responds to. */
  async probeLightingChannels(): Promise<number[]> {
    if (this.format === 'legacy') {
      // Legacy firmware only replies 0xFF when it has no lighting handler at
      // all. Otherwise it echoes ids it doesn't know (seen on a real K8 Pro,
      // protocol 9: "08 09" → "08 09"), so backlight vs RGB can't be told
      // apart by probing. Report the RGB ids (shown as channel 2) and let the
      // definition decide the rest.
      return (await this.hasChannel(CHANNEL.rgblight)) ? [CHANNEL.rgblight] : [];
    }
    const found: number[] = [];
    for (const ch of [CHANNEL.backlight, CHANNEL.rgblight, CHANNEL.rgbMatrix, CHANNEL.ledMatrix]) {
      if (await this.hasChannel(ch)) found.push(ch);
    }
    return found;
  }
}
