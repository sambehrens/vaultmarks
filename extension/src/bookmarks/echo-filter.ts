// Transaction mutex that prevents remote changes from triggering outgoing syncs.
// When applying a remote op: set flag → mutate bookmarks API → reset flag.
// The bookmark event listener checks this flag and discards the echo.

let ignoring = false;

export function isIgnoring(): boolean {
  return ignoring;
}

export async function withEchoFilter(fn: () => Promise<void>): Promise<void> {
  ignoring = true;
  try {
    await fn();
  } finally {
    ignoring = false;
  }
}
