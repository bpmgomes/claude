import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createUserRateLimit, parseTimeWindow } from '../../src/http/user-rate-limit.js';

function req(id) {
  return { user: id ? { id } : null };
}

describe('parseTimeWindow', () => {
  test('aceita número e texto', () => {
    assert.equal(parseTimeWindow(1500), 1500);
    assert.equal(parseTimeWindow('1 minute'), 60_000);
    assert.equal(parseTimeWindow('30 seconds'), 30_000);
    assert.equal(parseTimeWindow('2h'), 7_200_000);
    assert.throws(() => parseTimeWindow('sempre'));
  });
});

describe('createUserRateLimit (critério 22, plano B do 6.5)', () => {
  test('conta por usuário e libera na próxima janela', async () => {
    let t = 0;
    const hook = createUserRateLimit({ max: 2, timeWindow: 1000, now: () => t });
    await hook(req('a'));
    await hook(req('a'));
    await assert.rejects(hook(req('a')), (err) => {
      assert.equal(err.statusCode, 429);
      assert.equal(err.code, 'RATE_LIMITED');
      assert.equal(err.retryAfterHeader, 1);
      return true;
    });
    await hook(req('b')); // outro usuário não é afetado
    t = 1000;
    await hook(req('a'));
  });

  test('sem usuário não conta (requireAuth responde antes)', async () => {
    const hook = createUserRateLimit({ max: 0, timeWindow: 1000, now: () => 0 });
    await hook(req(null));
    assert.equal(hook.size(), 0);
  });

  test('remove janelas vencidas', async () => {
    let t = 0;
    const hook = createUserRateLimit({ max: 5, timeWindow: 1000, now: () => t });
    for (const id of ['a', 'b', 'c']) await hook(req(id));
    assert.equal(hook.size(), 3);
    t = 5000;
    await hook(req('d'));
    assert.equal(hook.size(), 1);
  });
});
