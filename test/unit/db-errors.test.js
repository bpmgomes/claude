import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { translateError } from '../../src/db/sqlite.js';
import { ExclusionViolationError, UniqueViolationError } from '../../src/db/errors.js';

function sqliteError(sql, setup) {
  const conn = new DatabaseSync(':memory:');
  conn.exec(setup);
  try {
    conn.exec(sql);
  } catch (err) {
    return err;
  } finally {
    conn.close();
  }
  throw new Error('esperava erro');
}

test('erro de trigger appointments_no_overlap vira ExclusionViolationError com constraint e causa', () => {
  const err = sqliteError(
    'INSERT INTO t VALUES (1)',
    "CREATE TABLE t(x); CREATE TRIGGER g BEFORE INSERT ON t BEGIN SELECT RAISE(ABORT, 'appointments_no_overlap'); END;",
  );
  const translated = translateError(err);
  assert.ok(translated instanceof ExclusionViolationError);
  assert.equal(translated.name, 'ExclusionViolationError');
  assert.equal(translated.constraint, 'appointments_no_overlap');
  assert.equal(translated.cause, err);
});

test('outra mensagem de trigger passa intacta', () => {
  const err = sqliteError(
    'INSERT INTO t VALUES (1)',
    "CREATE TABLE t(x); CREATE TRIGGER g BEFORE INSERT ON t BEGIN SELECT RAISE(ABORT, 'outra_coisa'); END;",
  );
  assert.equal(translateError(err), err);
});

test('unicidade continua UniqueViolationError com o nome reconstruído', () => {
  const err = sqliteError('INSERT INTO t VALUES (1, 2); INSERT INTO t VALUES (1, 2);', 'CREATE TABLE t(a, b, UNIQUE (a, b));');
  const translated = translateError(err);
  assert.ok(translated instanceof UniqueViolationError);
  assert.equal(translated.constraint, 't_a_b_unique');
});
