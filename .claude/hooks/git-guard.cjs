// PreToolUse-страж для git (matcher Bash, if Bash(git *)).
//
// Зачем: в этом рабочем дереве параллельно работают другие агенты и могут
// пре-стейджить/менять файлы. Широкое индексирование и `commit -a` утащат
// чужие правки в твой коммит; `push origin` уйдёт в чужой/устаревший форк.
//
// Блокирует (permissionDecision: deny):
//   - git add -A | --all | -u | --update | . | :/ | *
//   - git commit -a | -am | --all (без явного списка путей)
//   - git push ... origin ...
// Разрешает: git add -- <пути>, git add <конкретный путь>,
//   git commit -- <пути>, git commit -m "..." -- <пути>,
//   git push personal <branch>, любые read-only git (status/diff/log/...).
//
// Логика ИДЕНТИЧНА памяти feedback_git_isolate_unrelated_changes.

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let cmd = '';
  try { cmd = (JSON.parse(raw).tool_input || {}).command || ''; } catch (_) { /* пустой/битый ввод — пропускаем */ }

  // Гасим содержимое кавычек (сообщения коммита и т.п.), чтобы `-a` внутри
  // текста сообщения не считалось флагом и не давало ложных срабатываний.
  const bare = cmd.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");

  const rules = [
    [/git\s+add\s+(-A|--all|-u|--update|\.|:\/|\*)(\s|$)/,
      'git add -A/--all/-u/./:/ /* ЗАПРЕЩЁН: в рабочем дереве возможны правки параллельного агента. Индексируй конкретные пути (git add -- <paths>) или коммить напрямую через git commit -- <paths>.'],
    [/git\s+commit(\s+\S+)*\s+(-[A-Za-z]*a[A-Za-z]*|--all)(\s|=|$)/,
      'git commit -a/-am/--all ЗАПРЕЩЁН: захватит чужие правки из рабочего дерева. Коммить ТОЛЬКО явными путями: git commit -- <paths> (или git commit -m "..." -- <paths>).'],
    [/git\s+push(\s+\S+)*\s+origin(\s|\/|$)/,
      'git push origin ЗАПРЕЩЁН: пушим ТОЛЬКО в personal — git push personal <branch> (origin = чужой/устаревший форк).'],
  ];

  for (const [re, reason] of rules) {
    if (re.test(bare)) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }));
      break;
    }
  }
  process.exit(0);
});
