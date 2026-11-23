// Fetches one sample tile per catalogue layer and reports status + CORS.
// Run with: npm run check-layers
// Node >= 22.18 strips TypeScript types on import.
const { CATALOG, defaultParam } = await import('../src/layers/catalog.ts');

// z/x/y samples: Valais for alpine layers, in-country tiles for national services.
const SAMPLE = { default: [12, 2128, 1455], 'at-': [12, 2206, 1432], 'fr-': [12, 2121, 1463], 'de-': [12, 2180, 1400], 'it-bz': [12, 2176, 1444], 'no-': [10, 541, 285] };
const sampleFor = (id) => Object.entries(SAMPLE).find(([prefix]) => id.startsWith(prefix))?.[1] ?? SAMPLE.default;

let failures = 0;
await Promise.all(
  CATALOG.map(async (def) => {
    try {
      let url = def.kind === 'style' ? def.styleUrl : def.resolveTiles ? await def.resolveTiles() : def.tiles;
      let [z, x, y] = sampleFor(def.id);
      while (z > (def.maxzoom ?? 18)) { z--; x >>= 1; y >>= 1; }
      url = url.replace('{key}', 'none').replace('{param}', defaultParam(def) ?? '').replace('{z}', z).replace('{x}', x).replace('{y}', y);
      const response = await fetch(url, { headers: { Origin: 'http://localhost:5173' }, signal: AbortSignal.timeout(20000) });
      const cors = response.headers.get('access-control-allow-origin');
      // Key-protected layers are checked without a key: the endpoint must exist and refuse politely.
      const ok = def.needsKey ? [401, 403].includes(response.status) && cors !== null : response.ok && (def.needsProxy || cors === '*' || cors === 'http://localhost:5173');
      if (!ok) failures++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${def.id.padEnd(18)} ${response.status} cors=${cors ?? 'none'}${def.needsProxy ? ' (proxy layer)' : ''} ${(response.headers.get('content-type') ?? '').split(';')[0]}`);
    } catch (err) {
      failures++;
      console.log(`FAIL ${def.id.padEnd(18)} ${err.message}`);
    }
  }),
);
console.log(failures ? `\n${failures} layer(s) failed` : '\nall layers reachable');
process.exit(failures ? 1 : 0);
