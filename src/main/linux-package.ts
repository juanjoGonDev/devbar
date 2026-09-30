import { execFile } from 'node:child_process';

/**
 * The Linux side of an update that the in-place swap cannot do: telling a
 * .deb install apart, and installing a downloaded .deb through polkit.
 *
 * Every command is an argv array handed to execFile — never a shell string —
 * so a download path is one argument whatever characters it holds. Root is
 * only ever obtained through pkexec, which asks the user in a graphical
 * prompt; nothing here runs sudo.
 */

export interface ProcessResult {
  /** Exit code, or null when the process never ran (or died by signal). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why it could not be started (ENOENT, EACCES…), else null. */
  spawnError: string | null;
}

export type RunProcess = (
  file: string,
  args: readonly string[],
) => Promise<ProcessResult>;

export type LinuxInstallShape = 'appImage' | 'deb' | 'other';

/** The package name electron-builder gives the .deb (package.json `name`). */
const DEB_PACKAGE = 'devbar';
const PKEXEC_CANDIDATES = ['/usr/bin/pkexec', '/bin/pkexec'];
const APT_GET = '/usr/bin/apt-get';
const DPKG = '/usr/bin/dpkg';
/** pkexec: the user dismissed the authentication dialog. */
const PKEXEC_DISMISSED = 126;
/** pkexec: no authorization could be obtained (no polkit agent, error). */
const PKEXEC_NOT_AUTHORIZED = 127;

/** Never rejects: a failure to start is reported in `spawnError`. */
export function runProcess(
  file: string,
  args: readonly string[],
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout, stderr, spawnError: null });
          return;
        }
        const code = (err as { code?: unknown }).code;
        resolve(
          typeof code === 'number'
            ? { code, stdout, stderr, spawnError: null }
            : {
                code: null,
                stdout,
                stderr,
                spawnError: typeof code === 'string' ? code : err.message,
              },
        );
      },
    );
  });
}

/**
 * How this Linux copy was installed. An AppImage is recognised upstream (see
 * self-update-linux.ts); a .deb install is whatever dpkg says owns the running
 * executable (/opt/DevBar/devbar for electron-builder's package).
 */
export async function detectLinuxInstallShape(input: {
  appImage: string | null;
  execPath: string;
  run: RunProcess;
}): Promise<LinuxInstallShape> {
  if (input.appImage) return 'appImage';
  const res = await input.run('dpkg-query', ['-S', input.execPath]);
  if (res.code !== 0) return 'other';
  const owner = new RegExp(`^${DEB_PACKAGE}(:[\\w-]+)?:\\s`, 'm');
  return owner.test(res.stdout) ? 'deb' : 'other';
}

function shellQuote(value: string): string {
  return /^[\w./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command the user can paste when the automatic install is not possible.
 * An absolute path (apt reads a local file when the argument holds a slash),
 * so it works from any directory.
 */
export function manualDebCommand(debPath: string): string {
  return `sudo apt install ${shellQuote(debPath)}`;
}

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  return lines.at(-1)?.trim() ?? '';
}

/**
 * Install a downloaded .deb as root through polkit: `pkexec apt-get install
 * -y <path>` (apt resolves dependencies), or `pkexec dpkg -i <path>` on a
 * system without apt-get.
 */
export async function installDebPackage(
  debPath: string,
  deps: { run: RunProcess; exists: (target: string) => boolean },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const pkexec = PKEXEC_CANDIDATES.find((candidate) => deps.exists(candidate));
  if (!pkexec) return { ok: false, reason: 'pkexec no está instalado' };
  const installer = deps.exists(APT_GET)
    ? { name: 'apt-get', args: [APT_GET, 'install', '-y', debPath] }
    : deps.exists(DPKG)
      ? { name: 'dpkg', args: [DPKG, '-i', debPath] }
      : null;
  if (!installer)
    return { ok: false, reason: 'no se encontró apt-get ni dpkg' };
  const res = await deps.run(pkexec, installer.args);
  if (res.spawnError)
    return {
      ok: false,
      reason: `no se pudo ejecutar pkexec: ${res.spawnError}`,
    };
  if (res.code === 0) return { ok: true };
  if (res.code === PKEXEC_DISMISSED)
    return { ok: false, reason: 'autenticación cancelada' };
  if (res.code === PKEXEC_NOT_AUTHORIZED)
    return {
      ok: false,
      reason:
        'no se pudo autenticar (¿hay un agente de polkit en esta sesión?)',
    };
  const detail = lastLine(res.stderr);
  return {
    ok: false,
    reason: `${installer.name} terminó con código ${res.code}${detail ? `: ${detail}` : ''}`,
  };
}
