import { describe, it, expect } from 'vitest';
import {
  belongsToMergedScope,
  makeActionId,
  makeAggregatorId,
  makeCommandId,
  makePreScriptId,
  parseProcessId,
} from '../src/compound-id.js';
import { PIPELINE_LOG_GROUP_ID } from '../src/pipeline-labels.js';

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
      if (parsed.kind !== 'command')
        throw new Error('Expected command process id');
      expect(parsed.groupId).toBe(gid);
      expect(parsed.commandId).toBe(cid);
    });

    it('roundtrips an action id', () => {
      const gid = 'group-uuid-abcd';
      const aid = 'action-uuid-efgh';
      const pid = makeActionId(gid, aid);
      const parsed = parseProcessId(pid);
      expect(parsed.kind).toBe('action');
      if (parsed.kind !== 'action')
        throw new Error('Expected action process id');
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
      if (parsed.kind !== 'command')
        throw new Error('Expected command process id');
      expect(parsed.groupId).toBe('group1');
      expect(parsed.commandId).toBe('sub1:sub2');
    });
  });

  // ─── makePreScriptId ─────────────────────────────────────────────────
  describe('makePreScriptId', () => {
    it('returns the correct 2-arg format (stepId dropped: pid stable across drag-and-drop)', () => {
      expect(makePreScriptId('g1', 'sc1')).toBe('pre:g1:sc1');
    });

    it('handles uuid-like values', () => {
      const gid = 'aaaa-1111';
      const scid = 'cccc-3333';
      expect(makePreScriptId(gid, scid)).toBe(`pre:${gid}:${scid}`);
    });
  });

  // ─── makeAggregatorId ────────────────────────────────────────────────
  describe('makeAggregatorId', () => {
    it('returns the correct pre-pipeline format (groupId dropped: one global pipeline)', () => {
      expect(makeAggregatorId('1234567890')).toBe('pre-pipeline:1234567890');
    });
  });

  // ─── parseProcessId — prescript roundtrip ────────────────────────────
  describe('parseProcessId — prescript roundtrip', () => {
    it('roundtrips a pre-script id', () => {
      const gid = 'group-uuid-1234';
      const scid = 'script-uuid-9012';
      const pid = makePreScriptId(gid, scid);
      const parsed = parseProcessId(pid);
      expect(parsed.kind).toBe('prescript');
      if (parsed.kind !== 'prescript')
        throw new Error('Expected prescript process id');
      expect(parsed.groupId).toBe(gid);
      expect(parsed.scriptId).toBe(scid);
    });

    it('roundtrips a pre-pipeline aggregator id', () => {
      const runId = '1717000000000';
      const pid = makeAggregatorId(runId);
      const parsed = parseProcessId(pid);
      expect(parsed.kind).toBe('preAggregator');
      if (parsed.kind !== 'preAggregator')
        throw new Error('Expected preAggregator process id');
      expect(parsed.runId).toBe(runId);
    });

    it('distinguishes pre: from pre-pipeline:', () => {
      const preParsed = parseProcessId('pre:g:sc');
      const aggParsed = parseProcessId('pre-pipeline:run123');
      expect(preParsed.kind).toBe('prescript');
      expect(aggParsed.kind).toBe('preAggregator');
    });

    it('pre: does not match pre-pipeline: prefix', () => {
      // A pre-pipeline: id must NOT be parsed as prescript kind
      const aggId = makeAggregatorId('9999');
      expect(parseProcessId(aggId).kind).toBe('preAggregator');
    });

    it('a script id that itself contains colons is captured verbatim (greedy last segment)', () => {
      const pid = 'pre:group1:sub1:sub2';
      const parsed = parseProcessId(pid);
      expect(parsed.kind).toBe('prescript');
      if (parsed.kind !== 'prescript')
        throw new Error('Expected prescript process id');
      expect(parsed.groupId).toBe('group1');
      expect(parsed.scriptId).toBe('sub1:sub2');
    });

    it('incomplete pre: id (only 1 segment after the prefix) returns unknown', () => {
      expect(parseProcessId('pre:g')).toEqual({ kind: 'unknown' });
    });

    it('existing cmd/act paths unchanged after adding pre: branches', () => {
      const cmdParsed = parseProcessId('cmd:g:c');
      expect(cmdParsed.kind).toBe('command');
      if (cmdParsed.kind !== 'command')
        throw new Error('Expected command process id');
      expect(cmdParsed.groupId).toBe('g');
      expect(cmdParsed.commandId).toBe('c');

      const actParsed = parseProcessId('act:g:a');
      expect(actParsed.kind).toBe('action');
      if (actParsed.kind !== 'action')
        throw new Error('Expected action process id');
      expect(actParsed.groupId).toBe('g');
      expect(actParsed.actionId).toBe('a');
    });
  });
});

describe('belongsToMergedScope', () => {
  const cmd = parseProcessId(makeCommandId('back', 'c1'));
  const action = parseProcessId(makeActionId('back', 'a1'));
  const script = parseProcessId(makePreScriptId('back', 's1'));
  const otherScript = parseProcessId(makePreScriptId('front', 's2'));
  const aggregator = parseProcessId(makeAggregatorId(1789107788205));

  // One rule for BOTH the snapshot (`collectMergedSources`) and the live
  // stream (`broadcastLog`). They were written separately once and drifted:
  // the pipeline view listed a script's buffer but never received its new
  // lines, so it only filled in on reload.
  describe('the "Todo" scope', () => {
    it('takes everything that parses', () => {
      for (const parsed of [cmd, action, script, otherScript, aggregator])
        expect(belongsToMergedScope(parsed, null)).toBe(true);
    });

    it('still rejects an unparseable id', () => {
      expect(belongsToMergedScope(parseProcessId('nonsense'), null)).toBe(
        false,
      );
    });
  });

  describe('the pipeline scope', () => {
    it('takes the aggregator and EVERY group’s pre-scripts', () => {
      expect(belongsToMergedScope(aggregator, PIPELINE_LOG_GROUP_ID)).toBe(
        true,
      );
      expect(belongsToMergedScope(script, PIPELINE_LOG_GROUP_ID)).toBe(true);
      expect(belongsToMergedScope(otherScript, PIPELINE_LOG_GROUP_ID)).toBe(
        true,
      );
    });

    it('takes no commands or actions', () => {
      expect(belongsToMergedScope(cmd, PIPELINE_LOG_GROUP_ID)).toBe(false);
      expect(belongsToMergedScope(action, PIPELINE_LOG_GROUP_ID)).toBe(false);
    });
  });

  describe('a real group scope', () => {
    it('takes that group’s commands, actions and pre-scripts', () => {
      expect(belongsToMergedScope(cmd, 'back')).toBe(true);
      expect(belongsToMergedScope(action, 'back')).toBe(true);
      expect(belongsToMergedScope(script, 'back')).toBe(true);
    });

    it('takes nothing from another group', () => {
      expect(belongsToMergedScope(otherScript, 'back')).toBe(false);
    });

    it('never nests the pipeline aggregator under a real group', () => {
      expect(belongsToMergedScope(aggregator, 'back')).toBe(false);
    });
  });
});
