#!/usr/bin/env node
// Диагностика подключения к API МТС (наш контур api.mts.ru или соседний INTP).
// Секреты не логируются. Запуск: node fot-server/scripts/probe-intp-contour.mjs [tokenUrl] [apiUrl]
import readline from 'node:readline';

const mask = (s) => (!s ? '(пусто)' : `${String(s).slice(0, 4)}…(len ${String(s).length})`);
const clean = (raw) => String(raw).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***').slice(0, 2000);
// Настоящая причина «fetch failed» лежит в error.cause (DNS/TCP/TLS).
const netErr = (e) => {
  const c = e?.cause;
  const base = c ? `${c.code ?? ''} ${c.message ?? c}`.trim() : (e?.message ?? String(e));
  const code = c?.code ?? e?.code;
  let hint = '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') hint = ' → хост не резолвится: внутренний контур (нужна сеть/VPN МТС) или неверный хост.';
  else if (code === 'ECONNREFUSED') hint = ' → соединение отклонено: неверный порт/хост или закрыто фаерволом.';
  else if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') hint = ' → таймаут: хост недоступен из этой сети (вероятно нужен VPN МТС).';
  else if (String(code).includes('CERT') || String(code).includes('SELF_SIGNED')) hint = ' → проблема TLS-сертификата контура.';
  else if (String(base).includes('Invalid URL')) hint = ' → неверный URL (нужен полный адрес со схемой https://).';
  return base + hint;
};

// Обычные (не секретные) промпты — через readline.
const ask = (rl, q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

// Скрытый ввод пароля — сырой stdin (надёжно в т.ч. в Windows-консоли).
const askHidden = (q) => new Promise((resolve) => {
  process.stdout.write(q);
  const stdin = process.stdin;
  const isTTY = Boolean(stdin.isTTY);
  if (isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  let input = '';
  const done = () => {
    stdin.removeListener('data', onData);
    if (isTTY) stdin.setRawMode(false);
    stdin.pause();
    process.stdout.write('\n');
    resolve(input);
  };
  const onData = (chunk) => {
    for (const ch of chunk) {
      const code = ch.charCodeAt(0);
      if (ch === '\n' || ch === '\r' || code === 4) { done(); return; } // Enter / Ctrl-D
      if (code === 3) { if (isTTY) stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); } // Ctrl-C
      if (code === 127 || code === 8) { input = input.slice(0, -1); continue; } // Backspace
      if (code >= 32) input += ch;
    }
  };
  stdin.on('data', onData);
});

const [argTokenUrl, argApiUrl] = process.argv.slice(2);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const tokenUrl = argTokenUrl || (await ask(rl, 'Token URL (напр. https://api.mts.ru/token): '));
const apiUrlRaw = argApiUrl ?? (await ask(rl, 'API test URL (Enter — пропустить): '));
const login = await ask(rl, 'Login (Consumer Key / client_id): ');
const scope = await ask(rl, 'Scope (Enter — без scope): ');
rl.close();
const password = await askHidden('Password (Consumer Secret): ');
// Освобождаем stdin, чтобы процесс завершился штатно (обход libuv-assert на Windows).
try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* */ }
process.stdin.pause();
if (process.stdin.unref) process.stdin.unref();

// Нормализация: если URL без схемы — дописываем https://
const norm = (u) => { const t = (u || '').trim(); return t && !/^https?:\/\//i.test(t) ? 'https://' + t : t; };
const apiUrl = norm(apiUrlRaw);

async function getToken(mode) {
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  if (scope) body.set('scope', scope);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (mode === 'basic') headers.Authorization = 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
  else { body.set('client_id', login); body.set('client_secret', password); }
  const r = await fetch(norm(tokenUrl), { method: 'POST', headers, body });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, text, json };
}

async function run() {
  if (!tokenUrl || !login || !password) { console.error('Нужны token URL, login и password.'); process.exitCode = 1; return; }

  console.log(`\n[1/2] Токен → POST ${norm(tokenUrl)}`);
  let tok;
  try {
    tok = await getToken('basic');
    if (tok.status === 400 || tok.status === 401) {
      console.log(`  Basic → HTTP ${tok.status}, пробую client_id/client_secret в теле…`);
      tok = await getToken('body');
    }
  } catch (e) { console.error(`  Сетевая ошибка: ${netErr(e)}`); process.exitCode = 2; return; }

  const accessToken = tok.json?.access_token ?? tok.json?.accessToken;
  console.log(`  HTTP ${tok.status}`);
  if (accessToken) {
    console.log(`  ✓ access_token=${mask(accessToken)} type=${tok.json?.token_type ?? '-'} expires_in=${tok.json?.expires_in ?? '-'} scope=${tok.json?.scope ?? '-'}`);
  } else {
    console.log(`  ✗ токен не получен. Тело: ${clean(tok.text)}`);
    if (tok.status === 401) console.log('  → 401: неверные креды или способ подписи.');
    process.exitCode = 3; return;
  }

  if (!apiUrl) { console.log('\nAPI URL не задан — проверка подписки пропущена.'); return; }

  console.log(`\n[2/2] API → GET ${apiUrl}`);
  let r, text, json;
  try {
    r = await fetch(apiUrl, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    text = await r.text();
    try { json = JSON.parse(text); } catch { /* */ }
  } catch (e) { console.error(`  Сетевая ошибка: ${netErr(e)}`); process.exitCode = 2; return; }

  const errCode = json?.error?.errorCode ?? json?.errorCode ?? json?.code;
  const errMsg = json?.error?.message ?? json?.message ?? json?.description;
  console.log(`  HTTP ${r.status}${errCode != null ? ` errorCode=${errCode}` : ''}`);
  if (r.status === 200) console.log('  ✓ Доступ есть — подписка/продукт подключены.');
  else if (r.status === 401) console.log('  → 401: токен не принят (креды/подпись).');
  else if (r.status === 403 && String(errCode) === '1010') console.log('  → 403/1010: подписка на продукт/ЛС не найдена (то же, что у соседнего портала). Оформляется на стороне МТС.');
  else console.log(`  → ${errMsg ?? ''}`.trim());
  console.log(`  Тело: ${clean(text)}`);
}

await run();
