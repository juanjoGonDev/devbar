import { describe, expect, it } from 'vitest';
import {
  ipcMcpAuditPageQuery,
  ipcMcpClientPatch,
  ipcMcpConfirmAnswer,
  ipcMcpId,
  ipcMcpScopes,
} from '../src/main/mcp/validate.js';

describe('src/main/mcp/validate.ts', () => {
  describe('ipcMcpId', () => {
    it.each([[''], [42], ['x'.repeat(201)]])('refuses %j', (value) => {
      expect(() => ipcMcpId(value)).toThrow(TypeError);
    });

    it('passes a plain id through', () => {
      expect(ipcMcpId('c1')).toBe('c1');
    });
  });

  describe('ipcMcpScopes', () => {
    it('keeps the known switches and drops the rest', () => {
      expect(ipcMcpScopes({ read: false, config: true, admin: true })).toEqual({
        read: false,
        config: true,
      });
    });

    it('reads a missing value as no change', () => {
      expect(ipcMcpScopes(undefined)).toBeUndefined();
    });

    it('refuses a switch that is not a boolean', () => {
      expect(() => ipcMcpScopes({ control: 'yes' })).toThrow(
        'Invalid IPC scopes.control',
      );
    });
  });

  describe('ipcMcpClientPatch', () => {
    it('narrows every editable field', () => {
      expect(
        ipcMcpClientPatch({
          name: 'Mi Claude',
          scopes: { workflows: false },
          confirm: { control: 'always', workflows: 'never', config: 'never' },
          groups: ['g1'],
          redactSecrets: false,
          status: 'allowed',
        }),
      ).toEqual({
        name: 'Mi Claude',
        scopes: { workflows: false },
        confirm: { control: 'always', workflows: 'never', config: 'never' },
        groups: ['g1'],
        redactSecrets: false,
      });
    });

    it('accepts "all" as the group selection', () => {
      expect(ipcMcpClientPatch({ groups: 'all' })).toEqual({ groups: 'all' });
    });

    it.each([
      [{ confirm: { control: 'sometimes' } }],
      [{ confirm: { config: 'sometimes' } }],
      [{ groups: 'some' }],
      [{ groups: [1] }],
      [{ groups: Array.from({ length: 501 }, (_, i) => `g${i}`) }],
      [{ redactSecrets: 'no' }],
      [{ name: 'x'.repeat(201) }],
      [null],
    ])('refuses %j', (patch) => {
      expect(() => ipcMcpClientPatch(patch)).toThrow(TypeError);
    });
  });

  describe('ipcMcpAuditPageQuery', () => {
    it('narrows a full query and drops unknown keys', () => {
      expect(
        ipcMcpAuditPageQuery({
          search: 'restart',
          clientIds: ['c1', 'c1', 'c2'],
          tools: ['restart'],
          results: ['ok', 'error'],
          undoable: true,
          from: 10,
          to: 20,
          sort: [
            { key: 'client', dir: 'asc' },
            { key: 'time', dir: 'desc', extra: 1 },
          ],
          offset: 50,
          limit: 50,
          admin: true,
        }),
      ).toEqual({
        search: 'restart',
        clientIds: ['c1', 'c2'],
        tools: ['restart'],
        results: ['ok', 'error'],
        undoable: true,
        from: 10,
        to: 20,
        sort: [
          { key: 'client', dir: 'asc' },
          { key: 'time', dir: 'desc' },
        ],
        offset: 50,
        limit: 50,
      });
    });

    it('keeps an empty list, which matches nothing', () => {
      expect(
        ipcMcpAuditPageQuery({ clientIds: [], offset: 0, limit: 1 }),
      ).toEqual({ clientIds: [], offset: 0, limit: 1 });
    });

    it.each([
      [0, 1],
      [-5, 1],
      [9999, 100],
    ])('clamps a limit of %d to %d', (limit, expected) => {
      expect(ipcMcpAuditPageQuery({ offset: 0, limit }).limit).toBe(expected);
    });

    it.each([
      [{ limit: 10 }],
      [{ offset: -1, limit: 10 }],
      [{ offset: 1.5, limit: 10 }],
      [{ offset: 0, limit: 2.5 }],
      [{ offset: 0, limit: Number.NaN }],
      [{ offset: 0, limit: 10, from: Number.POSITIVE_INFINITY }],
      [{ offset: 0, limit: 10, to: '5' }],
      [{ offset: 0, limit: 10, search: 'x'.repeat(201) }],
      [{ offset: 0, limit: 10, search: 7 }],
      [{ offset: 0, limit: 10, clientIds: 'c1' }],
      [{ offset: 0, limit: 10, clientIds: [''] }],
      [{ offset: 0, limit: 10, clientIds: Array(501).fill('c') }],
      [{ offset: 0, limit: 10, tools: ['x'.repeat(101)] }],
      [{ offset: 0, limit: 10, results: ['fine'] }],
      [{ offset: 0, limit: 10, undoable: 'yes' }],
      [{ offset: 0, limit: 10, sort: [{ key: 'size', dir: 'asc' }] }],
      [{ offset: 0, limit: 10, sort: [{ key: 'time', dir: 'up' }] }],
      [{ offset: 0, limit: 10, sort: ['time'] }],
      [{ offset: 0, limit: 10, sort: { key: 'time', dir: 'asc' } }],
      [
        {
          offset: 0,
          limit: 10,
          sort: [
            { key: 'time', dir: 'asc' },
            { key: 'time', dir: 'desc' },
          ],
        },
      ],
      [null],
    ])('refuses %j', (query) => {
      expect(() => ipcMcpAuditPageQuery(query)).toThrow(TypeError);
    });
  });

  describe('ipcMcpConfirmAnswer', () => {
    it('accepts only apply and reject', () => {
      expect(ipcMcpConfirmAnswer('apply')).toBe('apply');
      expect(ipcMcpConfirmAnswer('reject')).toBe('reject');
      expect(() => ipcMcpConfirmAnswer('maybe')).toThrow(TypeError);
    });
  });
});
