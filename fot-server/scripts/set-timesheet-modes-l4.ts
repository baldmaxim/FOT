/**
 * Пакетная установка режима табелирования 1С по списку расхождений с 1С («Лист4»).
 *
 * Эквивалент ручной настройки в UI «Управление кадрами → Режим табелирования» для каждого
 * из списка: режим `object` с закреплённым объектом (одному человеку — `current_activity`).
 * Действует постоянно, на все периоды — как и ручная настройка.
 *
 * Пишет ТОЛЬКО employees.timesheet_export_mode / timesheet_export_object_id (миграция 249).
 * `employee_object_assignment` / `department_object_assignment` НЕ трогает — они участвуют
 * в скоупе табельщиц и правах. `updated_at` намеренно не обновляется.
 *
 * Гарантии:
 *   - preflight: колонки 249 на месте; employeeId ↔ ФИО; objectId ↔ название ↔ печатный адрес;
 *     объект активен и единственный; дублей employeeId нет;
 *   - уже заданный вручную режим НЕ перезаписывается — такие строки пропускаются и печатаются;
 *   - advisory lock → SELECT ... FOR UPDATE → повторная сверка → UPDATE ... WHERE mode IS NULL;
 *   - снимок «до/после» пишется на диск ДО commit: упала запись файла — откатилась транзакция;
 *   - post-check внутри транзакции: rowCount и конечные пары (mode, object_id);
 *   - откат: --rollback <файл>; возвращает строку, только если её текущее значение всё ещё
 *     равно установленному этим скриптом (иначе — конфликт, пропуск).
 *
 * Запуск локально (БД — прод):
 *   cd fot-server && npx tsx scripts/set-timesheet-modes-l4.ts
 *   npx tsx scripts/set-timesheet-modes-l4.ts --apply --actor-user-id=<uuid> --snapshot=<путь>
 *
 * Запуск на проде (из /opt/fot-build/fot-server, env уже задан окружением):
 *   npx tsx scripts/set-timesheet-modes-l4.ts
 *   npx tsx scripts/set-timesheet-modes-l4.ts --apply --actor-user-id=<uuid> \
 *     --snapshot=/srv/sites/fot.su10.ru/rollback_timesheet_modes_l4.json
 *
 * Откат:
 *   npx tsx scripts/set-timesheet-modes-l4.ts --rollback <файл> --actor-user-id=<uuid>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

// На проде DATABASE_URL/CA приходят из окружения — не подменяем. Локально читаем fot-server/.env.
if (!process.env.DATABASE_URL) {
  const envPath = path.resolve(__dirname, '../.env');
  const text = fs.readFileSync(envPath, 'utf8');
  const parsed: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    parsed[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  if (!parsed.DATABASE_URL) {
    console.error(`DATABASE_URL не найден ни в окружении, ни в ${envPath}`);
    process.exit(1);
  }
  try {
    const u = new URL(parsed.DATABASE_URL);
    for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) u.searchParams.delete(k);
    process.env.DATABASE_URL = u.toString();
  } catch {
    process.env.DATABASE_URL = parsed.DATABASE_URL;
  }
  process.env.DATABASE_SSL = process.env.DATABASE_SSL ?? 'true';
  process.env.DATABASE_SSL_CA_PATH = process.env.DATABASE_SSL_CA_PATH
    ?? path.resolve(__dirname, '../../.migration/yandex-ca.pem');
}

interface ITarget {
  employeeId: number;
  name: string;
  mode: 'object' | 'current_activity';
  objectId: string | null;
  objectName: string | null;
  /** Печатный адрес объекта в едином файле 1С: alt_name || name. */
  objectAddress: string;
}

/** Целевой список из «Лист4» (сгенерирован scripts/gen-l4-targets.ts). */
const TARGETS: ITarget[] = [
  { employeeId: 76, name: "Агарков Артем Эдуардович", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 95, name: "Айдралиева Мадина Бикбулатовна", mode: 'object', objectId: '660dd204-4baf-4b06-8c9b-0379291c1050', objectName: "ЖК Примавера К13", objectAddress: "Волоколамское ш., вл. 71/13, ЖК PRIMAVERA, к. 13, (стр. 1, 2, 3, 4, 5, 6, 7, А) н/ч, п/ч (-1этаж), организация стр. площадки, благоустройство" },
  { employeeId: 109, name: "Александрович Олег", mode: 'object', objectId: '505b7090-27cf-44e9-9bd1-556d373b422d', objectName: "ЖК Инжой", objectAddress: "Адмирала Макарова ул., вл. 2/16, ЖК \"INJOY\" п/ч, с. 1.1 - 1.10 н/ч, организация стройплощадки в соответствии с ПОС" },
  { employeeId: 110, name: "Александрович Руслана", mode: 'object', objectId: 'ced2b4b9-84e8-4403-8da0-4a02eaeb36b6', objectName: "ЖК Stories", objectAddress: "Раменки ВТМО, ЖК \"Stories\", ул. Лобачевского, з/у 124/3А,  п/ч, к. 1, 2 н/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 8926, name: "Алесина Светлана Михайловна", mode: 'object', objectId: 'ca93f010-b022-485b-b90f-453e4c08d8b8', objectName: "ЖК King and Sons", objectAddress: "Мосфильмовская ул., вл. 31А, ЖК \"King&Sons\" п/ч, жд, стр. 1, 2 н/ч, организация строительной площадки в соответствии с ПОС, благоустройство" },
  { employeeId: 2326, name: "Бабаев Эмиль Юсифович", mode: 'object', objectId: 'ced2b4b9-84e8-4403-8da0-4a02eaeb36b6', objectName: "ЖК Stories", objectAddress: "Раменки ВТМО, ЖК \"Stories\", ул. Лобачевского, з/у 124/3А,  п/ч, к. 1, 2 н/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 13379, name: "Баллиев Алихан Расулович", mode: 'object', objectId: 'ced2b4b9-84e8-4403-8da0-4a02eaeb36b6', objectName: "ЖК Stories", objectAddress: "Раменки ВТМО, ЖК \"Stories\", ул. Лобачевского, з/у 124/3А,  п/ч, к. 1, 2 н/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 229, name: "Барабаш Виктор Васильевич", mode: 'object', objectId: '61cd81b6-1a8c-46e0-b1a7-844cf8ca2db0', objectName: "ЖК Зил 18,19,27", objectAddress: "Автозаводская ул., вл. 23/2, ЖК «ЗИЛАРТ», Лоты 18, 19, 27, к. 1 - 7, н/ч, п/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 231, name: "Баранская Зореслава Олеговна", mode: 'object', objectId: '505b7090-27cf-44e9-9bd1-556d373b422d', objectName: "ЖК Инжой", objectAddress: "Адмирала Макарова ул., вл. 2/16, ЖК \"INJOY\" п/ч, с. 1.1 - 1.10 н/ч, организация стройплощадки в соответствии с ПОС" },
  { employeeId: 248, name: "Барышева Алена Александровна", mode: 'object', objectId: '9f240764-c8b8-401d-9c92-d257b30afc23', objectName: "ЖК Wave", objectAddress: "Борисовские Пруды ул., ЖК \"Wave 2\", п/ч, н/ч, к. 1 - 7, организация стр. площадки в соотв-и с ПОС, благоустройство" },
  { employeeId: 273, name: "Бегматов Джасурбек Илхомович", mode: 'object', objectId: '660dd204-4baf-4b06-8c9b-0379291c1050', objectName: "ЖК Примавера К13", objectAddress: "Волоколамское ш., вл. 71/13, ЖК PRIMAVERA, к. 13, (стр. 1, 2, 3, 4, 5, 6, 7, А) н/ч, п/ч (-1этаж), организация стр. площадки, благоустройство" },
  { employeeId: 2459, name: "Бестаев Асланбек Ильич", mode: 'object', objectId: '61cd81b6-1a8c-46e0-b1a7-844cf8ca2db0', objectName: "ЖК Зил 18,19,27", objectAddress: "Автозаводская ул., вл. 23/2, ЖК «ЗИЛАРТ», Лоты 18, 19, 27, к. 1 - 7, н/ч, п/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 11223, name: "Вайнштейн Марк Олегович", mode: 'object', objectId: 'ca93f010-b022-485b-b90f-453e4c08d8b8', objectName: "ЖК King and Sons", objectAddress: "Мосфильмовская ул., вл. 31А, ЖК \"King&Sons\" п/ч, жд, стр. 1, 2 н/ч, организация строительной площадки в соответствии с ПОС, благоустройство" },
  { employeeId: 2524, name: "Василиу Анна Васильевна", mode: 'object', objectId: 'ced2b4b9-84e8-4403-8da0-4a02eaeb36b6', objectName: "ЖК Stories", objectAddress: "Раменки ВТМО, ЖК \"Stories\", ул. Лобачевского, з/у 124/3А,  п/ч, к. 1, 2 н/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 2461, name: "Вигилев Александр Олегович", mode: 'object', objectId: '660dd204-4baf-4b06-8c9b-0379291c1050', objectName: "ЖК Примавера К13", objectAddress: "Волоколамское ш., вл. 71/13, ЖК PRIMAVERA, к. 13, (стр. 1, 2, 3, 4, 5, 6, 7, А) н/ч, п/ч (-1этаж), организация стр. площадки, благоустройство" },
  { employeeId: 11224, name: "Волкова Анастасия Михайловна", mode: 'object', objectId: '2e223230-200c-4cde-a47b-180dbf6eaafa', objectName: "ЖК Примавера К22", objectAddress: "Волоколамское ш., вл. 71/12, ЖК PRIMAVERA, к. 22,  стр. 1, 2, А, Б н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 407, name: "Воронович Евгений Викторович", mode: 'object', objectId: '61cd81b6-1a8c-46e0-b1a7-844cf8ca2db0', objectName: "ЖК Зил 18,19,27", objectAddress: "Автозаводская ул., вл. 23/2, ЖК «ЗИЛАРТ», Лоты 18, 19, 27, к. 1 - 7, н/ч, п/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 408, name: "Воронцова Наталья Алексеевна", mode: 'object', objectId: '505b7090-27cf-44e9-9bd1-556d373b422d', objectName: "ЖК Инжой", objectAddress: "Адмирала Макарова ул., вл. 2/16, ЖК \"INJOY\" п/ч, с. 1.1 - 1.10 н/ч, организация стройплощадки в соответствии с ПОС" },
  { employeeId: 414, name: "Габараева Ригина Георгиевна", mode: 'object', objectId: '484ff35d-6518-472d-ad6d-e2cb6cb1c4ce', objectName: "ЖК Дом 56", objectAddress: "Фридриха Энгельса ул., з. у. 56/1, ЖК \"Дом 56\" п/ч, с. 1 - 3 н/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 415, name: "Гаврилов Александр Николаевич", mode: 'object', objectId: '2e223230-200c-4cde-a47b-180dbf6eaafa', objectName: "ЖК Примавера К22", objectAddress: "Волоколамское ш., вл. 71/12, ЖК PRIMAVERA, к. 22,  стр. 1, 2, А, Б н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 437, name: "Гезалов Элзамин Элизбар Оглы", mode: 'object', objectId: '2e223230-200c-4cde-a47b-180dbf6eaafa', objectName: "ЖК Примавера К22", objectAddress: "Волоколамское ш., вл. 71/12, ЖК PRIMAVERA, к. 22,  стр. 1, 2, А, Б н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 440, name: "Гладкая Алина Романовна", mode: 'object', objectId: '19a30fb1-e816-41f3-9e73-def8c7807c9b', objectName: "ЖК Alia", objectAddress: "Лётная ул., ЖК «ÁLIA», Блоки 13А, 13B п/ч, к. 1 - 7 н/ч, организация стройплощадки в соответствии с ПОС, благоустройство, разработка РД" },
  { employeeId: 444, name: "Глянь Артём Денисович", mode: 'object', objectId: '20479cb6-fee5-4996-be15-3dd05f6b930d', objectName: "ЖК События 6.2", objectAddress: "Раменки р-н, ЖК \"Событие 6.2\", м/у ул. Лобачевского и платформой \"Матвеевское\", п/ч (-2 этажа), с. 1 - 5, н/ч, организация стройпл., благ-во, разр. РД" },
  { employeeId: 464, name: "Гореликова Алла Николаевна", mode: 'object', objectId: '660dd204-4baf-4b06-8c9b-0379291c1050', objectName: "ЖК Примавера К13", objectAddress: "Волоколамское ш., вл. 71/13, ЖК PRIMAVERA, к. 13, (стр. 1, 2, 3, 4, 5, 6, 7, А) н/ч, п/ч (-1этаж), организация стр. площадки, благоустройство" },
  { employeeId: 483, name: "Гриценко Андрей Владимирович", mode: 'object', objectId: '19a30fb1-e816-41f3-9e73-def8c7807c9b', objectName: "ЖК Alia", objectAddress: "Лётная ул., ЖК «ÁLIA», Блоки 13А, 13B п/ч, к. 1 - 7 н/ч, организация стройплощадки в соответствии с ПОС, благоустройство, разработка РД" },
  { employeeId: 487, name: "Гулдасташоев Иброхим Назархудоевич", mode: 'object', objectId: '2e223230-200c-4cde-a47b-180dbf6eaafa', objectName: "ЖК Примавера К22", objectAddress: "Волоколамское ш., вл. 71/12, ЖК PRIMAVERA, к. 22,  стр. 1, 2, А, Б н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 497, name: "Гусакова Ольга Анатольевна", mode: 'object', objectId: '61cd81b6-1a8c-46e0-b1a7-844cf8ca2db0', objectName: "ЖК Зил 18,19,27", objectAddress: "Автозаводская ул., вл. 23/2, ЖК «ЗИЛАРТ», Лоты 18, 19, 27, к. 1 - 7, н/ч, п/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 505, name: "Давлатназаров Охир Тохирович", mode: 'object', objectId: '61cd81b6-1a8c-46e0-b1a7-844cf8ca2db0', objectName: "ЖК Зил 18,19,27", objectAddress: "Автозаводская ул., вл. 23/2, ЖК «ЗИЛАРТ», Лоты 18, 19, 27, к. 1 - 7, н/ч, п/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 2525, name: "Дакенова Диана Ильфировна", mode: 'object', objectId: '660dd204-4baf-4b06-8c9b-0379291c1050', objectName: "ЖК Примавера К13", objectAddress: "Волоколамское ш., вл. 71/13, ЖК PRIMAVERA, к. 13, (стр. 1, 2, 3, 4, 5, 6, 7, А) н/ч, п/ч (-1этаж), организация стр. площадки, благоустройство" },
  { employeeId: 523, name: "Демчук Анна Александровна", mode: 'object', objectId: '484ff35d-6518-472d-ad6d-e2cb6cb1c4ce', objectName: "ЖК Дом 56", objectAddress: "Фридриха Энгельса ул., з. у. 56/1, ЖК \"Дом 56\" п/ч, с. 1 - 3 н/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 14122, name: "Дуброва Анна Николаевна", mode: 'object', objectId: '20479cb6-fee5-4996-be15-3dd05f6b930d', objectName: "ЖК События 6.2", objectAddress: "Раменки р-н, ЖК \"Событие 6.2\", м/у ул. Лобачевского и платформой \"Матвеевское\", п/ч (-2 этажа), с. 1 - 5, н/ч, организация стройпл., благ-во, разр. РД" },
  { employeeId: 562, name: "Дульянинов Владислав Игоревич", mode: 'object', objectId: '660dd204-4baf-4b06-8c9b-0379291c1050', objectName: "ЖК Примавера К13", objectAddress: "Волоколамское ш., вл. 71/13, ЖК PRIMAVERA, к. 13, (стр. 1, 2, 3, 4, 5, 6, 7, А) н/ч, п/ч (-1этаж), организация стр. площадки, благоустройство" },
  { employeeId: 572, name: "Евтушенко Юрий Евгеньевич", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 573, name: "Егоров Максим Олегович", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 577, name: "Ельшина Светлана Владимировна", mode: 'object', objectId: '20479cb6-fee5-4996-be15-3dd05f6b930d', objectName: "ЖК События 6.2", objectAddress: "Раменки р-н, ЖК \"Событие 6.2\", м/у ул. Лобачевского и платформой \"Матвеевское\", п/ч (-2 этажа), с. 1 - 5, н/ч, организация стройпл., благ-во, разр. РД" },
  { employeeId: 625, name: "Загородских Милана Юрьевна", mode: 'object', objectId: 'ced2b4b9-84e8-4403-8da0-4a02eaeb36b6', objectName: "ЖК Stories", objectAddress: "Раменки ВТМО, ЖК \"Stories\", ул. Лобачевского, з/у 124/3А,  п/ч, к. 1, 2 н/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 12758, name: "Загрудинова Ляйсан Мансуровна", mode: 'object', objectId: 'fefa18d1-6d2e-42ca-ae4b-9698e28a0b3e', objectName: "ЖК Примавера К14", objectAddress: "Волоколамское ш., вл. 71/14, ЖК PRIMAVERA, к. 14,  п/ч (-1этаж), н/ч, к. 14.1 - 14.7, 14.Г, 14.Д, организация стр. площадки, благоустройство" },
  { employeeId: 5824, name: "Зацепин Александр Евгеньевич", mode: 'object', objectId: '61cd81b6-1a8c-46e0-b1a7-844cf8ca2db0', objectName: "ЖК Зил 18,19,27", objectAddress: "Автозаводская ул., вл. 23/2, ЖК «ЗИЛАРТ», Лоты 18, 19, 27, к. 1 - 7, н/ч, п/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 642, name: "Злобина Валерия Викторовна", mode: 'object', objectId: '2b406444-f37f-4eb7-9b9a-750d56b30cbf', objectName: "ЖК Сад 69", objectAddress: "Садовническая ул., вл. 76/71,  ЖК \"Садовническая 69\", п/ч (-2 этажа), к. 1 - 4, н/ч, организация стройплощадки, благоустройство" },
  { employeeId: 650, name: "Золотухина Анастасия Игоревна", mode: 'object', objectId: 'b589ce7f-3f81-4683-a45c-3f52ffc4aefa', objectName: "ЖК Метрополия", objectAddress: "Волгоградский пр-т, вл. 32, к. 3, с. 1, 2, 3, н/ч, п/ч, организация стр. площадки, РД, благоустройство" },
  { employeeId: 655, name: "Зрелов Николай Анатольевич", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 656, name: "Зуева Нина Александровна", mode: 'object', objectId: '660dd204-4baf-4b06-8c9b-0379291c1050', objectName: "ЖК Примавера К13", objectAddress: "Волоколамское ш., вл. 71/13, ЖК PRIMAVERA, к. 13, (стр. 1, 2, 3, 4, 5, 6, 7, А) н/ч, п/ч (-1этаж), организация стр. площадки, благоустройство" },
  { employeeId: 11198, name: "Илларионова Янина Андреевна", mode: 'object', objectId: '2b406444-f37f-4eb7-9b9a-750d56b30cbf', objectName: "ЖК Сад 69", objectAddress: "Садовническая ул., вл. 76/71,  ЖК \"Садовническая 69\", п/ч (-2 этажа), к. 1 - 4, н/ч, организация стройплощадки, благоустройство" },
  { employeeId: 2346, name: "Имаметдинова Рузалия Рушановна", mode: 'object', objectId: '20479cb6-fee5-4996-be15-3dd05f6b930d', objectName: "ЖК События 6.2", objectAddress: "Раменки р-н, ЖК \"Событие 6.2\", м/у ул. Лобачевского и платформой \"Матвеевское\", п/ч (-2 этажа), с. 1 - 5, н/ч, организация стройпл., благ-во, разр. РД" },
  { employeeId: 704, name: "Исаев Дмитрий Михайлович", mode: 'object', objectId: '75167cfa-7d9e-4c00-b1ee-8b2b86533cdc', objectName: "База Илимская", objectAddress: "База Илимская-хозяйственная деятельность" },
  { employeeId: 714, name: "Исмаилов Рамиз Загирбегович", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 748, name: "Калиновский Сергей Александрович", mode: 'object', objectId: '484ff35d-6518-472d-ad6d-e2cb6cb1c4ce', objectName: "ЖК Дом 56", objectAddress: "Фридриха Энгельса ул., з. у. 56/1, ЖК \"Дом 56\" п/ч, с. 1 - 3 н/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 759, name: "Канивец Андрей Сергеевич", mode: 'object', objectId: 'b589ce7f-3f81-4683-a45c-3f52ffc4aefa', objectName: "ЖК Метрополия", objectAddress: "Волгоградский пр-т, вл. 32, к. 3, с. 1, 2, 3, н/ч, п/ч, организация стр. площадки, РД, благоустройство" },
  { employeeId: 760, name: "Канышева Алевтина Геннадьевна", mode: 'object', objectId: '9f240764-c8b8-401d-9c92-d257b30afc23', objectName: "ЖК Wave", objectAddress: "Борисовские Пруды ул., ЖК \"Wave 2\", п/ч, н/ч, к. 1 - 7, организация стр. площадки в соотв-и с ПОС, благоустройство" },
  { employeeId: 877, name: "Королев Сергей Викторович", mode: 'object', objectId: 'e90a66d8-ce50-42d3-8825-eea00ebd76ea', objectName: "Варшавская (ГО)", objectAddress: "КОТЛЯКОВСКИЙ 2-Й ПЕР., ВЛ. 1, ВАРШАВСКАЯ LIFE, КВ. 1, 2, 3 (Н/Ч), ПОДЗЕМ. А/СТ, КВ. 1, 2, 3 (П/Ч)" },
  { employeeId: 880, name: "Короткевич Дмитрий Владимирович", mode: 'object', objectId: '9f240764-c8b8-401d-9c92-d257b30afc23', objectName: "ЖК Wave", objectAddress: "Борисовские Пруды ул., ЖК \"Wave 2\", п/ч, н/ч, к. 1 - 7, организация стр. площадки в соотв-и с ПОС, благоустройство" },
  { employeeId: 882, name: "Короткова Виктория Васильевна", mode: 'object', objectId: '660dd204-4baf-4b06-8c9b-0379291c1050', objectName: "ЖК Примавера К13", objectAddress: "Волоколамское ш., вл. 71/13, ЖК PRIMAVERA, к. 13, (стр. 1, 2, 3, 4, 5, 6, 7, А) н/ч, п/ч (-1этаж), организация стр. площадки, благоустройство" },
  { employeeId: 8954, name: "Костромина Анна Викторовна", mode: 'object', objectId: '505b7090-27cf-44e9-9bd1-556d373b422d', objectName: "ЖК Инжой", objectAddress: "Адмирала Макарова ул., вл. 2/16, ЖК \"INJOY\" п/ч, с. 1.1 - 1.10 н/ч, организация стройплощадки в соответствии с ПОС" },
  { employeeId: 14119, name: "Котовский Андрей Йосифович", mode: 'object', objectId: '9d1f76d2-eec5-4231-88ef-b5b7cbdd0648', objectName: "Нагорная (ГО)", objectAddress: "Электролитный пр-д, вл. 7А, ЖК TopHILLS, к. 1 - 6, н/ч, подзем. а/ст (2 уровня) + рампа, стилобат (ФОК, ТЦ), благоустройство" },
  { employeeId: 13408, name: "Красюков Максим Андреевич", mode: 'current_activity', objectId: null, objectName: null, objectAddress: "Текущая деятельность" },
  { employeeId: 898, name: "Кречман Мария Александровна", mode: 'object', objectId: 'b589ce7f-3f81-4683-a45c-3f52ffc4aefa', objectName: "ЖК Метрополия", objectAddress: "Волгоградский пр-т, вл. 32, к. 3, с. 1, 2, 3, н/ч, п/ч, организация стр. площадки, РД, благоустройство" },
  { employeeId: 2539, name: "Крошкова Алина Сергеевна", mode: 'object', objectId: '20479cb6-fee5-4996-be15-3dd05f6b930d', objectName: "ЖК События 6.2", objectAddress: "Раменки р-н, ЖК \"Событие 6.2\", м/у ул. Лобачевского и платформой \"Матвеевское\", п/ч (-2 этажа), с. 1 - 5, н/ч, организация стройпл., благ-во, разр. РД" },
  { employeeId: 920, name: "Кузнецов Илья Викторович", mode: 'object', objectId: 'ca93f010-b022-485b-b90f-453e4c08d8b8', objectName: "ЖК King and Sons", objectAddress: "Мосфильмовская ул., вл. 31А, ЖК \"King&Sons\" п/ч, жд, стр. 1, 2 н/ч, организация строительной площадки в соответствии с ПОС, благоустройство" },
  { employeeId: 2526, name: "Кураж Камилла Игоревна", mode: 'object', objectId: '2e223230-200c-4cde-a47b-180dbf6eaafa', objectName: "ЖК Примавера К22", objectAddress: "Волоколамское ш., вл. 71/12, ЖК PRIMAVERA, к. 22,  стр. 1, 2, А, Б н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 972, name: "Кучаров Руслан Ботир Угли", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 981, name: "Лазов Янис Романович", mode: 'object', objectId: '484ff35d-6518-472d-ad6d-e2cb6cb1c4ce', objectName: "ЖК Дом 56", objectAddress: "Фридриха Энгельса ул., з. у. 56/1, ЖК \"Дом 56\" п/ч, с. 1 - 3 н/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 984, name: "Лаптева Надежда Владимировна", mode: 'object', objectId: 'b141b7a4-ab8b-426b-86c0-46e9ea66b3d3', objectName: "ЖК Марк (лот 33)", objectAddress: "Автозаводская ул., вл. 23/2, ЖК «ЗИЛАРТ», Лот 33, к. 1 - 3 н/ч, п/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 8909, name: "Лукьянова Ангелина Вячеславовна", mode: 'object', objectId: '61cd81b6-1a8c-46e0-b1a7-844cf8ca2db0', objectName: "ЖК Зил 18,19,27", objectAddress: "Автозаводская ул., вл. 23/2, ЖК «ЗИЛАРТ», Лоты 18, 19, 27, к. 1 - 7, н/ч, п/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 2364, name: "Магомедов Наиб Юнусович", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 1082, name: "Мартьянов Егор Андреевич", mode: 'object', objectId: '9f240764-c8b8-401d-9c92-d257b30afc23', objectName: "ЖК Wave", objectAddress: "Борисовские Пруды ул., ЖК \"Wave 2\", п/ч, н/ч, к. 1 - 7, организация стр. площадки в соотв-и с ПОС, благоустройство" },
  { employeeId: 1093, name: "Матвеева Людмила Викторовна", mode: 'object', objectId: '505b7090-27cf-44e9-9bd1-556d373b422d', objectName: "ЖК Инжой", objectAddress: "Адмирала Макарова ул., вл. 2/16, ЖК \"INJOY\" п/ч, с. 1.1 - 1.10 н/ч, организация стройплощадки в соответствии с ПОС" },
  { employeeId: 2537, name: "Мачкова Светлана Михайловна", mode: 'object', objectId: 'b141b7a4-ab8b-426b-86c0-46e9ea66b3d3', objectName: "ЖК Марк (лот 33)", objectAddress: "Автозаводская ул., вл. 23/2, ЖК «ЗИЛАРТ», Лот 33, к. 1 - 3 н/ч, п/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 1125, name: "Мелешко Александр Юрьевич", mode: 'object', objectId: 'ca93f010-b022-485b-b90f-453e4c08d8b8', objectName: "ЖК King and Sons", objectAddress: "Мосфильмовская ул., вл. 31А, ЖК \"King&Sons\" п/ч, жд, стр. 1, 2 н/ч, организация строительной площадки в соответствии с ПОС, благоустройство" },
  { employeeId: 2540, name: "Митасова Анастасия Андреевна", mode: 'object', objectId: 'b589ce7f-3f81-4683-a45c-3f52ffc4aefa', objectName: "ЖК Метрополия", objectAddress: "Волгоградский пр-т, вл. 32, к. 3, с. 1, 2, 3, н/ч, п/ч, организация стр. площадки, РД, благоустройство" },
  { employeeId: 1162, name: "Михайлова Наталья Николаевна", mode: 'object', objectId: '505b7090-27cf-44e9-9bd1-556d373b422d', objectName: "ЖК Инжой", objectAddress: "Адмирала Макарова ул., вл. 2/16, ЖК \"INJOY\" п/ч, с. 1.1 - 1.10 н/ч, организация стройплощадки в соответствии с ПОС" },
  { employeeId: 2529, name: "Мунческул Галина Федоровна", mode: 'object', objectId: '8d3ee006-5cd0-4130-8f4f-2916357e2918', objectName: "Тагильская (ГО)", objectAddress: "Тагильская ул., вл. 4, Этап 5, з/у 3, п/ч, Корпус в осях А-М; Р-Ю; благоустройство" },
  { employeeId: 1221, name: "Муха Александр Григорьевич", mode: 'object', objectId: '61cd81b6-1a8c-46e0-b1a7-844cf8ca2db0', objectName: "ЖК Зил 18,19,27", objectAddress: "Автозаводская ул., вл. 23/2, ЖК «ЗИЛАРТ», Лоты 18, 19, 27, к. 1 - 7, н/ч, п/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 1239, name: "Набока Татьяна Евгеньевна", mode: 'object', objectId: '660dd204-4baf-4b06-8c9b-0379291c1050', objectName: "ЖК Примавера К13", objectAddress: "Волоколамское ш., вл. 71/13, ЖК PRIMAVERA, к. 13, (стр. 1, 2, 3, 4, 5, 6, 7, А) н/ч, п/ч (-1этаж), организация стр. площадки, благоустройство" },
  { employeeId: 1255, name: "Назархудоев Шукрихудо Назархудоевич", mode: 'object', objectId: 'b589ce7f-3f81-4683-a45c-3f52ffc4aefa', objectName: "ЖК Метрополия", objectAddress: "Волгоградский пр-т, вл. 32, к. 3, с. 1, 2, 3, н/ч, п/ч, организация стр. площадки, РД, благоустройство" },
  { employeeId: 1283, name: "Нижников Геннадий Петрович", mode: 'object', objectId: '2e223230-200c-4cde-a47b-180dbf6eaafa', objectName: "ЖК Примавера К22", objectAddress: "Волоколамское ш., вл. 71/12, ЖК PRIMAVERA, к. 22,  стр. 1, 2, А, Б н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 1295, name: "Новоселова Наталья Петровна", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 1347, name: "Орехова Галина Михайловна", mode: 'object', objectId: '19a30fb1-e816-41f3-9e73-def8c7807c9b', objectName: "ЖК Alia", objectAddress: "Лётная ул., ЖК «ÁLIA», Блоки 13А, 13B п/ч, к. 1 - 7 н/ч, организация стройплощадки в соответствии с ПОС, благоустройство, разработка РД" },
  { employeeId: 1377, name: "Пантелин Дмитрий Сергеевич", mode: 'object', objectId: 'b589ce7f-3f81-4683-a45c-3f52ffc4aefa', objectName: "ЖК Метрополия", objectAddress: "Волгоградский пр-т, вл. 32, к. 3, с. 1, 2, 3, н/ч, п/ч, организация стр. площадки, РД, благоустройство" },
  { employeeId: 1382, name: "Парахненко Антон Андреевич", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 1392, name: "Пахомова Василина Валерьевна", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 1408, name: "Пиронов Фирдавс Бобоназарович", mode: 'object', objectId: '484ff35d-6518-472d-ad6d-e2cb6cb1c4ce', objectName: "ЖК Дом 56", objectAddress: "Фридриха Энгельса ул., з. у. 56/1, ЖК \"Дом 56\" п/ч, с. 1 - 3 н/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 1409, name: "Пичугин Ярослав Геннадьевич", mode: 'object', objectId: '9f240764-c8b8-401d-9c92-d257b30afc23', objectName: "ЖК Wave", objectAddress: "Борисовские Пруды ул., ЖК \"Wave 2\", п/ч, н/ч, к. 1 - 7, организация стр. площадки в соотв-и с ПОС, благоустройство" },
  { employeeId: 1438, name: "Пудовкин Александр Александрович", mode: 'object', objectId: '505b7090-27cf-44e9-9bd1-556d373b422d', objectName: "ЖК Инжой", objectAddress: "Адмирала Макарова ул., вл. 2/16, ЖК \"INJOY\" п/ч, с. 1.1 - 1.10 н/ч, организация стройплощадки в соответствии с ПОС" },
  { employeeId: 1475, name: "Рахматуллаев Бекзод Ташбоевич", mode: 'object', objectId: 'b589ce7f-3f81-4683-a45c-3f52ffc4aefa', objectName: "ЖК Метрополия", objectAddress: "Волгоградский пр-т, вл. 32, к. 3, с. 1, 2, 3, н/ч, п/ч, организация стр. площадки, РД, благоустройство" },
  { employeeId: 2399, name: "Рахматуллаев Фаррухжон Тошбекович", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 1493, name: "Ревизор Ирина Васильевна", mode: 'object', objectId: 'b141b7a4-ab8b-426b-86c0-46e9ea66b3d3', objectName: "ЖК Марк (лот 33)", objectAddress: "Автозаводская ул., вл. 23/2, ЖК «ЗИЛАРТ», Лот 33, к. 1 - 3 н/ч, п/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 1494, name: "Редько Дмитрий Викторович", mode: 'object', objectId: '8d3ee006-5cd0-4130-8f4f-2916357e2918', objectName: "Тагильская (ГО)", objectAddress: "Тагильская ул., вл. 4, Этап 5, з/у 3, п/ч, Корпус в осях А-М; Р-Ю; благоустройство" },
  { employeeId: 1499, name: "Репетенко Владимир Михайлович", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 8861, name: "Родионов Роман Станиславович", mode: 'object', objectId: '20479cb6-fee5-4996-be15-3dd05f6b930d', objectName: "ЖК События 6.2", objectAddress: "Раменки р-н, ЖК \"Событие 6.2\", м/у ул. Лобачевского и платформой \"Матвеевское\", п/ч (-2 этажа), с. 1 - 5, н/ч, организация стройпл., благ-во, разр. РД" },
  { employeeId: 1511, name: "Романец Галина Васильевна", mode: 'object', objectId: '660dd204-4baf-4b06-8c9b-0379291c1050', objectName: "ЖК Примавера К13", objectAddress: "Волоколамское ш., вл. 71/13, ЖК PRIMAVERA, к. 13, (стр. 1, 2, 3, 4, 5, 6, 7, А) н/ч, п/ч (-1этаж), организация стр. площадки, благоустройство" },
  { employeeId: 1572, name: "Сайдиллаев Азиз Эргашевич", mode: 'object', objectId: 'b589ce7f-3f81-4683-a45c-3f52ffc4aefa', objectName: "ЖК Метрополия", objectAddress: "Волгоградский пр-т, вл. 32, к. 3, с. 1, 2, 3, н/ч, п/ч, организация стр. площадки, РД, благоустройство" },
  { employeeId: 1593, name: "Санжаровский Кирилл Владимирович", mode: 'object', objectId: '660dd204-4baf-4b06-8c9b-0379291c1050', objectName: "ЖК Примавера К13", objectAddress: "Волоколамское ш., вл. 71/13, ЖК PRIMAVERA, к. 13, (стр. 1, 2, 3, 4, 5, 6, 7, А) н/ч, п/ч (-1этаж), организация стр. площадки, благоустройство" },
  { employeeId: 1600, name: "Сары Мария Петровна", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 1607, name: "Сатыбалдиев Артём", mode: 'object', objectId: '2e223230-200c-4cde-a47b-180dbf6eaafa', objectName: "ЖК Примавера К22", objectAddress: "Волоколамское ш., вл. 71/12, ЖК PRIMAVERA, к. 22,  стр. 1, 2, А, Б н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 1608, name: "Сатыбалдиева Екатерина Владимировна", mode: 'object', objectId: '2e223230-200c-4cde-a47b-180dbf6eaafa', objectName: "ЖК Примавера К22", objectAddress: "Волоколамское ш., вл. 71/12, ЖК PRIMAVERA, к. 22,  стр. 1, 2, А, Б н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 1633, name: "Свинцицкая Анастасия Геннадьевна", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 1634, name: "Свинцицкий Олег Владимирович", mode: 'object', objectId: 'ced2b4b9-84e8-4403-8da0-4a02eaeb36b6', objectName: "ЖК Stories", objectAddress: "Раменки ВТМО, ЖК \"Stories\", ул. Лобачевского, з/у 124/3А,  п/ч, к. 1, 2 н/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 2463, name: "Семёнов Никита Антонович", mode: 'object', objectId: 'ced2b4b9-84e8-4403-8da0-4a02eaeb36b6', objectName: "ЖК Stories", objectAddress: "Раменки ВТМО, ЖК \"Stories\", ул. Лобачевского, з/у 124/3А,  п/ч, к. 1, 2 н/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 1638, name: "Сердечный Максим Вячеславович", mode: 'object', objectId: 'b589ce7f-3f81-4683-a45c-3f52ffc4aefa', objectName: "ЖК Метрополия", objectAddress: "Волгоградский пр-т, вл. 32, к. 3, с. 1, 2, 3, н/ч, п/ч, организация стр. площадки, РД, благоустройство" },
  { employeeId: 1646, name: "Сидорчук Олег Дмитриевич", mode: 'object', objectId: '484ff35d-6518-472d-ad6d-e2cb6cb1c4ce', objectName: "ЖК Дом 56", objectAddress: "Фридриха Энгельса ул., з. у. 56/1, ЖК \"Дом 56\" п/ч, с. 1 - 3 н/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 1660, name: "Скрыпник Василий Викторович", mode: 'object', objectId: 'b589ce7f-3f81-4683-a45c-3f52ffc4aefa', objectName: "ЖК Метрополия", objectAddress: "Волгоградский пр-т, вл. 32, к. 3, с. 1, 2, 3, н/ч, п/ч, организация стр. площадки, РД, благоустройство" },
  { employeeId: 2528, name: "Смирнова Александра Дмитриевна", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 1665, name: "Смитская Юлия Александровна", mode: 'object', objectId: 'ca93f010-b022-485b-b90f-453e4c08d8b8', objectName: "ЖК King and Sons", objectAddress: "Мосфильмовская ул., вл. 31А, ЖК \"King&Sons\" п/ч, жд, стр. 1, 2 н/ч, организация строительной площадки в соответствии с ПОС, благоустройство" },
  { employeeId: 1667, name: "Смоляков Александр Юрьевич", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 2468, name: "Спасскова Елена Викторовна", mode: 'object', objectId: '484ff35d-6518-472d-ad6d-e2cb6cb1c4ce', objectName: "ЖК Дом 56", objectAddress: "Фридриха Энгельса ул., з. у. 56/1, ЖК \"Дом 56\" п/ч, с. 1 - 3 н/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 1707, name: "Студзинский Виктор Михайлович", mode: 'object', objectId: '660dd204-4baf-4b06-8c9b-0379291c1050', objectName: "ЖК Примавера К13", objectAddress: "Волоколамское ш., вл. 71/13, ЖК PRIMAVERA, к. 13, (стр. 1, 2, 3, 4, 5, 6, 7, А) н/ч, п/ч (-1этаж), организация стр. площадки, благоустройство" },
  { employeeId: 1742, name: "Терентьева Ольга Борисовна", mode: 'object', objectId: '61cd81b6-1a8c-46e0-b1a7-844cf8ca2db0', objectName: "ЖК Зил 18,19,27", objectAddress: "Автозаводская ул., вл. 23/2, ЖК «ЗИЛАРТ», Лоты 18, 19, 27, к. 1 - 7, н/ч, п/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 13394, name: "Тимофеев Леонид Леонидович", mode: 'object', objectId: '20479cb6-fee5-4996-be15-3dd05f6b930d', objectName: "ЖК События 6.2", objectAddress: "Раменки р-н, ЖК \"Событие 6.2\", м/у ул. Лобачевского и платформой \"Матвеевское\", п/ч (-2 этажа), с. 1 - 5, н/ч, организация стройпл., благ-во, разр. РД" },
  { employeeId: 1767, name: "Топал Наталья Владимировна", mode: 'object', objectId: '2e223230-200c-4cde-a47b-180dbf6eaafa', objectName: "ЖК Примавера К22", objectAddress: "Волоколамское ш., вл. 71/12, ЖК PRIMAVERA, к. 22,  стр. 1, 2, А, Б н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 1768, name: "Топорков Алексей Вячеславович", mode: 'object', objectId: '2e223230-200c-4cde-a47b-180dbf6eaafa', objectName: "ЖК Примавера К22", objectAddress: "Волоколамское ш., вл. 71/12, ЖК PRIMAVERA, к. 22,  стр. 1, 2, А, Б н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 1792, name: "Тудаков Игорь Дмитриевич", mode: 'object', objectId: 'b141b7a4-ab8b-426b-86c0-46e9ea66b3d3', objectName: "ЖК Марк (лот 33)", objectAddress: "Автозаводская ул., вл. 23/2, ЖК «ЗИЛАРТ», Лот 33, к. 1 - 3 н/ч, п/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 1818, name: "Турсунов Салимхон Собирхонович", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 1839, name: "Ульянов Илья Валерьевич", mode: 'object', objectId: '2b406444-f37f-4eb7-9b9a-750d56b30cbf', objectName: "ЖК Сад 69", objectAddress: "Садовническая ул., вл. 76/71,  ЖК \"Садовническая 69\", п/ч (-2 этажа), к. 1 - 4, н/ч, организация стройплощадки, благоустройство" },
  { employeeId: 1901, name: "Филина Мадина Изатуллоевна", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 6296, name: "Фоменков Алексей Николаевич", mode: 'object', objectId: 'ced2b4b9-84e8-4403-8da0-4a02eaeb36b6', objectName: "ЖК Stories", objectAddress: "Раменки ВТМО, ЖК \"Stories\", ул. Лобачевского, з/у 124/3А,  п/ч, к. 1, 2 н/ч, организация стр. площадки в соотв-и с ПОС" },
  { employeeId: 1978, name: "Хачатуров Самвел Александрович", mode: 'object', objectId: '646b93f3-5e41-4d93-8503-de792dd9ec65', objectName: "Селигер Сити", objectAddress: "Ильменский пр-д, вл. 14, оч. 1-я, к. А (4 сек.30-38 эт), В (3 сек.6-12 эт), К (2 сек.6-11эт), п/ч стилобат" },
  { employeeId: 2051, name: "Царев Юрий Анатольевич", mode: 'object', objectId: '9d1f76d2-eec5-4231-88ef-b5b7cbdd0648', objectName: "Нагорная (ГО)", objectAddress: "Электролитный пр-д, вл. 7А, ЖК TopHILLS, к. 1 - 6, н/ч, подзем. а/ст (2 уровня) + рампа, стилобат (ФОК, ТЦ), благоустройство" },
  { employeeId: 2053, name: "Цыганов Денис Геннадьевич", mode: 'object', objectId: '9f240764-c8b8-401d-9c92-d257b30afc23', objectName: "ЖК Wave", objectAddress: "Борисовские Пруды ул., ЖК \"Wave 2\", п/ч, н/ч, к. 1 - 7, организация стр. площадки в соотв-и с ПОС, благоустройство" },
  { employeeId: 2088, name: "Шаймарданов Ильдар Мунирович", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 2100, name: "Шапорев Иван Евгеньевич", mode: 'object', objectId: '5088e622-a4f9-4cdb-9c4b-81ac815a1141', objectName: "ЖК Ситибэй", objectAddress: "Волоколамское ш., вл. 93-97, ЖК CITY BAY (2 этап), к. 1 - 3, ДОУ, н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 2106, name: "Шаргородский Олег Васильевич", mode: 'object', objectId: 'b589ce7f-3f81-4683-a45c-3f52ffc4aefa', objectName: "ЖК Метрополия", objectAddress: "Волгоградский пр-т, вл. 32, к. 3, с. 1, 2, 3, н/ч, п/ч, организация стр. площадки, РД, благоустройство" },
  { employeeId: 2122, name: "Шевхужева Асият Шамильевна", mode: 'object', objectId: '2e223230-200c-4cde-a47b-180dbf6eaafa', objectName: "ЖК Примавера К22", objectAddress: "Волоколамское ш., вл. 71/12, ЖК PRIMAVERA, к. 22,  стр. 1, 2, А, Б н/ч, п/ч, организация стр. площадки, благоустройство" },
  { employeeId: 13376, name: "Шипуля Егор Александрович", mode: 'object', objectId: '20479cb6-fee5-4996-be15-3dd05f6b930d', objectName: "ЖК События 6.2", objectAddress: "Раменки р-н, ЖК \"Событие 6.2\", м/у ул. Лобачевского и платформой \"Матвеевское\", п/ч (-2 этажа), с. 1 - 5, н/ч, организация стройпл., благ-во, разр. РД" },
  { employeeId: 2155, name: "Штанько Маргарита Юрьевна", mode: 'object', objectId: '9f240764-c8b8-401d-9c92-d257b30afc23', objectName: "ЖК Wave", objectAddress: "Борисовские Пруды ул., ЖК \"Wave 2\", п/ч, н/ч, к. 1 - 7, организация стр. площадки в соотв-и с ПОС, благоустройство" },
  { employeeId: 2231, name: "Якимов Александр Сергеевич", mode: 'object', objectId: '19a30fb1-e816-41f3-9e73-def8c7807c9b', objectName: "ЖК Alia", objectAddress: "Лётная ул., ЖК «ÁLIA», Блоки 13А, 13B п/ч, к. 1 - 7 н/ч, организация стройплощадки в соответствии с ПОС, благоустройство, разработка РД" },
];

interface ISnapshotRow {
  id: number;
  name: string;
  before_mode: string | null;
  before_object_id: string | null;
  after_mode: string;
  after_object_id: string | null;
}

interface ISnapshot {
  created_at: string;
  source: string;
  employees: ISnapshotRow[];
}

const argValue = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const inline = process.argv.find(a => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
};

async function main(): Promise<void> {
  const { query, queryOne, withTransaction, getPool } = await import('../src/config/postgres.js');
  const { auditService, AUDIT_ACTIONS } = await import('../src/services/audit.service.js');
  const { TIMESHEET_MODE_LOCK_KEY } = await import('../src/services/timesheet-export-mode.service.js');

  const apply = process.argv.includes('--apply');
  const rollbackFile = argValue('rollback');
  const actorUserId = argValue('actor-user-id') ?? null;

  if ((apply || rollbackFile) && !actorUserId) {
    throw new Error('--actor-user-id обязателен для --apply и --rollback');
  }
  if (actorUserId) {
    const actor = await queryOne<{ id: string }>('SELECT id FROM app_auth.users WHERE id = $1::uuid', [actorUserId]);
    if (!actor) throw new Error(`Пользователь ${actorUserId} не найден`);
  }

  if (rollbackFile) {
    await runRollback(rollbackFile, actorUserId!, { withTransaction, auditService, AUDIT_ACTIONS, TIMESHEET_MODE_LOCK_KEY });
    await getPool().end();
    return;
  }

  // ── Preflight ──────────────────────────────────────────────────────────────
  const columns = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE column_name IN ('timesheet_export_mode', 'timesheet_export_object_id')
        AND table_name IN ('employees', 'org_departments')`,
  );
  if (columns.length < 4) {
    console.error('Миграция 249 не применена: нет колонок timesheet_export_mode / timesheet_export_object_id.');
    process.exit(1);
  }

  const problems: string[] = [];

  const seenIds = new Set<number>();
  for (const t of TARGETS) {
    if (seenIds.has(t.employeeId)) problems.push(`employee ${t.employeeId} (${t.name}) встречается в списке несколько раз`);
    seenIds.add(t.employeeId);
    if (t.mode === 'object' && !t.objectId) problems.push(`employee ${t.employeeId} (${t.name}): режим object без objectId`);
    if (t.mode === 'current_activity' && t.objectId) problems.push(`employee ${t.employeeId} (${t.name}): current_activity с objectId`);
  }

  const empRows = await query<{
    id: number; full_name: string | null; timesheet_export_mode: string | null; timesheet_export_object_id: string | null;
  }>(
    `SELECT id, full_name, timesheet_export_mode, timesheet_export_object_id::text
       FROM employees WHERE id = ANY($1::int[])`,
    [TARGETS.map(t => t.employeeId)],
  );
  const empById = new Map(empRows.map(r => [Number(r.id), r]));
  for (const t of TARGETS) {
    const row = empById.get(t.employeeId);
    if (!row) { problems.push(`сотрудник ${t.employeeId} (${t.name}) не найден`); continue; }
    if ((row.full_name ?? '').trim() !== t.name.trim()) {
      problems.push(`сотрудник ${t.employeeId}: ФИО «${row.full_name}» ≠ ожидаемого «${t.name}»`);
    }
  }

  const objectIds = [...new Set(TARGETS.map(t => t.objectId).filter((v): v is string => Boolean(v)))];
  const objRows = objectIds.length > 0
    ? await query<{ id: string; name: string; alt_name: string | null; is_active: boolean }>(
      'SELECT id::text, name, alt_name, is_active FROM skud_objects WHERE id = ANY($1::uuid[])',
      [objectIds],
    )
    : [];
  const objById = new Map(objRows.map(r => [r.id, r]));
  for (const t of TARGETS) {
    if (!t.objectId) continue;
    const obj = objById.get(t.objectId);
    if (!obj) { problems.push(`объект ${t.objectId} (${t.objectName}) не найден`); continue; }
    if (!obj.is_active) problems.push(`объект «${obj.name}» неактивен`);
    if (obj.name !== t.objectName) problems.push(`объект ${t.objectId}: название «${obj.name}» ≠ ожидаемого «${t.objectName}»`);
    const printed = obj.alt_name?.trim() ? obj.alt_name.trim() : obj.name;
    if (printed !== t.objectAddress) {
      problems.push(`объект «${obj.name}»: печатный адрес изменился\n      было: ${t.objectAddress}\n      стало: ${printed}`);
    }
  }

  const skipManual = TARGETS.filter(t => empById.get(t.employeeId)?.timesheet_export_mode != null);
  const toWrite = TARGETS.filter(t => empById.get(t.employeeId)?.timesheet_export_mode == null && empById.has(t.employeeId));

  console.log('=== План изменений ===');
  const byObject = new Map<string, number>();
  for (const t of toWrite) {
    const key = t.mode === 'object' ? (t.objectName ?? '?') : 'Текущая деятельность (режим)';
    byObject.set(key, (byObject.get(key) ?? 0) + 1);
  }
  for (const [obj, cnt] of [...byObject].sort((a, b) => b[1] - a[1])) console.log(`  ${String(cnt).padStart(3)} → ${obj}`);
  console.log(`\nВсего в списке ${TARGETS.length}, к записи ${toWrite.length}, пропуск (режим задан вручную) ${skipManual.length}`);
  for (const t of skipManual) {
    console.log(`  ⏭ ${t.employeeId} ${t.name} — уже ${empById.get(t.employeeId)?.timesheet_export_mode}`);
  }

  if (problems.length > 0) {
    console.error('\n=== PREFLIGHT НЕ ПРОЙДЕН — ничего не записано ===');
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log('\nPreflight пройден.');

  if (!apply) {
    console.log('Режим dry-run. Для применения: --apply --actor-user-id=<uuid> [--snapshot=<путь>]');
    await getPool().end();
    return;
  }
  if (toWrite.length === 0) {
    console.log('Записывать нечего.');
    await getPool().end();
    return;
  }

  // ── Применение ─────────────────────────────────────────────────────────────
  const createdAt = new Date().toISOString();
  const snapshotPath = path.resolve(
    argValue('snapshot')
    ?? path.resolve(__dirname, `../../temp/rollback_timesheet_modes_l4_${createdAt.replace(/[:.]/g, '-')}.json`),
  );

  const written = await withTransaction(async client => {
    // Порядок важен: лок → FOR UPDATE → сверка → запись.
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [TIMESHEET_MODE_LOCK_KEY]);

    const locked = await client.query<{
      id: number; full_name: string | null; timesheet_export_mode: string | null; timesheet_export_object_id: string | null;
    }>(
      `SELECT id, full_name, timesheet_export_mode, timesheet_export_object_id::text
         FROM employees WHERE id = ANY($1::int[]) FOR UPDATE`,
      [toWrite.map(t => t.employeeId)],
    );
    const lockedById = new Map(locked.rows.map(r => [Number(r.id), r]));

    const finalRows: ISnapshotRow[] = [];
    for (const t of toWrite) {
      const row = lockedById.get(t.employeeId);
      if (!row) throw new Error(`сотрудник ${t.employeeId} исчез между preflight и записью`);
      if ((row.full_name ?? '').trim() !== t.name.trim()) {
        throw new Error(`сотрудник ${t.employeeId}: ФИО изменилось между preflight и записью`);
      }
      // Режим появился после dry-run — пропускаем, не перезаписываем.
      if (row.timesheet_export_mode !== null) {
        console.warn(`  ⏭ ${t.employeeId} ${t.name} — режим задан между проверкой и записью (${row.timesheet_export_mode}), пропуск`);
        continue;
      }
      finalRows.push({
        id: t.employeeId,
        name: t.name,
        before_mode: null,
        before_object_id: row.timesheet_export_object_id,
        after_mode: t.mode,
        after_object_id: t.objectId,
      });
    }
    if (finalRows.length === 0) throw new Error('После сверки под локом записывать нечего — отмена');

    let affected = 0;
    for (const r of finalRows) {
      const res = await client.query(
        `UPDATE employees
            SET timesheet_export_mode = $1,
                timesheet_export_object_id = $2::uuid
          WHERE id = $3::int AND timesheet_export_mode IS NULL`,
        [r.after_mode, r.after_object_id, r.id],
      );
      affected += res.rowCount ?? 0;
    }
    if (affected !== finalRows.length) {
      throw new Error(`Обновлено ${affected} строк вместо ${finalRows.length} — откат`);
    }

    // Post-check ДО commit: конечные пары (mode, object_id) соответствуют плану.
    const after = await client.query<{ id: number; timesheet_export_mode: string; timesheet_export_object_id: string | null }>(
      `SELECT id, timesheet_export_mode, timesheet_export_object_id::text
         FROM employees WHERE id = ANY($1::int[])`,
      [finalRows.map(r => r.id)],
    );
    const afterById = new Map(after.rows.map(r => [Number(r.id), r]));
    for (const r of finalRows) {
      const got = afterById.get(r.id);
      if (!got || got.timesheet_export_mode !== r.after_mode || (got.timesheet_export_object_id ?? null) !== r.after_object_id) {
        throw new Error(`Post-check не сошёлся для ${r.id} (${r.name}) — откат`);
      }
    }

    await auditService.logWithClient(client, {
      user_id: actorUserId,
      action: AUDIT_ACTIONS.TIMESHEET_MODE_BULK_UPDATED,
      entity_type: 'timesheet_export_mode',
      entity_id: 'l4-objects-setup',
      details: {
        source: 'set-timesheet-modes-l4',
        count: finalRows.length,
        employees: finalRows.map(r => ({
          id: r.id, name: r.name, old_mode: r.before_mode, new_mode: r.after_mode, new_object_id: r.after_object_id,
        })),
      },
    });

    // Снимок пишем ДО commit: если запись файла упала — транзакция откатится.
    const snapshot: ISnapshot = { created_at: createdAt, source: 'set-timesheet-modes-l4', employees: finalRows };
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');

    return finalRows;
  });

  console.log(`\nПрименено: ${written.length} сотрудников.`);
  console.log(`Снимок для отката: ${snapshotPath}`);
  console.log(`Откат: npx tsx scripts/set-timesheet-modes-l4.ts --rollback ${snapshotPath} --actor-user-id=<uuid>`);
  await getPool().end();
}

async function runRollback(
  file: string,
  actorUserId: string,
  deps: {
    withTransaction: typeof import('../src/config/postgres.js').withTransaction;
    auditService: typeof import('../src/services/audit.service.js').auditService;
    AUDIT_ACTIONS: typeof import('../src/services/audit.service.js').AUDIT_ACTIONS;
    TIMESHEET_MODE_LOCK_KEY: number;
  },
): Promise<void> {
  const snapshot: ISnapshot = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  console.log(`Откат из снимка от ${snapshot.created_at}: строк ${snapshot.employees.length}`);

  const result = await deps.withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [deps.TIMESHEET_MODE_LOCK_KEY]);
    const reverted: number[] = [];
    const conflicts: Array<{ id: number; name: string; current: string | null }> = [];

    for (const r of snapshot.employees) {
      // Возвращаем, только если значение всё ещё то, что поставил скрипт.
      const res = await client.query(
        `UPDATE employees
            SET timesheet_export_mode = $1,
                timesheet_export_object_id = $2::uuid
          WHERE id = $3::int
            AND timesheet_export_mode IS NOT DISTINCT FROM $4
            AND timesheet_export_object_id::text IS NOT DISTINCT FROM $5`,
        [r.before_mode, r.before_object_id, r.id, r.after_mode, r.after_object_id],
      );
      if ((res.rowCount ?? 0) === 1) {
        reverted.push(r.id);
      } else {
        const cur = await client.query<{ timesheet_export_mode: string | null }>(
          'SELECT timesheet_export_mode FROM employees WHERE id = $1::int',
          [r.id],
        );
        conflicts.push({ id: r.id, name: r.name, current: cur.rows[0]?.timesheet_export_mode ?? null });
      }
    }

    await deps.auditService.logWithClient(client, {
      user_id: actorUserId,
      action: deps.AUDIT_ACTIONS.TIMESHEET_MODE_BULK_UPDATED,
      entity_type: 'timesheet_export_mode',
      entity_id: 'l4-objects-rollback',
      details: {
        source: 'set-timesheet-modes-l4 --rollback',
        snapshot_created_at: snapshot.created_at,
        reverted: reverted.length,
        conflicts,
      },
    });

    return { reverted, conflicts };
  });

  console.log(`Откачено ${result.reverted.length}, пропущено (изменено после скрипта) ${result.conflicts.length}`);
  for (const c of result.conflicts) console.log(`  ⏭ ${c.id} ${c.name} — сейчас ${c.current ?? 'NULL'}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
