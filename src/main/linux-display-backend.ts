/**
 * Which display backend DevBar runs on under Linux, decided before Electron
 * initialises anything.
 *
 * On a native Wayland session the compositor owns window placement: Electron's
 * setBounds/setPosition are ignored, and `screen.workArea` reports the whole
 * display instead of the display minus the panel. The tray popover then opens
 * wherever the compositor decides (the middle of the screen on KWin) and its
 * bottom slides under the taskbar. Under XWayland both work, so DevBar prefers
 * it whenever an X display is available.
 *
 * The switch has to be on the real command line. Electron selects the Ozone
 * platform in ElectronMainDelegate::PreSandboxStartup
 * (shell/app/electron_main_delegate.cc, v43: `ui::OzonePlatform::
 * PreSandboxStartup()` fixes the platform), which runs before the main script
 * is loaded in ElectronBrowserMainParts::PostEarlyInitialization — so
 * `app.commandLine.appendSwitch('ozone-platform', 'x11')` from main.ts is too
 * late. Packaged launchers pass the flag themselves (electron-builder
 * `linux.executableArgs`, the autostart entry); any other launch path is
 * relaunched once with the flag added.
 *
 * Pure: no electron import, every input is passed in.
 */

export const X11_OZONE_FLAG = '--ozone-platform=x11';
/** Opt-out: `DEVBAR_WAYLAND_NATIVE=1` keeps DevBar on native Wayland. */
const WAYLAND_NATIVE_ENV = 'DEVBAR_WAYLAND_NATIVE';

export interface DisplayBackendInput {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  argv: readonly string[];
}

function isWaylandSession(env: DisplayBackendInput['env']): boolean {
  return env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY);
}

/** Any explicit ozone choice (`--ozone-platform=…`, `--ozone-platform-hint=…`). */
function hasOzoneArg(argv: readonly string[]): boolean {
  return argv.some((arg) => arg.startsWith('--ozone-platform'));
}

/** Whether this launch must be relaunched under XWayland. */
export function shouldForceX11({
  platform,
  env,
  argv,
}: DisplayBackendInput): boolean {
  if (platform !== 'linux') return false;
  if (env[WAYLAND_NATIVE_ENV] === '1') return false;
  if (!isWaylandSession(env)) return false;
  // No X display means no XWayland to fall back to.
  if (!env.DISPLAY) return false;
  // Already chosen (by a launcher, the user or a previous relaunch): this is
  // also what keeps the relaunch from looping.
  return !hasOzoneArg(argv);
}

/** Whether Electron ends up on native Wayland (auto-selected or requested). */
export function runsNativeWayland({
  platform,
  env,
  argv,
}: DisplayBackendInput): boolean {
  if (platform !== 'linux' || !isWaylandSession(env)) return false;
  return !argv.includes(X11_OZONE_FLAG);
}

/** The backend line for app.log, so bug reports carry it. Null off Linux. */
export function describeLinuxDisplayBackend(
  input: DisplayBackendInput,
): string | null {
  if (input.platform !== 'linux') return null;
  if (runsNativeWayland(input)) return 'wayland (native)';
  return isWaylandSession(input.env) ? 'x11 (forced from wayland)' : 'x11';
}

/**
 * `app.relaunch` options that add the x11 flag. A running AppImage executes
 * from a tmp mount that disappears when this process exits, so the relaunch
 * targets the .AppImage file itself.
 */
export function x11RelaunchOptions({
  argv,
  appImage,
}: {
  argv: readonly string[];
  appImage: string | null;
}): { execPath?: string; args: string[] } {
  const args = [...argv.slice(1), X11_OZONE_FLAG];
  return appImage ? { execPath: appImage, args } : { args };
}

/** The Electron effects `settleLinuxDisplayBackend` needs, injected. */
export interface DisplayBackendEffects {
  relaunch: (options: { execPath?: string; args: string[] }) => void;
  exit: () => void;
  /** The running .AppImage file, or null when not one. */
  appImagePath: () => string | null;
}

/**
 * Called at the very top of main, before the single-instance lock: when a
 * Wayland launch carries no ozone choice (terminal, an AppImage run directly)
 * it schedules a relaunch with the x11 flag and exits, returning true. Doing
 * it before the lock means this short-lived process never owns it, and before
 * the file logger means it never rotates app.log. `app.exit()` before the
 * message loop exits synchronously, and Electron's relauncher waits for that
 * exit before starting the new process.
 */
export function settleLinuxDisplayBackend(
  input: DisplayBackendInput,
  effects: DisplayBackendEffects,
): boolean {
  if (!shouldForceX11(input)) return false;
  effects.relaunch(
    x11RelaunchOptions({ argv: input.argv, appImage: effects.appImagePath() }),
  );
  effects.exit();
  return true;
}
