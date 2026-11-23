'use strict';

const { spawnSync } = require('node:child_process');
const { error: envError } = require('dotenv').config();

if (envError && envError.code !== 'ENOENT') throw envError;

if (!process.env.DATABASE_URL && process.env.database_url) {
  process.env.DATABASE_URL = process.env.database_url;
}

const { error, status } = spawnSync(
  process.execPath,
  [require.resolve('prisma/build/index.js'), ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

if (error) throw error;
process.exitCode = status ?? 1;
