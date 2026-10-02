import type os from 'node:os';

/**
 * Which addresses the remote-control server answers on. Only private IPv4
 * ranges count as "the local network" (10/8, 172.16/12, 192.168/16): a VPN's
 * carrier-grade NAT (100.64/10), link-local and public addresses are left
 * out, so the QR never points a phone somewhere it cannot — or should not —
 * reach.
 */

type Interfaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1'];

function octets(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : -1,
  );
  return numbers.every((n) => n >= 0 && n <= 255) ? numbers : null;
}

export function isPrivateIPv4(address: string): boolean {
  const parts = octets(address);
  if (!parts) return false;
  const [a = -1, b = -1] = parts;
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

export function lanAddresses(interfaces: Interfaces): string[] {
  const found = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      // Node 18.0–18.3 reported the family as the number 4.
      const ipv4 = entry.family === 'IPv4' || (entry.family as unknown) === 4;
      if (ipv4 && !entry.internal && isPrivateIPv4(entry.address))
        found.add(entry.address);
    }
  }
  return [...found];
}

/**
 * DNS-rebinding defence: a page on evil.example that re-points its own name
 * at this machine still sends `Host: evil.example:…`, so only a request
 * addressed to one of OUR addresses (or loopback) with OUR port gets in.
 */
export function isAllowedHost(
  host: string | undefined,
  addresses: readonly string[],
  port: number,
): boolean {
  if (!host) return false;
  const value = host.toLowerCase();
  return [...addresses, ...LOOPBACK_HOSTS].some(
    (allowed) => value === `${allowed}:${port}`,
  );
}

/** `::ffff:192.168.1.4` → `192.168.1.4`; what the desktop shows. */
export function normalizeIp(address: string | undefined): string {
  if (!address) return 'desconocida';
  return address.startsWith('::ffff:')
    ? address.slice('::ffff:'.length)
    : address;
}
