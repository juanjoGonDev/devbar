/**
 * The detected ports of every running command, keyed by process id — the one
 * place the state snapshot, the remote views and `openPort` read them from.
 * Detection (log lines, socket scans, HTTP probes) feeds it through
 * `setPorts`; a stop or restart clears it.
 */
import { makeCommandId } from '../compound-id.js';
import type { DetectedPort } from '../domain-types.js';
import { sortPorts } from './port-links.js';

export interface PortRegistry {
  portsOf: (processId: string) => DetectedPort[];
  /** Replaces a command's ports (stored primary first); notifies on change. */
  setPorts: (groupId: string, commandId: string, ports: DetectedPort[]) => void;
  setProcessPorts: (processId: string, ports: DetectedPort[]) => void;
  clear: (processId: string) => void;
}

function samePorts(
  a: readonly DetectedPort[],
  b: readonly DetectedPort[],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createPortRegistry(onChange: () => void): PortRegistry {
  const byProcess = new Map<string, DetectedPort[]>();
  function setProcessPorts(processId: string, ports: DetectedPort[]): void {
    const next = sortPorts(ports);
    if (samePorts(byProcess.get(processId) ?? [], next)) return;
    if (next.length === 0) byProcess.delete(processId);
    else byProcess.set(processId, next);
    onChange();
  }
  return {
    portsOf: (processId) => [...(byProcess.get(processId) ?? [])],
    setPorts: (groupId, commandId, ports) =>
      setProcessPorts(makeCommandId(groupId, commandId), ports),
    setProcessPorts,
    clear: (processId) => setProcessPorts(processId, []),
  };
}
