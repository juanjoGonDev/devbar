import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  desktopApplicationsDir,
  desktopLauncherPath,
  ensureInstallIcon,
  findAppIcon,
  lnkCommand,
  pickRepoIcon,
  renderDesktopEntry,
  startMenuLnkPath,
  startMenuProgramsDir,
  DESKTOP_FILE_NAME,
} from '../scripts/register-launcher.js';

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

  it('quotes the Exec path and emits Icon as an iconstring', () => {
    const content = renderDesktopEntry(
      '/home/u my name/.local/share/DevBar/devbar',
      '/home/u my name/.local/share/DevBar/resources/icon.png',
    );
    // Exec is a desktop string: double-quoted.
    expect(content).toContain(
      `Exec="/home/u my name/.local/share/DevBar/devbar"`,
    );
    // Icon is an iconstring: NOT double-quoted — whitespace is escaped
    // as \s per the Desktop Entry spec.
    expect(content).toContain(
      'Icon=/home/u\\smy\\sname/.local/share/DevBar/resources/icon.png',
    );
  });

  it('escapes backslashes and ; in the icon path (icon-list separator)', () => {
    const content = renderDesktopEntry(
      '/home/u/devbar',
      '/home/u/dir\\x;a/icon.png',
    );
    expect(content).toContain('Icon=/home/u/dir\\\\x\\;a/icon.png');
  });

  it('quotes a lone backslash and doubles it to FOUR (string unescape runs before quote unescape)', () => {
    // A backslash is special in Exec even unquoted: it would escape the
    // following character, so the value must be quoted — and a literal \
    // needs FOUR backslashes in the file, because the generic string
    // unescape (\\ -> \) runs BEFORE the quoting unescape.
    const content = renderDesktopEntry('/home/u/odd\\path/devbar');
    expect(content).toContain(`Exec="/home/u/odd\\\\\\\\path/devbar"`);
  });

  it('escapes newline, tab and carriage return so Exec stays one line', () => {
    // A key file is line-based: emitted raw, a newline would end the Exec=
    // line and the rest of the path would be read as a second key — an
    // extra Exec= that the desktop environment would launch instead.
    const content = renderDesktopEntry('/home/u/a\nExec=/evil\tb\rc/devbar');
    expect(content).toContain(`Exec="/home/u/a\\nExec=/evil\\tb\\rc/devbar"`);
    const execLines = content
      .split('\n')
      .filter((line) => line.startsWith('Exec='));
    expect(execLines).toHaveLength(1);
  });

  it('doubles literal % (field codes are expanded after unquoting)', () => {
    // Unquoted % would be read as a field-code start (%u, %f, …).
    const content = renderDesktopEntry('/home/u/a%ub/devbar');
    expect(content).toContain('Exec=/home/u/a%%ub/devbar');
    // Inside a quoted value the % is doubled too.
    const quoted = renderDesktopEntry('/home/u/my %u app/devbar');
    expect(quoted).toContain(`Exec="/home/u/my %%u app/devbar"`);
  });

  it('quotes reserved characters beyond whitespace (no escaping inside quotes)', () => {
    // & ; ( ) etc. are reserved in Exec: unquoted they would be parsed as
    // command separators / field codes — so the value must be quoted,
    // though inside the quotes they need no backslash.
    const content = renderDesktopEntry('/home/u/a&b;c(d)/devbar');
    expect(content).toContain(`Exec="/home/u/a&b;c(d)/devbar"`);
  });

  it('escapes backslash, dollar, backtick and quote inside quoted values', () => {
    const tricky = '/home/u/a \\b$c`d"x/devbar'; // \ $ ` " and a space
    const content = renderDesktopEntry(tricky);
    expect(content).toContain(
      `Exec="/home/u/a \\\\\\\\b\\$c` + '\\' + '`' + `d\\"x/devbar"`,
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

  it('ignores a RELATIVE XDG_DATA_HOME (the XDG spec requires absolute paths)', () => {
    // A relative value would resolve against the process CWD — the
    // launcher would land in some random ./foo/applications while the
    // install reports success, so it must fall back to the default.
    withEnvVar('XDG_DATA_HOME', 'relative/data', () => {
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
  // The Windows branch only ever runs on win32, where path.isAbsolute IS
  // path.win32.isAbsolute. This suite also runs on POSIX CI, where a
  // `C:\…` literal is NOT absolute and would be rejected by the guard —
  // so the fixture uses a value that is absolute under both.
  const appData = path.join(path.sep, 'Users', 'u', 'AppData', 'Roaming');

  it('lives under %APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs', () => {
    withEnvVar('APPDATA', appData, () => {
      expect(startMenuProgramsDir()).toBe(
        path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      );
      expect(startMenuLnkPath()).toBe(
        path.join(
          appData,
          'Microsoft',
          'Windows',
          'Start Menu',
          'Programs',
          'DevBar.lnk',
        ),
      );
    });
  });

  it.each([
    ['empty', ''],
    ['relative', path.join('relative', 'roaming')],
  ])(
    'ignores an %s APPDATA and falls back to ~/AppData/Roaming',
    (_label, value) => {
      // `??` alone would let the empty string through and
      // path.join('', 'Microsoft', …) yields a RELATIVE path resolved
      // against the process CWD — the shortcut would land in the
      // checkout while the install still reports success.
      withEnvVar('APPDATA', value, () => {
        expect(startMenuProgramsDir()).toBe(
          path.join(
            os.homedir(),
            'AppData',
            'Roaming',
            'Microsoft',
            'Windows',
            'Start Menu',
            'Programs',
          ),
        );
      });
    },
  );
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

describe('pickRepoIcon', () => {
  it('prefers the largest PNG in buildResources/icons', () => {
    const root = makeTempDir('devbar-repo-');
    fs.mkdirSync(path.join(root, 'buildResources', 'icons'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, 'buildResources', 'icons', '64.png'),
      '64',
    );
    fs.writeFileSync(
      path.join(root, 'buildResources', 'icons', '256.png'),
      '256',
    );
    expect(pickRepoIcon(root, '.png')).toBe(
      path.join(root, 'buildResources', 'icons', '256.png'),
    );
  });

  it('uses assets/icon.ico for the Windows extension', () => {
    const root = makeTempDir('devbar-repo-');
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    const ico = path.join(root, 'assets', 'icon.ico');
    fs.writeFileSync(ico, 'ico');
    expect(pickRepoIcon(root, '.ico')).toBe(ico);
  });

  it('returns null when the repo has no icon sources', () => {
    const root = makeTempDir('devbar-repo-');
    expect(pickRepoIcon(root, '.png')).toBeNull();
    expect(pickRepoIcon(root, '.ico')).toBeNull();
  });
});

describe('ensureInstallIcon', () => {
  it('keeps an icon already shipped inside the install', () => {
    const repo = makeTempDir('devbar-repo-');
    const install = makeTempDir('devbar-install-');
    fs.mkdirSync(path.join(install, 'resources'));
    const shipped = path.join(install, 'resources', 'icon.png');
    fs.writeFileSync(shipped, 'shipped');
    expect(ensureInstallIcon(install, '.png', repo)).toBe(shipped);
  });

  it('copies the repo icon into <install>/resources when missing', () => {
    const repo = makeTempDir('devbar-repo-');
    fs.mkdirSync(path.join(repo, 'buildResources', 'icons'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repo, 'buildResources', 'icons', '128.png'),
      'repo-icon',
    );
    const install = makeTempDir('devbar-install-');
    const icon = ensureInstallIcon(install, '.png', repo);
    expect(icon).toBe(path.join(install, 'resources', 'icon.png'));
    expect(fs.readFileSync(icon!, 'utf8')).toBe('repo-icon');
  });

  it('returns null when neither the install nor the repo has an icon', () => {
    const repo = makeTempDir('devbar-repo-');
    const install = makeTempDir('devbar-install-');
    expect(ensureInstallIcon(install, '.png', repo)).toBeNull();
  });
});
