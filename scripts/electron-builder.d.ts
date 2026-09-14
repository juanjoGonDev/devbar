/**
 * Minimal ambient declaration of the tiny slice of electron-builder's
 * programmatic API that scripts/package-win-linux.ts uses.
 *
 * electron-builder 26.x ships broken type declarations (a missing
 * `out/targets/snap/snapcraft` module and an untyped `yargs` import), and
 * this repo type-checks with `skipLibCheck: false`, so importing the
 * package's own .d.ts fails the build. The runtime package works fine —
 * only its types are incomplete. Declaring the surface we actually use
 * keeps strict type-checking without weakening it globally.
 *
 * If package-win-linux.ts grows new options, extend this declaration and
 * verify them against the electron-builder docs for the installed version.
 */
/* Module-shaped declaration: loaded via tsconfig `paths`, not ambient. */
export interface TargetDescriptor {
  target: string;
  arch?: string[];
}

export interface BuildConfiguration {
  appId?: string;
  productName?: string;
  description?: string;
  asar?: boolean;
  publish?: null;
  directories?: { output?: string; buildResources?: string };
  files?: string[];
  win?: {
    icon?: string;
    target?: Array<string | TargetDescriptor>;
  };
  nsis?: Record<string, unknown>;
  portable?: Record<string, unknown>;
  linux?: Record<string, unknown>;
}

export interface BuildOptions {
  config?: BuildConfiguration | string;
}

export function build(rawOptions?: BuildOptions): Promise<string[]>;
