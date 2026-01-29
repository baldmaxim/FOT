/**
 * Скрипт для создания тестового кода привязки
 * Запуск: npx ts-node scripts/create-test-code.ts
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Генерация кода формата FOT-XXXXXX
function generateCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // без O,I,L,0,1
  let code = 'FOT-';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

async function main() {
  console.log('Создание тестового кода привязки...\n');

  // 1. Получаем первую организацию
  const { data: orgs, error: orgError } = await supabase
    .from('organizations')
    .select('id, name')
    .limit(1);

  if (orgError || !orgs?.length) {
    console.error('Ошибка получения организации:', orgError?.message || 'Нет организаций');

    // Создаём тестовую организацию
    console.log('Создаём тестовую организацию...');
    const { data: newOrg, error: createOrgError } = await supabase
      .from('organizations')
      .insert({ name: 'Тестовая организация' })
      .select()
      .single();

    if (createOrgError) {
      console.error('Не удалось создать организацию:', createOrgError.message);
      process.exit(1);
    }

    orgs!.push(newOrg);
  }

  const org = orgs![0];
  console.log(`Организация: ${org.name} (${org.id})`);

  // 2. Получаем super_admin пользователя
  const { data: admins, error: adminError } = await supabase
    .from('user_profiles')
    .select('id, full_name, position_type')
    .eq('position_type', 'super_admin')
    .limit(1);

  if (adminError || !admins?.length) {
    console.error('Ошибка: не найден super_admin пользователь');
    console.log('Сначала создайте пользователя с position_type = super_admin');
    process.exit(1);
  }

  const admin = admins[0];
  console.log(`Создатель: ${admin.full_name || 'Super Admin'} (${admin.id})`);

  // 3. Генерируем уникальный код
  let code = generateCode();
  let attempts = 0;

  while (attempts < 10) {
    const { data: existing } = await supabase
      .from('employee_link_codes')
      .select('id')
      .eq('code', code)
      .single();

    if (!existing) break;
    code = generateCode();
    attempts++;
  }

  // 4. Создаём код привязки
  const { data: linkCode, error: codeError } = await supabase
    .from('employee_link_codes')
    .insert({
      organization_id: org.id,
      code: code,
      position_type: 'worker',
      created_by: admin.id,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 дней
    })
    .select()
    .single();

  if (codeError) {
    console.error('Ошибка создания кода:', codeError.message);
    process.exit(1);
  }

  console.log('\n========================================');
  console.log('ТЕСТОВЫЙ КОД СОЗДАН!');
  console.log('========================================');
  console.log(`Код: ${linkCode.code}`);
  console.log(`Должность: worker (Сотрудник)`);
  console.log(`Организация: ${org.name}`);
  console.log(`Действителен до: ${new Date(linkCode.expires_at).toLocaleDateString('ru-RU')}`);
  console.log('========================================\n');
  console.log('Используйте этот код при регистрации на /register');
}

main().catch(console.error);
