import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { hedged } from './hedge.ts';

const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
});
/** A fake model call that answers (or fails) after `ms` and records what happened to it. */
const task = (log: string[], name: string, ms: number, fail = false) => async (signal: AbortSignal) => {
  log.push(`start ${name}`);
  try { await wait(ms, signal); } catch (e) { log.push(`aborted ${name}`); throw e; }
  if (fail) { log.push(`failed ${name}`); throw new Error(`${name} failed`); }
  return name;
};

Deno.test('hedged: a fast main answer wins and the fallback never starts', async () => {
  const log: string[] = [];
  assertEquals(await hedged([task(log, 'main', 10), task(log, 'lite', 10)], 100), 'main');
  assertEquals(log, ['start main']);
});

Deno.test('hedged: a slow main model gets the fallback started; the first answer wins', async () => {
  const log: string[] = [];
  assertEquals(await hedged([task(log, 'main', 500), task(log, 'lite', 20)], 50), 'lite');
  assertEquals(log, ['start main', 'start lite', 'aborted main']);
});

Deno.test('hedged: a failing main model moves on at once', async () => {
  const log: string[] = [];
  const t = Date.now();
  assertEquals(await hedged([task(log, 'main', 10, true), task(log, 'lite', 10)], 5_000), 'lite');
  assertEquals(log, ['start main', 'failed main', 'start lite']);
  assertEquals(Date.now() - t < 1_000, true);
});

Deno.test('hedged: rejects with the last error when every model fails', async () => {
  const log: string[] = [];
  await assertRejects(() => hedged([task(log, 'main', 10, true), task(log, 'lite', 10, true)], 50), Error, 'lite failed');
});
