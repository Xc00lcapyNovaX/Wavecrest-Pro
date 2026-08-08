// Applies migrations/*.sql in filename order, tracking what ran in _migrations.
// Usage: npm run migrate          (uses DB_URL or DATABASE_URL from env)
//        Reads .env.local automatically when run outside Vercel.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env.local loader for local runs (Vercel injects env itself)
const envFile = join(root, '.env.local');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m) process.env[m[1]] ??= m[2];
  }
}

const { getPool } = await import(join(root, 'lib/db.js'));
const db = getPool();

await db.query(`
  CREATE TABLE IF NOT EXISTS _migrations (
    name       text PRIMARY KEY,
    applied_at timestamptz DEFAULT now()
  )
`);

const applied = new Set(
  (await db.query('SELECT name FROM _migrations')).rows.map(r => r.name)
);

const files = readdirSync(join(root, 'migrations')).filter(f => f.endsWith('.sql')).sort();
let ran = 0;

for (const file of files) {
  if (applied.has(file)) continue;
  const sql = readFileSync(join(root, 'migrations', file), 'utf8');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log(`applied  ${file}`);
    ran++;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`FAILED   ${file}:`, err.message);
    process.exit(1);
  } finally {
    client.release();
  }
}

console.log(ran ? `${ran} migration(s) applied` : 'nothing to apply — up to date');
process.exit(0);
