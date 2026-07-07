#!/usr/bin/env node
/** Запуск SQL на проде через SSH (без PowerShell-экранирования). */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';

const { Client } = ssh2;
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const ENV_FILE = join(REPO_ROOT, '.ssh', '.env');
const KEY_FILE = join(REPO_ROOT, '.ssh', 'selectel_ed25519');
const HOST = '45.80.128.254';

function loadEnv() {
  const vars = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    vars[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return { login: vars.login || 'root', password: vars.password, keyPassphrase: vars.key_passphrase };
}

function exec(conn, command) {
  return new Promise((resolvePromise, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', d => { stdout += d.toString(); });
      stream.stderr.on('data', d => { stderr += d.toString(); });
      stream.on('close', code => resolvePromise({ code: code ?? 0, stdout, stderr }));
    });
  });
}

const sqlFile = process.argv[2] || join(__dirname, 'mts-prod-cleanup.sql');
const sql = readFileSync(sqlFile, 'utf8').replace(/\r\n/g, '\n');
const b64 = Buffer.from(sql).toString('base64');

const { login, password, keyPassphrase } = loadEnv();
const conn = new Client();
conn.on('ready', async () => {
  try {
    const cmd = `echo ${b64} | base64 -d | bash -c 'DB=$(grep ^DATABASE_URL= /srv/sites/fot.su10.ru/fot-server/.env | cut -d= -f2-); psql "$DB" -v ON_ERROR_STOP=1'`;
    const r = await exec(conn, cmd);
    process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.code);
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    conn.end();
  }
}).connect({
  host: HOST,
  port: 22,
  username: login,
  privateKey: readFileSync(KEY_FILE),
  passphrase: keyPassphrase,
  tryKeyboard: true,
  keyboardInteractive: (_n, _i, _l, prompts, finish) => finish(prompts.map(() => password)),
});
