/**
 * The lines DevBar's own port probe makes a service print (its 404 for
 * `GET /`), muted per process until a moment after the probe answers: they
 * stay in the log, but never count as the service's errors.
 */
export interface ProbeNoise {
  mute(id: string, until: number, matches: (line: string) => boolean): void;
  /** Whether `line`, printed now by `id`, is the echo of a probe. */
  isNoise(id: string, line: string): boolean;
}

export function createProbeNoise(now: () => number = Date.now): ProbeNoise {
  const windows = new Map<
    string,
    { until: number; matches: (line: string) => boolean }
  >();
  return {
    mute: (id, until, matches) => windows.set(id, { until, matches }),
    isNoise(id, line) {
      const window = windows.get(id);
      return (
        window !== undefined && now() < window.until && window.matches(line)
      );
    },
  };
}
