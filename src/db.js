const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let pool;

function initPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  pool = new Pool({ connectionString });
  return pool;
}

async function runMigrations() {
  const p = initPool();
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'schema.sql'), 'utf8');
  await p.query(sql);
}

module.exports = { initPool, runMigrations };
