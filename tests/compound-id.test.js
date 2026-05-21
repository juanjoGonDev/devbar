import { describe, it, expect } from 'vitest';
import { makeCommandId, makeActionId, parseProcessId } from '../src/compound-id.js';

describe('compound-id', () => {
  // ─── makeCommandId ───────────────────────────────────────────────────
  describe('makeCommandId', () => {
    it('returns the correct format', () => {
      expect(makeCommandId('g1', 'c1')).toBe('cmd:g1:c1');
    });

    it('handles uuid-like values', () => {
      const gid = 'aaaa-bbbb';
      const cid = 'cccc-dddd';
      expect(makeCommandId(gid, cid)).toBe(`cmd:${gid}:${cid}`);
    });
  });

  // ─── makeActionId ────────────────────────────────────────────────────
  describe('makeActionId', () => {
    it('returns the correct format', () => {
      expect(makeActionId('g1', 'a1')).toBe('act:g1:a1');
    });
  });

  // ─── parseProcessId roundtrip ────────────────────────────────────────
  describe('parseProcessId roundtrip', () => {
    it('roundtrips a command id', () => {
      const gid = 'group-uuid-1234';
      const cid = 'cmd-uuid-5678';
      const pid = makeCommandId(gid, cid);
      const parsed = parseProcessId(pid);
      expect(parsed.kind).toBe('command');
      expect(parsed.groupId).toBe(gid);
      expect(parsed.commandId).toBe(cid);
    });

    it('roundtrips an action id', () => {
      const gid = 'group-uuid-abcd';
      const aid = 'action-uuid-efgh';
      const pid = makeActionId(gid, aid);
      const parsed = parseProcessId(pid);
      expect(parsed.kind).toBe('action');
      expect(parsed.groupId).toBe(gid);
      expect(parsed.actionId).toBe(aid);
    });

    it('distinguishes cmd from act', () => {
      const cmdParsed = parseProcessId('cmd:g:c');
      const actParsed = parseProcessId('act:g:a');
      expect(cmdParsed.kind).toBe('command');
      expect(actParsed.kind).toBe('action');
    });
  });

  // ─── parseProcessId malformed inputs ────────────────────────────────
  describe('parseProcessId malformed inputs', () => {
    it('returns unknown for empty string', () => {
      expect(parseProcessId('')).toEqual({ kind: 'unknown' });
    });

    it('returns unknown for non-string input', () => {
      expect(parseProcessId(null)).toEqual({ kind: 'unknown' });
      expect(parseProcessId(undefined)).toEqual({ kind: 'unknown' });
      expect(parseProcessId(42)).toEqual({ kind: 'unknown' });
    });

    it('returns unknown for plain id without prefix', () => {
      expect(parseProcessId('just-an-id')).toEqual({ kind: 'unknown' });
    });

    it('returns unknown for unknown prefix', () => {
      expect(parseProcessId('svc:g1:c1')).toEqual({ kind: 'unknown' });
    });

    it('returns unknown for incomplete compound id (missing second part)', () => {
      expect(parseProcessId('cmd:g1')).toEqual({ kind: 'unknown' });
    });

    it('handles commandId that contains colons', () => {
      // commandId = "part1:part2" — the regex is greedy on the last segment
      const pid = 'cmd:group1:sub1:sub2';
      const parsed = parseProcessId(pid);
      expect(parsed.kind).toBe('command');
      expect(parsed.groupId).toBe('group1');
      expect(parsed.commandId).toBe('sub1:sub2');
    });
  });
});
