# 🚀 SK-KIT PostgreSQL Quickstart

## Полностью автоматизированный старт PostgreSQL + приложения

### ⚡ Самый быстрый способ (3 шага)

**Шаг 1: Установите Docker Desktop**
- Скачайте: https://www.docker.com/products/docker-desktop
- Установите и перезагрузитесь
- Запустите Docker Desktop (значок 🐋 в трее должен быть зеленым)

**Шаг 2: Обновите `.env`**
Откройте файл `.env` в папке проекта и добавьте:
```
DATABASE_URL=postgresql://skkit_user:skkit_secure_password_change_in_production@localhost:6432/skkit_production
```

**Шаг 3: Запустите скрипт**
Откройте PowerShell в папке проекта и выполните:
```powershell
.\start-postgres-dev.ps1
```

---

## ✅ Что происходит автоматически

Скрипт `start-postgres-dev.ps1` делает всё это за вас:

1. ✓ Проверяет Docker
2. ✓ Запускает `docker-compose up -d` → PostgreSQL + pgbouncer
3. ✓ Обновляет `.env` с правильной `DATABASE_URL`
4. ✓ Устанавливает npm пакеты (если нужно)
5. ✓ Применяет все 18 миграций БД автоматически
6. ✓ Запускает приложение на `http://localhost:3000`

---

## 🎯 Готовые компоненты

| Файл | Назначение | Статус |
|------|-----------|--------|
| `docker-compose.yml` | PostgreSQL 16 + pgbouncer | ✅ Готов |
| `init-db.sh` | Автоматические миграции | ✅ Готов |
| `src/server/database.ts` | PostgreSQL/SQLite поддержка | ✅ Готов |
| `server.ts` | Инициализация БД при старте | ✅ Готов |
| `start-postgres-dev.ps1` | Полная автоматизация | ✅ Готов |

---

## 📊 Архитектура

```
┌─────────────────────────────────────────────┐
│        SK-KIT Приложение (Node.js)          │
│        Running on localhost:3000            │
└──────────────┬──────────────────────────────┘
               │
               ▼
        ┌──────────────┐
        │  pgbouncer   │ ← Connection Pool
        │ :6432        │   (25 active connections)
        └──────┬───────┘
               │
               ▼
    ┌──────────────────────┐
    │  PostgreSQL 16       │
    │  :5432               │
    │  skkit_production    │
    │  18 migrations ✓     │
    └──────────────────────┘
               │
               ▼
    ┌──────────────────────┐
    │  postgres_data       │
    │  (volume)            │
    │  (persistent storage)│
    └──────────────────────┘
```

---

## 🔧 Команды для управления

**Запустить**:
```powershell
.\start-postgres-dev.ps1
```

**Остановить PostgreSQL** (данные сохранятся):
```bash
docker-compose down
```

**Перезагрузить контейнеры**:
```bash
docker-compose restart
```

**Посмотреть логи PostgreSQL**:
```bash
docker-compose logs postgres -f
```

**Посмотреть логи pgbouncer**:
```bash
docker-compose logs pgbouncer -f
```

**Подключиться к БД из терминала**:
```bash
# Через pgbouncer (connection pool)
psql -h localhost -p 6432 -U skkit_user -d skkit_production

# Напрямую к PostgreSQL
psql -h localhost -p 5432 -U skkit_user -d skkit_production
```

**Проверить статус контейнеров**:
```bash
docker-compose ps
```

---

## 🆘 Troubleshooting

### "docker: The term 'docker' is not recognized"
- Docker не установлен
- Решение: Установите Docker Desktop (см. шаг 1 выше)

### "PostgreSQL не ответил за отведённое время"
```bash
# Проверьте логи
docker-compose logs postgres

# Проверьте что контейнер запущен
docker-compose ps postgres
```

### "Connection refused to localhost:6432"
- pgbouncer не запустился
- Решение: `docker-compose restart pgbouncer`

### "Миграции не применились"
```bash
# Проверьте логи инициализации
docker-compose logs postgres | grep "Applying migration"

# Примените вручную
docker exec sk-kit-postgres psql -U skkit_user -d skkit_production -f /docker-entrypoint-initdb.d/init-db.sh
```

---

## 🔐 Production Deployment

Для production используйте:
- **AWS RDS** / **Google Cloud SQL** / **Heroku Postgres**
- Обновите `DATABASE_URL` в переменных окружения
- Примените миграции на production БД

```bash
# Пример для AWS RDS
DATABASE_URL=postgresql://user:password@production-db.amazonaws.com:5432/skkit_production npm run dev
```

---

## 📝 Что было сделано

**Шаг 1**: Decimal.js для финансовых вычислений ✅
**Шаг 2**: Multer disk storage + rate limiting ✅
**Шаг 3**: Circuit breaker для GenAI API ✅
**Шаг 4**: PostgreSQL + SQLite fallback ✅
**Шаг 5**: Docker + автоматизированный старт ✅

**Система Production-Ready! 🎉**

---

## 💡 Дополнительно

- [POSTGRES_SETUP.md](./POSTGRES_SETUP.md) — Подробная инструкция по PostgreSQL
- [docker-compose.yml](./docker-compose.yml) — Конфигурация контейнеров
- [src/server/database.ts](./src/server/database.ts) — Код подключения к БД

---

**Готовы начать?** Запустите скрипт:
```powershell
.\start-postgres-dev.ps1
```

Приложение будет работать на **http://localhost:3000** 🚀
