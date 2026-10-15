import type {ValueRef} from '../protocol/encoding';

// The UI only ever sees this model, never raw definition JSON or bytes.

export type ControlType = 'range' | 'dropdown' | 'color' | 'toggle';

export interface Control {
  /** VIA value_key, e.g. "id_qmk_rgb_matrix_effect". Used by showIf. */
  key: string;
  label: string;
  type: ControlType;
  ref: ValueRef;
  /** range: [min, max]; toggle: [off, on]. */
  min: number;
  max: number;
  /** dropdown only. */
  options: {label: string; value: number}[];
  showIf?: string;
}

export interface Zone {
  label: string;
  controls: Control[];
}

export type DefinitionSource =
  | 'vial'
  | 'bundled'
  | 'via-hosted-v3'
  | 'via-hosted-v2'
  | 'file'
  | 'probe';

export interface LightingModel {
  name: string;
  source: DefinitionSource;
  zones: Zone[];
  /** True when effect names come from VIA's generic lists and may not match this board. */
  genericNames: boolean;
}

/** Bytes each control's value takes on the wire. */
export function dataLength(control: Control): number {
  if (control.type === 'color') return 2;
  return control.max > 255 ? 2 : 1;
}

/** Channels used by the model, in first-seen order. */
export function channelsOf(model: LightingModel): number[] {
  const seen: number[] = [];
  for (const z of model.zones) {
    for (const c of z.controls) {
      if (!seen.includes(c.ref.channel)) seen.push(c.ref.channel);
    }
  }
  return seen;
}
