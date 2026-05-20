/**
 * Скрипт для создания тестового кода привязки
 * Запуск: npx tsx scripts/create-test-code.ts
 */

import * as dotenv from 'dotenv';

import { queryOne } from '../src/config/postgres.js';

dotenv.config();

// Генерация кода формата FOT-XXXXXX
function generateCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // без O,I,L,0,1
  let code = 'FOT-';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

interface IOrgRow {
  id: string;
  name: string;
}

interface IAdminRow {
  id: string;
  full_name: string | null;
  position_type: string;
}

interface ILinkCodeRow {
  id: string;
  code: string;
  expires_at: string;
}

async function main(): Promise<void> {
  console.log('Создание тестового кода привязки...\n');

  // 1. Получаем первую организацию (или создаём)
  let org = await queryOne<IOrgRow>(
    'SELECT id, name FROM organizations LIMIT 1',
  );

  if (!org) {
    console.log('Организаций нет, создаём тестовую...');
    org = await queryOne<IOrgRow>(
      `INSERT INTO organizations (name)
       VALUES ($1)
       RETURNING id, name`,
      ['Тестовая организация'],
    );
    if (!org) {
      console.error('Не удалось создать организацию');
      process.exit(1);
    }
  }

  console.log(`Организация: ${org.name} (${org.id})`);

  // 2. Получаем admin пользователя
  const admin = await queryOne<IAdminRow>(
    `SELECT id, full_name, position_type
       FROM user_profiles
      WHERE position_type = $1
      LIMIT 1`,
    ['admin'],
  );

  if (!admin) {
    console.error('Ошибка: не найден admin пользователь');
    console.log('Сначала создайте пользователя с position_type = admin');
    process.exit(1);
  }

  console.log(`Создатель: ${admin.full_name || 'Admin'} (${admin.id})`);

  // 3. Генерируем уникальный код
  let code = generateCode();
  let attempts = 0;

  while (attempts < 10) {
    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM employee_link_codes WHERE code = $1 LIMIT 1',
      [code],
    );
    if (!existing) break;
    code = generateCode();
    attempts++;
  }

  // 4. Создаём код привязки
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const linkCode = await queryOne<ILinkCodeRow>(
    `INSERT INTO employee_link_codes (organization_id, code, position_type, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, code, expires_at`,
    [org.id, code, 'worker_office', admin.id, expiresAt],
  );

  if (!linkCode) {
    console.error('Ошибка создания кода');
    process.exit(1);
  }

  console.log('\n========================================');
  console.log('ТЕСТОВЫЙ КОД СОЗДАН!');
  console.log('========================================');
  console.log(`Код: ${linkCode.code}`);
  console.log(`Должность: worker_office (Офисный сотрудник)`);
  console.log(`Организация: ${org.name}`);
  console.log(`Действителен до: ${new Date(linkCode.expires_at).toLocaleDateString('ru-RU')}`);
  console.log('========================================\n');
  console.log('Используйте этот код при регистрации на /register');
}

main().catch(console.error);
