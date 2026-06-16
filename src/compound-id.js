'use strict';

/**
 * compound-id.js — pure helpers for building and parsing DevBar compound process ids.
 *
 * Long-running command:      cmd:<groupId>:<commandId>
 * One-shot action:           act:<groupId>:<actionId>
 * Pre-script (step/script):  pre:<groupId>:<stepId>:<scriptId>
 * Pre-script pipeline:       pre-pipeline:<groupId>:<runId>
 *
 * NOTE: step and script ids are always uuids (no colons), so the
 * 4-segment pre: regex is unambiguous. Do NOT use ids with colons.
 */

function makeCommandId(groupId, commandId) {
  return `cmd:${groupId}:${commandId}`;
}

function makeActionId(groupId, actionId) {
  return `act:${groupId}:${actionId}`;
}

/**
 * Build a pre-script process id.
 * Format: pre:<groupId>:<stepId>:<scriptId>
 */
function makePreScriptId(groupId, stepId, scriptId) {
  return `pre:${groupId}:${stepId}:${scriptId}`;
}

/**
 * Build a pre-script pipeline aggregator id.
 * Format: pre-pipeline:<groupId>:<runId>
 * This is a virtual pid used only for the aggregator log buffer.
 */
function makeAggregatorId(groupId, runId) {
  return `pre-pipeline:${groupId}:${runId}`;
}

/**
 * Parse a compound process id.
 *
 * Returns one of:
 *   { kind: 'command',       groupId, commandId }
 *   { kind: 'action',        groupId, actionId  }
 *   { kind: 'prescript',     groupId, stepId, scriptId }
 *   { kind: 'preAggregator', groupId, runId }
 *   { kind: 'unknown' }
 *
 * Order matters: pre: and pre-pipeline: must be tested before (cmd|act):
 */
function parseProcessId(s) {
  if (typeof s !== 'string') return { kind: 'unknown' };

  // 4-segment: pre:<groupId>:<stepId>:<scriptId>
  let m = /^pre:([^:]+):([^:]+):(.+)$/.exec(s);
  if (m)
    return { kind: 'prescript', groupId: m[1], stepId: m[2], scriptId: m[3] };

  // 3-segment: pre-pipeline:<groupId>:<runId>
  m = /^pre-pipeline:([^:]+):(.+)$/.exec(s);
  if (m) return { kind: 'preAggregator', groupId: m[1], runId: m[2] };

  // existing 3-segment: cmd|act:<groupId>:<id>
  m = /^(cmd|act):([^:]+):(.+)$/.exec(s);
  if (!m) return { kind: 'unknown' };
  if (m[1] === 'cmd') {
    return { kind: 'command', groupId: m[2], commandId: m[3] };
  }
  return { kind: 'action', groupId: m[2], actionId: m[3] };
}

module.exports = {
  makeCommandId,
  makeActionId,
  makePreScriptId,
  makeAggregatorId,
  parseProcessId,
};
