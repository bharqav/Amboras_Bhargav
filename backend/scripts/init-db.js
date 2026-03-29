/* eslint-disable no-console */
require('./load-env')();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function run() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    await pool.query(sql);
    console.log('Schema applied successfully.');
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
