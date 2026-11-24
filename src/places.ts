/** Name of the place at a point (village, locality, named feature) from OpenStreetMap, or null. */
export async function placeName(at: [lng: number, lat: number]): Promise<string | null> {
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=en&lat=${at[1].toFixed(5)}&lon=${at[0].toFixed(5)}`);
    const data = await response.json();
    const a = data.address ?? {};
    return data.name || a.hamlet || a.village || a.town || a.city || a.municipality || null;
  } catch {
    return null;
  }
}
