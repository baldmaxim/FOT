#!/usr/bin/env node
/** Залить probe-mts-business-tariff.ts на прод и запустить. */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectAuto, exec, sftp, fastPut } from './client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../..');
const PROBE = join(REPO, 'fot-server/scripts/probe-mts-business-tariff.ts');
const REMOTE = '/opt/fot-build/fot-server/scripts/probe-mts-business-tariff.ts';
const msisdn = process.argv[2];

const b64 = readFileSync(PROBE).toString('base64');

const conn = await connectAuto();
try {
  const sftpClient = await sftp(conn);
  await fastPut(sftpClient, PROBE, REMOTE);
  const upload = await exec(conn, `wc -c ${REMOTE}`);
  process.stdout.write(upload.stdout);
  if (upload.code !== 0) {
    process.stderr.write(upload.stderr);
    process.exit(upload.code);
  }

  if (!msisdn) {
    const pick = await exec(
      conn,
      `cd /opt/fot-build && npx tsx fot-server/scripts/probe-mts-number-all.ts --help 2>/dev/null; cd /opt/fot-build && npx tsx -r dotenv/config fot-server/scripts/probe-mts-number-all.ts 2>&1 | head -1 || true`,
    );
    // fallback: resolve via tiny inline script file
    const helperB64 = Buffer.from(`import dotenv from 'dotenv';
dotenv.config({ path: '/srv/sites/fot.su10.ru/fot-server/.env' });
const { mtsBusinessMappingService } = await import('./fot-server/src/services/mts-business-mapping.service.js');
const rows = await mtsBusinessMappingService.getImportedNumbers();
const r = rows.find(x => x.msisdn && x.accountId) ?? rows.find(x => x.msisdn);
console.log(r?.msisdn ?? '');
`).toString('base64');
    await exec(conn, `cd /opt/fot-build && echo '${helperB64}' | base64 -d > /tmp/pick-msisdn.mjs`);
    const got = await exec(conn, 'cd /opt/fot-build && npx tsx /tmp/pick-msisdn.mjs');
    const picked = got.stdout.trim().split(/\r?\n/).pop()?.trim();
    if (!picked) {
      console.error('Не удалось подобрать MSISDN, передай аргументом');
      process.exit(1);
    }
    console.log(`[msisdn] ${picked.slice(0, 4)}***${picked.slice(-2)}`);
    const run = await exec(conn, `cd /opt/fot-build && MTS_PROBE_RAW=1 npx tsx fot-server/scripts/probe-mts-business-tariff.ts ${picked}`);
    process.stdout.write(run.stdout);
    process.stderr.write(run.stderr);
    process.exit(run.code);
  }

  console.log(`[msisdn] ${msisdn.slice(0, 4)}***${msisdn.slice(-2)}`);
  const run = await exec(conn, `cd /opt/fot-build && MTS_PROBE_RAW=1 npx tsx fot-server/scripts/probe-mts-business-tariff.ts ${msisdn}`);
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exit(run.code);
} finally {
  conn.end();
}
