/**
 * Осиротевшие claim увольнения после отката синком Sigur (07–08.2026) — разбор 29.10.2026
 * (orphan-dismissal-claim-repair.service.ts). Элмирзоев (2300) снят отдельным SQL в тот же день,
 * Галущак (10044) не входит — решают кадры.
 *
 *  - 8 работают (проходы СКУД в октябре) — снять claim;
 *  - 14 уволены по факту (0 проходов после D, открыто только «Уволенные» с D+1) — штатное увольнение датой D.
 *
 * Запуск (на сервере — из каталога сайта, где .env; Sigur доступен только оттуда):
 *   npx tsx scripts/repair-orphan-dismissal-claims-2026-10.ts          — сухой прогон (проверки, без записи)
 *   npx tsx scripts/repair-orphan-dismissal-claims-2026-10.ts --apply  — запись
 */
import { closeDb } from '../src/config/postgres.js';
import {
  repairOrphanDismissalClaims,
  type IOrphanClaimItem,
  type IOrphanClaimTarget,
} from '../src/services/orphan-dismissal-claim-repair.service.js';

const TAG = '[repair-orphan-dismissal-claims]';

const working = (employeeId: number, fullName: string): IOrphanClaimTarget => (
  { employeeId, fullName, outcome: 'legitimate_rehire' }
);
const fired = (employeeId: number, fullName: string, dismissalDate: string): IOrphanClaimTarget => (
  { employeeId, fullName, outcome: 'confirmed_fired', dismissalDate }
);

const TARGETS: IOrphanClaimTarget[] = [
  working(17, 'Абдуганиев Абдухаким Абдухафизович'),
  working(130, 'Алланазаров Жура Холиярович'),
  working(462, 'Горбенко Константин Николаевич'),
  working(1020, 'Любинская Наталья Евгеньевна'),
  working(1938, 'Хакимов Абдурайим Абдухалимович'),
  working(1939, 'Хакимов Боборайим Абдухалимович'),
  working(2157, 'Шукуров Мансур Тожиевич'),
  working(2366, 'Мамаражабов Сардоржон Ботир Угли'),

  fired(1381, 'Парахненко Александра Салиховна', '2026-08-12'),
  fired(2617, 'Абдувалиев Аблаёр Хамиджон Угли', '2026-08-06'),
  fired(2687, 'Абзойиров Нурбой Олим Угли', '2026-08-11'),
  fired(2872, 'Аскаров Гайратжон Муйдинович', '2026-08-12'),
  fired(3469, 'Зарифов Сардорбек Анвар Угли', '2026-08-11'),
  fired(3669, 'Каримов Шахром Кушин Угли', '2026-08-11'),
  fired(4214, 'Муротов Равшан Жума Угли', '2026-08-05'),
  fired(4873, 'Сотиболдиев Санжарбек Илхомбек Угли', '2026-08-11'),
  fired(5367, 'Хусанов Санжар Рашидович', '2026-08-12'),
  fired(5668, 'Юсупов Аброрбек Немат Угли', '2026-08-11'),
  fired(5774, 'Абдулазизов Азимшер Алишерович', '2026-08-07'),
  fired(5780, 'Ералиев Олим Азамович', '2026-08-07'),
  fired(5903, 'Зокиров Музаффар Хамдамович', '2026-08-12'),
  fired(5931, 'Мардаев Абдужаббор Тоирович', '2026-08-12'),
];

const formatResult = (item: IOrphanClaimItem): string => {
  const { result } = item;
  switch (result.status) {
    case 'skipped': return `пропущен — ${result.reason}`;
    case 'planned': return item.outcome === 'confirmed_fired'
      ? `будет уволен датой ${result.dismissalDate}`
      : 'claim будет снят (записано и откатано)';
    case 'claim_cleared': return 'claim снят';
    case 'dismissed': return `уволен датой ${result.dismissalDate}, операция ${result.operationId}`;
    case 'sigur_pending': return `уволен в портале не до конца: Sigur не ответил, операция ${result.operationId} `
      + `в очереди бэкенда (${result.error})`;
    case 'failed': return `ОШИБКА — ${result.error}`;
  }
};

const main = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');
  const items = await repairOrphanDismissalClaims(TARGETS, { apply });
  console.log(`${TAG} ${apply ? 'ЗАПИСЬ' : 'сухой прогон'}: сотрудников ${items.length}`);
  for (const item of items) console.log(`${TAG}   ${item.employeeId} ${item.fullName}: ${formatResult(item)}`);

  const count = (statuses: string[]): number => items.filter(item => statuses.includes(item.result.status)).length;
  console.log(`${TAG} ${apply ? 'применено' : 'к применению'}: ${count(['planned', 'claim_cleared', 'dismissed'])}, `
    + `Sigur в очереди: ${count(['sigur_pending'])}, пропущено: ${count(['skipped'])}, ошибок: ${count(['failed'])}`);
  if (count(['skipped', 'failed']) > 0) process.exitCode = 1;
};

main()
  .catch(error => {
    console.error(`${TAG} ошибка до обработки сотрудников, ничего не записано:`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
