/** One step of a document-parsing run, for an in-app "parsing log" review panel. */
export interface ParseLogEntry {
  stage: string;
  detail: string;
}

export interface ParseLog {
  entries: ParseLogEntry[];
  log(stage: string, detail: string): void;
}

/** A plain accumulator threaded through a parse call — no reactivity needed,
 *  since a UI only reads `entries` once the parse promise settles. */
export function createParseLog(): ParseLog {
  const entries: ParseLogEntry[] = [];
  return {
    entries,
    log(stage, detail) {
      entries.push({ stage, detail });
    },
  };
}
