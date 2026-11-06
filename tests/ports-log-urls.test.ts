import { describe, expect, it } from 'vitest';
import { detectLabel, extractLogPorts } from '../src/ports/log-urls.js';

const ESC = '\u001b';
const HOSTS = { hostname: 'mbp-juanjo.local', lanAddresses: ['192.168.1.20'] };

describe('src/ports/log-urls.ts', () => {
  describe('extractLogPorts — real lines from common dev servers', () => {
    const cases: Array<{ tool: string; line: string; expected: string[] }> = [
      {
        tool: 'Vite',
        line: `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m`,
        expected: ['http://localhost:5173/'],
      },
      {
        tool: 'Vite (network line on the LAN address)',
        line: '  ➜  Network: http://192.168.1.20:5173/',
        expected: ['http://192.168.1.20:5173/'],
      },
      {
        tool: 'Next.js',
        line: '   - Local:        http://localhost:3000',
        expected: ['http://localhost:3000'],
      },
      {
        tool: 'Next.js (legacy)',
        line: 'ready - started server on 0.0.0.0:3000, url: http://localhost:3000',
        expected: ['http://localhost:3000'],
      },
      {
        tool: 'Nest',
        line: 'Application is running on: http://[::1]:3000',
        expected: ['http://[::1]:3000'],
      },
      {
        tool: 'Rails (Puma)',
        line: '* Listening on http://127.0.0.1:3000',
        expected: ['http://127.0.0.1:3000'],
      },
      {
        tool: 'Django',
        line: 'Starting development server at http://127.0.0.1:8000/',
        expected: ['http://127.0.0.1:8000/'],
      },
      {
        tool: 'python -m http.server',
        line: 'Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...',
        expected: ['http://localhost:8000/'],
      },
      {
        tool: 'python -m http.server (IPv6 any)',
        line: 'Serving HTTP on :: port 8080 (http://[::]:8080/) ...',
        expected: ['http://localhost:8080/'],
      },
      {
        tool: 'Storybook',
        line: '│   Local:            http://localhost:6006/                 │',
        expected: ['http://localhost:6006/'],
      },
      {
        tool: 'webpack-dev-server',
        line: '<i> [webpack-dev-server] Loopback: http://localhost:8080/, http://[::1]:8080/',
        expected: ['http://localhost:8080/'],
      },
      {
        tool: 'Express',
        line: 'Example app listening on port 3000',
        expected: ['http://localhost:3000'],
      },
      {
        tool: 'Go / generic',
        line: '2024/05/01 10:00:00 Listening on :8081',
        expected: ['http://localhost:8081'],
      },
      {
        tool: 'Spring Boot',
        line: "o.s.b.w.embedded.tomcat.TomcatWebServer  : Tomcat started on port 8080 (http) with context path ''",
        expected: ['http://localhost:8080'],
      },
      {
        tool: 'Spring Boot (older)',
        line: 'Tomcat started on port(s): 8080 (http)',
        expected: ['http://localhost:8080'],
      },
      {
        tool: 'machine hostname',
        line: 'Ready at http://mbp-juanjo.local:4000/app',
        expected: ['http://mbp-juanjo.local:4000/app'],
      },
      {
        tool: 'https dev server',
        line: 'Server ready at https://localhost:8443/',
        expected: ['https://localhost:8443/'],
      },
    ];

    it.each(cases)('$tool', ({ line, expected }) => {
      expect(extractLogPorts(line, HOSTS).map((hit) => hit.url)).toEqual(
        expected,
      );
    });
  });

  describe('extractLogPorts — what it must ignore', () => {
    it.each([
      'GET /api/users 200 12ms',
      'Connecting to postgres at db.internal:5432',
      'Fetched https://registry.npmjs.org:443/react',
      'see http://example.com:8080/docs',
      'listening on port 99999',
      'compiled in 3000 ms',
    ])('%s', (line) => {
      expect(extractLogPorts(line, HOSTS)).toEqual([]);
    });
  });

  describe('extractLogPorts — shape', () => {
    it('reports the numeric port and dedupes one port mentioned twice', () => {
      expect(
        extractLogPorts(
          'Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...',
          HOSTS,
        ),
      ).toEqual([{ port: 8000, url: 'http://localhost:8000/' }]);
    });

    it('works without knowing the machine names', () => {
      expect(extractLogPorts('Local: http://localhost:5173/')).toEqual([
        { port: 5173, url: 'http://localhost:5173/' },
      ]);
    });

    it('strips a trailing punctuation mark from the path', () => {
      expect(
        extractLogPorts('Open http://localhost:3000/admin.', HOSTS)[0]?.url,
      ).toBe('http://localhost:3000/admin');
    });
  });

  describe('detectLabel', () => {
    it.each([
      [`  ${ESC}[32mVITE v5.2.0${ESC}[39m  ready in 312 ms`, 'Vite'],
      ['Storybook 7.6.17 for react-vite started', 'Storybook'],
      ['   ▲ Next.js 14.1.0', 'Next.js'],
      ['<i> [webpack-dev-server] Project is running at:', 'webpack'],
      [
        '[Nest] 4242  - LOG [NestApplication] Nest application successfully started',
        'Nest',
      ],
      ['Django version 5.0, using settings', 'Django'],
      [
        '  .   ____          _            __ _ _  :: Spring Boot ::',
        'Spring Boot',
      ],
      ['Puma starting in single mode...', 'Rails'],
    ])('%s → %s', (line, label) => {
      expect(detectLabel(line)).toBe(label);
    });

    it('answers null for a line that names no tool', () => {
      expect(detectLabel('GET / 200')).toBeNull();
    });
  });
});
