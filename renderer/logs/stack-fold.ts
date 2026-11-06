/**
 * Stack traces, folded under the line they belong to.
 *
 * A crash prints one message and then a dozen frames nobody reads twice; left
 * flat they push the next real line off screen. Consecutive continuation lines
 * — `    at …` (Node), `\tat …` / `... N more` (Java), `File "…", line N`
 * (Python), and the indented, caret and blank lines that ride along once a
 * stack is open — form a block under the line just before them, drawn
 * collapsed as «+N líneas de stack».
 *
 * The grouping is pure (`isStackLine`, `groupStacks`); the index below keys
 * blocks by entry OBJECT rather than position, so trimming the buffer never
 * rebases it, and whether a block is open is keyed by its head entry, so it
 * survives repaints and rebuilds of the index alike. Nothing here touches the
 * DOM: filtering, silencing and the search still see every line of a block,
 * because folding only decides how a drawn row looks.
 */
import { stripAnsi } from './ansi.js';
import type { LogEntry } from '../../src/domain-types.js';
import type { SourcedLogEntry } from '../../src/ipc-contract.js';

/** Fewer lines than this are shown as they are: folding one frame saves nothing. */
export const MIN_FOLD = 2;

// A frame opens a stack on its own, wherever it appears.
const FRAME =
  /^(?:\s+at\s|\s*File ".*", line \d+|\s*\.\.\. \d+ (?:more|common frames omitted))/;
const BLANK_OR_CARET = /^\s*\^*\s*$/;
const INDENTED = /^\s+\S/;

/**
 * Whether `text` continues a stack. `open`: the line before it already did;
 * `afterError`: the line before it is an error, whose `^` caret or trailing
 * blank line belongs with it.
 */
export function isStackLine(
  text: string,
  open: boolean,
  afterError: boolean,
): boolean {
  const plain = stripAnsi(text);
  if (FRAME.test(plain)) return true;
  if (BLANK_OR_CARET.test(plain)) return open || afterError;
  return open && INDENTED.test(plain);
}

export interface StackInput {
  text: string;
  error: boolean;
}

/** A block: the line it hangs from, and its first and last continuation. */
export interface StackRun {
  head: number;
  start: number;
  end: number;
}

/** Every block in `lines`, in order. A continuation needs a line to follow. */
export function groupStacks(lines: readonly StackInput[]): StackRun[] {
  const out: StackRun[] = [];
  let current: StackRun | null = null;
  for (let i = 1; i < lines.length; i += 1) {
    const prev = lines[i - 1] as StackInput;
    const here = lines[i] as StackInput;
    if (isStackLine(here.text, current !== null, prev.error)) {
      if (current) current.end = i;
      else {
        current = { head: i - 1, start: i, end: i };
        out.push(current);
      }
    } else current = null;
  }
  return out;
}

export interface StackBlock {
  head: LogEntry;
  /** The continuation lines, in order — consecutive in the buffer. */
  members: LogEntry[];
}

let blockOf = new WeakMap<LogEntry, StackBlock>();
/** Heads of the blocks someone opened. */
const opened = new WeakSet<LogEntry>();

function sourceOf(entry: LogEntry): string | undefined {
  return (entry as SourcedLogEntry).srcId;
}

/**
 * Index one line given the line before it — for a line that just arrived.
 * Lines of two different services in a merged view never join one block.
 */
export function indexStackEntry(
  prev: LogEntry | undefined,
  entry: LogEntry,
): void {
  if (!prev || sourceOf(prev) !== sourceOf(entry)) return;
  const open = blockOf.get(prev);
  const afterError = (prev.originalLevel ?? prev.level) === 'error';
  if (!isStackLine(entry.line, open !== undefined, afterError)) return;
  if (open) {
    open.members.push(entry);
    blockOf.set(entry, open);
  } else blockOf.set(entry, { head: prev, members: [entry] });
}

/** Rebuild the index over a fresh set of lines (a snapshot, a scope switch). */
export function indexStacks(entries: readonly LogEntry[]): void {
  blockOf = new WeakMap();
  for (let i = 0; i < entries.length; i += 1)
    indexStackEntry(entries[i - 1], entries[i] as LogEntry);
}

export function stackOf(entry: LogEntry): StackBlock | undefined {
  return blockOf.get(entry);
}

/** Drawn collapsed: big enough to be worth folding, and not opened. */
export function isFolded(block: StackBlock): boolean {
  return block.members.length >= MIN_FOLD && !opened.has(block.head);
}

export function toggleStack(block: StackBlock): void {
  if (opened.has(block.head)) opened.delete(block.head);
  else opened.add(block.head);
}
