# SK-КИТ — ОБЯЗАТЕЛЬНЫЙ РАБОЧИЙ РЕГЛАМЕНТ

> Этот регламент имеет приоритет над разделом «Ruflo» ниже при любом противоречии.

## 1. ЯЗЫК ОБЩЕНИЯ

Отвечать пользователю исключительно на русском: ход работы, анализ, планы, объяснения, отчёты,
выводы, предупреждения, рекомендации, итоговые статусы. Промежуточные сообщения — тоже на русском
(«Проверяю…», «Анализирую…», «Найдено…», «Исправляю…»), не «Let me check…», «Found…», «Done…».

Английский допустим только для технических сущностей: имена файлов, пути, функции, классы,
переменные, npm-пакеты, команды, URL, API endpoints, HTTP methods, SQL, JSON, код на
TypeScript/JavaScript/Bash/PowerShell, дословные сообщения компилятора и runtime.

## 2. ОСНОВНОЙ ПРИНЦИП

```
СНАЧАЛА ДОКАЗАТЬ → ПОТОМ ИЗМЕНИТЬ → ПОТОМ ПРОВЕРИТЬ
```

Нельзя исправлять предполагаемую проблему до установления её фактической причины. Нельзя объявлять
проблему решённой потому, что код выглядит правильным.

Каждое существенное утверждение маркировать статусом:
`ПОДТВЕРЖДЕНО` · `ПОДТВЕРЖДЕНО ЧАСТИЧНО` · `НЕ ПРОВЕРЕНО` · `ЛОЖНОЕ СРАБАТЫВАНИЕ` · `ПРЕДПОЛОЖЕНИЕ`

## 3. НЕ ДОДУМЫВАТЬ АРХИТЕКТУРУ

Никогда не предполагать, какая БД является production, какой проект основным, какой файл
актуальным, какой API каноническим. Не считать, что PostgreSQL используется потому, что существует
migration; что SQLite используется потому, что есть файл БД; что тестовая инфраструктура существует
потому, что упомянута в старом отчёте; что Docker работает потому, что есть `Dockerfile`.

Сначала — repository forensics. Если фактическое состояние противоречит предыдущему отчёту:
указать противоречие → проверить факт → использовать фактическое состояние → не сохранять старый
вывод ради согласованности.

## 4. НЕ ДЕЛАТЬ «ЦЕРЕМОНИАЛЬНЫЕ» ИСПРАВЛЕНИЯ

Не внедрять технологию ради закрытия пункта аудита. Если runtime использует SQLite, а PostgreSQL
migrations — неиспользуемый код, нельзя внедрять RLS только потому, что аудитор увидел его
отсутствие. Сначала установить, какая БД реально используется, затем определять модель изоляции.

## 5. APPLICATION SECURITY

Для каждого защищённого endpoint проверять цепочку:

```
Authentication → Tenant determination → Project access → Object access
→ Role authorization → Business rule → Database operation
```

Особое внимание: IDOR, cross-project access, cross-tenant access, body spoofing, header spoofing,
подмена userId / responsibleUserId / projectId / tenantId / role.

Данные из HTTP body и header никогда не считать доверенными. Идентичность пользователя определяется
только серверной сессией.

## 6. FAIL-CLOSED

Нет подтверждённого права → отказ. Если невозможно определить tenant, project, user, role или
ownership — доступ запрещён. Не использовать fallback, расширяющий доступ.

## 7. STATE MACHINE

Канонический workflow:

```
OPEN → ASSIGNED → IN_PROGRESS → RESOLVED → VERIFIED
```

`REJECTED` — только по существующим правилам проекта. Не добавлять состояния, не менять переходы без
прямого указания пользователя. Нельзя обходить authorization через альтернативный endpoint: все
endpoint, меняющие состояние, обязаны соблюдать одну бизнес-логику.

## 8. VERIFIED — ФИНАЛЬНОЕ СОСТОЯНИЕ

После `VERIFIED` изменения запрещены, в том числе для административных ролей. Любое исключение —
только по явному согласованию с пользователем и с документированием.

## 9. EVIDENCE

- **OPEN** — проектный участник может добавить evidence, кроме `FINANCE`.
- **ASSIGNED / IN_PROGRESS / RESOLVED** — только `responsibleUserId`, `CONSTRUCTION_CONTROL`,
  `CHIEF_ENGINEER`, `SUPER_ADMIN`. Остальным — отказ.
- **VERIFIED** — добавление evidence запрещено всем.

Не ослаблять эту модель без прямого указания.

## 10. AERON

AERON — реальный пилотный объект. Нельзя удалять реальные данные, менять реальные дефекты,
переводить их между состояниями, менять evidence, history, resolutionNotes, использовать AERON для
destructive security tests.

Для security tests создавать изолированные `TENANT_TEST_A/B`, `PROJECT_TEST_A/B`.

Если данные AERON отсутствуют в workspace — писать прямо: «Данные AERON в текущем workspace
отсутствуют. Проверка целостности AERON не выполнена». Не создавать искусственные данные и не
выдавать их за реальные.

## 11. ТЕСТЫ

Не считать тесты существующими на основании старых отчётов. Сначала установить фактическую
инфраструктуру: runner, scripts, БД, credentials, нужен ли запущенный сервер, создаются ли и
очищаются ли тестовые данные. Для security testing предпочтителен clean-room.

## 12. CLEAN-ROOM

```
РЕАЛЬНАЯ БД → НЕ ТРОГАТЬ
CLEAN-ROOM БД → SECURITY TESTS → DISCARD
```

После тестирования проверить, что реальные данные не изменились.

## 13. AUTHENTICATION

Production не должна содержать: hardcoded password, hardcoded OTP, password или OTP в логах,
password или password hash в API response, случайно генерируемый неизвестный пользователю
production password.

Development fallback допустим, только если невозможен в production, явно отделён от него и не
создаёт credential leakage.

Любая ротация credential проверяется фактическим тестом: `OLD PASSWORD → rejected`,
`NEW PASSWORD → accepted`.

## 14. СЕКРЕТЫ

Никогда не выводить пользователю реальные пароли, API keys, tokens, session secrets, private keys,
database credentials. При обнаружении секрета в логах: зафиксировать факт → устранить утечку →
проверить repository и `.git` → не публиковать сам секрет. Использовать `[SECRET REDACTED]`.

## 15. DATABASE

Всегда различать «код БД» и «фактически используемую БД». Перед изменением архитектуры определить:
runtime driver, canonical schema, persistence path, startup initialization, migrations, backup,
restore, restart persistence.

Нельзя оставлять две взаимоисключающие production-модели БД без явного архитектурного решения.

## 16. ENVIRONMENT

Не считать `.env` автоматически доступным. Если файл недоступен из-за permissions — сказать об этом
прямо, не утверждать, что переменная удалена или configuration исправлена. Обозначить
`MANUAL ACTION REQUIRED` и дать точное действие.

## 17. DOCKER

Не утверждать «Docker работает», если Docker не запускался. Разделять: Dockerfile static
verification · Docker build verification · Container startup verification · Healthcheck
verification · SIGTERM verification. Если Docker отсутствует — `Docker runtime verification: НЕ ПРОВЕРЕНО`.

## 18. HEALTH И READINESS

Различать liveness и readiness. Не называть liveness endpoint readiness endpoint без проверки. Если
orchestration требует readiness — сначала определить deployment target, затем внедрять минимально
необходимое.

## 19. TYPESCRIPT

Запрещено «исправлять» ошибки отключением strict mode, `skipLibCheck`, массовым `any`, массовым
`@ts-ignore`, удалением проверок или функциональности.

Классифицировать каждую группу: production blocker · real runtime bug · development quality issue ·
dead/unused code · technical debt. Production build и `tsc` — разные проверки, не смешивать.

## 20. BUILD

```
TypeScript → Build → Artifact → Boot artifact → Health → SIGTERM
```

Не считать build успешным по наличию output directory. Проверять, что существует и запускается
именно тот artifact, который указан в production CMD.

## 21. SQL И DATA ACCESS

Никогда не подставлять пользовательские данные через небезопасную string interpolation — SQL, file
paths, shell commands, HTML, URL. Для SQL — parameterized queries. После security fix — exploit
regression test.

## 22. ИЗМЕНЕНИЕ КОДА

До: найти фактический код → понять вызывающий путь → понять существующие тесты → определить
минимальное место исправления.
После: проверить diff → TypeScript → build → security behavior → regression.
Не переписывать большие файлы без необходимости.

## 23. НЕ РАСШИРЯТЬ SCOPE

Задача «исправить P0» не даёт права переходить к новым функциям, UI redesign, новой архитектуре,
cloud migration, PostgreSQL migration, AI features, BIM, CRM, analytics, performance optimization.

Проблема вне scope фиксируется как: `ОБНАРУЖЕНО / НЕ ИСПРАВЛЯЛОСЬ — ВНЕ ТЕКУЩЕГО SCOPE`.

## 24. CHANGE SCOPE

После работы обязательно: `git status`, `git diff --stat`, `git diff`. В отчёте указать: файл,
изменение, причина. Не создавать лишние и временные файлы в repository; удалять созданные тестовые
артефакты, если они не являются частью проекта.

## 25. ОТЧЁТ

Структура: 1 Цель · 2 Что проверено · 3 Что обнаружено · 4 Что исправлено · 5 Что подтверждено ·
6 Что не подтверждено · 7 Тесты · 8 Изменённые файлы · 9 Оставшиеся blockers · 10 Текущий статус ·
11 Один следующий шаг.

## 26. СТАТУСЫ

`ГОТОВО` — требование реально проверено. `ЧАСТИЧНО ГОТОВО` — подтверждена часть.
`НЕ ПРОВЕРЕНО` — проверку выполнить не удалось. `БЛОКЕР` — препятствует требуемой готовности.
`ВНЕ SCOPE` — проблема существует, но не относится к задаче.

## 27. НЕЛЬЗЯ ПОДМЕНЯТЬ ПРОВЕРКУ ЗАЯВЛЕНИЕМ

Запрещено: «код выглядит правильно → значит работает».
Правильно: код изменён → тест → фактический результат → вывод.

## 28. ЕСЛИ ПРОВЕРКА НЕВОЗМОЖНА

Не симулировать результат и не писать `verified`. Писать прямо: «Проверка не выполнена: Docker
недоступен», «Проверка не выполнена: production database отсутствует в текущем workspace».

## 29. ПЕРЕД КАЖДЫМ ИСПРАВЛЕНИЕМ

1. Это действительно ошибка? 2. Я доказал причину? 3. Это входит в текущий scope?
4. Как я докажу после исправления, что ошибка устранена?
Нет ответа на любой вопрос — сначала проверка.

## 30. ФИНАЛЬНЫЙ ОТВЕТ ПОЛЬЗОВАТЕЛЮ

На русском, кратко: что сделал → что подтверждено → что осталось → текущий статус → один следующий
шаг. Не заканчивать списком альтернативных «следующих шагов» — всегда ровно один, если пользователь
не запросил несколько.

## 31. ОСНОВНОЙ ПРИНЦИП SK-КИТ

```
Доказательство → Факт → Дефект → Причина → Нормативное основание → Финансовый эффект
→ Сроковой эффект → Ответственный → Устранение → Проверка → История
```

Без доказательства нельзя выдавать предположение за факт. Без проверки нельзя выдавать устранение за
подтверждённое устранение. Без истории изменение не считается контролируемым.

## 32. ГЛАВНОЕ ПРАВИЛО

**НЕ УГОДИТЬ ПОЛЬЗОВАТЕЛЮ — А ДАТЬ ФАКТИЧЕСКИ ВЕРНЫЙ РЕЗУЛЬТАТ.**

Если запрос противоречит фактическому состоянию repository: показать противоречие → привести
доказательство → предложить минимальное исправление → не скрывать проблему ради статуса GO.

Приоритет:

```
ФАКТ > БЕЗОПАСНОСТЬ > СОХРАННОСТЬ ДАННЫХ > КОРРЕКТНОСТЬ > ТЕСТИРУЕМОСТЬ
> МИНИМАЛЬНОСТЬ ИЗМЕНЕНИЙ > СКОРОСТЬ
```

---

# Ruflo — Claude Code Configuration

## Rules

- Do what has been asked; nothing more, nothing less
- NEVER create files unless absolutely necessary — prefer editing existing files
- NEVER create documentation files unless explicitly requested
- NEVER save working files or tests to root — use `/src`, `/tests`, `/docs`, `/config`, `/scripts`
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files
- NEVER add a `Co-Authored-By` trailer to user commits unless this project's `.claude/settings.json` has `attribution.commit` set (#2078). The Claude Code Bash tool may suggest one in its default commit-message template — ignore it. `Co-Authored-By` is semantic authorship attribution under git/GitHub convention; the tool is the facilitator, not a co-author.
- Keep files under 500 lines
- Validate input at system boundaries

## Ruflo Capability Brain & Implementation Loop

Ruflo is the coordination ledger and policy decision point. Claude Code is the
executor: after a Ruflo coordination call, continue implementing the task.

When it is registered, call
`guidance_brain({ mode: "recommend", task: "..." })` before complex Ruflo
work. Use its live registry instead of guessing tool names. Treat
`registered`, `configured`, `reachable`, `healthy`, and `authorized`
as separate facts. If the brain is unavailable, continue with the compatible
`guidance_recommend` tool, CLI discovery, and repository instructions.

Follow the returned loop:

1. Recall memory and ADR constraints.
2. Inspect source, runtime, dependencies, policy, and health.
3. Route to the smallest capable topology, agents, skills, and tools.
4. Plan acceptance criteria, safety envelope, ownership, and validation.
5. Execute in isolated scopes; the coding agent performs the work.
6. Test focused, regression, and failure paths.
7. Validate types, security, policy, compatibility, and artifacts.
8. Benchmark a source-bound candidate against a source-bound baseline.
9. Optimize measured bottlenecks without weakening safety.
10. Bind claims and evidence to exact source/build receipts.
11. Reconcile concurrent handoffs and disclose limitations.
12. Publish only through a separately authorized release gate.

### Concurrency and authority

- Never allow two writers in one worktree; give each writing agent an isolated
  worktree and explicit file ownership.
- Read-only research may run concurrently and report findings to the owner.
- Only the integration owner edits shared manifests and lockfiles or reconciles
  overlapping changes.
- A child may drop capabilities but cannot add tools, network, secrets, spend,
  concurrency, namespaces, or delegation depth.
- A lease or claim coordinates ownership; it does not authorize a side effect.
- Darwin, Flywheel, MetaHarness, memory, and neural systems may propose or
  evaluate candidates but cannot self-promote or expand their SafetyEnvelope.
- Bind tests, benchmarks, policy decisions, and release evidence to an exact
  commit or immutable dirty-worktree snapshot.

## Agent Comms (SendMessage-First Coordination)

Named agents coordinate via `SendMessage`, not polling or shared state.

```
Lead (you) ←→ architect ←→ developer ←→ tester ←→ reviewer
              (named agents message each other directly)
```

### Spawning a Coordinated Team

```javascript
// ALL agents in ONE message, each knows WHO to message next
Agent({ prompt: "Research the codebase. SendMessage findings to 'architect'.",
  subagent_type: "researcher", name: "researcher", run_in_background: true })
Agent({ prompt: "Wait for 'researcher'. Design solution. SendMessage to 'coder'.",
  subagent_type: "system-architect", name: "architect", run_in_background: true })
Agent({ prompt: "Wait for 'architect'. Implement it. SendMessage to 'tester'.",
  subagent_type: "coder", name: "coder", run_in_background: true })
Agent({ prompt: "Wait for 'coder'. Write tests. SendMessage results to 'reviewer'.",
  subagent_type: "tester", name: "tester", run_in_background: true })
Agent({ prompt: "Wait for 'tester'. Review code quality and security.",
  subagent_type: "reviewer", name: "reviewer", run_in_background: true })

// Kick off the pipeline
SendMessage({ to: "researcher", summary: "Start", message: "[task context]" })
```

### Patterns

| Pattern | Flow | Use When |
|---------|------|----------|
| **Pipeline** | A → B → C → D | Sequential dependencies (feature dev) |
| **Fan-out** | Lead → A, B, C → Lead | Independent parallel work (research) |
| **Supervisor** | Lead ↔ workers | Ongoing coordination (complex refactor) |

### Rules

- ALWAYS name agents — `name: "role"` makes them addressable
- ALWAYS include comms instructions in prompts — who to message, what to send
- Spawn ALL agents in ONE message with `run_in_background: true`
- After spawning, continue independent local work; wait only when a dependency
  genuinely blocks progress
- Do not poll repeatedly — agents message back or complete automatically
- Give every writing agent an isolated worktree and a non-overlapping file scope

## Swarm & Routing

### Config
- **Topology**: hierarchical-mesh (anti-drift)
- **Max Agents**: 15
- **Memory**: hybrid
- **HNSW**: Enabled
- **Neural**: Enabled

```bash
npx @claude-flow/cli@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized
```

### Agent Routing

| Task | Agents | Topology |
|------|--------|----------|
| Bug Fix | researcher, coder, tester | hierarchical |
| Feature | architect, coder, tester, reviewer | hierarchical |
| Refactor | architect, coder, reviewer | hierarchical |
| Performance | perf-engineer, coder | hierarchical |
| Security | security-architect, auditor | hierarchical |

### When to Swarm
- **YES**: 3+ files, new features, cross-module refactoring, API changes, security, performance
- **NO**: single file edits, 1-2 line fixes, docs updates, config changes, questions

### 3-Tier Model Routing

| Tier | Handler | Use Cases |
|------|---------|-----------|
| 1 | Agent Booster (WASM) | Simple transforms — skip LLM, use Edit directly |
| 2 | Haiku | Simple tasks, low complexity |
| 3 | Sonnet/Opus | Architecture, security, complex reasoning |

## Memory & Learning

### Before Any Task
```bash
npx @claude-flow/cli@latest memory search --query "[task keywords]" --namespace patterns
npx @claude-flow/cli@latest hooks route --task "[task description]"
```

### After Success
```bash
npx @claude-flow/cli@latest memory store --namespace patterns --key "[name]" --value "[what worked]"
npx @claude-flow/cli@latest hooks post-task --task-id "[id]" --success true --store-results true
```

### MCP Tools (use `ToolSearch("keyword")` to discover)

| Category | Key Tools |
|----------|-----------|
| **Memory** | `memory_store`, `memory_search`, `memory_search_unified` |
| **Bridge** | `memory_import_claude`, `memory_bridge_status` |
| **Swarm** | `swarm_init`, `swarm_status`, `swarm_health` |
| **Agents** | `agent_spawn`, `agent_list`, `agent_status` |
| **Hooks** | `hooks_route`, `hooks_post-task`, `hooks_worker-dispatch` |
| **Security** | `aidefence_scan`, `aidefence_is_safe`, `aidefence_has_pii` |
| **Hive-Mind** | `hive-mind_init`, `hive-mind_consensus`, `hive-mind_spawn` |

### Background Workers

| Worker | When |
|--------|------|
| `audit` | After security changes |
| `optimize` | After performance work |
| `testgaps` | After adding features |
| `map` | Every 5+ file changes |
| `document` | After API changes |

```bash
npx @claude-flow/cli@latest hooks worker dispatch --trigger audit
```

## Agents

**Core**: `coder`, `reviewer`, `tester`, `planner`, `researcher`
**Architecture**: `system-architect`, `backend-dev`, `mobile-dev`
**Security**: `security-architect`, `security-auditor`
**Performance**: `performance-engineer`, `perf-analyzer`
**Coordination**: `hierarchical-coordinator`, `mesh-coordinator`, `adaptive-coordinator`
**GitHub**: `pr-manager`, `code-review-swarm`, `issue-tracker`, `release-manager`

Any string works as a custom agent type.

## Build & Test

- ALWAYS run tests after code changes
- ALWAYS verify build succeeds before committing

```bash
npm run build && npm test
```

## CLI Quick Reference

```bash
npx @claude-flow/cli@latest init --wizard           # Setup
npx @claude-flow/cli@latest swarm init --v3-mode     # Start swarm
npx @claude-flow/cli@latest memory search --query "" # Vector search
npx @claude-flow/cli@latest hooks route --task ""    # Route to agent
npx @claude-flow/cli@latest doctor --fix             # Diagnostics
npx @claude-flow/cli@latest security scan            # Security scan
npx @claude-flow/cli@latest performance benchmark    # Benchmarks
```

26 commands, 140+ subcommands. Use `--help` on any command for details.

## Setup

```bash
claude mcp add claude-flow -- npx -y ruflo@latest mcp start
npx ruflo@latest doctor --fix
```

> The background `daemon` is optional. It runs interval workers that each spawn
> a headless `claude` session, so it consumes tokens continuously. Start it only
> if you want those sweeps: `npx ruflo@latest daemon start` (self-stops after 12h
> by default; `--ttl 0` to disable, `daemon status --all` to audit running daemons).

**Agent tool** handles execution (agents, files, code, git). **MCP tools** handle coordination (swarm, memory, hooks). **CLI** is the same via Bash.
