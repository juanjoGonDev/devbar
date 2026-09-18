import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Windows update paths.
 *
 * - INSTALLED apps (NSIS per-user default: `%LOCALAPPDATA%\Programs\DevBar`)
 *   update by running the new oneClick installer AFTER DevBar quits: the
 *   installer replaces the files and relaunches the app itself. The running
 *   exe/DLLs are locked, so no in-process swap is possible — the installer is
 *   the swap.
 * - PORTABLE apps: electron-builder's portable target is a SINGLE self-
 *   extracting .exe the user keeps in any folder. The running app is the
 *   PAYLOAD the stub extracted to a temp folder, so an update targets the
 *   CONTAINER — the stub itself, resolved as the payload's parent process
 *   (`portableContainerPath`) — and swaps it: wait for the process, rename
 *   the old exe aside, copy the new one in, relaunch, roll back on failure
 *   — the same shape as the macOS bundle and Linux AppImage swaps.
 * - Program Files installs update only via the assisted flow: replacing
 *   those files needs elevation, which the app must not silently request.
 */

/**
 * True when the exe sits where a per-user NSIS install puts it:
 * `%LOCALAPPDATA%\Programs\DevBar\DevBar.exe` — an EXACT (case-insensitive)
 * match, because a suffix check would also accept `D:\Programs\...` or
 * `C:\NotPrograms\...` and misroute a portable file through the NSIS flow.
 * `localAppData` is injectable so the check stays testable off Windows.
 */
export function isInstalledExe(
  execPath: string,
  localAppData: string = process.env.LOCALAPPDATA ?? '',
): boolean {
  const name = path.win32.basename(execPath).toLowerCase();
  const dir = path.win32.basename(path.win32.dirname(execPath)).toLowerCase();
  if (name !== 'devbar.exe' || dir !== 'devbar' || !localAppData) return false;
  const expected = path.win32
    .normalize(path.win32.join(localAppData, 'Programs'))
    .toLowerCase();
  const parent = path.win32
    .normalize(path.win32.dirname(path.win32.dirname(execPath)))
    .toLowerCase();
  return parent === expected;
}

/** The two-byte MZ header every Windows PE file carries. */
function looksLikeWindowsExe(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(2);
    if (fs.readSync(fd, buf, 0, 2, 0) < 2) return false;
    return buf.toString('latin1') === 'MZ';
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A running NSIS portable app executes the PAYLOAD that the stub (the
 * portable file the user keeps) extracted into a temp folder, so
 * `process.execPath` of a portable instance is an ephemeral copy. Swapping
 * that copy would not survive the next launch: the container — the stub,
 * i.e. the payload's parent process — is the file an update must replace.
 *
 * Safety: this must never point a swap at a wrong file, so the candidate
 * parent is accepted only when it is a real PE whose name still says
 * "devbar", living outside Program Files (an assisted-only,
 * elevation-requiring location).
 *
 * The gate FAILS CLOSED. Any failure returns null, and winInstalledAppPath
 * (self-update.ts) then returns null as well for a temp-dir execPath — so
 * the caller degrades to the ASSISTED flow ("download the new version
 * yourself"), NOT to a swap of the ephemeral payload, and never to another
 * application's file. Swapping the payload would write an update into a
 * temp copy that dies with the temp dir while the user's real portable
 * file silently stayed on the old version.
 *
 * That is also why the "support portable executables that users rename"
 * review note is a UX LIMITATION, not a bug, and should not be reopened:
 * a portable stub renamed to something without "devbar" in it is simply
 * not recognized, and the user gets the assisted flow instead of a wrong
 * or useless swap. Widening the name check is the only way to change that,
 * and it would trade a fail-closed gate for a guess at which neighbouring
 * executable is ours.
 */

/**
 * The 64-bit and 32-bit install roots, by NAME — the same literals this
 * module has always compared against. Deliberately not read from
 * `%ProgramFiles%` / `%ProgramFiles(x86)%`: matching the first directory
 * under the path's own root covers a Windows installed on any drive, and
 * keeps the gate testable off Windows, where those variables do not exist.
 */
const PROGRAM_FILES_ROOTS = ['program files', 'program files (x86)'];

/**
 * True when `candidate` lives anywhere under a Program Files root: a direct
 * child (`C:\Program Files\DevBarPortable.exe`) or nested any number of
 * levels down (`C:\Program Files\Tools\DevBar\DevBarPortable.exe`).
 *
 * CONTAINMENT, not a fixed-depth basename comparison. The previous check
 * looked exactly two levels up, so it only ever saw the root for one
 * particular depth: anything deeper compared a middle directory instead and
 * an installed exe was accepted as a portable container — routing an
 * elevation-requiring location through the swap, whose rollback cannot help
 * when `move` fails before the backup exists (no backup, nothing relaunched,
 * and the app has already quit).
 *
 * WHOLE segments only, so `C:\Program FilesX\...` is not contained; both
 * separators are handled (`path.win32.normalize` folds `/` into `\`) and the
 * comparison is case-insensitive, as Windows itself is.
 */
export function isUnderProgramFiles(candidate: string): boolean {
  const normalized = path.win32.normalize(candidate);
  const { root } = path.win32.parse(normalized);
  // A relative path has no root to be contained by.
  if (!root) return false;
  const first = normalized
    .slice(root.length)
    .split('\\')
    .find((segment) => segment.length > 0);
  return (
    first !== undefined && PROGRAM_FILES_ROOTS.includes(first.toLowerCase())
  );
}

/** Pure gate: is `parentPath` a plausible portable container for `execPath`? */
export function isPortableContainer(
  execPath: string,
  parentPath: string | null,
): boolean {
  if (!parentPath) return false;
  const parent = parentPath.toLowerCase();
  if (parent === execPath.toLowerCase()) return false;
  if (!path.win32.basename(parent).includes('devbar')) return false;
  // Both Program Files roots, at any depth, are assisted-only.
  return !isUnderProgramFiles(parentPath);
}

let portableContainerCache: {
  execPath: string;
  container: string | null;
} | null = null;

/**
 * The portable file a running portable app was extracted from, or null when
 * this is not a portable instance (or it cannot be established). Resolved
 * once per process and cached: the answer is stable for the app's lifetime.
 */
/** True when the path lives under the system temp dir (a portable NSIS
 *  stub extracts its payload there, so a temp-dir execPath is a portable
 *  candidate). Separator-aware: Windows tmpdirs end in `\`, POSIX ones
 *  don't. */
export function isUnderTempDir(execPath: string): boolean {
  const tmp = os.tmpdir().toLowerCase();
  const sep = tmp.includes('\\') ? '\\' : '/';
  const tmpPrefix = tmp.endsWith(sep) ? tmp : `${tmp}${sep}`;
  return execPath.toLowerCase().startsWith(tmpPrefix);
}

export function portableContainerPath(execPath: string): string | null {
  if (process.platform !== 'win32') return null;
  if (portableContainerCache?.execPath === execPath)
    return portableContainerCache.container;
  const result: string | null = (() => {
    try {
      // Only a payload extracted under the temp dir can be a portable
      // instance; every other case short-circuits without a process query.
      if (!isUnderTempDir(execPath)) return null;
      const ppid = process.ppid;
      if (!ppid || ppid <= 1) return null;
      // wmic is gone from current Windows images; CIM via powershell is
      // the portable way to ask "which exe is my parent".
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${ppid}" -ErrorAction Stop).ExecutablePath`,
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          timeout: 10000,
        },
      );
      const parentPath =
        out
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .find((line) => line.length > 0) ?? null;
      if (!parentPath || !isPortableContainer(execPath, parentPath))
        return null;
      // The gate says "plausible"; only a real PE is a target for a swap.
      return looksLikeWindowsExe(parentPath) ? parentPath : null;
    } catch {
      return null; // parent already gone, query failed — degrade safely
    }
  })();
  portableContainerCache = { execPath, container: result };
  return result;
}

export function stageWindowsArtifact({
  filePath,
  destDir,
  fileName,
}: {
  filePath: string;
  destDir: string;
  fileName: string;
}): string {
  // Both the NSIS installer and the portable app are PE executables.
  if (!looksLikeWindowsExe(filePath))
    throw new Error('la descarga no parece un ejecutable de Windows válido');
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const staged = path.join(destDir, fileName);
  fs.copyFileSync(filePath, staged);
  return staged;
}

const BAT_ENV_CLEAR_LINES = [
  'rem The relaunch must never re-enter a CI simulation: clear the',
  'rem update/hold env the app was run with (relaunch args, if any,',
  'rem re-enable plain smoke explicitly).',
  'set "DEVBAR_SMOKE="',
  'set "DEVBAR_SMOKE_HOLD="',
  'set "DEVBAR_SMOKE_UPDATE="',
  'set "DEVBAR_SMOKE_ARTIFACT="',
  'set "DEVBAR_SMOKE_SHA="',
  'set "DEVBAR_SMOKE_VERSION="',
];

/**
 * Double literal percent signs for .bat embedding. cmd.exe expands `%x%`
 * expressions on EVERY batch line before executing it — including the
 * `set "name=value"` lines that STORE these values — so a literal `%` in
 * a path or argument would be consumed before assignment or use.
 */
const batPct = (value: string): string => value.replaceAll('%', '%%');

/** Double-quote for .bat embedding, doubling any inner quote AND percent. */
function batQuote(value: string): string {
  return `"${batPct(value).replaceAll('"', '""')}"`;
}

/**
 * Bounded "wait until our pid is gone" prologue shared by both bats. The
 * swap must never touch a file a live process holds, so both the portable
 * swap and the NSIS install wait for the app to actually exit first.
 *
 * The check is deliberately PIPE-FREE: `tasklist | find` has been observed
 * hanging in the hidden detached context these bats run in (find waits for
 * an EOF that never comes, and the bat sits in the wait loop forever).
 * tasklist writes to a file, findstr scans the file — no pipe, no console.
 * `ping` paces the loop because `timeout` also wants a console.
 */
const PID_WAIT_LINES = (pid: number): string[] => [
  'set /a tries=0',
  ':wait',
  `tasklist /fi "PID eq ${pid}" /fo csv > "%~dp0devbar-pid.tmp" 2>nul`,
  'findstr /i "DevBar" "%~dp0devbar-pid.tmp" >nul 2>&1',
  'if errorlevel 1 goto :pidgone',
  'set /a tries+=1',
  'if %tries% geq 150 (',
  '  echo [%date% %time%] giving up: old pid still present >> "%log%"',
  '  del /q "%~dp0devbar-pid.tmp" 2>nul',
  '  exit /b 1',
  ')',
  'ping -n 2 127.0.0.1 >nul',
  'goto :wait',
  ':pidgone',
  'del /q "%~dp0devbar-pid.tmp" 2>nul',
];

/**
 * Portable exe swap. Waits (bounded) for the old process, moves the file
 * aside, copies the new one into place, relaunches. A failed copy rolls the
 * old file back and relaunches it, so the user never ends up with no DevBar
 * at all.
 *
 * `relaunchArgs` and `markerPath` are CI conveniences (both optional, and
 * null in production): the relaunch receives the given arguments (the
 * `--devbar-smoke` proof of life, for example) and a success marker is
 * written once the swap has completed.
 */
export function buildSwapBat({
  pid,
  target,
  staged,
  relaunchArgs,
  markerPath,
}: {
  pid: number;
  target: string;
  staged: string;
  relaunchArgs?: string[] | null | undefined;
  markerPath?: string | null | undefined;
}): string {
  const args = (relaunchArgs ?? []).map((a) => batQuote(a)).join(' ');
  const relaunch = args ? `start "" "%target%" ${args}` : `start "" "%target%"`;
  const markerLine = markerPath ? `echo ok> ${batQuote(markerPath)} 2>nul` : '';
  return [
    '@echo off',
    'setlocal',
    // NO quotes inside the stored value: `set "name=value"` keeps
    // everything to the final quote as the value, and the later `"%var%"`
    // expansions add their own pair. batQuote here would embed literal
    // quotes in %target%, producing double-quoted (broken) paths —
    // exactly the case with a space in the directory.
    `set "target=${batPct(target)}"`,
    `set "staged=${batPct(staged)}"`,
    // (batPct: a literal % in a path would be expanded by cmd.exe on the SET line itself)
    'set "backup=%target%.devbar-old"',
    'set "log=%~dp0swap.log"',
    'echo [%date% %time%] swap bat started >> "%log%"',
    ...BAT_ENV_CLEAR_LINES,
    ...PID_WAIT_LINES(pid),
    'echo [%date% %time%] pid gone, swapping >> "%log%"',
    'rem let the GPU/render helper processes wind down before we move the file',
    'ping -n 3 127.0.0.1 >nul',
    ':swap',
    'del /f /q "%backup%" 2>nul',
    // Command output goes to the trace: a swap failure must say WHY (access
    // denied, path problem, lock), not just that it happened.
    'move /y "%target%" "%backup%" >> "%log%" 2>&1 || goto :fail',
    'copy /y "%staged%" "%target%" >> "%log%" 2>&1 || goto :fail',
    'del /f /q "%backup%" 2>nul',
    ...(markerLine ? [markerLine] : []),
    'echo [%date% %time%] swap done, relaunching >> "%log%"',
    relaunch,
    'exit /b 0',
    ':fail',
    'echo [%date% %time%] swap failed, rolling back >> "%log%"',
    'if exist "%backup%" (',
    '  del /f /q "%target%" 2>nul',
    '  move /y "%backup%" "%target%"',
    '  start "" "%target%"',
    ')',
    'exit /b 1',
    '',
  ].join('\r\n');
}

/**
 * Launch a .bat detached through an explicit `cmd.exe /d /c`. Node's
 * implicit .bat wrapping has been seen to fail with `spawn EINVAL` on CI
 * runners; running cmd.exe (a real PE) directly is the stable form.
 *
 * The bat path is passed UNQUOTED: Node quotes it exactly once when it
 * builds the command line, and `cmd /c` (without /s) reduces that single
 * quoted token to the path itself, so spaced paths reach the bat intact.
 * No /s: with it, cmd strips the first and last quote character of the
 * WHOLE /c string, so any extra quoting (a path that itself contains a
 * quote) would be mangled beyond recovery. Pre-quoting here would leave a
 * dangling quote after cmd's reduction and the bat would silently never
 * run — verified on CI.
 */
function spawnBat(scriptPath: string): void {
  // `||`, not `??`: `??` only catches undefined, so COMSPEC="" would
  // reach spawn('') — the swap bat would never launch, and since the app
  // quits straight after, the user would be left with no update and no
  // relaunch. platform.ts reads the same variable the same way.
  const comspec = process.env.COMSPEC || 'cmd.exe';
  spawn(comspec, ['/d', '/c', scriptPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

/** Write the bat and launch it detached (hidden console). Caller quits. */
export function spawnSwapBat({
  scriptPath,
  pid,
  target,
  staged,
  relaunchArgs,
  markerPath,
}: {
  scriptPath: string;
  pid: number;
  target: string;
  staged: string;
  relaunchArgs?: string[] | null | undefined;
  markerPath?: string | null | undefined;
}): void {
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    buildSwapBat({ pid, target, staged, relaunchArgs, markerPath }),
  );
  spawnBat(scriptPath);
}

/**
 * NSIS install + relaunch bat. The running exe and its DLLs stay locked
 * until the process has fully exited, so the installer must wait for our
 * pid first — launching it immediately would race the quit and can fail to
 * replace a locked file. The oneClick installer then upgrades in place.
 *
 * The RELAUNCH is the bat's own job, not the installer's: the installer's
 * "run after finish" has been observed to fire only in interactive contexts
 * and silently no-op in the hidden detached one this bat runs in. Relaunching
 * here makes the outcome deterministic on both paths (if the installer ALSO
 * relaunches in some context, the single-instance lock makes the second
 * launch a harmless no-op).
 */
export function buildInstallerBat({
  pid,
  installer,
  target,
  relaunchArgs,
  markerPath,
}: {
  pid: number;
  installer: string;
  target: string;
  relaunchArgs?: string[] | null | undefined;
  markerPath?: string | null | undefined;
}): string {
  const args = (relaunchArgs ?? []).map((a) => batQuote(a)).join(' ');
  const relaunch = args ? `start "" "%target%" ${args}` : `start "" "%target%"`;
  // Same contract as buildSwapBat: the marker proves the update FINISHED
  // (installer ok + relaunch issued) — CI smoke runs wait on it.
  const markerLine = markerPath ? `echo ok> ${batQuote(markerPath)} 2>nul` : '';
  return [
    '@echo off',
    'setlocal',
    // NO quotes inside the stored value (same rule as buildSwapBat):
    // `set "name=value"` keeps everything to the final quote as the
    // value, and the later `start "" "%target%"` adds its own pair.
    `set "target=${batPct(target)}"`,
    'set "log=%~dp0install.log"',
    'echo [%date% %time%] installer bat started (waiting for old pid) >> "%log%"',
    ...BAT_ENV_CLEAR_LINES,
    ...PID_WAIT_LINES(pid),
    'echo [%date% %time%] pid gone, launching installer >> "%log%"',
    'rem let the GPU/render helper processes release their file locks',
    'ping -n 3 127.0.0.1 >nul',
    // Run the installer directly: a plain PE launch that also yields the
    // installer's exit code for the log.
    `${batQuote(installer)} /S`,
    'if not errorlevel 1 goto :relaunch',
    'rem one retry: a lingering helper process may still hold a file lock',
    'ping -n 5 127.0.0.1 >nul',
    `${batQuote(installer)} /S`,
    'if not errorlevel 1 goto :relaunch',
    'echo [%date% %time%] installer FAILED with code %errorlevel%, not relaunching >> "%log%"',
    'exit /b 1',
    ':relaunch',
    'echo [%date% %time%] installer done, relaunching app >> "%log%"',
    relaunch,
    ...(markerLine ? [markerLine] : []),
    'exit /b 0',
    '',
  ].join('\r\n');
}

/** Write the bat and launch it detached (hidden console). Caller quits. */
export function spawnInstallerBat({
  scriptPath,
  pid,
  installer,
  target,
  relaunchArgs,
  markerPath,
}: {
  scriptPath: string;
  pid: number;
  installer: string;
  target: string;
  relaunchArgs?: string[] | null | undefined;
  markerPath?: string | null | undefined;
}): void {
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    buildInstallerBat({ pid, installer, target, relaunchArgs, markerPath }),
  );
  spawnBat(scriptPath);
}
