'use strict';

/**
 * compound-id.js — pure helpers for building and parsing DevBar compound process ids.
 *
 * Long-running command: cmd:<groupId>:<commandId>
 * One-shot action:      act:<groupId>:<actionId>
 */

function makeCommandId(groupId, commandId) {
  return `cmd:${groupId}:${commandId}`;
}

function makeActionId(groupId, actionId) {
  return `act:${groupId}:${actionId}`;
}

/**
 * Parse a compound process id.
 *
 * Returns one of:
 *   { kind: 'command', groupId, commandId }
 *   { kind: 'action',  groupId, actionId  }
 *   { kind: 'unknown' }
 */
function parseProcessId(s) {
  if (typeof s !== 'string') return { kind: 'unknown' };
  const m = /^(cmd|act):([^:]+):(.+)$/.exec(s);
  if (!m) return { kind: 'unknown' };
  if (m[1] === 'cmd') {
    return { kind: 'command', groupId: m[2], commandId: m[3] };
  }
  return { kind: 'action', groupId: m[2], actionId: m[3] };
}

module.exports = { makeCommandId, makeActionId, parseProcessId };
