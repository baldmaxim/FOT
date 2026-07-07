#!/usr/bin/env node
/**
 * SSH на production (fot.su10.ru) для агента Cursor.
 * Креды: .ssh/.env (login, password). Ключ: .ssh/selectel_ed25519
 *
 * Usage:
 *   node scripts/fot-ssh/run.mjs <remote command>
 *   node scripts/fot-ssh/run.mjs --bootstrap
 *   node scripts/fot-ssh/run.mjs --check
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  connectAuto,
  exec,
  publicKeyLine,
  HOST,
} from './client.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SSH_DIR = resolve(__dirname, '../..', '.ssh');

function loadEnv() {
  const ENV_FILE = join(SSH_DIR, '.env');
  if (!existsSync(ENV_FILE)) {
    throw new Error(`Нет ${ENV_FILE}. Создай login= и password=.`);
  }
  const vars = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  const password = vars.password;
  if (!password) throw new Error('В .ssh/.env нужен password=');
  return { login: vars.login || 'root', password };
}

async function passwordAuth() {
  const { Client } = await import('ssh2');
  const { login, password } = loadEnv();
  return new Promise((resolvePromise, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => resolvePromise(conn))
      .on('error', reject)
      .connect({
        host: HOST,
        port: 22,
        username: login,
        password,
        readyTimeout: 15000,
        tryKeyboard: true,
        keyboardInteractive: (_name, _instr, _lang, prompts, finish) => {
          if (prompts.length > 0) finish(prompts.map(() => password));
          else finish([]);
        },
      });
  });
}

async function bootstrapKey() {
  const conn = await passwordAuth();
  try {
    const pub = publicKeyLine().replace(/'/g, `'\\''`);
    const cmd = [
      'mkdir -p ~/.ssh && chmod 700 ~/.ssh',
      `touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
      `grep -qF 'fot-cursor-agent' ~/.ssh/authorized_keys || echo '${pub}' >> ~/.ssh/authorized_keys`,
      'echo BOOTSTRAP_OK',
    ].join(' && ');

    const result = await exec(conn, cmd);
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.code !== 0) throw new Error(`bootstrap exit ${result.code}`);
  } finally {
    conn.end();
  }

  const keyConn = await connectAuto();
  try {
    const check = await exec(keyConn, 'hostname');
    process.stdout.write(`Key auth OK: ${check.stdout.trim()}\n`);
  } finally {
    keyConn.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`Usage:
  node scripts/fot-ssh/run.mjs --bootstrap   добавить ключ на сервер (нужен password)
  node scripts/fot-ssh/run.mjs --pubkey      публичный ключ для панели Selectel
  node scripts/fot-ssh/run.mjs --check       проверить подключение
  node scripts/fot-ssh/run.mjs <command>     выполнить команду на сервере`);
    process.exit(args.length === 0 ? 1 : 0);
  }

  if (args[0] === '--bootstrap') {
    await bootstrapKey();
    return;
  }

  if (args[0] === '--pubkey') {
    const line = publicKeyLine();
    const pubFile = join(SSH_DIR, 'selectel_ed25519.pub');
    writeFileSync(pubFile, `${line}\n`, 'utf8');
    console.log(line);
    console.log(`\nСохранено: ${pubFile}`);
    return;
  }

  const conn = await connectAuto();
  try {
    if (args[0] === '--check') {
      const r = await exec(conn, 'hostname && pwd && whoami');
      process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      process.exit(r.code);
    }

    const command = args.join(' ');
    const r = await exec(conn, command);
    process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.code);
  } finally {
    conn.end();
  }
}

main().catch((e) => {
  console.error(`fot-ssh: ${e.message}`);
  process.exit(1);
});
