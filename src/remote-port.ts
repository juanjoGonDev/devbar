/**
 * The port rule of «Control remoto», shared by main (which enforces it before
 * persisting) and the config window (which keeps «Aplicar» off until a value
 * passes it). Below 1024 a port needs root on macOS and Linux; past 65535 it
 * is not a port. No imports: the renderer bundles this file too.
 */

const MIN_PORT = 1024;
const MAX_PORT = 65535;

/** An integer port in 1024–65535. */
export function isRemotePort(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_PORT &&
    value <= MAX_PORT
  );
}

/** Why `value` cannot be the remote-control port, in Spanish; else null. */
export function remotePortError(value: unknown): string | null {
  return isRemotePort(value)
    ? null
    : `El puerto debe ser un número entero entre ${MIN_PORT} y ${MAX_PORT}.`;
}
