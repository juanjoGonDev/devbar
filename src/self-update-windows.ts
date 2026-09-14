import { spawn } from 'node:child_process';
import fs from 'node:fs';
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
 *   extracting .exe the user keeps in any folder. Updating one is a plain
 *   file swap: wait for the process, rename the old exe aside, copy the new
 *   one in, relaunch, roll back on failure — the same shape as the macOS
 *   bundle and Linux AppImage swaps.
 * - Program Files installs update only via the assisted flow: replacing
 *   those files needs elevation, which the app must not silently request.
 */

/** True when the exe sits where a per-user NSIS install puts it. */
export function isInstalledExe(execPath: string): boolean {
  const name = path.win32.basename(execPath).toLowerCase();
  const dir = path.win32.basename(path.win32.dirname(execPath)).toLowerCase();
  const parent = path.win32.dirname(path.win32.dirname(execPath)).toLowerCase();
  return (
    name === 'devbar.exe' && dir === 'devbar' && parent.endsWith('programs')
  );
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

/** Double-quote for .bat embedding, doubling any inner quote. */
function batQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Bounded "wait until our pid is gone" prologue shared by both bats. The
 * swap must never touch a file a live process holds, so both the portable
 * swap and the NSIS install wait for the app to actually exit first.
 */
const PID_WAIT_LINES = (pid: number): string[] => [
  'set /a tries=0',
  ':wait',
  `tasklist /fi "PID eq ${pid}" /fo csv | find /i "DevBar" >nul`,
  'if not errorlevel 1 (',
  '  set /a tries+=1',
  '  if %tries% geq 120 exit /b 1',
  '  timeout /t 1 /nobreak >nul',
  '  goto :wait',
  ')',
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
    `set "target=${batQuote(target)}"`,
    `set "staged=${batQuote(staged)}"`,
    'set "backup=%target%.devbar-old"',
    ...BAT_ENV_CLEAR_LINES,
    ...PID_WAIT_LINES(pid),
    'rem let the GPU/render helper processes wind down before we move the file',
    'timeout /t 2 /nobreak >nul',
    ':swap',
    'del /f /q "%backup%" 2>nul',
    'move /y "%target%" "%backup%" || goto :fail',
    'copy /y "%staged%" "%target%" || goto :fail',
    'del /f /q "%backup%" 2>nul',
    ...(markerLine ? [markerLine] : []),
    relaunch,
    'exit /b 0',
    ':fail',
    'if exist "%backup%" (',
    '  del /f /q "%target%" 2>nul',
    '  move /y "%backup%" "%target%"',
    '  start "" "%target%"',
    ')',
    'exit /b 1',
    '',
  ].join('\r\n');
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
  // Spawn the .bat directly: Node transparently runs it through cmd.exe,
  // without any shell string built from untrusted path components.
  spawn(scriptPath, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

/**
 * NSIS install prologue. The running exe and its DLLs stay locked until the
 * process has fully exited, so the installer must wait for our pid first —
 * launching it immediately would race the quit and can fail to replace a
 * locked file. The oneClick installer then upgrades in place and relaunches
 * the app by default.
 */
export function buildInstallerBat({
  pid,
  installer,
}: {
  pid: number;
  installer: string;
}): string {
  return [
    '@echo off',
    'setlocal',
    ...BAT_ENV_CLEAR_LINES,
    ...PID_WAIT_LINES(pid),
    'rem let the GPU/render helper processes release their file locks',
    'timeout /t 2 /nobreak >nul',
    `start "" ${batQuote(installer)} /S`,
    'exit /b 0',
    '',
  ].join('\r\n');
}

/** Write the bat and launch it detached (hidden console). Caller quits. */
export function spawnInstallerBat({
  scriptPath,
  pid,
  installer,
}: {
  scriptPath: string;
  pid: number;
  installer: string;
}): void {
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, buildInstallerBat({ pid, installer }));
  spawn(scriptPath, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

/**
 * Launch the oneClick NSIS installer silent and detached. With DevBar quit,
 * the installer upgrades in place and relaunches the app by default.
 * (Kept for direct callers; the updater itself goes through
 * spawnInstallerBat, which waits for the old process first.)
 */
export function spawnInstaller(installerPath: string): void {
  // Spawn the installer exe directly with its silent flag — no shell.
  spawn(installerPath, ['/S'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}
