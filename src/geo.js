// Геометричні допоміжні функції (сфера, метри, градуси).

const R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Відстань між двома точками в метрах (формула гаверсинуса). */
export function distance(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Азимут з точки 1 на точку 2, градуси 0..360 (0 = північ, за годинниковою стрілкою). */
export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dl = toRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Різниця азимутів у межах -180..180. Додатна — поворот праворуч. */
export function turnDelta(fromBearing, toBearing) {
  let d = (toBearing - fromBearing) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}
