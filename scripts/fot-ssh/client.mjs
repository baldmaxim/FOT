/**
 * Общий SSH-клиент для fot-ssh и deploy-скриптов.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';

const { Client, utils } = ssh2;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const SSH_DIR = join(REPO_ROOT, '.ssh');
const ENV_FILE = join(SSH_DIR, '.env');
const KEY_FILE = join(SSH_DIR, 'selectel_ed25519');
export const HOST = '45.80.128.254';

function loadEnv() {
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
  const login = vars.login || 'root';
  const password = vars.password;
  const keyPassphrase = vars.key_passphrase || process.env.FOT_KEY_PASSPHRASE || undefined;
  if (!password) throw new Error('В .ssh/.env нужен password=');
  return { login, password, keyPassphrase };
}

function loadPrivateKey() {
  if (!existsSync(KEY_FILE)) {
    throw new Error(`Нет ключа ${KEY_FILE}`);
  }
  const { keyPassphrase } = loadEnv();
  return {
    key: readFileSync(KEY_FILE),
    passphrase: keyPassphrase,
  };
}

function connect(config) {
  return new Promise((resolvePromise, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => resolvePromise(conn))
      .on('error', reject)
      .connect({ host: HOST, port: 22, readyTimeout: 15000, ...config });
  });
}

async function tryKeyAuth() {
  const { login } = loadEnv();
  const { key, passphrase } = loadPrivateKey();
  return connect({ username: login, privateKey: key, passphrase });
}

async function passwordAuth() {
  const { login, password } = loadEnv();
  return connect({
    username: login,
    password,
    tryKeyboard: true,
    keyboardInteractive: (_name, _instr, _lang, prompts, finish) => {
      if (prompts.length > 0) {
        finish(prompts.map(() => password));
      } else {
        finish([]);
      }
    },
  });
}

export async function connectAuto() {
  try {
    return await tryKeyAuth();
  } catch {
    return passwordAuth();
  }
}

export function exec(conn, command) {
  return new Promise((resolvePromise, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (d) => { stdout += d.toString(); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      stream.on('close', (code) => {
        resolvePromise({ code: code ?? 0, stdout, stderr });
      });
    });
  });
}

export function sftp(conn) {
  return new Promise((resolvePromise, reject) => {
    conn.sftp((err, sftpClient) => {
      if (err) return reject(err);
      resolvePromise(sftpClient);
    });
  });
}

export function fastPut(sftpClient, localPath, remotePath) {
  return new Promise((resolvePromise, reject) => {
    sftpClient.fastPut(localPath, remotePath, (err) => {
      if (err) return reject(err);
      resolvePromise();
    });
  });
}

export function publicKeyLine() {
  const { key, passphrase } = loadPrivateKey();
  const parsed = utils.parseKey(key, passphrase);
  if (parsed instanceof Error) {
    throw new Error(`Ключ: ${parsed.message}. Добавь key_passphrase= в .ssh/.env`);
  }
  if (!utils.isParsedKey(parsed)) {
    throw new Error('Не удалось разобрать приватный ключ');
  }
  return `${parsed.type} ${parsed.getPublicSSH()} fot-cursor-agent`;
}
