/** A compact age, like GitHub's list: "now", "5m", "3h", "2d", "4mo", "2y". */
export function ago(unixSeconds: number, now = Date.now() / 1000): string {
  const s = Math.max(0, now - unixSeconds);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d`;
  if (s < 365 * 86400) return `${Math.floor(s / (30 * 86400))}mo`;
  return `${Math.floor(s / (365 * 86400))}y`;
}

/** The full date, for a tooltip. */
export function fullDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}
