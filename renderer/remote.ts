import { startRemoteApp } from './remote/app.js';

/**
 * Entry point of the phone page (renderer/remote.html), served to LAN
 * browsers by the remote-control server as ONE esbuild bundle (scripts/
 * build.ts), the @noble crypto included. Unlike every other renderer entry it
 * has no `window.api` and no error reporting back to main: it talks to DevBar
 * over HTTP and Server-Sent Events only, every message sealed by devbar-rc/1
 * (see renderer/remote/channel.ts and renderer/remote/connection.ts).
 */
void startRemoteApp({
  fetch: (url, init) => fetch(url, init),
  pathname: location.pathname,
  search: location.search,
  hash: location.hash,
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
