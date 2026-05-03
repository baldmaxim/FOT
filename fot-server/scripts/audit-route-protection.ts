// Превентивный аудит: ищет API-роуты, защищённые только authenticate без
// requirePageAccess / requireAnyPageAccess / requireAdmin. Это симметричный
// эквивалент дыры на фронте, когда <ProtectedRoute> используется без requiredPage —
// фронт пропускает любого залогиненного по прямому URL, бэк отдаёт ему данные.
//
// Запуск:
//   npx tsx scripts/audit-route-protection.ts
//
// Выход: 0 если все роуты защищены / в whitelist, 1 — есть нарушения.

import { readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';

const ROUTES_DIR = join(process.cwd(), 'src', 'routes');
const PROTECTION_MARKERS = [
  'requirePageAccess',
  'requireAnyPageAccess',
  'requireAdmin',
];

// Файлы целиком исключены из аудита: содержат публичные роуты или роуты со
// строгим self-scope в контроллере (фильтр по req.user.id), что делает доступ
// безопасным без дополнительной проверки страницы.
const FILE_WHITELIST = new Set<string>([
  'auth.routes.ts',
  'push.routes.ts',
  'notification.routes.ts',
]);

interface Violation {
  file: string;
  line: number;
  method: string;
  path: string;
  reason: string;
}

const ROUTE_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
const routeRegex = new RegExp(
  `\\brouter\\.(${ROUTE_VERBS.join('|')})\\s*\\(\\s*(['"\`])([^'"\`]+)\\2`,
  'g',
);
const useRegex = /\brouter\.use\s*\(([^;]+?)\)/g;

function hasMarker(snippet: string, aliases: Set<string>): boolean {
  if (PROTECTION_MARKERS.some((marker) => snippet.includes(marker))) return true;
  for (const alias of aliases) {
    // Граница слова, чтобы 'view' не матчился внутри 'preview'.
    if (new RegExp(`\\b${alias}\\b`).test(snippet)) return true;
  }
  return false;
}

// Локальные алиасы вида:
//   const view = requirePageAccess('/x', 'view');
//   const edit = requireAnyPageAccess([...]);
//   const onlyAdmin = requireAdmin;
function collectAliases(content: string): Set<string> {
  const aliases = new Set<string>();
  const aliasRegex = /\b(?:const|let|var)\s+(\w+)\s*=\s*([^;]+);/g;
  for (const match of content.matchAll(aliasRegex)) {
    const [, name, rhs] = match;
    if (PROTECTION_MARKERS.some((marker) => rhs.includes(marker))) {
      aliases.add(name);
    }
  }
  return aliases;
}

function auditFile(filePath: string): Violation[] {
  const fileName = basename(filePath);
  if (FILE_WHITELIST.has(fileName)) return [];

  const content = readFileSync(filePath, 'utf8');
  const aliases = collectAliases(content);

  // Сканируем router.use(...) и запоминаем offset, с которого защита включена.
  const useEvents: Array<{ offset: number; hasMarker: boolean }> = [];
  for (const match of content.matchAll(useRegex)) {
    useEvents.push({
      offset: match.index ?? 0,
      hasMarker: hasMarker(match[1], aliases),
    });
  }
  useEvents.sort((a, b) => a.offset - b.offset);

  const violations: Violation[] = [];
  for (const match of content.matchAll(routeRegex)) {
    const offset = match.index ?? 0;
    const method = match[1];
    const path = match[3];

    // Inline-маркеры на той же строке:
    //   `// audit:public`       — намеренно публичный роут (без auth);
    //   `// audit:self-scoped`  — authenticated, доступ ограничен через
    //                             req.user.id/employee_id внутри контроллера.
    const lineStart = content.lastIndexOf('\n', offset) + 1;
    const lineEnd = content.indexOf('\n', offset);
    const fullLine = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
    if (/\/\/\s*audit:(public|self-scoped)\b/.test(fullLine)) continue;

    // Защита на уровне router.use(...) выше по файлу?
    const protectedByUse = useEvents
      .filter((evt) => evt.offset < offset)
      .some((evt) => evt.hasMarker);

    if (protectedByUse) continue;

    // Иначе — ищем marker в самом router.<verb>(...) до закрывающей скобки.
    const tail = content.slice(offset);
    const callEnd = findCallEnd(tail);
    const callSnippet = tail.slice(0, callEnd);
    if (hasMarker(callSnippet, aliases)) continue;

    const lineNumber = content.slice(0, offset).split('\n').length;
    violations.push({
      file: fileName,
      line: lineNumber,
      method: method.toUpperCase(),
      path,
      reason: 'no requirePageAccess / requireAnyPageAccess / requireAdmin',
    });
  }

  return violations;
}

function findCallEnd(snippet: string): number {
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  for (let i = 0; i < snippet.length; i++) {
    const ch = snippet[i];
    const prev = i > 0 ? snippet[i - 1] : '';
    if (inString) {
      if (ch === inString && prev !== '\\') inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return snippet.length;
}

function main(): void {
  const files = readdirSync(ROUTES_DIR)
    .filter((name) => name.endsWith('.routes.ts'))
    .map((name) => join(ROUTES_DIR, name));

  let allViolations: Violation[] = [];
  for (const file of files) {
    allViolations = allViolations.concat(auditFile(file));
  }

  if (allViolations.length === 0) {
    console.log('✓ Route protection audit passed. All non-whitelisted routes guarded.');
    process.exit(0);
  }

  console.error(`✗ ${allViolations.length} route(s) without role-based protection:\n`);
  for (const v of allViolations) {
    console.error(`  ${v.file}:${v.line}  ${v.method} ${v.path}  — ${v.reason}`);
  }
  console.error(
    '\nFix: add requirePageAccess / requireAnyPageAccess / requireAdmin middleware,\n' +
    '     OR — if the route is intentionally public / self-scoped — add the file to\n' +
    '     FILE_WHITELIST in scripts/audit-route-protection.ts with a comment explaining why.',
  );
  process.exit(1);
}

main();
