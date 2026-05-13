// sigur-retention-probe.ts
//
// Определяет границу retention'а Sigur API: за какие даты он ещё возвращает
// события. Нужно для решения, какой диапазон можно вытянуть в backfill
// после Yandex cutover.
//
// Скрипт ТОЛЬКО ЧИТАЕТ из Sigur (никаких записей). Безопасно повторно
// запускать. БД target не трогает вообще.
//
// Запуск:
//   npm run migrate:yandex:sigur-retention -- --help
//   npm run migrate:yandex:sigur-retention -- --probes=30,60,90,180,365,540,730
//
// ENV (из .migration/yandex.env или fot-server/.env):
//   SIGUR_INTERNAL_URL / SIGUR_INTERNAL_USERNAME / SIGUR_INTERNAL_PASSWORD
//   ИЛИ SIGUR_EXTERNAL_*  — sigurService автоматически выберет.
//
// Не зависит от target БД. Можно запускать с локального .env / прод-сервера.

import { sigurService } from '../../src/services/sigur.service.js';

const HELP = `sigur-retention-probe — пробует Sigur API на разной глубине истории

Usage:
  npm run migrate:yandex:sigur-retention -- [--probes=DAYS_LIST]

Options:
  --probes=N,N,N  список глубин в днях для проверки.
                  Default: 7,30,90,180,365,540,730
  --window=N      окно в часах вокруг каждой пробной точки (default: 24)
  --help, -h      эта справка.

ENV:
  SIGUR_INTERNAL_URL / SIGUR_INTERNAL_USERNAME / SIGUR_INTERNAL_PASSWORD
  или SIGUR_EXTERNAL_* — sigurService выберет автоматически.

Что делает:
  Для каждой глубины D дней назад:
    1. Считает startTime = (now - D days), endTime = startTime + 24 ч.
    2. Запрашивает sigurService.getEventsWithFailures(start, end).
    3. Печатает: глубина D, дата, pass-count, failures-count, ok|empty|error.
  Выводит вердикт: максимальная глубина, на которой Sigur вернул хотя бы 1
  событие.

Exit codes:
  0 — успешно запросили (даже если все пробы вернули 0)
  1 — Sigur не настроен или сеть недоступна
  2 — ошибка аргументов
`;

interface ICli {
  probes: number[];
  windowHours: number;
  help: boolean;
}

function parseArgs(argv: readonly string[]): ICli {
  const out: ICli = { probes: [7, 30, 90, 180, 365, 540, 730], windowHours: 24, help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--probes=')) {
      out.probes = a.slice(9).split(',').map(s => Number.parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
    } else if (a.startsWith('--window=')) {
      const v = Number.parseInt(a.slice(9), 10);
      if (Number.isFinite(v) && v > 0) out.windowHours = v;
    } else {
      throw new Error(`Неизвестный аргумент: ${a}`);
    }
  }
  if (out.probes.length === 0) throw new Error('--probes должен быть непустым списком');
  return out;
}

function fmtIsoMoscow(d: Date): string {
  // Sigur ожидает локальное время Москвы; sigurService.ensureTimezone сам
  // подкорректирует, нам достаточно ISO без TZ.
  return d.toISOString().slice(0, 19);
}

async function main(): Promise<void> {
  let cli: ICli;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error('\n' + HELP);
    process.exit(2);
  }
  if (cli.help) {
    console.log(HELP);
    return;
  }

  if (!(await sigurService.isConfigured())) {
    console.error('ERROR: Sigur не настроен — проверьте SIGUR_INTERNAL_URL/EXTERNAL_URL + creds в .env');
    process.exit(1);
  }

  console.log(`Probing Sigur retention; window=${cli.windowHours}h around each point`);
  console.log(`Connection: ${await sigurService.getActiveConnectionLabel?.() ?? '(unknown)'}`);
  console.log('');

  const now = new Date();
  let deepest: { days: number; pass: number; failures: number } | null = null;

  for (const days of cli.probes) {
    const startTime = new Date(now.getTime() - days * 86400_000);
    const endTime = new Date(startTime.getTime() + cli.windowHours * 3600_000);
    const startStr = fmtIsoMoscow(startTime);
    const endStr = fmtIsoMoscow(endTime);
    process.stdout.write(`  -${days}d @ ${startStr.slice(0, 10)} ... `);
    try {
      const result = await sigurService.getEventsWithFailures(startStr, endStr);
      const passN = result.pass?.length ?? 0;
      const failN = result.failures?.length ?? 0;
      const status = passN + failN > 0 ? 'OK' : 'empty';
      console.log(`pass=${passN} failures=${failN} → ${status}`);
      if (passN + failN > 0) {
        deepest = { days, pass: passN, failures: failN };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`ERROR: ${msg.slice(0, 200)}`);
    }
  }

  console.log('');
  if (deepest) {
    console.log(`✓ Sigur retention: as deep as ${deepest.days} days back returned data (${deepest.pass} pass / ${deepest.failures} failures in 1h window).`);
    console.log('  Используйте этот диапазон при планировании Sigur API backfill.');
  } else {
    console.log('⚠ Все пробы пустые — Sigur может не иметь истории, или endpoint вернул ошибки.');
    console.log('  Проверьте Sentry / Sigur dashboard. Не запускайте backfill без подтверждения retention.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err instanceof Error ? err.stack : err);
  process.exit(2);
});
