import { queryOne, execute } from '../src/config/postgres.ts';

const KEY = 'mts_business_refresh_all';

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'show';
  const row = await queryOne<{
    key: string;
    lease_expires_at: string | null;
    meta: { status?: Record<string, unknown> } | null;
  }>('SELECT key, lease_expires_at, meta FROM sigur_runtime_state WHERE key = $1', [KEY]);

  if (!row) {
    console.log('no row');
    return;
  }

  const status = row.meta?.status as {
    running?: boolean;
    steps?: Array<{ status: string; step: string; accountLabel: string; message?: string | null }>;
    error?: string | null;
    finishedAt?: string | null;
  } | undefined;

  console.log('lease_expires_at:', row.lease_expires_at);
  console.log('running:', status?.running);
  console.log('error:', status?.error);
  if (status?.steps) {
    for (const s of status.steps) {
      console.log(`  ${s.accountLabel} · ${s.step}: ${s.status} ${s.message ?? ''}`);
    }
  }

  if (mode === 'fix' && status) {
    const leaseAlive = row.lease_expires_at != null && Date.parse(row.lease_expires_at) > Date.now();
    if (status.running && !leaseAlive) {
      const fixed = {
        ...status,
        running: false,
        finishedAt: status.finishedAt ?? new Date().toISOString(),
        error: status.error ?? 'Обновление прервано (сервер перезапущен)',
        steps: (status.steps ?? []).map(s => (
          s.status === 'running' || s.status === 'pending'
            ? { ...s, status: 'error', message: s.message ?? 'Прервано' }
            : s
        )),
      };
    await execute(
      `UPDATE sigur_runtime_state SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{status}', $2::jsonb), updated_at = NOW(), lease_expires_at = NULL, lease_owner = NULL WHERE key = $1`,
      [KEY, JSON.stringify(fixed)],
    );
      console.log('FIXED');
    } else {
      console.log('nothing to fix');
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
