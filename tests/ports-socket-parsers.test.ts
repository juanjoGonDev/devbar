import { describe, expect, it } from 'vitest';
import {
  descendantsOf,
  parseLsof,
  parseNetstat,
  parsePidTable,
  parseSs,
} from '../src/ports/socket-parsers.js';

/** `lsof -nP -iTCP -sTCP:LISTEN -a -p … -F pn` on macOS. */
const LSOF = [
  'p4100',
  'f23',
  'n*:3000',
  'f24',
  'n127.0.0.1:5173',
  'f25',
  'n[::1]:5173',
  'p4200',
  'f12',
  'n192.168.1.20:8080',
  'f13',
  'n[::]:9229',
  '',
].join('\n');

/** `ss -ltnp` on Linux (iproute2). */
const SS = [
  'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
  'LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*     users:(("node",pid=1234,fd=20))',
  'LISTEN 0      511             [::]:5173          [::]:*     users:(("node",pid=1235,fd=21),("node",pid=1236,fd=21))',
  'LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*',
  'LISTEN 0      128        127.0.0.1:6006       0.0.0.0:*     users:(("node",pid=1240,fd=30))',
  '',
].join('\n');

/** `netstat -ano -p tcp` on a Spanish Windows: the state column is localized. */
const NETSTAT = [
  '',
  'Conexiones activas',
  '',
  '  Proto  Dirección local          Dirección remota        Estado           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              ESCUCHANDO       1040',
  '  TCP    0.0.0.0:3000           0.0.0.0:0              ESCUCHANDO       9876',
  '  TCP    127.0.0.1:5173         0.0.0.0:0              ESCUCHANDO       9877',
  '  TCP    127.0.0.1:5173         127.0.0.1:50123        ESTABLECIDO      9877',
  '  TCP    [::]:8080              [::]:0                 ESCUCHANDO       9878',
  '',
].join('\r\n');

describe('src/ports/socket-parsers.ts', () => {
  describe('parseLsof', () => {
    it('reads every listening socket with its pid, host and port', () => {
      expect(parseLsof(LSOF)).toEqual([
        { pid: 4100, host: '*', port: 3000 },
        { pid: 4100, host: '127.0.0.1', port: 5173 },
        { pid: 4100, host: '[::1]', port: 5173 },
        { pid: 4200, host: '192.168.1.20', port: 8080 },
        { pid: 4200, host: '[::]', port: 9229 },
      ]);
    });

    it('answers nothing for empty output (lsof exits 1 when nothing matches)', () => {
      expect(parseLsof('')).toEqual([]);
    });

    it('ignores a name line that is not host:port', () => {
      expect(parseLsof('p1\nf3\nn/dev/null\n')).toEqual([]);
    });
  });

  describe('parseSs', () => {
    it('reads one socket per owning pid and skips sockets without one', () => {
      expect(parseSs(SS)).toEqual([
        { pid: 1234, host: '0.0.0.0', port: 3000 },
        { pid: 1235, host: '[::]', port: 5173 },
        { pid: 1236, host: '[::]', port: 5173 },
        { pid: 1240, host: '127.0.0.1', port: 6006 },
      ]);
    });
  });

  describe('parseNetstat', () => {
    it('keeps the listening TCP rows whatever the language of the state column', () => {
      expect(parseNetstat(NETSTAT)).toEqual([
        { pid: 1040, host: '0.0.0.0', port: 135 },
        { pid: 9876, host: '0.0.0.0', port: 3000 },
        { pid: 9877, host: '127.0.0.1', port: 5173 },
        { pid: 9878, host: '[::]', port: 8080 },
      ]);
    });
  });

  describe('parsePidTable / descendantsOf', () => {
    const table = parsePidTable(
      [
        '    1     0',
        '  500     1',
        '  501   500',
        '  502   501',
        '  600     1',
        'junk',
      ].join('\n'),
    );

    it('reads a "pid ppid" table', () => {
      expect(table.get(502)).toBe(501);
      expect(table.size).toBe(5);
    });

    it('collects a root and every process below it', () => {
      expect([...descendantsOf(500, table)].sort()).toEqual([500, 501, 502]);
    });

    it('still answers the root alone when the table does not know it', () => {
      expect([...descendantsOf(9999, table)]).toEqual([9999]);
    });

    it('survives a cycle in a corrupted table', () => {
      const cyclic = new Map([
        [10, 11],
        [11, 10],
      ]);
      expect([...descendantsOf(10, cyclic)].sort()).toEqual([10, 11]);
    });
  });
});
