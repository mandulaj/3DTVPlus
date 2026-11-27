const cache = new Map<string, string | null>();

/** Name of the place at a point (village, locality, named feature) from OpenStreetMap, or null. */
export async function placeName(at: [lng: number, lat: number]): Promise<string | null> {
  const key = `${at[1].toFixed(4)},${at[0].toFixed(4)}`;
  if (cache.has(key)) return cache.get(key)!;
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=en&lat=${at[1].toFixed(5)}&lon=${at[0].toFixed(5)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const a = data.address ?? {};
    const name: string | null = data.name || a.hamlet || a.village || a.town || a.city || a.municipality || null;
    cache.set(key, name);
    if (cache.size > 100) cache.delete(cache.keys().next().value!);
    return name;
  } catch {
    return null;
  }
}
