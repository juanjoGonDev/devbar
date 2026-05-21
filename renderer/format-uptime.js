'use strict';

/**
 * Renderer-side uptime formatter — exposes formatUptime as a global.
 * Logic is duplicated from src/format-uptime.js to avoid a Node require
 * in the browser context.
 *
 * < 60s  → "Xs"      e.g. "42s"
 * < 60m  → "Xm Ys"   e.g. "3m 12s"
 * < 24h  → "Xh Ym"   e.g. "2h 47m"
 * ≥ 24h  → "Xd Yh"   e.g. "1d 4h"
 */
function formatUptime(ms) {
  if (typeof ms !== 'number' || isNaN(ms) || ms < 0) ms = 0;

  const totalSeconds = Math.floor(ms / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours   = Math.floor(totalMinutes / 60);
  const totalDays    = Math.floor(totalHours   / 24);

  if (totalDays >= 1) {
    const h = totalHours % 24;
    return `${totalDays}d ${h}h`;
  }
  if (totalHours >= 1) {
    const m = totalMinutes % 60;
    return `${totalHours}h ${m}m`;
  }
  if (totalMinutes >= 1) {
    const s = totalSeconds % 60;
    return `${totalMinutes}m ${s}s`;
  }
  return `${totalSeconds}s`;
}
