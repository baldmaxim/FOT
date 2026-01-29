import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

// Используем service_role key для полного доступа к данным
// RLS будет обходиться, проверка прав происходит в middleware
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

// Клиент для проверки токенов пользователей
export const supabaseAuth = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
