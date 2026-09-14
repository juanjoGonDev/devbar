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
export function looksLikeWindowsExe(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(2);
    if (fs.readSync(fd, buf, 0, 2, 0) < 2) return false;
    return buf.toString('latin1') === 'MZ';
  } finally {
    fs.closeSync(fd);
  }
}

/** `PK` zip magic (an HTML error page or a truncated download is neither). */
export function looksLikeZip(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(2);
    if (fs.readSync(fd, buf, 0, 2, 0) < 2) return false;
    return buf.toString('latin1') === 'PK';
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

/** Double-quote for .bat embedding, doubling any inner quote. */
function batQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Portable exe swap. Waits (bounded) for the old process, moves the file
 * aside, copies the new one into place, relaunches. A failed copy rolls the
 * old file back and relaunches it, so the user never ends up with no DevBar
 * at all.
 */
export function buildSwapBat({
  pid,
  target,
  staged,
}: {
  pid: number;
  target: string;
  staged: string;
}): string {
  return [
    '@echo off',
    'setlocal',
    `set "target=${batQuote(target)}"`,
    `set "staged=${batQuote(staged)}"`,
    'set "backup=%target%.devbar-old"',
    'set /a tries=0',
    ':wait',
    `tasklist /fi "PID eq ${pid}" /fo csv | find /i "DevBar" >nul`,
    'if not errorlevel 1 (',
    '  set /a tries+=1',
    '  if %tries% geq 120 exit /b 1',
    '  timeout /t 1 /nobreak >nul',
    '  goto :wait',
    ')',
    'rem let the GPU/render helper processes wind down before we move the file',
    'timeout /t 2 /nobreak >nul',
    ':swap',
    'del /f /q "%backup%" 2>nul',
    'move /y "%target%" "%backup%" || goto :fail',
    'copy /y "%staged%" "%target%" || goto :fail',
    'del /f /q "%backup%" 2>nul',
    'start "" "%target%"',
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
}: {
  scriptPath: string;
  pid: number;
  target: string;
  staged: string;
}): void {
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, buildSwapBat({ pid, target, staged }));
  spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', scriptPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

/**
 * Launch the oneClick NSIS installer silent and detached. With DevBar quit,
 * the installer upgrades in place and relaunches the app by default.
 */
export function spawnInstaller(installerPath: string): void {
  spawn(
    process.env.ComSpec || 'cmd.exe',
    ['/d', '/c', 'start', '""', '/wait', installerPath, '/S'],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  ).unref();
}
