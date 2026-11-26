// Regex única das varreduras "só enqueue-email.js enfileira" (AF-18 critério 6 e AF-14): o nome exato
// `email_outbox`, com aspas opcionais ("", ``, []) e limite de palavra, para não aceitar
// `INSERT INTO "email_outbox"` nem acusar `INSERT INTO email_outbox_new` (a recriação da 014).
// Também pega `INSERT OR <ação>`, `REPLACE INTO`, o esquema `main.` e aspas simples.
export const OUTBOX_INSERT_RE =
  /(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO\s+(?:["'`[]?\w+["'`\]]?\s*\.\s*)?["'`[]?email_outbox["'`\]]?(?!\w)/i;
