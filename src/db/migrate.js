import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Aplica, em ordem, as migrações ainda não registradas em schema_migrations.
 * @param {import('./index.js').Database} db
 * @returns {Promise<string[]>} versões aplicadas nesta execução
 */
export async function runMigrations(db, { dir = MIGRATIONS_DIR } = {}) {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);',
  );
  const rows = await db.all('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  const files = (await readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const done = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [
        version,
        new Date().toISOString(), // utc
      ]);
    });
    done.push(version);
  }
  return done;
}

// CLI: npm run migrate
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { loadConfig } = await import('../config.js');
  const { createDatabase } = await import('./index.js');
  const db = createDatabase(loadConfig());
  try {
    const done = await runMigrations(db);
    console.log(done.length ? `Migrações aplicadas: ${done.join(', ')}` : 'Nenhuma migração pendente.');
  } finally {
    await db.close();
  }
}
