/**
 * Whether an address is a private IPv4 one (10/8, 172.16/12, 192.168/16).
 * Pure and free of Node types, so both main and the renderer can use it.
 */
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
