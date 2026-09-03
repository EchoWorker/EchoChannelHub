const tails = new Map<string, Promise<void>>();

export async function runSerial<T>(peer: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(peer) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => current);
  tails.set(peer, tail);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (tails.get(peer) === tail) tails.delete(peer);
  }
}
