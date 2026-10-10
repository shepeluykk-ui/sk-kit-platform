# PostgreSQL Migration Guide for SK-KIT

## 📋 Полная инструкция по миграции на PostgreSQL

### 🐳 Шаг 1: Запустить PostgreSQL в Docker

```bash
# Убедитесь, что Docker установлен и работает
docker --version

# Запустите контейнер PostgreSQL с pgbouncer
docker-compose up -d
```

**Что произойдёт:**
- PostgreSQL 16 запустится на порту 5432
- pgbouncer (connection pool) запустится на порту 6432
- Все 18 миграций автоматически применятся при старте контейнера
- Data сохраняется в volume `postgres_data` (survives container restarts)

**Проверить статус:**
```bash
docker-compose ps
docker logs sk-kit-postgres
docker logs sk-kit-pgbouncer
```

---

### 🔧 Шаг 2: Обновить .env файл

Добавьте следующие переменные в `.env`:

```env
# ========== PostgreSQL Configuration ==========
# For production: postgres://user:password@host:5432/dbname
# For local Docker setup:
DATABASE_URL=postgresql://skkit_user:skkit_secure_password_change_in_production@localhost:6432/skkit_production

# Connection pool settings (pgbouncer)
DB_POOL_SIZE=25
DB_MIN_POOL_SIZE=10
DB_MAX_CONNECTIONS=1000

# Optional: query timeout in seconds (0 = disabled)
DB_QUERY_TIMEOUT=30

# ========== Development vs Production ==========
# Development: Keep DATABASE_URL empty to use SQLite (file-based, no Docker needed)
# Production: Set DATABASE_URL to use PostgreSQL (Docker or managed RDS/CloudSQL)
```

**Важно:**
- **LOCAL DEV:** Оставьте `DATABASE_URL` пустым → используется SQLite
- **DOCKER DEV:** Установите `DATABASE_URL` как выше → используется PostgreSQL в контейнере
- **PRODUCTION:** Используйте управляемый PostgreSQL (AWS RDS, Google Cloud SQL, Heroku Postgres)

---

### 🚀 Шаг 3: Запустить сервер

```bash
# Установите зависимости (если ещё не установлены)
npm install

# Запустите сервер (автоматически применит миграции при первом подключении)
npm run dev
```

**Лог должен показать:**
```
[Database] Connected to PostgreSQL
[БД] Персистентность инициализирована: пользователи=12, проекты=4, ...
[Строительный Контроль] Server running on http://0.0.0.0:3000
```

---

### 📊 Шаг 4: Проверить БД

**Подключиться к PostgreSQL из терминала:**
```bash
# Напрямую к PostgreSQL
psql -h localhost -U skkit_user -d skkit_production

# Или через pgbouncer (connection pool)
psql -h localhost -p 6432 -U skkit_user -d skkit_production
```

**Часто используемые SQL команды:**
```sql
-- Посмотреть все таблицы
\dt

-- Посмотреть кол-во строк в каждой таблице
SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

-- Посмотреть структуру таблицы
\d users

-- Проверить активные подключения
SELECT count(*) FROM pg_stat_activity;
```

---

### 🔄 Миграции: Как они работают

**Файлы миграций:** `src/server/db/migrations/[001-018]*.sql`

**При запуске Docker контейнера:**
1. PostgreSQL инициализируется
2. `init-db.sh` скрипт автоматически запускается
3. Все миграции применяются по порядку (001, 002, ..., 018)
4. Если миграция уже применена → пропускается (idempotent)

**Применить миграции вручную (если нужно):**
```bash
# Через Docker
docker exec sk-kit-postgres psql -U skkit_user -d skkit_production -f /docker-entrypoint-initdb.d/init-db.sh

# Или локально (если psql установлен)
for file in src/server/db/migrations/*.sql; do
  echo "Applying $file..."
  psql -h localhost -U skkit_user -d skkit_production -f "$file"
done
```

---

### 🧹 Шаг 5: Остановить/Перезагрузить

**Остановить контейнеры (данные сохранятся):**
```bash
docker-compose down
```

**Полностью удалить всё (включая данные):**
```bash
docker-compose down -v
```

**Перезагрузить контейнеры:**
```bash
docker-compose restart
```

---

### 🛡️ Production Deployment

**На AWS RDS / Google Cloud SQL:**
```bash
# 1. Создайте управляемый PostgreSQL инстанс
# 2. Получите CONNECTION STRING: postgresql://user:pass@host:port/dbname
# 3. В .env установите: DATABASE_URL=<YOUR_CONNECTION_STRING>
# 4. Запустите приложение: npm run dev (миграции применятся автоматически)
```

**На Heroku:**
```bash
heroku addons:create heroku-postgresql:standard-0
heroku config:get DATABASE_URL
# Установите эту переменную в ваших environment variables
```

**Безопасность:**
- Никогда не коммитьте реальные пароли в .env
- Используйте `DATABASE_URL` из переменных окружения на production
- На Docker: измените пароль `skkit_secure_password_change_in_production`

---

### 🆘 Troubleshooting

**PostgreSQL не подключается:**
```bash
# Проверьте что контейнер запущен
docker ps | grep postgres

# Посмотрите логи
docker logs sk-kit-postgres

# Убедитесь что порт 5432 не занят
lsof -i :5432  # Linux/Mac
netstat -ano | findstr :5432  # Windows
```

**Миграции не применились:**
```bash
# Проверьте логи миграций
docker logs sk-kit-postgres | grep "Applying migration"

# Примените вручную
docker exec sk-kit-postgres psql -U skkit_user -d skkit_production \
  -f /docker-entrypoint-initdb.d/init-db.sh
```

**Connection pool проблемы:**
```bash
# Проверьте pgbouncer статус
docker logs sk-kit-pgbouncer

# Пересоздайте pgbouncer
docker-compose restart pgbouncer
```

---

## ✅ Итоговый Чеклист

- [ ] Docker установлен и работает
- [ ] `docker-compose up -d` запущен без ошибок
- [ ] `.env` содержит правильный `DATABASE_URL`
- [ ] `npm run dev` подключается к PostgreSQL (проверьте логи)
- [ ] Все 18 миграций применены (проверьте в `\dt` command)
- [ ] Приложение доступно на http://localhost:3000
- [ ] Можно залогиниться с demo аккаунтом

**Готово! 🎉 Проект полностью миграл на PostgreSQL и Production-ready.**
