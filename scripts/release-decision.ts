import process from 'node:process';
import { parseArgs } from 'node:util';
import { isEntrypoint } from './lib/script-runtime.ts';

/**
 * Decides what the release workflow does for the package version currently
 * on the default branch. release.yml gathers the live GitHub state with
 * `gh` and asks this module; keeping the decision here keeps it testable.
 *
 * The rule: publish the current version when it has NO published GitHub
 * Release yet and is strictly greater than the latest published release.
 * The build and the tag always use the run's HEAD. A published release is
 * never touched. A draft or a tag left behind for the current version by a
 * cancelled or failed run is ours and is healed (deleted, then recreated at
 * HEAD by the publish job).
 */

export type ReleaseState = 'none' | 'draft' | 'published';
export type ReleaseEvent = 'push' | 'workflow_dispatch';
/** 'unknown' = no published baseline to compare against (first release). */
export type PendingImpact = 'true' | 'false' | 'unknown';

export type ReleaseDecisionInput = {
  currentVersion: string;
  /** Latest published stable release version, or null when none exists. */
  latestPublishedVersion: string | null;
  /** State of the GitHub Release whose tag is v<currentVersion>. */
  releaseState: ReleaseState;
  /** Commit the v<currentVersion> tag points to, or null when absent. */
  existingTagSha: string | null;
  headSha: string;
  event: ReleaseEvent;
  pendingImpact: PendingImpact;
};

export type ReleaseDecision = {
  /** 'heal' publishes too, after removing this version's leftovers. */
  action: 'publish' | 'heal' | 'skip' | 'fail';
  reason: string;
  /** Delete every draft release for this version before drafting anew. */
  deleteDrafts: boolean;
  /** Delete the existing tag: it points away from HEAD and is unpublished. */
  deleteTag: boolean;
  /** The tag already points to HEAD (so this run did not create it). */
  tagAtHead: boolean;
};

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;

function parseVersion(version: string): [number, number, number] | null {
  const match = STABLE_SEMVER.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when a < b, zero when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) {
    throw new Error(`Not a stable semantic version: ${left ? b : a}`);
  }
  const deltas = left.map((part, index) => part - (right[index] ?? 0));
  return deltas.find((delta) => delta !== 0) ?? 0;
}

function outcome(
  action: ReleaseDecision['action'],
  reason: string,
  extra: Partial<Omit<ReleaseDecision, 'action' | 'reason'>> = {},
): ReleaseDecision {
  return {
    action,
    reason,
    deleteDrafts: false,
    deleteTag: false,
    tagAtHead: false,
    ...extra,
  };
}

export function decideRelease(input: ReleaseDecisionInput): ReleaseDecision {
  const {
    currentVersion,
    latestPublishedVersion,
    releaseState,
    existingTagSha,
    headSha,
    event,
    pendingImpact,
  } = input;

  if (parseVersion(currentVersion) === null) {
    return outcome(
      'fail',
      `${currentVersion} is not a stable semantic version.`,
    );
  }
  if (!COMMIT_SHA.test(headSha)) {
    return outcome('fail', `${headSha} is not a full commit SHA.`);
  }
  if (existingTagSha !== null && !COMMIT_SHA.test(existingTagSha)) {
    return outcome('fail', `${existingTagSha} is not a full commit SHA.`);
  }

  // A published release is immutable history: never rebuild, retag or edit.
  if (releaseState === 'published') {
    return outcome(
      'skip',
      `v${currentVersion} is already published; it is never touched.`,
    );
  }

  if (latestPublishedVersion !== null) {
    if (parseVersion(latestPublishedVersion) === null) {
      return outcome(
        'fail',
        `Latest release ${latestPublishedVersion} is not a stable semantic version.`,
      );
    }
    const order = compareVersions(currentVersion, latestPublishedVersion);
    if (order < 0) {
      return outcome(
        'fail',
        `package.json version ${currentVersion} is lower than the latest published release ${latestPublishedVersion}.`,
      );
    }
    if (order === 0) {
      return outcome(
        'fail',
        `v${currentVersion} is the latest published release but its release could not be resolved by tag.`,
      );
    }
  }

  // Recovery (workflow_dispatch) rebuilds regardless of impact; a push only
  // publishes when release-impacting commits exist since the latest release.
  if (event === 'push' && pendingImpact === 'false') {
    return outcome(
      'skip',
      `No release-impacting commits exist since v${latestPublishedVersion ?? '?'}; installer build skipped.`,
    );
  }

  const deleteDrafts = releaseState === 'draft';
  const tagAtHead = existingTagSha === headSha;
  const deleteTag = existingTagSha !== null && !tagAtHead;
  if (deleteDrafts || deleteTag) {
    const leftovers = [
      deleteDrafts ? 'draft release' : null,
      deleteTag ? `tag at ${existingTagSha}` : null,
    ].filter((item) => item !== null);
    return outcome(
      'heal',
      `v${currentVersion} is unpublished; replacing the leftover ${leftovers.join(' and ')} from an interrupted run with a release of ${headSha}.`,
      { deleteDrafts, deleteTag, tagAtHead },
    );
  }

  return outcome('publish', `Publishing v${currentVersion} from ${headSha}.`, {
    tagAtHead,
  });
}

const RELEASE_STATES = new Set<string>(['none', 'draft', 'published']);
const RELEASE_EVENTS = new Set<string>(['push', 'workflow_dispatch']);
const PENDING_IMPACTS = new Set<string>(['true', 'false', 'unknown']);

function oneOf<T extends string>(
  name: string,
  value: string | undefined,
  allowed: Set<string>,
): T {
  if (value === undefined || !allowed.has(value)) {
    throw new Error(
      `--${name} must be one of: ${[...allowed].join(', ')} (got ${value ?? 'nothing'})`,
    );
  }
  return value as T;
}

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error(`--${name} is required`);
  }
  return value;
}

/** Empty string means "absent" so the workflow can pass `""` verbatim. */
function optional(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

export function main(argv: readonly string[]): ReleaseDecision {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      current: { type: 'string' },
      latest: { type: 'string' },
      state: { type: 'string' },
      'tag-sha': { type: 'string' },
      head: { type: 'string' },
      event: { type: 'string' },
      impact: { type: 'string' },
    },
  });
  return decideRelease({
    currentVersion: required('current', values.current),
    latestPublishedVersion: optional(values.latest),
    releaseState: oneOf<ReleaseState>('state', values.state, RELEASE_STATES),
    existingTagSha: optional(values['tag-sha']),
    headSha: required('head', values.head),
    event: oneOf<ReleaseEvent>('event', values.event, RELEASE_EVENTS),
    pendingImpact: oneOf<PendingImpact>(
      'impact',
      values.impact,
      PENDING_IMPACTS,
    ),
  });
}

if (isEntrypoint(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
