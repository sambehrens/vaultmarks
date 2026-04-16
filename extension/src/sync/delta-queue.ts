// Persistent queue of encrypted Loro deltas waiting to be pushed to the server.
// Backed by IndexedDB so ops survive service worker termination.

import { enqueue, peekQueue, dequeue, type QueuedDelta } from "../storage/db";
import { encrypt } from "../crypto/aes";
import { getEncryptionKey, getActiveProfileId } from "../auth/session";

/** Encrypt a raw Loro delta and add it to the persistent queue. */
export async function enqueueDelta(rawDelta: Uint8Array): Promise<void> {
  const encryptedDelta = await encrypt(getEncryptionKey(), rawDelta);
  const item: QueuedDelta = {
    id: crypto.randomUUID(),
    profileId: getActiveProfileId(),
    encryptedDelta,
    timestamp: Date.now(),
  };
  await enqueue(item);
}

/** Return up to `limit` queued items, oldest first. */
export async function peek(limit = 50): Promise<QueuedDelta[]> {
  return peekQueue(limit);
}

/** Remove items from the queue after a successful push. */
export function acknowledge(ids: string[]): Promise<void> {
  return dequeue(ids);
}
