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

/**
 * The time of day, to the minute, in the browser's locale ("14:05" or "2:05 PM"), with the day
 * in front when it isn't today ("Tue 14:05", "Oct 3, 2:05 PM").
 */
export function clockTime(unixSeconds: number, now = new Date()): string {
  const at = new Date(unixSeconds * 1000);
  const time: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  if (at.toDateString() === now.toDateString()) return at.toLocaleTimeString([], time);
  const withinWeek = Math.abs(at.getTime() - now.getTime()) < 6 * 86400 * 1000;
  const day: Intl.DateTimeFormatOptions = withinWeek ? { weekday: "short" } : { month: "short", day: "numeric" };
  return at.toLocaleString([], { ...day, ...time });
}
