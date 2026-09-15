import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  desktopApplicationsDir,
  desktopLauncherPath,
  findAppIcon,
  lnkCommand,
  renderDesktopEntry,
  startMenuLnkPath,
  startMenuProgramsDir,
  DESKTOP_FILE_NAME,
} from '../scripts/launcher.js';

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function withEnvVar<T>(name: string, value: string, fn: () => T): T {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('renderDesktopEntry', () => {
  it('renders a valid XDG application entry with the exact executable', () => {
    const content = renderDesktopEntry('/home/u/.local/share/DevBar/devbar');
    expect(content).toContain('[Desktop Entry]');
    expect(content).toContain('Type=Application');
    expect(content).toContain('Name=DevBar');
    expect(content).toContain(`Exec=/home/u/.local/share/DevBar/devbar`);
    expect(content).toContain('Terminal=false');
    expect(content).toContain('Categories=Development;Utility;');
    expect(content).not.toContain('Icon=');
    expect(content.endsWith('\n')).toBe(true);
  });

  it('includes the icon line only when an icon path is given', () => {
    const withIcon = renderDesktopEntry(
      '/home/u/.local/share/DevBar/devbar',
      '/home/u/.local/share/DevBar/resources/icon.png',
    );
    expect(withIcon).toContain(
      'Icon=/home/u/.local/share/DevBar/resources/icon.png',
    );
  });

  it('quotes paths containing whitespace per the Desktop Entry spec', () => {
    const content = renderDesktopEntry(
      '/home/u my name/.local/share/DevBar/devbar',
      '/home/u my name/.local/share/DevBar/resources/icon.png',
    );
    expect(content).toContain(
      `Exec="/home/u my name/.local/share/DevBar/devbar"`,
    );
    expect(content).toContain(
      `Icon="/home/u my name/.local/share/DevBar/resources/icon.png"`,
    );
  });
});

describe('desktopLauncherPath', () => {
  it('lives under $XDG_DATA_HOME/applications when set', () => {
    withEnvVar('XDG_DATA_HOME', '/custom/data', () => {
      expect(desktopApplicationsDir()).toBe(
        path.join('/custom/data', 'applications'),
      );
      expect(desktopLauncherPath()).toBe(
        path.join('/custom/data', 'applications', DESKTOP_FILE_NAME),
      );
    });
  });

  it('ignores an empty XDG_DATA_HOME and falls back to ~/.local/share', () => {
    withEnvVar('XDG_DATA_HOME', '', () => {
      expect(desktopLauncherPath()).toBe(
        path.join(
          os.homedir(),
          '.local',
          'share',
          'applications',
          DESKTOP_FILE_NAME,
        ),
      );
    });
  });
});

describe('startMenuLnkPath', () => {
  it('lives under %APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs', () => {
    withEnvVar('APPDATA', 'C:\\Users\\u\\AppData\\Roaming', () => {
      expect(startMenuProgramsDir()).toBe(
        path.join(
          'C:\\Users\\u\\AppData\\Roaming',
          'Microsoft',
          'Windows',
          'Start Menu',
          'Programs',
        ),
      );
      expect(startMenuLnkPath()).toBe(
        path.join(
          'C:\\Users\\u\\AppData\\Roaming',
          'Microsoft',
          'Windows',
          'Start Menu',
          'Programs',
          'DevBar.lnk',
        ),
      );
    });
  });
});

describe('lnkCommand', () => {
  const lnk =
    'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\DevBar.lnk';
  const target = 'C:\\Users\\u\\AppData\\Local\\Programs\\DevBar\\DevBar.exe';
  const workDir = 'C:\\Users\\u\\AppData\\Local\\Programs\\DevBar';

  it('creates the shortcut with target, working dir and Save', () => {
    const cmd = lnkCommand(lnk, target, workDir);
    expect(cmd).toContain('New-Object -ComObject WScript.Shell');
    expect(cmd).toContain(`CreateShortcut('${lnk}')`);
    expect(cmd).toContain(`TargetPath = '${target}'`);
    expect(cmd).toContain(`WorkingDirectory = '${workDir}'`);
    expect(cmd).toContain('$l.Save()');
    expect(cmd).not.toContain('IconLocation');
  });

  it('adds the icon location only when an icon is given', () => {
    const withIcon = lnkCommand(
      lnk,
      target,
      workDir,
      'C:\\Users\\u\\AppData\\Local\\Programs\\DevBar\\resources\\icon.ico',
    );
    expect(withIcon).toContain(
      `IconLocation = 'C:\\Users\\u\\AppData\\Local\\Programs\\DevBar\\resources\\icon.ico,0'`,
    );
  });

  it('doubles single quotes inside paths (PowerShell escaping)', () => {
    const cmd = lnkCommand(lnk, "C:\\Users\\o'ne\\DevBar.exe", workDir);
    expect(cmd).toContain("TargetPath = 'C:\\Users\\o''ne\\DevBar.exe'");
  });
});

describe('findAppIcon', () => {
  it('finds the icon under resources/', () => {
    const dir = makeTempDir('devbar-icon-');
    fs.mkdirSync(path.join(dir, 'resources'));
    const icon = path.join(dir, 'resources', 'icon.png');
    fs.writeFileSync(icon, 'png');
    expect(findAppIcon(dir, '.png')).toBe(icon);
  });

  it('finds a top-level icon as fallback', () => {
    const dir = makeTempDir('devbar-icon-');
    const icon = path.join(dir, 'icon.ico');
    fs.writeFileSync(icon, 'ico');
    expect(findAppIcon(dir, '.ico')).toBe(icon);
  });

  it('returns null when no icon exists', () => {
    const dir = makeTempDir('devbar-icon-');
    expect(findAppIcon(dir, '.png')).toBeNull();
  });
});
