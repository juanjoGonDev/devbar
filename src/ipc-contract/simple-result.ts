/** The `{ ok }` answer most IPC calls resolve with. */
export type SimpleResult =
  | { ok: true }
  | {
      ok: false;
      error?: string | undefined;
      canceled?: boolean;
      cancelled?: boolean;
    };
