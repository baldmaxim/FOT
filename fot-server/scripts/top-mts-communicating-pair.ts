/**
 * Топ-пара номеров МТС Бизнес с наибольшим числом звонков друг другу.
 * Учитываются только пары, где оба номера есть в mts_business_number_map.
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
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

const main = async (): Promise<void> => {
  const { query } = await import('../src/config/postgres.js');
  const { encryptionService } = await import('../src/services/encryption.service.js');
  const { msisdnHash } = await import('../src/services/mts-business-cdr.service.js');

  const numbers = await query<{
    msisdn_hash: string;
    msisdn_enc: string | null;
    mts_fio: string | null;
    employee_full_name: string | null;
  }>(
    `SELECT nm.msisdn_hash, nm.msisdn_enc, nm.mts_fio, e.full_name AS employee_full_name
       FROM mts_business_number_map nm
       LEFT JOIN employees e ON e.id = nm.employee_id`,
  );

  const byHash = new Map<string, INumberInfo>();
  for (const row of numbers) {
    const msisdn = row.msisdn_enc ? encryptionService.decryptField(row.msisdn_enc) : null;
    byHash.set(row.msisdn_hash, {
      msisdn,
      mtsFio: row.mts_fio,
      employeeName: row.employee_full_name,
    });
  }

  const pairStats = new Map<string, { calls: number; totalSec: number }>();
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
      if (!ownHash || !byHash.has(ownHash)) continue;

      const peer = encryptionService.decryptField(row.peer_number_enc);
      const peerHash = msisdnHash(peer);
      if (!peerHash || !byHash.has(peerHash)) continue;

      const key = pairKey(ownHash, peerHash);
      const cur = pairStats.get(key) ?? { calls: 0, totalSec: 0 };
      cur.calls += 1;
      cur.totalSec += row.duration_sec ?? 0;
      pairStats.set(key, cur);
    }

    offset += rows.length;
    if (rows.length < BATCH) break;
  }

  const sorted = [...pairStats.entries()].sort((a, b) => b[1].calls - a[1].calls);
  if (sorted.length === 0) {
    console.log('Нет пар внутренних звонков (оба номера в number_map).');
    return;
  }

  const topN = Math.min(5, sorted.length);
  console.log(`Топ-${topN} пар по числу звонков (оба номера в МТС Бизнес):\n`);

  for (let i = 0; i < topN; i++) {
    const [key, stat] = sorted[i];
    const [h1, h2] = key.split('|');
    const n1 = byHash.get(h1)!;
    const n2 = byHash.get(h2)!;
    const label = (n: INumberInfo): string =>
      n.employeeName ?? n.mtsFio ?? n.msisdn ?? '—';

    const mins = Math.floor(stat.totalSec / 60);
    const secs = stat.totalSec % 60;
    console.log(
      `${i + 1}. ${label(n1)} ↔ ${label(n2)} — ${stat.calls} звонков, ${mins} мин ${secs} с`,
    );
    console.log(`   ${n1.msisdn ?? '—'} ↔ ${n2.msisdn ?? '—'}`);
    if (n1.mtsFio && n1.employeeName) console.log(`   [1] МТС: ${n1.mtsFio}`);
    if (n2.mtsFio && n2.employeeName) console.log(`   [2] МТС: ${n2.mtsFio}`);
    console.log('');
  }
};

main().catch(err => {
  console.error(err);
  process.exit(1);
});
