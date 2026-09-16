import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  autostartDesktopPath,
  desktopFileContent,
  setLinuxAutostart,
  linuxAutostartPresent,
  wasOpenedAtLoginFromArgv,
  LOGIN_ARG,
  DESKTOP_FILE_NAME,
} from '../src/autostart.js';

const tmpDirs: string[] = [];

function withTempXdgConfigHome<T>(fn: () => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbar-xdg-'));
  tmpDirs.push(dir);
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('desktopFileContent', () => {
  it('renders a valid XDG autostart entry with the --login flag', () => {
    const content = desktopFileContent('/home/u/Apps/DevBar.AppImage');
    expect(content).toContain('[Desktop Entry]');
    expect(content).toContain('Type=Application');
    expect(content).toContain('Name=DevBar');
    expect(content).toContain('Terminal=false');
    expect(content).toContain('X-GNOME-Autostart-enabled=true');
    expect(content).toContain(`Exec=/home/u/Apps/DevBar.AppImage ${LOGIN_ARG}`);
    // Trailing newline so the file ends cleanly.
    expect(content.endsWith('\n')).toBe(true);
  });

  it('quotes an install path containing whitespace (Exec is a desktop string)', () => {
    const content = desktopFileContent('/home/u my app/DevBar.AppImage');
    // Unquoted, the desktop environment would split the path on the
    // space and autostart would launch a nonexistent binary.
    expect(content).toContain(
      `Exec="/home/u my app/DevBar.AppImage" ${LOGIN_ARG}`,
    );
  });
});

describe('autostartDesktopPath', () => {
  it('lives under $XDG_CONFIG_HOME/autostart when set', () => {
    withTempXdgConfigHome(() => {
      expect(autostartDesktopPath()).toBe(
        path.join(process.env.XDG_CONFIG_HOME!, 'autostart', DESKTOP_FILE_NAME),
      );
    });
  });

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
    const previous = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      expect(autostartDesktopPath()).toBe(
        path.join(os.homedir(), '.config', 'autostart', DESKTOP_FILE_NAME),
      );
    } finally {
      if (previous !== undefined) process.env.XDG_CONFIG_HOME = previous;
    }
  });
});

describe('setLinuxAutostart', () => {
  it('creates the file when enabling and removes it when disabling', () => {
    withTempXdgConfigHome(() => {
      expect(linuxAutostartPresent()).toBe(false);
      setLinuxAutostart('/opt/DevBar/DevBar', true);
      expect(linuxAutostartPresent()).toBe(true);
      const written = fs.readFileSync(autostartDesktopPath(), 'utf8');
      expect(written).toContain('Exec=/opt/DevBar/DevBar --login');

      setLinuxAutostart('/opt/DevBar/DevBar', false);
      expect(linuxAutostartPresent()).toBe(false);
      // Idempotent: removing again must not throw.
      setLinuxAutostart('/opt/DevBar/DevBar', false);
      expect(linuxAutostartPresent()).toBe(false);
    });
  });
});

describe('wasOpenedAtLoginFromArgv', () => {
  it('is driven by the --login argument', () => {
    const argv = process.argv;
    argv.push(LOGIN_ARG);
    try {
      expect(wasOpenedAtLoginFromArgv()).toBe(true);
    } finally {
      argv.pop();
    }
    expect(wasOpenedAtLoginFromArgv()).toBe(false);
  });
});
