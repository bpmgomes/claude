import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createImageLimiter, unlimitedImageLimiter } from '../../src/images/image-limiter.js';
import { ImageBusyError, InvalidImageError } from '../../src/http/errors.js';

/** Relógio de teste: timeouts só disparam com `advance`. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
    size: () => pending.size,
  };
}

/** Tarefa controlada por promessa; registra início e o pico de simultâneas. */
function controlled(tracker, label) {
  let release;
  let fail;
  const gate = new Promise((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const task = async () => {
    tracker.running += 1;
    tracker.peak = Math.max(tracker.peak, tracker.running);
    tracker.started.push(label);
    try {
      return await gate;
    } finally {
      tracker.running -= 1;
    }
  };
  return { task, release: (v = label) => release(v), fail: (e) => fail(e) };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createImageLimiter (critério 14, AF-05 item 2)', () => {
  test('no máximo 2 simultâneas, 3ª e 4ª esperam e rodam na ordem, 5ª recebe ImageBusyError na hora', async () => {
    const timers = fakeTimers();
    const limiter = createImageLimiter({ concurrency: 2, queueMax: 2, queueTimeoutMs: 1000, timers });
    const tracker = { running: 0, peak: 0, started: [] };
    const tasks = ['t1', 't2', 't3', 't4'].map((l) => controlled(tracker, l));
    const results = tasks.map((t) => limiter.run(t.task));
    await flush();
    assert.deepEqual(tracker.started, ['t1', 't2']);
    assert.deepEqual(limiter.stats(), { active: 2, queued: 2 });

    let ran = false;
    await assert.rejects(
      limiter.run(async () => {
        ran = true;
      }),
      (err) => err instanceof ImageBusyError && err.statusCode === 503 && err.code === 'IMAGE_BUSY',
    );
    assert.equal(ran, false);

    tasks[0].release();
    await flush();
    assert.deepEqual(tracker.started, ['t1', 't2', 't3']);
    tasks[1].release();
    await flush();
    assert.deepEqual(tracker.started, ['t1', 't2', 't3', 't4']);
    tasks[2].release();
    tasks[3].release();
    assert.deepEqual(await Promise.all(results), ['t1', 't2', 't3', 't4']);
    assert.equal(tracker.peak, 2);
    assert.deepEqual(limiter.stats(), { active: 0, queued: 0 });
    assert.equal(timers.size(), 0, 'timeouts da fila foram cancelados');
  });

  test('tarefa que lança (InvalidImageError ou erro inesperado) libera a vaga', async () => {
    const limiter = createImageLimiter({ concurrency: 1, queueMax: 1, queueTimeoutMs: 1000, timers: fakeTimers() });
    await assert.rejects(
      limiter.run(async () => {
        throw new InvalidImageError();
      }),
      InvalidImageError,
    );
    await assert.rejects(
      limiter.run(() => {
        throw new Error('síncrono');
      }),
      /síncrono/,
    );
    assert.deepEqual(limiter.stats(), { active: 0, queued: 0 });
    assert.equal(await limiter.run(async () => 'ok'), 'ok');
  });

  test('esperar mais de queueTimeoutMs dá ImageBusyError e tira o item da fila', async () => {
    const timers = fakeTimers();
    const limiter = createImageLimiter({ concurrency: 1, queueMax: 2, queueTimeoutMs: 500, timers });
    const tracker = { running: 0, peak: 0, started: [] };
    const first = controlled(tracker, 'a');
    const running = limiter.run(first.task);
    let queuedRan = false;
    const queued = limiter.run(async () => {
      queuedRan = true;
    });
    await flush();
    assert.deepEqual(limiter.stats(), { active: 1, queued: 1 });
    timers.advance(499);
    assert.deepEqual(limiter.stats(), { active: 1, queued: 1 });
    timers.advance(1);
    await assert.rejects(queued, ImageBusyError);
    assert.deepEqual(limiter.stats(), { active: 1, queued: 0 });
    first.release();
    await running;
    await flush();
    assert.equal(queuedRan, false);
    assert.deepEqual(limiter.stats(), { active: 0, queued: 0 });
  });

  test('queueMax 0: sem fila, a 2ª recebe ImageBusyError', async () => {
    const limiter = createImageLimiter({ concurrency: 1, queueMax: 0, queueTimeoutMs: 1000, timers: fakeTimers() });
    const tracker = { running: 0, peak: 0, started: [] };
    const first = controlled(tracker, 'a');
    const running = limiter.run(first.task);
    await assert.rejects(limiter.run(async () => 1), ImageBusyError);
    first.release();
    assert.equal(await running, 'a');
  });

  test('ImageBusyError leva Retry-After 5', () => {
    const err = new ImageBusyError();
    assert.equal(err.retryAfterHeader, 5);
    assert.equal(err.message, 'Muitas imagens sendo processadas agora. Tente novamente em instantes.');
  });

  test('opções inválidas lançam', () => {
    assert.throws(() => createImageLimiter({ concurrency: 0, queueMax: 1, queueTimeoutMs: 1 }));
    assert.throws(() => createImageLimiter({ concurrency: 1, queueMax: -1, queueTimeoutMs: 1 }));
  });

  test('unlimitedImageLimiter executa direto', async () => {
    assert.equal(await unlimitedImageLimiter.run(async () => 7), 7);
    assert.deepEqual(unlimitedImageLimiter.stats(), { active: 0, queued: 0 });
  });
});
