#!/usr/bin/env node
/** Залить export-mts-unused-fot-by-dept.ts на прод, запустить, скачать xlsx. */
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectAuto, exec, sftp, fastPut } from './client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../..');
const SCRIPT = join(REPO, 'fot-server/scripts/export-mts-unused-fot-by-dept.ts');
const REMOTE_SCRIPT = '/opt/fot-build/fot-server/scripts/export-mts-unused-fot-by-dept.ts';
const REMOTE_XLSX = '/tmp/mts-unused-fot-by-dept.xlsx';
const LOCAL_XLSX = join(REPO, 'mts-unused-fot-by-dept.xlsx');

const conn = await connectAuto();
try {
  const sftpClient = await sftp(conn);
  await fastPut(sftpClient, SCRIPT, REMOTE_SCRIPT);

  const run = await exec(
    conn,
    `cd /opt/fot-build/fot-server && npx tsx scripts/export-mts-unused-fot-by-dept.ts --out ${REMOTE_XLSX}`,
  );
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  if (run.code !== 0) process.exit(run.code);

  const b64 = await exec(conn, `base64 -w0 ${REMOTE_XLSX}`);
  if (b64.code !== 0) {
    process.stderr.write(b64.stderr);
    process.exit(b64.code);
  }
  writeFileSync(LOCAL_XLSX, Buffer.from(b64.stdout.trim(), 'base64'));
  console.log(`Скачан: ${LOCAL_XLSX}`);
} finally {
  conn.end();
}
