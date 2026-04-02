Задеплой проект на продакшен-сервер.

Шаги:
1. Выполни `git status` — проверь незакоммиченные изменения.
2. Если есть изменения — автоматически закоммить и запуш:
   - `git add -A`
   - Сгенерируй краткое сообщение коммита на русском по содержанию изменений
   - `git commit -m "сообщение"`
   - `git push`
3. Подключись по SSH и выполни деплой:

```bash
ssh root@80.74.28.233 "cd /var/www/fot && git pull && cd fot-server && npm ci && npm run build && pm2 restart fot-server && cd ../fot-app && npm ci && NODE_OPTIONS='--max-old-space-size=1024' npm run build"
```

4. Если нужен только фронтенд (аргумент `front`):
```bash
ssh root@80.74.28.233 "cd /var/www/fot && git pull && cd fot-app && NODE_OPTIONS='--max-old-space-size=1024' npm run build"
```

5. Если нужен только бэкенд (аргумент `back`):
```bash
ssh root@80.74.28.233 "cd /var/www/fot && git pull && cd fot-server && npm run build && pm2 restart fot-server"
```

Аргументы:
- Без аргументов или `all` — полный деплой (фронт + бэк)
- `front` — только фронтенд
- `back` — только бэкенд

После деплоя сообщи результат кратко.
