# SK-KIT PostgreSQL Development Environment Setup
# Полностью автоматизированный скрипт для Windows PowerShell
# Использование: .\start-postgres-dev.ps1

Write-Host "╔════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  SK-KIT PostgreSQL Development Environment Setup              ║" -ForegroundColor Cyan
Write-Host "║  Автоматическая настройка и запуск PostgreSQL + приложения   ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ==================== STEP 1: Проверка Docker ====================
Write-Host "📋 Шаг 1: Проверка Docker..." -ForegroundColor Yellow

$dockerPath = "C:\Program Files\Docker\Docker\resources\bin"
if (Test-Path $dockerPath) {
    $env:PATH = "$dockerPath;$env:PATH"
    Write-Host "✓ Docker найден и добавлен в PATH" -ForegroundColor Green
} else {
    Write-Host "✗ ОШИБКА: Docker не установлен!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Решение:" -ForegroundColor Yellow
    Write-Host "1. Скачайте Docker Desktop: https://www.docker.com/products/docker-desktop"
    Write-Host "2. Установите и перезагрузитесь"
    Write-Host "3. Запустите Docker Desktop (значок кита должен горит зеленым в трее)"
    Write-Host "4. Закройте этот скрипт, откройте новый PowerShell и запустите снова"
    exit 1
}

# Проверим что docker действительно работает
try {
    $dockerVersion = docker --version 2>$null
    Write-Host "✓ Docker версия: $dockerVersion" -ForegroundColor Green
} catch {
    Write-Host "✗ ОШИБКА: Docker не отвечает. Убедитесь что Docker Desktop запущен" -ForegroundColor Red
    exit 1
}

Write-Host ""

# ==================== STEP 2: Обновляем .env ====================
Write-Host "📋 Шаг 2: Обновление .env файла..." -ForegroundColor Yellow

$envFile = ".\.env"
$databaseUrl = "postgresql://skkit_user:skkit_secure_password_change_in_production@localhost:6432/skkit_production"

if (Test-Path $envFile) {
    Write-Host "Обновляю существующий .env..." -ForegroundColor Cyan
    $content = Get-Content $envFile -Raw

    # Удалим старую DATABASE_URL если есть
    $content = $content -replace 'DATABASE_URL=.*\n?', ''

    # Добавим новую
    if (-not $content.EndsWith("`n")) {
        $content += "`n"
    }
    $content += "DATABASE_URL=$databaseUrl`n"

    Set-Content $envFile -Value $content -Encoding UTF8
    Write-Host "✓ .env обновлен" -ForegroundColor Green
} else {
    Write-Host "Создаю новый .env..." -ForegroundColor Cyan
    @"
# ========== PostgreSQL Configuration ==========
DATABASE_URL=$databaseUrl

# ========== Other Settings ==========
NODE_ENV=development
PORT=3000
"@ | Set-Content $envFile -Encoding UTF8
    Write-Host "✓ .env создан" -ForegroundColor Green
}

Write-Host ""

# ==================== STEP 3: Запуск PostgreSQL + pgbouncer ====================
Write-Host "📋 Шаг 3: Запуск PostgreSQL и pgbouncer..." -ForegroundColor Yellow

Write-Host "Загрузка Docker образов и запуск контейнеров (первый запуск может занять 1-2 минуты)..." -ForegroundColor Cyan
docker-compose up -d

if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ Docker контейнеры запущены успешно" -ForegroundColor Green
} else {
    Write-Host "✗ ОШИБКА при запуске docker-compose" -ForegroundColor Red
    Write-Host "Проверьте логи: docker-compose logs" -ForegroundColor Yellow
    exit 1
}

Write-Host ""

# ==================== STEP 4: Ожидание готовности PostgreSQL ====================
Write-Host "📋 Шаг 4: Ожидание готовности PostgreSQL..." -ForegroundColor Yellow

$maxAttempts = 30
$attempt = 0
$pgReady = $false

while ($attempt -lt $maxAttempts -and -not $pgReady) {
    $attempt++
    Write-Host "Попытка подключения $attempt/$maxAttempts..." -ForegroundColor Cyan

    try {
        # Проверим что контейнер работает
        $status = docker-compose ps postgres --services --filter "status=running" 2>$null
        if ($status -contains "postgres") {
            $pgReady = $true
            Write-Host "✓ PostgreSQL готов" -ForegroundColor Green
            break
        }
    } catch {
        # Продолжим попытки
    }

    Start-Sleep -Seconds 2
}

if (-not $pgReady) {
    Write-Host "✗ ОШИБКА: PostgreSQL не ответил за отведённое время" -ForegroundColor Red
    Write-Host "Проверьте логи: docker-compose logs postgres" -ForegroundColor Yellow
    exit 1
}

Write-Host ""

# ==================== STEP 5: Установка зависимостей ====================
Write-Host "📋 Шаг 5: Проверка npm зависимостей..." -ForegroundColor Yellow

if (-not (Test-Path ".\node_modules")) {
    Write-Host "Установка npm пакетов..." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "✗ ОШИБКА при установке npm пакетов" -ForegroundColor Red
        exit 1
    }
    Write-Host "✓ npm пакеты установлены" -ForegroundColor Green
} else {
    Write-Host "✓ npm пакеты уже установлены" -ForegroundColor Green
}

Write-Host ""

# ==================== STEP 6: Запуск приложения ====================
Write-Host "📋 Шаг 6: Запуск приложения..." -ForegroundColor Yellow
Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  ✓ Всё готово! Запуск сервера...                              ║" -ForegroundColor Green
Write-Host "╚════════════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "Приложение будет доступно по адресу: http://localhost:3000" -ForegroundColor Cyan
Write-Host "PostgreSQL подключен через pgbouncer на localhost:6432" -ForegroundColor Cyan
Write-Host ""
Write-Host "Для остановки нажмите Ctrl+C" -ForegroundColor Yellow
Write-Host ""

# Запускаем приложение
npm run dev

# После остановки приложения
Write-Host ""
Write-Host "📋 Приложение остановлено" -ForegroundColor Yellow
Write-Host ""
Write-Host "Для следующего запуска используйте:" -ForegroundColor Cyan
Write-Host "  .\start-postgres-dev.ps1" -ForegroundColor White
Write-Host ""
Write-Host "Для остановки PostgreSQL/pgbouncer:" -ForegroundColor Cyan
Write-Host "  docker-compose down" -ForegroundColor White
Write-Host ""
