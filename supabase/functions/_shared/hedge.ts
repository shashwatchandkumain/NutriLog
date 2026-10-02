// Latency hedging for AI calls. A model under heavy load can take 20+ seconds just to say
// "high demand", so waiting for it (and retrying it) leaves the user staring at a spinner.

/**
 * Runs `tasks` in order of preference. The next task starts early when the current one is slow
 * (no answer after `hedgeMs`) or fails, and the first success wins — the others are aborted.
 * Rejects with the last error if every task fails.
 */
export function hedged<T>(tasks: ((signal: AbortSignal) => Promise<T>)[], hedgeMs: number): Promise<T> {
  if (!tasks.length) return Promise.reject(new Error('no tasks'));
  return new Promise((resolve, reject) => {
    const aborts = tasks.map(() => new AbortController());
    const timers: ReturnType<typeof setTimeout>[] = [];
    let started = 0, running = 0, done = false;
    let lastError: unknown = new Error('no tasks');
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      aborts.forEach((a) => a.abort());
      settle();
    };
    const startNext = () => {
      if (done || started >= tasks.length) return;
      const i = started++;
      running++;
      tasks[i](aborts[i].signal).then(
        (value) => finish(() => resolve(value)),
        (e) => {
          running--;
          lastError = e;
          if (started < tasks.length) startNext();
          else if (running === 0) finish(() => reject(lastError));
        },
      );
      if (started < tasks.length) timers.push(setTimeout(startNext, hedgeMs));
    };
    startNext();
  });
}
