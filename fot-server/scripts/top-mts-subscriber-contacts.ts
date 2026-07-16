/**
 * Top contacts for subscriber MSISDN in mts_business_cdr.
 * Usage: npx tsx scripts/top-mts-subscriber-contacts.ts [msisdn]
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

interface IContactStat {
  key: string;
  display: string;
  number: string;
  internal: boolean;
  calls: number;
  totalSec: number;
}

const formatDuration = (sec: number): string => {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m} min ${s} s`;
};

const main = async (): Promise<void> => {
  const rawArg = process.argv[2] ?? '79859207771';
  const { query } = await import('../src/config/postgres.js');
  const { encryptionService } = await import('../src/services/encryption.service.js');
  const { msisdnHash, normalizeMsisdn } = await import('../src/services/mts-business-cdr.service.js');

  const targetMsisdn = normalizeMsisdn(rawArg);
  if (!targetMsisdn) {
    console.error('Bad MSISDN:', rawArg);
    process.exit(1);
  }
  const targetHash = msisdnHash(targetMsisdn);
  if (!targetHash) {
    console.error('No hash for', targetMsisdn);
    process.exit(1);
  }

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
  for (const row of numbers) {
    byHash.set(row.msisdn_hash, {
      msisdn: row.msisdn_enc ? encryptionService.decryptField(row.msisdn_enc) : null,
      mtsFio: row.mts_fio,
      employeeName: row.employee_full_name,
      deptName: row.dept_name,
    });
  }

  const resolveContact = (
    hash: string | null,
    rawPeer: string | null,
  ): Omit<IContactStat, 'calls' | 'totalSec'> => {
    if (hash && byHash.has(hash)) {
      const n = byHash.get(hash)!;
      const name = n.employeeName ?? n.mtsFio ?? n.msisdn ?? hash;
      return { key: hash, display: name, number: n.msisdn ?? '-', internal: true };
    }
    const norm = normalizeMsisdn(rawPeer) ?? rawPeer?.trim() ?? '-';
    const h = hash ?? msisdnHash(norm) ?? norm;
    return { key: h, display: norm, number: norm, internal: false };
  };

  const owner = byHash.get(targetHash);
  const ownerLabel = owner?.employeeName ?? owner?.mtsFio ?? owner?.msisdn ?? targetMsisdn;

  const stats = new Map<string, IContactStat>();
  const BATCH = 5000;
  let offset = 0;

  for (;;) {
    const rows = await query<{
      msisdn_hash: string | null;
      peer_number_enc: string | null;
      duration_sec: number;
    }>(
      `SELECT msisdn_hash, peer_number_enc, duration_sec
         FROM mts_business_cdr
        WHERE msisdn_hash IS NOT NULL AND peer_number_enc IS NOT NULL
        ORDER BY id
        LIMIT $1 OFFSET $2`,
      [BATCH, offset],
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      const ownHash = row.msisdn_hash;
      if (!ownHash) continue;

      const peerRaw = encryptionService.decryptField(row.peer_number_enc);
      const peerHash = msisdnHash(peerRaw);

      let contact: Omit<IContactStat, 'calls' | 'totalSec'> | null = null;
      if (ownHash === targetHash) contact = resolveContact(peerHash, peerRaw);
      else if (peerHash === targetHash) contact = resolveContact(ownHash, null);
      if (!contact) continue;

      const cur = stats.get(contact.key) ?? { ...contact, calls: 0, totalSec: 0 };
      cur.calls += 1;
      cur.totalSec += row.duration_sec ?? 0;
      stats.set(contact.key, cur);
    }

    offset += rows.length;
    if (rows.length < BATCH) break;
  }

  const ranked = [...stats.values()].sort((a, b) => b.calls - a.calls || b.totalSec - a.totalSec);

  console.log(`SUBSCRIBER\t${targetMsisdn}\t${ownerLabel}`);
  console.log(`DEPT\t${owner?.deptName ?? '-'}`);
  console.log(`IN_MAP\t${owner ? 'yes' : 'no'}`);
  if (owner?.mtsFio) console.log(`MTS_FIO\t${owner.mtsFio}`);
  console.log(`UNIQUE_CONTACTS\t${ranked.length}`);
  console.log('RANK\tdisplay\tnumber\ttype\tcalls\tduration');

  for (let i = 0; i < Math.min(10, ranked.length); i++) {
    const r = ranked[i];
    console.log(
      `${i + 1}\t${r.display}\t${r.number}\t${r.internal ? 'internal' : 'external'}\t${r.calls}\t${formatDuration(r.totalSec)}`,
    );
  }
};

main().catch(err => {
  console.error(err);
  process.exit(1);
});
