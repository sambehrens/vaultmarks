// Reference-counted guard that prevents remote changes from triggering outgoing syncs.
// When applying a remote op: increment depth → mutate bookmarks API → decrement depth.
// The bookmark event listener checks isIgnoring() and discards the echo.
// Using a counter (not a boolean) makes it safe when multiple async ops overlap.

let ignoreDepth = 0;

export function isIgnoring(): boolean {
  return ignoreDepth > 0;
}

export async function withEchoFilter(fn: () => Promise<void>): Promise<void> {
  ignoreDepth++;
  try {
    await fn();
  } finally {
    ignoreDepth--;
  }
}
