#!/usr/bin/env node
// prepare-yandex-schema — transform `pg_dump --schema-only` output из Supabase
// в форму, которая безопасно применяется поверх пустого Yandex Managed PG.
//
// Пробегает по statements исходного дампа, классифицирует каждый
// (keep / strip / flag-critical) и пишет:
//   - <output> — очищенный SQL
//   - <report> — markdown-отчёт с метриками и критическими находками
//
// Чистый Node ESM, без зависимостей (стдлиб). Запускать:
//
//   node scripts/yandex-migration/prepare-yandex-schema.mjs \
//     --input  .migration/supabase_schema.sql \
//     --output .migration/yandex_schema.sql \
//     --report .migration/schema_transform_report.md

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Конфиг: что считается Supabase-only
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_SCHEMAS = new Set([
  'auth',
  'storage',
  'realtime',
  'graphql',
  'graphql_public',
  'vault',
  'net',
  'supabase_functions',
  'extensions',
  'pgsodium',
  'pgsodium_masks',
]);

const SUPABASE_ROLES = [
  'anon',
  'authenticated',
  'service_role',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_storage_admin',
  'supabase_realtime_admin',
  'dashboard_user',
];

// Version-controlled функции: создаются миграциями 024/025/060/083.
// Если их нет в дампе — это критическая проблема (или сами миграции
// потерялись, или version-controlled пакет применяли не полностью).
const VERSION_CONTROLLED_FUNCTIONS = {
  replace_role_access_profile: '025_access_catalog.sql + 036_functions_search_path.sql',
  data_api_list_public_schema: '060_data_api.sql',
  get_descendant_department_ids: '083_user_company_access.sql',
  heartbeat_sigur_runtime_lease: '024_sigur_runtime_state.sql',
  merge_sigur_runtime_state: '024_sigur_runtime_state.sql',
  release_sigur_runtime_lease: '024_sigur_runtime_state.sql',
  try_acquire_sigur_runtime_lease: '024_sigur_runtime_state.sql',
};

// Recovered runtime functions: исторически живут только в боевом Supabase,
// в version-controlled 001-086 их НЕТ. Полагается, что оператор применит
// 087_recover_runtime_functions.sql отдельно. Если в дампе они есть —
// прекрасно (значит, dump включает их). Если нет — это не критично при
// условии, что оператор подтвердил намерение применить 087
// (флаг --recovered-functions-migration).
// Это runtime-функции, которые вызываются backend'ом напрямую.
const RECOVERED_FUNCTIONS = {
  batch_recalculate_skud_daily_summary: '087_recover_runtime_functions.sql',
  bulk_update_employee_ids: '087_recover_runtime_functions.sql',
  find_skud_duplicate_ids: '087_recover_runtime_functions.sql',
  find_direct_conversation: '087_recover_runtime_functions.sql',
};

// Recovered helper functions: вспомогательные функции, которые НЕ
// вызываются backend'ом напрямую, но являются обязательной DB-internal
// зависимостью recovered-runtime функций. Семантически идентичны
// RECOVERED_FUNCTIONS (тот же source 087, тот же ack-флаг), но
// отделены для точного report'а: оператор должен понимать разницу
// между "функция вызывается из кода" vs "функция нужна другой
// функции в БД".
const RECOVERED_HELPER_FUNCTIONS = {
  // dependency: вызывается из batch_recalculate_skud_daily_summary
  recalculate_skud_daily_summary: '087_recover_runtime_functions.sql',
};

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const HELP_TEXT = `prepare-yandex-schema — transform Supabase schema dump for Yandex Managed PG

Usage:
  node scripts/yandex-migration/prepare-yandex-schema.mjs \\
    --input  .migration/supabase_schema.sql \\
    --output .migration/yandex_schema.sql \\
    --report .migration/schema_transform_report.md

Flags:
  --input  PATH   schema-only dump from \`pg_dump --schema-only --no-owner --no-privileges\`
  --output PATH   transformed SQL output
  --report PATH   markdown report path
  -h, --help      this help

Strips / comments:
  - CREATE EXTENSION / ALTER EXTENSION (recreate on Yandex отдельно)
  - CREATE SCHEMA + объекты в схемах: ${[...SUPABASE_SCHEMAS].join(', ')}
  - INSERT INTO storage.* (бакеты создаются в YOS, не в PG)
  - GRANT/REVOKE/ALTER DEFAULT PRIVILEGES для Supabase-ролей
  - NOTIFY pgrst
  - CREATE/ALTER/DROP POLICY
  - ENABLE/FORCE ROW LEVEL SECURITY → потом эмитим DISABLE для тех же таблиц

Flags:
  CLI flags:
  --input/--output/--report   (required)
  --recovered-functions-migration PATH   (optional)
      Декларирует, что recovered runtime-функции (4 шт., вызываемые
      backend'ом) И helper'ы (1 шт., DB-internal dependency) будут
      установлены отдельной миграцией. PATH должен указывать на
      существующий файл — обычно
      docs/migrations/087_recover_runtime_functions.sql.
      Без флага отсутствие любой из 5 — critical; с флагом — warning
      (информационно).
  --auth-primary-fk-validator PATH         (optional)
      Декларирует, что главный FK user_profiles_id_fkey пересоздаётся
      отдельным TS-скриптом. PATH должен указывать на существующий
      файл — обычно
      fot-server/scripts/yandex-migration/validate-auth-fk.ts.
      Без флага этот FK — critical; с флагом — warning.

  --auth-secondary-fk-replacement-migration PATH   (optional)
      Декларирует, что остальные 5 FK на auth.users пересоздаются
      отдельной миграцией. PATH — обычно
      docs/migrations/089_yandex_auth_user_fks.sql.
      Без флага эти FK — critical; с флагом — warnings.

  --auth-fk-replacement-migration PATH     (DEPRECATED alias)
      Устаревший флаг, эквивалент одновременно
      --auth-primary-fk-validator и --auth-secondary-fk-replacement-migration
      с одним и тем же PATH. Выводит stderr-warning. Сохранён для
      backward-compat, но в новом отчёте предпочтительны два отдельных флага.

FK на auth.users в CREATE TABLE inline (REFERENCES auth.users внутри
DDL колонки) — **всегда critical**, не понижается ни одним из флагов.
Inline-FK требует ручного редактирования pre-data файла (удалить
REFERENCES из CREATE TABLE), потому что трансформер не может
безопасно его извлечь.

FK на storage.objects всегда остаются critical (нет аналогичной
replacement-миграции).

Critical (exit 1):
  - FK на storage.objects (всегда)
  - FK на auth.users inline в CREATE TABLE (всегда — ручной transform)
  - FK ALTER TABLE на auth.users (user_profiles_id_fkey) — БЕЗ
    --auth-primary-fk-validator
  - FK ALTER TABLE на auth.users (остальные) — БЕЗ
    --auth-secondary-fk-replacement-migration
  - SECURITY DEFINER функции в public без SET search_path
  - Отсутствие version-controlled функций (${Object.keys(VERSION_CONTROLLED_FUNCTIONS).length}): из 024/025/060/083
  - Отсутствие recovered runtime функций (${Object.keys(RECOVERED_FUNCTIONS).length}) или
    helper'ов (${Object.keys(RECOVERED_HELPER_FUNCTIONS).length}, например recalculate_skud_daily_summary),
    из 087 — БЕЗ флага --recovered-functions-migration

Warning (exit 0, информационно):
  - Отсутствие recovered runtime функций, если флаг указан
  - FK ALTER TABLE на auth.users (primary/secondary), если соответствующий
    флаг указан

Section split (для 3-фазного restore без --disable-triggers):
  Вдобавок к combined --output, скрипт создаёт два файла:
    <output без .sql>_pre_data.sql   — schemas, types, functions, tables,
                                       sequences, comments, INLINE checks.
                                       Применяется ДО restore-public-data.sh.
    <output без .sql>_post_data.sql  — ALTER TABLE ADD CONSTRAINT (FK/PK/UNIQUE),
                                       CREATE INDEX, CREATE TRIGGER, CREATE RULE,
                                       ALTER TABLE DISABLE RLS.
                                       Применяется ПОСЛЕ data restore.
  На Yandex Managed PG это рекомендуемый flow — pg_restore --disable-triggers
  там недоступен регулярному пользователю.
`;

function parseArgs(argv) {
  const out = {
    input: null,
    output: null,
    report: null,
    recoveredFunctionsMigration: null,
    authPrimaryFkValidator: null,
    authSecondaryFkReplacementMigration: null,
    authFkReplacementMigrationDeprecated: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a === '--input') {
      out.input = argv[++i];
    } else if (a === '--output') {
      out.output = argv[++i];
    } else if (a === '--report') {
      out.report = argv[++i];
    } else if (a === '--recovered-functions-migration') {
      out.recoveredFunctionsMigration = argv[++i];
    } else if (a === '--auth-primary-fk-validator') {
      out.authPrimaryFkValidator = argv[++i];
    } else if (a === '--auth-secondary-fk-replacement-migration') {
      out.authSecondaryFkReplacementMigration = argv[++i];
    } else if (a === '--auth-fk-replacement-migration') {
      out.authFkReplacementMigrationDeprecated = argv[++i];
    } else {
      throw new Error(`Неизвестный аргумент: ${a}. Используйте --help.`);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL splitter (statement-level, поддерживает $tag$…$tag$ + ' + " + -- + /* */)
// ─────────────────────────────────────────────────────────────────────────────

function splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];
    const next = sql[i + 1];

    // -- line comment (до \n)
    if (ch === '-' && next === '-') {
      while (i < len && sql[i] !== '\n') {
        buf += sql[i++];
      }
      continue;
    }

    // /* block comment */
    if (ch === '/' && next === '*') {
      buf += '/*';
      i += 2;
      while (i < len) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          buf += '*/';
          i += 2;
          break;
        }
        buf += sql[i++];
      }
      continue;
    }

    // 'single-quoted string' с экранированием ''
    if (ch === "'") {
      buf += "'";
      i++;
      while (i < len) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          buf += "''";
          i += 2;
        } else if (sql[i] === "'") {
          buf += "'";
          i++;
          break;
        } else {
          buf += sql[i++];
        }
      }
      continue;
    }

    // "double-quoted identifier"
    if (ch === '"') {
      buf += '"';
      i++;
      while (i < len) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          buf += '""';
          i += 2;
        } else if (sql[i] === '"') {
          buf += '"';
          i++;
          break;
        } else {
          buf += sql[i++];
        }
      }
      continue;
    }

    // $tag$…$tag$ (Postgres dollar quoting)
    if (ch === '$') {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        buf += tag;
        i += tag.length;
        const closing = sql.indexOf(tag, i);
        if (closing === -1) {
          buf += sql.slice(i);
          i = len;
        } else {
          buf += sql.slice(i, closing + tag.length);
          i = closing + tag.length;
        }
        continue;
      }
    }

    // top-level ; → конец statement
    if (ch === ';') {
      buf += ';';
      i++;
      const stmt = buf.trim();
      if (stmt.length > 0) out.push(buf);
      buf = '';
      continue;
    }

    buf += ch;
    i++;
  }

  if (buf.trim().length > 0) out.push(buf);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers для классификации
// ─────────────────────────────────────────────────────────────────────────────

function getHeader(stmt) {
  // Убираем ведущие комментарии/пробелы, берём первые 800 символов, нормализуем
  // пробелы. Этого хватит, чтобы матчить action+target — тело функций сюда
  // обычно не попадает.
  //
  // ВНИМАНИЕ: pg_dump может оставлять trailing `-- comment` на той же строке
  // после `;`. SQL-splitter относит этот хвост к следующему statement —
  // оттуда буфер начинается с пробела, потом `-- comment`, потом ещё блок
  // комментариев. Поэтому стрипаем циклически (whitespace ИЛИ `-- line`
  // ИЛИ `/* block */`), пока есть что снимать.
  let trimmed = stmt;
  let prev;
  do {
    prev = trimmed;
    trimmed = trimmed.replace(/^\s+/, '');
    trimmed = trimmed.replace(/^--[^\n]*\n?/, '');
    trimmed = trimmed.replace(/^\/\*[\s\S]*?\*\//, '');
  } while (trimmed !== prev);
  return trimmed.slice(0, 800).replace(/\s+/g, ' ').trim();
}

const ACTION_TARGET_PATTERNS = [
  /^create\s+(?:or\s+replace\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:only\s+)?"?(\w+)"?\.\s*"?\w+"?/i,
  /^create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:"?\w+"?\s+)?on\s+(?:only\s+)?"?(\w+)"?\./i,
  /^create\s+sequence\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?\./i,
  /^create\s+(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?\./i,
  /^create\s+trigger\s+\S+\s+(?:before|after|instead\s+of)[\s\S]+?\bon\s+(?:only\s+)?"?(\w+)"?\./i,
  /^create\s+(?:or\s+replace\s+)?function\s+"?(\w+)"?\./i,
  /^create\s+(?:or\s+replace\s+)?procedure\s+"?(\w+)"?\./i,
  /^create\s+(?:or\s+replace\s+)?aggregate\s+"?(\w+)"?\./i,
  /^create\s+type\s+"?(\w+)"?\./i,
  /^create\s+domain\s+"?(\w+)"?\./i,
  /^create\s+publication\s+\S+\s+for\s+table[\s\S]+?"?(\w+)"?\./i,
  /^alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?"?(\w+)"?\./i,
  /^alter\s+sequence\s+(?:if\s+exists\s+)?"?(\w+)"?\./i,
  /^alter\s+index\s+(?:if\s+exists\s+)?"?(\w+)"?\./i,
  /^alter\s+function\s+"?(\w+)"?\./i,
  /^alter\s+procedure\s+"?(\w+)"?\./i,
  /^alter\s+type\s+"?(\w+)"?\./i,
  /^alter\s+view\s+(?:if\s+exists\s+)?"?(\w+)"?\./i,
  /^alter\s+trigger\s+\S+\s+on\s+"?(\w+)"?\./i,
  /^drop\s+(?:table|index|sequence|view|function|trigger|type|materialized\s+view|schema)\s+(?:if\s+exists\s+)?(?:only\s+)?"?(\w+)"?\./i,
  /^insert\s+into\s+(?:only\s+)?"?(\w+)"?\./i,
  /^update\s+(?:only\s+)?"?(\w+)"?\./i,
  /^delete\s+from\s+(?:only\s+)?"?(\w+)"?\./i,
  /^comment\s+on\s+\w+(?:\s+\w+)?\s+"?(\w+)"?\./i,
];

function getActionTargetSchema(header) {
  for (const p of ACTION_TARGET_PATTERNS) {
    const m = p.exec(header);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

function mentionsSupabaseRole(text) {
  return SUPABASE_ROLES.some(r => new RegExp(`\\b${r}\\b`, 'i').test(text));
}

// Sets / pg_catalog.set_config — клонируем в оба split-файла (pre и post):
// без них в post-data сессия не получит правильный search_path / encoding.
function isPreambleSetting(header) {
  return /^set\s+/i.test(header) || /^select\s+pg_catalog\.set_config\b/i.test(header);
}

// pg_dump semantics: что относится к post-data (применяется ПОСЛЕ data load).
function classifySection(header) {
  if (/^create\s+(unique\s+)?index\b/i.test(header)) return 'post';
  if (/^create\s+trigger\b/i.test(header)) return 'post';
  if (/^create\s+rule\b/i.test(header)) return 'post';
  // ALTER TABLE ... ADD CONSTRAINT (FK / PK / UNIQUE / EXCLUDE / CHECK)
  if (/^alter\s+table\b[\s\S]*?\badd\s+constraint\b/i.test(header)) return 'post';
  // ALTER TABLE ... ATTACH PARTITION — после данных
  if (/^alter\s+table\b[\s\S]*?\battach\s+partition\b/i.test(header)) return 'post';
  if (/^alter\s+index\b[\s\S]*?\battach\s+partition\b/i.test(header)) return 'post';
  return 'pre';
}

function deriveSplitPath(outputPath, suffix) {
  const ext = extname(outputPath);
  const base = ext ? outputPath.slice(0, outputPath.length - ext.length) : outputPath;
  return `${base}_${suffix}${ext || ''}`;
}

// Поиск inline REFERENCES в CREATE TABLE. Возвращает массив { schema, table }.
// Не различает SQL и комментарии — false-positive в пределах -- comments
// возможен, но pg_dump редко вставляет такие комментарии в DDL.
function extractInlineReferences(stmt) {
  const out = [];
  const re = /references\s+(?:only\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?/gi;
  let m;
  while ((m = re.exec(stmt)) !== null) {
    out.push({
      schema: (m[1] ?? 'public').toLowerCase(),
      table: m[2].toLowerCase(),
    });
  }
  return out;
}

// Парсинг ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY (cols).
// Возвращает { schema, table, constraint_name, columns[] } или null.
// Используется для table-FK Findings (constraint_name, columns)
// в report и в --auth-fk-replacement-migration acknowledgment.
function parseAddConstraintFk(stmt) {
  const m = /^\s*alter\s+table\s+(?:only\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?\s+add\s+constraint\s+"?(\w+)"?\s+foreign\s+key\s*\(([^)]+)\)/i.exec(stmt);
  if (!m) return null;
  const cols = m[4].split(',').map(c => c.replace(/"/g, '').trim()).filter(Boolean);
  return {
    schema: (m[1] || 'public').toLowerCase(),
    table: m[2],
    constraint_name: m[3],
    columns: cols,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Классификация
// ─────────────────────────────────────────────────────────────────────────────

const REASONS = {
  KEEP: 'keep',
  CREATE_EXTENSION: 'CREATE EXTENSION',
  ALTER_EXTENSION: 'ALTER EXTENSION',
  CREATE_SCHEMA_SUPABASE: 'CREATE SCHEMA (Supabase-only)',
  OBJECT_IN_SUPABASE_SCHEMA: 'object in Supabase-only schema',
  INSERT_STORAGE: 'INSERT INTO storage.*',
  GRANT_REVOKE_SUPABASE_ROLE: 'GRANT/REVOKE for Supabase role',
  ALTER_DEFAULT_PRIV_SUPABASE: 'ALTER DEFAULT PRIVILEGES for Supabase role',
  NOTIFY_PGRST: 'NOTIFY pgrst',
  POLICY: 'CREATE/ALTER/DROP POLICY',
  ENABLE_RLS: 'ENABLE ROW LEVEL SECURITY',
  FORCE_RLS: 'FORCE ROW LEVEL SECURITY',
  DISABLE_RLS_FROM_DUMP: 'DISABLE/NO FORCE RLS (will be re-emitted at end)',
  FK_AUTH_USERS_ALTER: 'FK -> auth.users (ALTER TABLE ADD CONSTRAINT)',
  FK_STORAGE_OBJECTS_ALTER: 'FK -> storage.objects (ALTER TABLE ADD CONSTRAINT)',
};

function classify(stmt, ctx) {
  const header = getHeader(stmt);
  const lower = header.toLowerCase();

  // SET / SELECT pg_catalog.set_config / COMMENT — keep
  if (/^set\s+/i.test(header) || /^select\s+pg_catalog\.set_config\b/i.test(header)) {
    return { action: 'keep' };
  }

  // CREATE EXTENSION
  if (/^create\s+extension\b/i.test(header)) {
    return { action: 'strip', reason: REASONS.CREATE_EXTENSION };
  }
  if (/^alter\s+extension\b/i.test(header)) {
    return { action: 'strip', reason: REASONS.ALTER_EXTENSION };
  }

  // CREATE SCHEMA <supabase>
  const csMatch = /^create\s+schema\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?/i.exec(header);
  if (csMatch && SUPABASE_SCHEMAS.has(csMatch[1].toLowerCase())) {
    return { action: 'strip', reason: REASONS.CREATE_SCHEMA_SUPABASE, detail: csMatch[1] };
  }

  // ENABLE / FORCE / DISABLE ROW LEVEL SECURITY
  // Должно идти ДО общей "object in supabase schema", т.к. public.* RLS тоже сюда.
  const rlsMatch = /^alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?\s+(enable|force|disable|no\s+force)\s+row\s+level\s+security/i.exec(header);
  if (rlsMatch) {
    const sch = (rlsMatch[1] || 'public').toLowerCase();
    const tbl = rlsMatch[2];
    const verb = rlsMatch[3].toLowerCase().replace(/\s+/g, ' ');
    if (SUPABASE_SCHEMAS.has(sch)) {
      return { action: 'strip', reason: REASONS.OBJECT_IN_SUPABASE_SCHEMA, detail: `${sch}.${tbl}` };
    }
    if (verb === 'enable') {
      ctx.rlsEnabledTables.add(`${sch}.${tbl}`);
      return { action: 'strip', reason: REASONS.ENABLE_RLS, detail: `${sch}.${tbl}` };
    }
    if (verb === 'force') {
      ctx.rlsEnabledTables.add(`${sch}.${tbl}`);
      return { action: 'strip', reason: REASONS.FORCE_RLS, detail: `${sch}.${tbl}` };
    }
    return { action: 'strip', reason: REASONS.DISABLE_RLS_FROM_DUMP, detail: `${sch}.${tbl}` };
  }

  // CREATE/ALTER/DROP POLICY
  if (/^(create|alter|drop)\s+policy\b/i.test(header)) {
    return { action: 'strip', reason: REASONS.POLICY };
  }

  // INSERT INTO storage.*
  if (/^insert\s+into\s+(?:only\s+)?"?storage"?\./i.test(header)) {
    return { action: 'strip', reason: REASONS.INSERT_STORAGE };
  }

  // NOTIFY pgrst
  if (/^notify\s+pgrst\b/i.test(header)) {
    return { action: 'strip', reason: REASONS.NOTIFY_PGRST };
  }

  // GRANT/REVOKE с Supabase-ролью
  if (/^(grant|revoke)\b/i.test(header) && mentionsSupabaseRole(header)) {
    return { action: 'strip', reason: REASONS.GRANT_REVOKE_SUPABASE_ROLE };
  }

  // ALTER DEFAULT PRIVILEGES с Supabase-ролью
  if (/^alter\s+default\s+privileges\b/i.test(header) && mentionsSupabaseRole(header)) {
    return { action: 'strip', reason: REASONS.ALTER_DEFAULT_PRIV_SUPABASE };
  }

  // Объекты в Supabase-only схемах
  const targetSchema = getActionTargetSchema(header);
  if (targetSchema && SUPABASE_SCHEMAS.has(targetSchema)) {
    return { action: 'strip', reason: REASONS.OBJECT_IN_SUPABASE_SCHEMA, detail: targetSchema };
  }

  // FK на auth.users / storage.objects
  const refsAuthUsers = /references\s+(?:only\s+)?"?auth"?\."?users"?\b/i.test(stmt);
  const refsStorageObjects = /references\s+(?:only\s+)?"?storage"?\."?objects"?\b/i.test(stmt);
  if (refsAuthUsers || refsStorageObjects) {
    const target = refsAuthUsers ? 'auth.users' : 'storage.objects';
    if (/^alter\s+table\b/i.test(header)) {
      // ALTER TABLE ... ADD CONSTRAINT — стрипаем + critical.
      const reason = refsAuthUsers ? REASONS.FK_AUTH_USERS_ALTER : REASONS.FK_STORAGE_OBJECTS_ALTER;
      const meta = parseAddConstraintFk(stmt);
      // Primary FK = user_profiles_id_fkey (главный, его лечит
      // validate-auth-fk.ts). Остальные ALTER FKs — secondary (089).
      const isPrimaryAuthFk = refsAuthUsers && meta && meta.constraint_name === 'user_profiles_id_fkey';
      const replacementKind = !refsAuthUsers
        ? 'storage_manual'
        : (isPrimaryAuthFk ? 'primary' : 'secondary');
      const note = refsAuthUsers
        ? (isPrimaryAuthFk
            ? 'Главный FK user_profiles_id_fkey → восстанавливается через validate-auth-fk.ts. Передайте --auth-primary-fk-validator для понижения до warning.'
            : 'Secondary FK → пересоздаётся через 089_yandex_auth_user_fks.sql. Передайте --auth-secondary-fk-replacement-migration для понижения до warning.')
        : 'storage.objects на Yandex нет; переносите в Yandex Object Storage и переделайте FK';
      ctx.critical.push({
        kind: refsAuthUsers ? 'fk_auth_users_alter' : 'fk_storage_objects_alter',
        severity: 'critical',
        snippet: header.slice(0, 240),
        note,
        fk_meta: meta ? {
          constraint_name: meta.constraint_name,
          source_table: `${meta.schema}.${meta.table}`,
          source_columns: meta.columns,
          referenced: target,
          form: 'alter_table_add_constraint',
          replacement_kind: replacementKind,
        } : {
          constraint_name: '(parse failed)',
          source_table: '?',
          source_columns: [],
          referenced: target,
          form: 'alter_table_add_constraint',
          replacement_kind: replacementKind,
        },
      });
      return { action: 'strip', reason };
    }
    // CREATE TABLE ... REFERENCES auth.users — keep + critical ВСЕГДА.
    // inline FK не downgrade-ится никаким флагом: трансформер не может
    // безопасно удалить REFERENCES внутри DDL колонки, оператор патчит
    // pre-data файл вручную.
    const createTblMatch = /^\s*create\s+(?:or\s+replace\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?/i.exec(stmt);
    const inlineTable = createTblMatch ? `${(createTblMatch[1] || 'public').toLowerCase()}.${createTblMatch[2]}` : '?';
    ctx.critical.push({
      kind: refsAuthUsers ? 'fk_auth_users_inline' : 'fk_storage_objects_inline',
      severity: 'critical',
      snippet: header.slice(0, 240),
      note: `inline ${target} FK requires manual transform — REFERENCES внутри CREATE TABLE не извлекается автоматически. Отредактируйте pre-data SQL (уберите REFERENCES auth.users из определения колонки) ДО apply.`,
      fk_meta: {
        constraint_name: '(inline, no name)',
        source_table: inlineTable,
        source_columns: [],
        referenced: target,
        form: 'create_table_inline',
        replacement_kind: 'manual',
      },
    });
    return { action: 'keep', warn: `inline FK -> ${target} (manual transform required)` };
  }

  // Inline FK в CREATE TABLE на любые другие таблицы — warning. Inline FK
  // создаётся одновременно с таблицей (в pre-data) и активен per-row при
  // data-only restore. Если родительская таблица ещё не залита, INSERT
  // в дочернюю упадёт. Это не критично (часто FK ссылается на static
  // справочники, заполняемые рано в TOC custom-dump), но стоит зафиксировать.
  if (/^create\s+(?:or\s+replace\s+)?table\b/i.test(header)) {
    const inlineRefs = extractInlineReferences(stmt);
    const interesting = inlineRefs.filter(ref =>
      !(ref.schema === 'auth' && ref.table === 'users') &&
      !(ref.schema === 'storage' && ref.table === 'objects'),
    );
    if (interesting.length > 0) {
      const refList = [...new Set(interesting.map(r => `${r.schema}.${r.table}`))].join(', ');
      ctx.warnings.push({
        kind: 'inline_fk_in_create_table',
        severity: 'warning',
        snippet: header.slice(0, 240),
        note: `CREATE TABLE содержит inline REFERENCES (${refList}). FK активен сразу же — при data-only restore без --disable-triggers может упасть на отсутствующих parent-строках. Если pg_restore TOC грузит parent раньше child, всё ок. Иначе вынесите REFERENCES в ALTER TABLE ADD CONSTRAINT (попадёт в post-data) или применяйте combined yandex_schema.sql.`,
      });
    }
  }

  // Учёт CREATE FUNCTION в public
  const fnMatch = /^create\s+(?:or\s+replace\s+)?function\s+(?:"?(\w+)"?\.)?"?(\w+)"?\s*\(/i.exec(header);
  if (fnMatch) {
    const sch = (fnMatch[1] || 'public').toLowerCase();
    const fname = fnMatch[2];
    if (SUPABASE_SCHEMAS.has(sch)) {
      return { action: 'strip', reason: REASONS.OBJECT_IN_SUPABASE_SCHEMA, detail: `${sch}.${fname}` };
    }
    if (sch === 'public') {
      ctx.seenPublicFunctions.add(fname);
      if (/\bsecurity\s+definer\b/i.test(stmt)) {
        ctx.securityDefiner.add(fname);
        if (!/\bset\s+search_path\b/i.test(stmt)) {
          ctx.securityDefinerWithoutSearchPath.add(fname);
        }
      }
    }
    return { action: 'keep' };
  }

  return { action: 'keep' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Рендер отчёта
// ─────────────────────────────────────────────────────────────────────────────

function renderReport(ctx, args) {
  const lines = [];
  lines.push('# prepare-yandex-schema report');
  lines.push('');
  lines.push(`- Input:  \`${args.input}\``);
  lines.push(`- Output: \`${args.output}\``);
  lines.push(`- Started:  ${ctx.startedAt}`);
  lines.push(`- Finished: ${ctx.finishedAt}`);
  lines.push(`- Total statements: ${ctx.totalStatements}`);
  lines.push(`- Kept: ${ctx.keptCount}`);
  lines.push(`- Stripped: ${ctx.strippedCount}`);
  lines.push(`- Critical findings: ${ctx.critical.length}`);
  lines.push(`- Warnings: ${ctx.warnings.length}`);
  if (ctx.recoveredAck) {
    lines.push(`- recovered-functions-migration: \`${ctx.recoveredAckPath}\` (acknowledged)`);
  }
  lines.push('');

  lines.push('## Stripped by reason');
  lines.push('');
  lines.push('| Reason | Count |');
  lines.push('|---|---|');
  const sortedReasons = [...ctx.reasonCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [r, c] of sortedReasons) {
    lines.push(`| ${r} | ${c} |`);
  }
  lines.push('');

  if (ctx.critical.length > 0) {
    lines.push('## ⚠ Critical findings');
    lines.push('');
    for (const c of ctx.critical) {
      lines.push(`- **${c.kind}** — ${c.note}`);
      lines.push('  ```sql');
      lines.push(`  ${c.snippet}`);
      lines.push('  ```');
    }
    lines.push('');
  } else {
    lines.push('## ✓ No critical findings');
    lines.push('');
  }

  if (ctx.warnings.length > 0) {
    lines.push('## ⓘ Warnings (информационно, exit=0)');
    lines.push('');
    for (const w of ctx.warnings) {
      lines.push(`- **${w.kind}** — ${w.note}`);
      lines.push('  ```sql');
      lines.push(`  ${w.snippet}`);
      lines.push('  ```');
    }
    lines.push('');
  }

  // Отдельная таблица для FK на auth.users — независимо от того,
  // в critical они или warnings (зависит от флагов).
  const authFkFindings = [...ctx.critical, ...ctx.warnings].filter(
    f => f.kind === 'fk_auth_users_alter' || f.kind === 'fk_auth_users_inline',
  );
  if (authFkFindings.length > 0) {
    lines.push('## FK на auth.users — replacement plan');
    lines.push('');
    lines.push('Главный FK `user_profiles_id_fkey` пересоздаётся через `validate-auth-fk.ts`. Остальные ALTER-form FK — через `089_yandex_auth_user_fks.sql`. Inline FK внутри `CREATE TABLE` не извлекается автоматически и требует ручного редактирования pre-data SQL.');
    lines.push('');
    lines.push(`- \`--auth-primary-fk-validator\`: ${ctx.authPrimaryAck ? '`' + ctx.authPrimaryAckPath + '`' : '**не передан → primary FK critical**'}`);
    lines.push(`- \`--auth-secondary-fk-replacement-migration\`: ${ctx.authSecondaryAck ? '`' + ctx.authSecondaryAckPath + '`' : '**не передан → secondary FK critical**'}`);
    lines.push('');
    lines.push('| Source constraint | Source table | Source columns | Referenced | Kind | Replacement |');
    lines.push('|---|---|---|---|---|---|');
    for (const f of authFkFindings) {
      const m = f.fk_meta ?? {};
      const cols = (m.source_columns ?? []).join(', ') || '(inline — N/A)';
      let kind = m.replacement_kind ?? '?';
      let replacement;
      if (kind === 'primary') {
        replacement = ctx.authPrimaryAck
          ? '`' + ctx.authPrimaryAckPath + '`'
          : '**none — critical (pass --auth-primary-fk-validator)**';
      } else if (kind === 'secondary') {
        replacement = ctx.authSecondaryAck
          ? '`' + ctx.authSecondaryAckPath + '`'
          : '**none — critical (pass --auth-secondary-fk-replacement-migration)**';
      } else if (kind === 'manual') {
        replacement = '**manual transform required (always critical)**';
      } else {
        replacement = '**unknown**';
      }
      lines.push(`| \`${m.constraint_name ?? '?'}\` | \`${m.source_table ?? '?'}\` | ${cols} | \`${m.referenced ?? 'auth.users'}\` | ${kind} | ${replacement} |`);
    }
    lines.push('');
  }

  lines.push('## RLS tables');
  lines.push('');
  if (ctx.rlsEnabledTables.size === 0) {
    lines.push('Нет таблиц с ENABLE/FORCE RLS в дампе.');
  } else {
    lines.push('Следующие таблицы имели `ENABLE`/`FORCE ROW LEVEL SECURITY` в дампе. Выходной SQL добавит `DISABLE ROW LEVEL SECURITY` для каждой из них в самом конце:');
    lines.push('');
    for (const t of [...ctx.rlsEnabledTables].sort()) {
      lines.push(`- \`${t}\``);
    }
  }
  lines.push('');

  lines.push('## SECURITY DEFINER функции');
  lines.push('');
  if (ctx.securityDefiner.size === 0) {
    lines.push('SECURITY DEFINER функций в public не найдено.');
  } else {
    lines.push('| Function | Has SET search_path | Status |');
    lines.push('|---|---|---|');
    for (const f of [...ctx.securityDefiner].sort()) {
      const ok = !ctx.securityDefinerWithoutSearchPath.has(f);
      lines.push(`| public.${f} | ${ok ? '✓' : '**✗ MISSING**'} | ${ok ? 'ok' : 'critical: добавьте `SET search_path = pg_catalog, public` вручную'} |`);
    }
  }
  lines.push('');

  lines.push('## Version-controlled business functions');
  lines.push('');
  lines.push('Эти функции создаются миграциями 024/025/060/083. Если их нет в дампе — это критическая регрессия (либо version-controlled пакет применялся не полностью, либо они были удалены позже).');
  lines.push('');
  lines.push('| Function | Present | Source |');
  lines.push('|---|---|---|');
  for (const fn of Object.keys(VERSION_CONTROLLED_FUNCTIONS).sort()) {
    const present = ctx.seenPublicFunctions.has(fn);
    lines.push(`| public.${fn} | ${present ? '✓' : '**✗ MISSING (critical)**'} | ${VERSION_CONTROLLED_FUNCTIONS[fn]} |`);
  }
  lines.push('');

  lines.push('## Recovered runtime functions');
  lines.push('');
  lines.push('Backend-called функции, исторически не закоммиченные в миграции 001-086 и живущие только в боевом Supabase. Восстанавливаются через `087_recover_runtime_functions.sql` (см. `01_recover_runtime_functions.md`). Если в дампе они есть — отлично; если нет — это **критично без флага** `--recovered-functions-migration`, **warning с флагом**.');
  lines.push('');
  lines.push('| Function | Present | Source | Severity if missing |');
  lines.push('|---|---|---|---|');
  for (const fn of Object.keys(RECOVERED_FUNCTIONS).sort()) {
    const present = ctx.seenPublicFunctions.has(fn);
    const severity = ctx.recoveredAck ? 'warning (acknowledged)' : '**critical** (pass --recovered-functions-migration)';
    lines.push(`| public.${fn} | ${present ? '✓' : '**✗ MISSING**'} | ${RECOVERED_FUNCTIONS[fn]} | ${severity} |`);
  }
  lines.push('');

  lines.push('## Recovered helper functions (DB-internal dependencies)');
  lines.push('');
  lines.push('Вспомогательные функции в `public`, **не вызываемые backend\'ом напрямую**, но обязательные как зависимость recovered runtime-функций. Те же source (087) и ack-флаг, что у runtime-функций; отделены сюда для точности отчёта.');
  lines.push('');
  lines.push('| Function | Present | Source | Depended on by | Severity if missing |');
  lines.push('|---|---|---|---|---|');
  const HELPER_DEPENDED_ON_BY = {
    recalculate_skud_daily_summary: 'batch_recalculate_skud_daily_summary',
  };
  for (const fn of Object.keys(RECOVERED_HELPER_FUNCTIONS).sort()) {
    const present = ctx.seenPublicFunctions.has(fn);
    const severity = ctx.recoveredAck ? 'warning (acknowledged)' : '**critical** (pass --recovered-functions-migration)';
    const dep = HELPER_DEPENDED_ON_BY[fn] ?? '?';
    lines.push(`| public.${fn} | ${present ? '✓' : '**✗ MISSING**'} | ${RECOVERED_HELPER_FUNCTIONS[fn]} | \`${dep}\` | ${severity} |`);
  }
  lines.push('');

  lines.push('## Split files (для 3-фазного restore)');
  lines.push('');
  lines.push('| Файл | Содержит | Применяется |');
  lines.push('|---|---|---|');
  lines.push(`| \`${args.output}\` | combined (всё в одном файле) | при -ne 3-фазной installation |`);
  lines.push(`| \`${ctx.preDataPath}\` | ${ctx.preSectionCount} pre-data statements (tables, types, sequences, functions, comments) | **до** \`restore-public-data.sh\` |`);
  lines.push(`| \`${ctx.postDataPath}\` | ${ctx.postSectionCount} post-data statements (ALTER … ADD CONSTRAINT, CREATE INDEX, CREATE TRIGGER, DISABLE RLS) | **после** \`restore-public-data.sh\` |`);
  lines.push('');

  lines.push('## Что делать дальше');
  lines.push('');
  lines.push('1. Если есть **critical findings**, разберитесь с ними вручную в `' + args.output + '` (и в split-файлах) ДО применения.');
  lines.push('2. Создайте на Yandex расширения: `btree_gist`, `pg_trgm`, `pgcrypto` (см. `04_schema_prepare.md`).');
  lines.push('3. На Yandex применяйте **3 фазы**:');
  lines.push('   ```bash');
  lines.push('   bash scripts/yandex-migration/apply-yandex-schema.sh ' + ctx.preDataPath);
  lines.push('   bash scripts/yandex-migration/restore-public-data.sh');
  lines.push('   bash scripts/yandex-migration/apply-yandex-schema.sh ' + ctx.postDataPath);
  lines.push('   ```');
  lines.push('   (Альтернатива — combined `' + args.output + '` через `apply-yandex-schema.sh`, но потом restore-public-data.sh упадёт на FK без `USE_DISABLE_TRIGGERS=true`, который на Yandex недоступен.)');
  lines.push('4. Прогоните `087_recover_runtime_functions.sql` для отсутствующих RPC.');
  lines.push('5. Прогоните `088_yandex_app_auth.sql` и backfill `auth.users → app_auth.users`.');
  lines.push('');

  return lines.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

function commentOut(text) {
  return text
    .split('\n')
    .map(l => '-- ' + l)
    .join('\n');
}

function ensureDir(filePath) {
  const dir = dirname(resolve(filePath));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error('\n' + HELP_TEXT);
    process.exit(2);
  }
  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  if (!args.input || !args.output || !args.report) {
    console.error('Нужны все три флага: --input, --output, --report (см. --help)');
    process.exit(2);
  }
  if (!existsSync(args.input)) {
    console.error(`Не найден input: ${args.input}`);
    process.exit(2);
  }

  const startedAt = new Date().toISOString();
  const inputSql = readFileSync(args.input, 'utf8');
  const statements = splitStatements(inputSql);

  // Валидация --recovered-functions-migration: если задан, файл должен
  // существовать. Это защищает от опечаток типа --recovered-functions-migration=true.
  let recoveredAck = false;
  let recoveredAckPath = null;
  if (args.recoveredFunctionsMigration) {
    const resolved = resolve(args.recoveredFunctionsMigration);
    if (!existsSync(resolved)) {
      console.error(`--recovered-functions-migration: файл не найден: ${resolved}`);
      process.exit(2);
    }
    recoveredAck = true;
    recoveredAckPath = resolved;
  }

  // --auth-primary-fk-validator (главный FK)
  let authPrimaryAck = false;
  let authPrimaryAckPath = null;
  if (args.authPrimaryFkValidator) {
    const resolved = resolve(args.authPrimaryFkValidator);
    if (!existsSync(resolved)) {
      console.error(`--auth-primary-fk-validator: файл не найден: ${resolved}`);
      process.exit(2);
    }
    authPrimaryAck = true;
    authPrimaryAckPath = resolved;
  }

  // --auth-secondary-fk-replacement-migration (5 secondary FKs)
  let authSecondaryAck = false;
  let authSecondaryAckPath = null;
  if (args.authSecondaryFkReplacementMigration) {
    const resolved = resolve(args.authSecondaryFkReplacementMigration);
    if (!existsSync(resolved)) {
      console.error(`--auth-secondary-fk-replacement-migration: файл не найден: ${resolved}`);
      process.exit(2);
    }
    authSecondaryAck = true;
    authSecondaryAckPath = resolved;
  }

  // --auth-fk-replacement-migration (DEPRECATED) — сетит обе подтверждения
  // на один и тот же путь и выводит stderr-warning.
  if (args.authFkReplacementMigrationDeprecated) {
    const resolved = resolve(args.authFkReplacementMigrationDeprecated);
    if (!existsSync(resolved)) {
      console.error(`--auth-fk-replacement-migration: файл не найден: ${resolved}`);
      process.exit(2);
    }
    console.error(
      '[warn] --auth-fk-replacement-migration is DEPRECATED. ' +
        'Используйте --auth-primary-fk-validator (validate-auth-fk.ts) и ' +
        '--auth-secondary-fk-replacement-migration (089) по отдельности — это даёт точный отчёт по каждому FK.',
    );
    if (!authPrimaryAck) {
      authPrimaryAck = true;
      authPrimaryAckPath = resolved;
    }
    if (!authSecondaryAck) {
      authSecondaryAck = true;
      authSecondaryAckPath = resolved;
    }
  }

  const ctx = {
    startedAt,
    finishedAt: '',
    totalStatements: statements.length,
    keptCount: 0,
    strippedCount: 0,
    preSectionCount: 0,
    postSectionCount: 0,
    preDataPath: '',
    postDataPath: '',
    reasonCounts: new Map(),
    rlsEnabledTables: new Set(),
    seenPublicFunctions: new Set(),
    securityDefiner: new Set(),
    securityDefinerWithoutSearchPath: new Set(),
    critical: [],
    warnings: [],
    recoveredAck,
    recoveredAckPath,
    authPrimaryAck,
    authPrimaryAckPath,
    authSecondaryAck,
    authSecondaryAckPath,
  };

  const outChunks = [];
  const preChunks = [];
  const postChunks = [];
  const header = (label, sourceFile) => [
    '-- ============================================================',
    `-- ${label}`,
    `-- Generated by prepare-yandex-schema.mjs at ${startedAt}`,
    `-- Source: ${sourceFile}`,
    '-- See companion report: ' + args.report,
    '-- ============================================================',
    '',
  ];

  outChunks.push(...header('yandex_schema.sql (combined)', args.input));
  preChunks.push(...header('yandex_schema_pre_data.sql — apply BEFORE restore-public-data', args.input));
  postChunks.push(...header('yandex_schema_post_data.sql — apply AFTER restore-public-data', args.input));

  for (const stmt of statements) {
    const decision = classify(stmt, ctx);
    if (decision.action === 'strip') {
      ctx.strippedCount++;
      const reason = decision.reason + (decision.detail ? ` [${decision.detail}]` : '');
      ctx.reasonCounts.set(reason, (ctx.reasonCounts.get(reason) ?? 0) + 1);
      outChunks.push(`-- [stripped: ${reason}]`);
      outChunks.push(commentOut(stmt.trim()));
      outChunks.push('');
    } else {
      ctx.keptCount++;
      if (decision.warn) {
        outChunks.push(`-- [warn: ${decision.warn}]`);
      }
      const trimmed = stmt.trim();
      outChunks.push(trimmed);
      outChunks.push('');

      // Section split. SET / set_config — клонируются в оба файла,
      // остальные распределяются по pre/post.
      const stmtHeader = getHeader(stmt);
      if (isPreambleSetting(stmtHeader)) {
        preChunks.push(trimmed);
        preChunks.push('');
        postChunks.push(trimmed);
        postChunks.push('');
      } else if (classifySection(stmtHeader) === 'post') {
        if (decision.warn) postChunks.push(`-- [warn: ${decision.warn}]`);
        postChunks.push(trimmed);
        postChunks.push('');
        ctx.postSectionCount++;
      } else {
        if (decision.warn) preChunks.push(`-- [warn: ${decision.warn}]`);
        preChunks.push(trimmed);
        preChunks.push('');
        ctx.preSectionCount++;
      }
    }
  }

  // Эмитируем DISABLE RLS для всех таблиц, у которых был ENABLE/FORCE.
  // RLS относится к post-data — он не зависит от данных, но логически
  // парный к ALTER TABLE … ADD CONSTRAINT и не вредит в любом порядке.
  if (ctx.rlsEnabledTables.size > 0) {
    const rlsBlock = [
      '-- ============================================================',
      '-- DISABLE ROW LEVEL SECURITY for tables that had RLS in source.',
      '-- Reason: новый кластер не имеет ролей anon/authenticated/',
      '-- service_role; бэкенд ходит из одного пользователя с полными',
      '-- правами на public — RLS-обвязка теряет смысл и только',
      '-- усложняет диагностику.',
      '-- ============================================================',
    ];
    for (const line of rlsBlock) {
      outChunks.push(line);
      postChunks.push(line);
    }
    for (const t of [...ctx.rlsEnabledTables].sort()) {
      const line = `ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY;`;
      outChunks.push(line);
      postChunks.push(line);
    }
    outChunks.push('');
    postChunks.push('');
  }

  // Post-classification: missing функции и SECURITY DEFINER без search_path
  // → пушим в critical / warnings соответственно.
  for (const fname of Object.keys(VERSION_CONTROLLED_FUNCTIONS)) {
    if (!ctx.seenPublicFunctions.has(fname)) {
      ctx.critical.push({
        kind: 'version_controlled_function_missing',
        severity: 'critical',
        snippet: `public.${fname}`,
        note: `version-controlled функция отсутствует в дампе. Источник: ${VERSION_CONTROLLED_FUNCTIONS[fname]}. Применять её отдельно — это уже регрессия.`,
      });
    }
  }
  const checkRecovered = (fname, source, label, kindTag) => {
    if (ctx.seenPublicFunctions.has(fname)) return;
    const note = `${label} отсутствует в дампе. Источник: ${source}.`;
    if (ctx.recoveredAck) {
      ctx.warnings.push({
        kind: kindTag,
        severity: 'warning',
        snippet: `public.${fname}`,
        note: `${note} Будет создана через ${ctx.recoveredAckPath} (acknowledged via --recovered-functions-migration).`,
      });
    } else {
      ctx.critical.push({
        kind: kindTag,
        severity: 'critical',
        snippet: `public.${fname}`,
        note: `${note} Передайте --recovered-functions-migration <path>, если планируете применить 087 отдельно, либо применяйте 087 ДО prepare-yandex-schema.`,
      });
    }
  };
  for (const fname of Object.keys(RECOVERED_FUNCTIONS)) {
    checkRecovered(fname, RECOVERED_FUNCTIONS[fname], 'runtime-функция', 'recovered_function_missing');
  }
  for (const fname of Object.keys(RECOVERED_HELPER_FUNCTIONS)) {
    checkRecovered(fname, RECOVERED_HELPER_FUNCTIONS[fname], 'helper-зависимость (DB-internal)', 'recovered_helper_missing');
  }
  for (const fname of [...ctx.securityDefinerWithoutSearchPath].sort()) {
    ctx.critical.push({
      kind: 'security_definer_missing_search_path',
      severity: 'critical',
      snippet: `public.${fname}`,
      note: 'SECURITY DEFINER без SET search_path. Добавьте в определение: SET search_path = pg_catalog, public',
    });
  }

  // Acknowledgment FK→auth.users — отдельно primary и secondary.
  // Inline FK ВСЕГДА остаётся critical (replacement_kind === 'manual').
  // FK→storage.objects не затрагивается ни одним флагом.
  {
    const moveToWarnings = (predicate, ackPath, flagName) => {
      const toMove = ctx.critical.filter(predicate);
      if (toMove.length === 0) return;
      ctx.critical = ctx.critical.filter(c => !predicate(c));
      for (const c of toMove) {
        ctx.warnings.push({
          ...c,
          severity: 'warning',
          note: `${c.note} — acknowledged via ${flagName}=${ackPath}`,
        });
      }
    };

    if (ctx.authPrimaryAck) {
      moveToWarnings(
        c => c.kind === 'fk_auth_users_alter' && c.fk_meta?.replacement_kind === 'primary',
        ctx.authPrimaryAckPath,
        '--auth-primary-fk-validator',
      );
    }
    if (ctx.authSecondaryAck) {
      moveToWarnings(
        c => c.kind === 'fk_auth_users_alter' && c.fk_meta?.replacement_kind === 'secondary',
        ctx.authSecondaryAckPath,
        '--auth-secondary-fk-replacement-migration',
      );
    }
  }

  ctx.finishedAt = new Date().toISOString();

  const preDataPath = deriveSplitPath(args.output, 'pre_data');
  const postDataPath = deriveSplitPath(args.output, 'post_data');
  ctx.preDataPath = preDataPath;
  ctx.postDataPath = postDataPath;

  ensureDir(args.output);
  ensureDir(args.report);
  writeFileSync(args.output, outChunks.join('\n'));
  writeFileSync(preDataPath, preChunks.join('\n'));
  writeFileSync(postDataPath, postChunks.join('\n'));
  writeFileSync(args.report, renderReport(ctx, args));

  console.log(`statements: ${ctx.totalStatements} (kept=${ctx.keptCount}, stripped=${ctx.strippedCount})`);
  console.log(`sections:   pre=${ctx.preSectionCount}  post=${ctx.postSectionCount}`);
  console.log(`critical:   ${ctx.critical.length}`);
  console.log(`warnings:   ${ctx.warnings.length}`);
  console.log(`output:     ${args.output}`);
  console.log(`pre-data:   ${preDataPath}`);
  console.log(`post-data:  ${postDataPath}`);
  console.log(`report:     ${args.report}`);
  if (ctx.recoveredAck) {
    console.log(`recovered-functions-migration:        ${ctx.recoveredAckPath}`);
  }
  if (ctx.authPrimaryAck) {
    console.log(`auth-primary-fk-validator:            ${ctx.authPrimaryAckPath}`);
  }
  if (ctx.authSecondaryAck) {
    console.log(`auth-secondary-fk-replacement-migration: ${ctx.authSecondaryAckPath}`);
  }

  process.exit(ctx.critical.length > 0 ? 1 : 0);
}

main();
