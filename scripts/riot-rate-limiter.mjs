import { setTimeout as sleep } from 'node:timers/promises';

// One process-wide budget, conservatively shared across KR and ASIA hosts.
// Separate processes using the same key still need a shared coordinator.
export function createRiotRateLimiter({ now = () => performance.now(), wait = sleep, minSpacingMs = 1350 } = {}) {
  if (!Number.isFinite(minSpacingMs) || minSpacingMs < 0) throw new Error('RIOT_INVALID_SPACING');
  const windows = [{ count: 20, ms: 1000 }, { count: 100, ms: 120000 }];
  let starts = [], lastStart = -Infinity, blockedUntil = -Infinity, tail = Promise.resolve();
  return {
    acquire() {
      const pending = tail.then(async () => {
        for (;;) {
          const time = now();
          starts = starts.filter(start => time - start <= 120000);
          let next = Math.max(time, lastStart + minSpacingMs, blockedUntil);
          for (const window of windows) {
            const recent = starts.filter(start => time - start <= window.ms);
            if (recent.length >= window.count) next = Math.max(next, recent[recent.length - window.count] + window.ms + 1);
          }
          if (next > time) {
            await wait(Math.min(next - time, 60000));
            continue;
          }
          starts.push(time);
          lastStart = time;
          return;
        }
      });
      tail = pending.catch(() => {});
      return pending;
    },
    cooldown(seconds) {
      const duration = Number.isFinite(seconds) && seconds >= 0 ? seconds : 120;
      blockedUntil = Math.max(blockedUntil, now() + duration * 1000);
    }
  };
}
