/** 14:05:09 */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour12: false });
}

/** "2.3s", or "-" while the attempt is still running. */
export function formatDuration(startIso: string, endIso: string | null): string {
  if (!endIso) return '-';
  const seconds = (new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000;
  return `${seconds.toFixed(1)}s`;
}
