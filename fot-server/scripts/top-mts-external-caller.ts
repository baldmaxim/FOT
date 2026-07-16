/**
 * Внешний номер (нет в mts_business_number_map), который чаще всего
 * звонит на корпоративные номера FOT (direction = in у CDR).
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

interface IPeerStat {
  peer: string;
  peerHash: string;
  callsIn: number;
  callsOut: number;
  totalSecIn: number;
  totalSecOut: number;
  uniqueCompanyNumbers: Set<string>;
}

const main = async (): Promise<void> => {
  const { query } = await import('../src/config/postgres.js');
  const { encryptionService } = await import('../src/services/encryption.service.js');
  const { msisdnHash, normalizeMsisdn } = await import('../src/services/mts-business-cdr.service.js');

  const mapRows = await query<{ msisdn_hash: string }>(
    `SELECT msisdn_hash FROM mts_business_number_map`,
  );
  const internalHashes = new Set(mapRows.map(r => r.msisdn_hash));

  const byPeer = new Map<string, IPeerStat>();
  const BATCH = 5000;
  let offset = 0;

  for (;;) {
    const rows = await query<{
      msisdn_hash: string | null;
      peer_number_enc: string | null;
      direction: string | null;
      duration_sec: number;
    }>(
      `SELECT msisdn_hash, peer_number_enc, direction, duration_sec
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

      const peerRaw = encryptionService.decryptField(row.peer_number_enc);
      const peer = normalizeMsisdn(peerRaw) ?? peerRaw?.trim() ?? null;
      if (!peer) continue;

      const peerHash = msisdnHash(peer);
      if (!peerHash || internalHashes.has(peerHash)) continue;

      let st = byPeer.get(peerHash);
      if (!st) {
        st = {
          peer,
          peerHash,
          callsIn: 0,
          callsOut: 0,
          totalSecIn: 0,
          totalSecOut: 0,
          uniqueCompanyNumbers: new Set(),
        };
        byPeer.set(peerHash, st);
      }

      const dir = (row.direction ?? '').toLowerCase();
      const isIn = dir === 'in' || dir.includes('in') || dir.includes('<--');
      if (isIn) {
        st.callsIn += 1;
        st.totalSecIn += row.duration_sec ?? 0;
      } else {
        st.callsOut += 1;
        st.totalSecOut += row.duration_sec ?? 0;
      }
      st.uniqueCompanyNumbers.add(ownHash);
    }

    offset += rows.length;
    if (rows.length < BATCH) break;
  }

  const ranked = [...byPeer.values()].sort(
    (a, b) => b.callsIn - a.callsIn || b.totalSecIn - a.totalSecIn,
  );

  if (ranked.length === 0) {
    console.log('Нет внешних номеров с входящими на корпоративные.');
    return;
  }

  console.log('Внешние номера (нет в FOT number_map), чаще всего звонящие на корпоративные:');
  console.log('Метрика: входящие на номера компании (direction=in), период 01.06–10.07.2026\n');

  for (let i = 0; i < Math.min(10, ranked.length); i++) {
    const r = ranked[i];
    const mins = Math.floor(r.totalSecIn / 60);
    const secs = r.totalSecIn % 60;
    console.log(
      `${i + 1}. ${r.peer} — ${r.callsIn} входящих на корп. номера, ${mins} мин ${secs} с`,
    );
    console.log(
      `   уникальных корп. номеров: ${r.uniqueCompanyNumbers.size}; исходящих с корп. на него: ${r.callsOut}`,
    );
    console.log('');
  }
};

main().catch(err => {
  console.error(err);
  process.exit(1);
});
