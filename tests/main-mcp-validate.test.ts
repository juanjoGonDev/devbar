import { describe, expect, it } from 'vitest';
import {
  ipcMcpAuditQuery,
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
        confirm: { control: 'always', workflows: 'never' },
        groups: ['g1'],
        redactSecrets: false,
      });
    });

    it('accepts "all" as the group selection', () => {
      expect(ipcMcpClientPatch({ groups: 'all' })).toEqual({ groups: 'all' });
    });

    it.each([
      [{ confirm: { control: 'sometimes' } }],
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

  describe('ipcMcpAuditQuery', () => {
    it('narrows a full query', () => {
      expect(
        ipcMcpAuditQuery({ clientId: 'c1', filter: 'rejected', limit: 20 }),
      ).toEqual({ clientId: 'c1', filter: 'rejected', limit: 20 });
    });

    it.each([
      [{ limit: 0 }],
      [{ limit: 501 }],
      [{ limit: 2.5 }],
      [{}],
      [{ limit: 10, filter: 'mine' }],
    ])('refuses %j', (query) => {
      expect(() => ipcMcpAuditQuery(query)).toThrow(TypeError);
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
