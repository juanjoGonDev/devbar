export function formatUptime(value: unknown): string {
  const ms =
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : 0;
  const totalSeconds = Math.floor(ms / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);
  if (totalDays >= 1) return `${totalDays}d ${totalHours % 24}h`;
  if (totalHours >= 1) return `${totalHours}h ${totalMinutes % 60}m`;
  if (totalMinutes >= 1) return `${totalMinutes}m ${totalSeconds % 60}s`;
  return `${totalSeconds}s`;
}
