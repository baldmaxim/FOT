// Тестовый bootstrap: гарантирует обязательные env-переменные ДО импорта src/config/env.ts.
// На машине разработчика .env подхватывается dotenv (override:true) и перекрывает эти заглушки.
// В чистом окружении (CI / sandbox без .env) заглушки не дают env.ts вызвать process.exit(1).
process.env.SUPABASE_URL ||= 'http://localhost.test/supabase';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'test-jwt-secret-must-be-long-enough-for-zod-validator';
process.env.NODE_ENV ||= 'test';
