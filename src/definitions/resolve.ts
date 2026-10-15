// Finds a keyboard definition, trying sources in this order:
// bundled with the app → VIA's hosted library → (user file, handled by UI).
// Vial on-keyboard definitions are a later phase.

import type {DefinitionSource} from './model';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export const VIA_HOSTED = 'https://usevia.app/definitions';
const INDEX_CACHE_KEY = 'via-app:supported_kbs';

export function vendorProductId(vendorId: number, productId: number): number {
  // Same scheme as the VIA app. Multiplication, not <<, to stay out of
  // JavaScript's signed 32-bit range.
  return vendorId * 65536 + productId;
}

export interface ResolvedDefinition {
  definition: Json;
  source: DefinitionSource;
}

type Fetcher = (url: string) => Promise<Response>;

async function fetchJson(fetcher: Fetcher, url: string): Promise<Json | undefined> {
  try {
    const res = await fetcher(url);
    if (!res.ok) return undefined;
    // The hosted site answers unknown paths with an HTML page, not a 404.
    if (!(res.headers.get('content-type') ?? '').includes('json')) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

async function bundled(fetcher: Fetcher, vpid: number, baseUrl: string) {
  const index = await fetchJson(fetcher, `${baseUrl}definitions/bundled.json`);
  const entry = index?.definitions?.[String(vpid)];
  if (!entry?.file) return undefined;
  return fetchJson(fetcher, `${baseUrl}definitions/${entry.file}`);
}

interface HostedIndex {
  v2: number[];
  v3: number[];
}

function readCachedIndex(): HostedIndex | undefined {
  try {
    const raw = localStorage.getItem(INDEX_CACHE_KEY);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function writeCachedIndex(index: HostedIndex) {
  try {
    localStorage.setItem(INDEX_CACHE_KEY, JSON.stringify(index));
  } catch {
    // Storage blocked or full; the cache is only a convenience.
  }
}

async function hostedIndex(fetcher: Fetcher): Promise<HostedIndex | undefined> {
  const json = await fetchJson(fetcher, `${VIA_HOSTED}/supported_kbs.json`);
  const ids = json?.vendorProductIds;
  if (Array.isArray(ids?.v2) && Array.isArray(ids?.v3)) {
    const index = {v2: ids.v2, v3: ids.v3};
    writeCachedIndex(index);
    return index;
  }
  return readCachedIndex();
}

export async function resolveDefinition(
  vendorId: number,
  productId: number,
  {fetcher = fetch.bind(globalThis), baseUrl = '/'}: {fetcher?: Fetcher; baseUrl?: string} = {},
): Promise<ResolvedDefinition | undefined> {
  const vpid = vendorProductId(vendorId, productId);

  const local = await bundled(fetcher, vpid, baseUrl);
  if (local) return {definition: local, source: 'bundled'};

  const index = await hostedIndex(fetcher);
  for (const version of ['v3', 'v2'] as const) {
    if (index && !index[version].includes(vpid)) continue;
    const def = await fetchJson(fetcher, `${VIA_HOSTED}/${version}/${vpid}.json`);
    if (def) return {definition: def, source: version === 'v3' ? 'via-hosted-v3' : 'via-hosted-v2'};
  }
  return undefined;
}

/** True if a user-loaded definition claims to be for this device. */
export function definitionMatches(def: Json, vendorId: number, productId: number): boolean {
  const vid = Number(def?.vendorId);
  const pid = Number(def?.productId);
  return vid === vendorId && pid === productId;
}
