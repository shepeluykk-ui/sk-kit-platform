# 🚀 SK-KIT Cloud Deployment Roadmap

## Переход от локального разработки к Production

---

## 📋 Этап 1: Локальная валидация (ТЕКУЩИЙ ЭТАП)

### Шаги:
1. ✅ Установить Docker Desktop
2. ✅ Запустить `.\start-postgres-dev.ps1`
3. ✅ Проверить работу на `http://localhost:3000`
4. ✅ Протестировать основную функциональность:
   - Вход/выход
   - Создание проектов
   - Финансовые расчеты (КС-2/КС-3)
   - Загрузка файлов
   - ИИ-анализ

**Результат:** Убедиться что все компоненты работают локально

---

## 📋 Этап 2: Production Database Setup

### Вариант A: AWS RDS (Рекомендуется для Enterprise)
**Плюсы:** Управляемая БД, автоматические бэкапы, масштабируемость, высокая доступность

```bash
# 1. Создать RDS PostgreSQL instance в AWS
# - Engine: PostgreSQL 16
# - Instance class: db.t3.small (или db.t3.micro для начала)
# - Storage: 20GB gp3
# - Multi-AZ: Yes (для production)
# - Backup retention: 30 days

# 2. Создать security group с доступом только от приложения

# 3. Получить connection string
# Формат: postgresql://user:password@your-db.c9akciq32.us-east-1.rds.amazonaws.com:5432/skkit_production

# 4. Применить миграции
psql -h your-db.c9akciq32.us-east-1.rds.amazonaws.com \
     -U postgres \
     -d skkit_production \
     -f src/server/db/migrations/001_*.sql
```

**Стоимость:** ~$15-30/месяц

---

### Вариант B: Google Cloud SQL (Альтернатива)
**Плюсы:** Интеграция с GCP, CloudSQL Proxy, хорошая документация

```bash
# 1. Создать Cloud SQL instance
gcloud sql instances create skkit-production \
  --database-version=POSTGRES_16 \
  --tier=db-f1-micro \
  --region=europe-west1

# 2. Создать базу данных
gcloud sql databases create skkit_production \
  --instance=skkit-production

# 3. Получить public IP и подключиться
gcloud sql connect skkit-production --user=postgres
```

**Стоимость:** ~$20-40/месяц

---

### Вариант C: Heroku PostgreSQL (Быстро, но дороговато)
**Плюсы:** Самый быстрый старт, встроенная CI/CD

```bash
# 1. Установить Heroku CLI
npm install -g heroku

# 2. Создать приложение
heroku create skkit-production
heroku addons:create heroku-postgresql:standard-0

# 3. Получить DATABASE_URL
heroku config:get DATABASE_URL

# 4. Применить миграции
heroku run "psql ... < migrations.sql"
```

**Стоимость:** ~$50-100/месяц (для production tier)

---

## 📋 Этап 3: Application Deployment

### Вариант A: AWS ECS + Fargate (Рекомендуется)
**Архитектура:**
```
┌─────────────────────────────────────────────┐
│          CloudFront (CDN)                   │
│          + SSL/HTTPS                         │
└────────────────┬────────────────────────────┘
                 ↓
        ┌────────────────────┐
        │  Load Balancer     │
        │  (ALB)             │
        └────────┬───────────┘
                 ↓
    ┌────────────────────────────┐
    │  ECS Fargate Cluster       │
    │  (2-3 instances)           │
    │  - Task: SK-KIT App        │
    │  - CPU: 512                │
    │  - Memory: 1GB             │
    └────────────────────────────┘
                 ↓
        ┌────────────────────┐
        │  AWS RDS           │
        │  PostgreSQL 16     │
        └────────────────────┘
```

**Инструкции:**

```bash
# 1. Создать ECR repository
aws ecr create-repository --repository-name skkit-production

# 2. Создать Dockerfile (поместить в корень проекта)
# Уже готов: docker-compose.yml работает как основа

# 3. Собрать и залить Docker image
docker build -t skkit-production:latest .
docker tag skkit-production:latest YOUR_ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/skkit-production:latest
docker push YOUR_ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/skkit-production:latest

# 4. Создать ECS Task Definition
# Используйте image из ECR
# Port: 3000
# Environment: DATABASE_URL, JWT_SECRET, NODE_ENV=production

# 5. Создать ECS Service
# Желаемое количество задач: 2
# Load balancer: ALB на порт 80/443
# Auto scaling: от 2 до 5 задач в зависимости от CPU/Memory

# 6. Настроить SSL через ACM
# + Route53 для домена
```

**Стоимость:** ~$50-100/месяц (для базовой конфигурации)

---

### Вариант B: Render (Простой, но ограниченный)
**Плюсы:** Один клик деплоя, автоматический SSL

```bash
# 1. Коммитить в GitHub
git push origin main

# 2. Подключить Render
# - Перейти на render.com
# - Синхронизировать GitHub репозиторий
# - Выбрать Branch: main
# - Настроить Environment variables

# 3. Автоматический деплой при каждом push
```

**Стоимость:** ~$20-50/месяц (зависит от использования)

---

### Вариант C: Vercel (Frontend) + Railway/Render (Backend)
**Плюсы:** Лучший performance для фронтенда, простота

```bash
# Frontend на Vercel
vercel --prod

# Backend на Railway
railway up

# Статический сайт + API микросервис архитектура
```

**Стоимость:** ~$30-60/месяц

---

## 📋 Этап 4: SSL/HTTPS & Security

### Обязательно для Production:

```bash
# 1. SSL Certificate (бесплатный Let's Encrypt)
# AWS: Используйте ACM (автоматический)
# Heroku: Встроенный
# Render: Встроенный
# Vercel: Встроенный

# 2. Security Headers (обновить server.ts)
# - X-Frame-Options: DENY
# - X-Content-Type-Options: nosniff
# - Strict-Transport-Security: max-age=31536000
# - Content-Security-Policy: обновлено для WebSocket

# 3. Environment Variables (НЕ коммитить в git)
# - DATABASE_URL: production БД
# - JWT_SECRET: сильный рандомный ключ
# - NODE_ENV: production
# - API_KEYS: для внешних сервисов

# 4. Database Backups (КРИТИЧНО!)
# AWS RDS: Автоматические (30 дней retention)
# Google Cloud SQL: Автоматические
# Heroku: Автоматические (через pg_dump)
```

---

## 📋 Этап 5: CI/CD Pipeline

### GitHub Actions (встроен в GitHub, бесплатен)

```yaml
# .github/workflows/deploy.yml
name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Install dependencies
        run: npm install
      
      - name: Run tests
        run: npm test
      
      - name: Build
        run: npm run build
      
      - name: Deploy to AWS/Heroku/Render
        env:
          DEPLOY_KEY: ${{ secrets.DEPLOY_KEY }}
        run: |
          # Ваш скрипт деплоя
          ./deploy.sh
```

---

## 📋 Этап 6: Monitoring & Alerts

### Рекомендуемые сервисы:

| Сервис | Назначение | Стоимость |
|--------|-----------|----------|
| **CloudWatch** (AWS) | Логи, метрики | Входит в AWS |
| **Sentry** | Ошибки приложения | $0-99/месяц |
| **DataDog** | Full-stack monitoring | $15+/месяц |
| **PagerDuty** | On-call alerts | $14+/месяц |
| **UptimeRobot** | Проверка доступности | $0-99/месяц |

```bash
# Добавить Sentry для отслеживания ошибок
npm install @sentry/node @sentry/tracing

# Инициализировать в server.ts
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 1.0,
});
```

---

## 📋 Рекомендуемая конфигурация для SK-KIT

### Балансирование стоимости/производительности:

```
┌─────────────────────────────────────────────┐
│         Вариант: AWS ECS + RDS              │
├─────────────────────────────────────────────┤
│                                             │
│  Application Layer:                         │
│  - ECS Fargate × 2 instances                │
│  - 512 CPU, 1GB RAM каждый                  │
│  - Auto-scaling 2-5 instances               │
│  - Cost: ~$30-50/месяц                      │
│                                             │
│  Database Layer:                            │
│  - AWS RDS PostgreSQL 16                    │
│  - db.t3.small (2 vCPU, 2GB RAM)            │
│  - Multi-AZ (высокая доступность)          │
│  - 30-дневные автоматические backup        │
│  - Cost: ~$40-60/месяц                      │
│                                             │
│  Networking/CDN:                            │
│  - Application Load Balancer                │
│  - CloudFront CDN                           │
│  - Route53 DNS                              │
│  - SSL Certificate (бесплатный ACM)         │
│  - Cost: ~$10-20/месяц                      │
│                                             │
│  Monitoring:                                │
│  - CloudWatch (встроен)                     │
│  - Sentry для ошибок                        │
│  - Cost: ~$0-20/месяц                       │
│                                             │
│  ──────────────────────────────────         │
│  ИТОГО: ~$80-150/месяц                      │
│  (production-grade infrastructure)          │
│                                             │
└─────────────────────────────────────────────┘
```

---

## 📋 Шаги реализации (по очередности)

### Week 1: Подготовка
- ✅ Настроить локальный Docker (done)
- ⬜ Создать AWS аккаунт (если выбран AWS)
- ⬜ Настроить RDS PostgreSQL
- ⬜ Применить миграции на production БД

### Week 2: Контейнеризация
- ⬜ Создать Dockerfile для приложения
- ⬜ Создать docker-compose.prod.yml (без pgbouncer, только приложение)
- ⬜ Протестировать локально: `docker build && docker run`

### Week 3: Deployment
- ⬜ Настроить ECS/Fargate (или выбранный сервис)
- ⬜ Залить Docker image в ECR
- ⬜ Создать Load Balancer + ALB
- ⬜ Настроить SSL через ACM

### Week 4: Production Hardening
- ⬜ Настроить CloudWatch мониторинг
- ⬜ Добавить Sentry для ошибок
- ⬜ Настроить auto-scaling политику
- ⬜ Тестировать на нагрузку

### Week 5: Go Live!
- ⬜ Получить домен (yourcompany.ru)
- ⬜ Указать DNS на Route53
- ⬜ Перевести трафик на production
- ⬜ Мониторить метрики

---

## 🎯 Что дальше?

### После успешного запуска в облаке:

1. **Мобильное приложение**
   - React Native / Flutter
   - Синхронизация с backend API
   - Offline mode с локальной БД

2. **Интеграции**
   - 1C/Компас для дизайнов
   - Twilio для SMS уведомлений
   - Telegram bot для alerts

3. **Аналитика**
   - Яндекс.Метрика / Google Analytics
   - Custom дашборды по KPI
   - Отчеты для менеджмента

4. **Масштабирование**
   - Микросервисная архитектура
   - Message Queue (RabbitMQ/Redis)
   - Кэширование (Redis)

---

## 📞 Поддержка и консультация

Для вопросов по deployment:
- AWS документация: https://docs.aws.amazon.com/
- Heroku guides: https://devcenter.heroku.com/
- Render docs: https://render.com/docs/

---

**Система готова к облаку! 🚀**

Следующий шаг: Запустить локально, протестировать, затем выбрать облачного провайдера.
