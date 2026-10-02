import { startRemoteApp } from './remote/app.js';

/**
 * Entry point of the phone page (renderer/remote.html), served to LAN
 * browsers by the remote-control server. Unlike every other renderer entry it
 * has no `window.api` and no error reporting back to main: it talks to DevBar
 * over HTTP and Server-Sent Events only (see renderer/remote/api.ts and
 * renderer/remote/connection.ts).
 */
void startRemoteApp({
  fetch: (url, init) => fetch(url, init),
  search: location.search,
  hostname: location.hostname,
  replaceUrl: (url) => history.replaceState(null, '', url),
  confirm: (message) => window.confirm(message),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (handle) => window.clearInterval(handle as number),
  now: () => Date.now(),
  openEvents: (url) => new EventSource(url),
  // Read on each use: private modes and blocked site data throw here.
  storage: () => window.localStorage,
  reload: () => location.reload(),
});
