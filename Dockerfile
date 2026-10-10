# Multi-stage build for production
#
# Базовый образ — Node 24, и это не предпочтение, а требование артефакта.
# src/server/database.ts импортирует node:sqlite на верхнем уровне модуля, и
# esbuild переносит это в бандл как require("node:sqlite") вне функций. В Node 20
# такого встроенного модуля нет вовсе: проверка самого рантайма даёт
# ERR_UNKNOWN_BUILTIN_MODULE, а перехватить ошибку невозможно — она возникает
# при загрузке, до любого кода приложения. На node:20-alpine образ собирался, но
# контейнер падал сразу после старта. Минимум зафиксирован в package.json
# (engines.node); при понижении базового образа приложение не запустится.
#
# Stage 1: Build
FROM node:24-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Stage 2: Runtime
# Та же мажорная версия, что и в стадии сборки: артефакт исполняется здесь,
# и именно здесь требуется node:sqlite.
FROM node:24-alpine

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Copy only production dependencies
COPY package*.json ./
RUN npm install --production && npm cache clean --force

# Copy built application from builder.
#
# NOTE: there is deliberately no COPY of src/server/db here. That path does not
# exist in this project — the SQL migrations live in the separate SK-KIT/
# repository and target a PostgreSQL schema this application does not use (it
# creates its own SQLite schema at runtime in src/server/database.ts). The COPY
# that used to be on this line referenced the missing path and failed the image
# build outright.
COPY --from=builder /app/dist ./dist

# Каталоги, в которые приложение пишет во время работы.
#
# data/ — файл SQLite: src/server/database.ts открывает его как
# path.join(process.cwd(), 'data', 'skkit.db') и создаёт схему при старте.
# Каталог создаётся заранее и передаётся непривилегированному пользователю,
# иначе первая же запись упала бы на правах доступа.
#
# Оба каталога объявлены томами: без этого они остаются в слое контейнера, и
# пересоздание контейнера уничтожало бы и базу с задачами, владением и аудитом,
# и загруженные документы.
RUN mkdir -p ./data ./uploads/documents \
 && chown -R node:node ./data ./uploads

VOLUME ["/app/data", "/app/uploads"]

# Приложению права root не нужны: оно слушает порт 3000 (непривилегированный) и
# пишет только в каталоги выше. Образ node предоставляет готового пользователя.
USER node

# Health check — must match the endpoint the app actually serves (/api/health,
# server.ts). The default callback-style get() never fails on a connection
# error, so failures are wired explicitly.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Use dumb-init to handle signals properly
ENTRYPOINT ["/sbin/dumb-init", "--"]

# Start application — esbuild emits dist/server.cjs (see package.json build),
# not dist/server.js.
CMD ["node", "dist/server.cjs"]

# Expose port
EXPOSE 3000

# Metadata
LABEL maintainer="SK-KIT Team"
LABEL description="SK-KIT Construction Control System - Production Image"
LABEL version="1.0.0"
