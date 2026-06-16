import { describe, it, expect } from 'vitest';
import {
  makeCommandId,
  makeActionId,
  makePreScriptId,
  makeAggregatorId,
  parseProcessId,
} from '../src/compound-id.js';

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

  // ─── makePreScriptId ─────────────────────────────────────────────────
  describe('makePreScriptId', () => {
    it('returns the correct 4-segment format', () => {
      expect(makePreScriptId('g1', 's1', 'sc1')).toBe('pre:g1:s1:sc1');
    });

    it('handles uuid-like values', () => {
      const gid = 'aaaa-1111';
      const sid = 'bbbb-2222';
      const scid = 'cccc-3333';
      expect(makePreScriptId(gid, sid, scid)).toBe(`pre:${gid}:${sid}:${scid}`);
    });
  });

  // ─── makeAggregatorId ────────────────────────────────────────────────
  describe('makeAggregatorId', () => {
    it('returns the correct pre-pipeline format', () => {
      expect(makeAggregatorId('g1', '1234567890')).toBe(
        'pre-pipeline:g1:1234567890',
      );
    });
  });

  // ─── parseProcessId — prescript roundtrip ────────────────────────────
  describe('parseProcessId — prescript roundtrip', () => {
    it('roundtrips a pre-script id', () => {
      const gid = 'group-uuid-1234';
      const sid = 'step-uuid-5678';
      const scid = 'script-uuid-9012';
      const pid = makePreScriptId(gid, sid, scid);
      const parsed = parseProcessId(pid);
      expect(parsed.kind).toBe('prescript');
      expect(parsed.groupId).toBe(gid);
      expect(parsed.stepId).toBe(sid);
      expect(parsed.scriptId).toBe(scid);
    });

    it('roundtrips a pre-pipeline aggregator id', () => {
      const gid = 'group-uuid-abcd';
      const runId = '1717000000000';
      const pid = makeAggregatorId(gid, runId);
      const parsed = parseProcessId(pid);
      expect(parsed.kind).toBe('preAggregator');
      expect(parsed.groupId).toBe(gid);
      expect(parsed.runId).toBe(runId);
    });

    it('distinguishes pre: from pre-pipeline:', () => {
      const preParsed = parseProcessId('pre:g:s:sc');
      const aggParsed = parseProcessId('pre-pipeline:g:run123');
      expect(preParsed.kind).toBe('prescript');
      expect(aggParsed.kind).toBe('preAggregator');
    });

    it('pre: does not match pre-pipeline: prefix', () => {
      // A pre-pipeline: id must NOT be parsed as prescript kind
      const aggId = makeAggregatorId('groupX', '9999');
      expect(parseProcessId(aggId).kind).toBe('preAggregator');
    });

    it('incomplete pre: id (only 3 segments) returns unknown', () => {
      expect(parseProcessId('pre:g:s')).toEqual({ kind: 'unknown' });
    });

    it('existing cmd/act paths unchanged after adding pre: branches', () => {
      const cmdParsed = parseProcessId('cmd:g:c');
      expect(cmdParsed.kind).toBe('command');
      expect(cmdParsed.groupId).toBe('g');
      expect(cmdParsed.commandId).toBe('c');

      const actParsed = parseProcessId('act:g:a');
      expect(actParsed.kind).toBe('action');
      expect(actParsed.groupId).toBe('g');
      expect(actParsed.actionId).toBe('a');
    });
  });
});
