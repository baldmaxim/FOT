/**
 * Номер МТС Бизнес с наибольшим числом уникальных внутренних собеседников.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const envCandidates = [
  process.env.MTS_ENV_FILE,
  path.resolve(process.cwd(), '.env'),
  '/srv/sites/fot.su10.ru/fot-server/.env',
  path.resolve(__dirname, '../.env'),
].filter((p): p is string => Boolean(p));
const envPath = envCandidates.find(p => fs.existsSync(p));
if (envPath) dotenv.config({ path: envPath });

interface INumberInfo {
  msisdn: string | null;
  mtsFio: string | null;
  employeeName: string | null;
  deptName: string | null;
}

const displayName = (n: INumberInfo): string =>
  n.employeeName ?? n.mtsFio ?? n.msisdn ?? '—';

const main = async (): Promise<void> => {
  const { query } = await import('../src/config/postgres.js');
  const { encryptionService } = await import('../src/services/encryption.service.js');
  const { msisdnHash } = await import('../src/services/mts-business-cdr.service.js');

  const numbers = await query<{
    msisdn_hash: string;
    msisdn_enc: string | null;
    mts_fio: string | null;
    employee_full_name: string | null;
    dept_name: string | null;
  }>(
    `SELECT nm.msisdn_hash, nm.msisdn_enc, nm.mts_fio,
            e.full_name AS employee_full_name, od.name AS dept_name
       FROM mts_business_number_map nm
       LEFT JOIN employees e ON e.id = nm.employee_id
       LEFT JOIN org_departments od ON od.id = e.org_department_id`,
  );

  const byHash = new Map<string, INumberInfo>();
  const internalHashes = new Set<string>();
  for (const row of numbers) {
    internalHashes.add(row.msisdn_hash);
    byHash.set(row.msisdn_hash, {
      msisdn: row.msisdn_enc ? encryptionService.decryptField(row.msisdn_enc) : null,
      mtsFio: row.mts_fio,
      employeeName: row.employee_full_name,
      deptName: row.dept_name,
    });
  }

  const peersByOwn = new Map<string, Set<string>>();
  const callsByOwn = new Map<string, number>();
  const BATCH = 5000;
  let offset = 0;

  for (;;) {
    const rows = await query<{
      msisdn_hash: string | null;
      peer_number_enc: string | null;
    }>(
      `SELECT msisdn_hash, peer_number_enc
         FROM mts_business_cdr
        WHERE msisdn_hash IS NOT NULL AND peer_number_enc IS NOT NULL
        ORDER BY id
        LIMIT $1 OFFSET $2`,
      [BATCH, offset],
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      const ownHash = row.msisdn_hash;
      if (!ownHash || !internalHashes.has(ownHash)) continue;

      const peer = encryptionService.decryptField(row.peer_number_enc);
      const peerHash = msisdnHash(peer);
      if (!peerHash || !internalHashes.has(peerHash) || peerHash === ownHash) continue;

      let peers = peersByOwn.get(ownHash);
      if (!peers) {
        peers = new Set();
        peersByOwn.set(ownHash, peers);
      }
      peers.add(peerHash);
      callsByOwn.set(ownHash, (callsByOwn.get(ownHash) ?? 0) + 1);
    }

    offset += rows.length;
    if (rows.length < BATCH) break;
  }

  const ranked = [...peersByOwn.entries()]
    .map(([hash, peers]) => ({
      hash,
      uniquePeers: peers.size,
      internalCalls: callsByOwn.get(hash) ?? 0,
      info: byHash.get(hash)!,
    }))
    .sort((a, b) => b.uniquePeers - a.uniquePeers || b.internalCalls - a.internalCalls);

  if (ranked.length === 0) {
    console.log('Нет внутренних связей между номерами компании.');
    return;
  }

  const totalInternal = internalHashes.size;
  console.log(`Внутренних номеров в компании: ${totalInternal}`);
  console.log(`Период: 01.06.2026 — 10.07.2026\n`);
  console.log('Топ-10 номеров по числу уникальных внутренних собеседников:\n');

  for (let i = 0; i < Math.min(10, ranked.length); i++) {
    const r = ranked[i];
    const pct = ((r.uniquePeers / Math.max(totalInternal - 1, 1)) * 100).toFixed(1);
    console.log(
      `${i + 1}. ${displayName(r.info)} — ${r.uniquePeers} собеседников (${pct}% компании), ${r.internalCalls} внутр. звонков`,
    );
    console.log(`   ${r.info.msisdn ?? '—'} | ${r.info.deptName ?? 'отдел не указан'}`);
    console.log('');
  }
};

main().catch(err => {
  console.error(err);
  process.exit(1);
});
