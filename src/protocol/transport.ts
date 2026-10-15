// A transport moves fixed 32-byte reports to and from the keyboard's raw-HID
// interface. The rest of the app only sees this interface, so the same code
// runs in Chrome (WebHID), Electron (WebHID) and unit tests (mock).

export const REPORT_SIZE = 32;

/** VIA / Vial raw-HID interface, identical on every board. */
export const VIA_USAGE_PAGE = 0xff60;
export const VIA_USAGE = 0x61;

export interface Transport {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  /** Send one 32-byte report. Shorter payloads are zero-padded. */
  send(payload: ArrayLike<number>): Promise<void>;
  /** Called for every 32-byte report the keyboard sends back. */
  onReport(listener: (report: Uint8Array) => void): void;
  onDisconnect(listener: () => void): void;
  close(): Promise<void>;
}

export function pad(payload: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  if (payload.length > REPORT_SIZE) {
    throw new Error(`Payload is ${payload.length} bytes; max is ${REPORT_SIZE}`);
  }
  const out = new Uint8Array(REPORT_SIZE);
  out.set(Array.from(payload));
  return out;
}

export function isWebHidAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'hid' in navigator;
}

function isViaInterface(device: HIDDevice): boolean {
  return device.collections.some(
    (c) => c.usagePage === VIA_USAGE_PAGE && c.usage === VIA_USAGE,
  );
}

export class WebHidTransport implements Transport {
  private reportListeners: ((r: Uint8Array) => void)[] = [];
  private disconnectListeners: (() => void)[] = [];

  private constructor(private device: HIDDevice) {
    device.addEventListener('inputreport', (e: HIDInputReportEvent) => {
      const report = new Uint8Array(
        e.data.buffer,
        e.data.byteOffset,
        e.data.byteLength,
      ).slice();
      this.reportListeners.forEach((l) => l(report));
    });
    navigator.hid.addEventListener('disconnect', (e: HIDConnectionEvent) => {
      if (e.device === this.device) this.disconnectListeners.forEach((l) => l());
    });
  }

  get vendorId() {
    return this.device.vendorId;
  }
  get productId() {
    return this.device.productId;
  }
  get productName() {
    return this.device.productName;
  }

  /** Shows the browser's device picker, filtered to VIA-capable keyboards. */
  static async request(): Promise<WebHidTransport | undefined> {
    const devices = await navigator.hid.requestDevice({
      filters: [{usagePage: VIA_USAGE_PAGE, usage: VIA_USAGE}],
    });
    const device = devices.find(isViaInterface);
    return device ? WebHidTransport.open(device) : undefined;
  }

  /** Previously-approved devices, for reconnecting without a prompt. */
  static async known(): Promise<HIDDevice[]> {
    return (await navigator.hid.getDevices()).filter(isViaInterface);
  }

  static async open(device: HIDDevice): Promise<WebHidTransport> {
    if (!device.opened) await device.open();
    return new WebHidTransport(device);
  }

  async send(payload: ArrayLike<number>): Promise<void> {
    // Report ID 0 is passed separately in WebHID; the data is exactly 32 bytes.
    await this.device.sendReport(0, pad(payload));
  }

  onReport(listener: (report: Uint8Array) => void) {
    this.reportListeners.push(listener);
  }

  onDisconnect(listener: () => void) {
    this.disconnectListeners.push(listener);
  }

  async close() {
    if (this.device.opened) await this.device.close();
  }
}
