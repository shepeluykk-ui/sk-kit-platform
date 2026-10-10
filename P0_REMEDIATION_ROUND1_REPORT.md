# SK-КИТ P0 Remediation Round 1

**Date:** 2026-09-15
**Scope:** Fix only the P0/P1 items listed in the remediation brief. No refactoring, no business-logic changes.
**Method:** REPRODUCE → PROVE → FIX → VERIFY. Claims from the prior audit were re-tested, not assumed.

---

## Executive Summary

Two of the prior audit's findings were confirmed, one was **misdiagnosed**, and the most severe
defect in the codebase **was not in the audit at all** — it was introduced by my own PostgreSQL
rewrite in the previous session and had left the application unable to boot.

| # | Prior audit claim | Verdict after testing |
|---|---|---|
| 1 | TypeScript compilation FAIL | **CONFIRMED** — backend now 0 errors; frontend errors remain (pre-existing, non-blocking) |
| 2 | Hardcoded `skkit2024` → auth bypass | **CONFIRMED, but wrong mechanism.** Direct login is blocked; the real path is OTP activation. Exploit proven, then fixed |
| 3 | RLS defined but not enforced → cross-tenant access possible | **MISDIAGNOSED.** See "RLS" below. Isolation is application-level and passes 37/37 security tests |
| 4 | Docker entrypoint mismatch | **CONFIRMED** — fixed and verified by booting the built artifact |
| 5 | Docker healthcheck mismatch | **CONFIRMED** — fixed and verified (HTTP 200) |
| 6 | Duplicate project / package manager | **CONFIRMED but benign** — they are two *different applications*, not duplicates |
| — | *(not in audit)* SQLite layer used a non-existent API | **NEW P0** — server could not boot. Fixed |
| — | *(not in audit)* SQL injection in `dbUpsert`/`dbDelete` | **NEW P0** — fixed |

**Test suite on a clean database: 62/62 PASS** (37/37 security, 25/25 e2e).

---

## Baseline

```
Git root (main app)   : D:/SK-KIT              <- PRODUCTION TARGET
Git root (nested)     : D:/SK-KIT/SK-KIT       <- separate repo, different application
Branch                : master
package.json          : D:/SK-KIT/package.json (npm; bun.lock also present but unused)
Entry point           : server.ts -> dist/server.cjs
Build                 : vite build && esbuild server.ts --outfile=dist/server.cjs
Migrations            : SK-KIT/src/server/db/migrations/*.sql (001-020) -- NOT APPLIED, see RLS
Live schema           : created at runtime by initSqlite() in src/server/database.ts
```

`SK-KIT/` is **not** a duplicate. Its persistence model is
`tenants, evidence_nodes, claims, contradictions, risks, causal_links` — the "Risk Intelligence"
application. The root project is the construction-control application
(`defects, inspections, aosr, estimates`). They share a name and nothing else.

---

## Changes Made

| File | Change |
|---|---|
| `src/server/database.ts` | Restored correct `node:sqlite` API; restored parameterized queries; restored WAL checkpoint on backup; restored WAL/SHM cleanup on restore; restored `updatedAt` in read results; `DATABASE_URL` now fails fast |
| `server.ts` | Demo registration fixtures gated behind non-production; production refuses to boot without `SEED_USER_PASSWORD`; removed duplicate `bootstrapPersistence()` call I had added |
| `Dockerfile` | `CMD` → `dist/server.cjs`; `HEALTHCHECK` → `/api/health` with real failure propagation |

No changes to: business logic, state machine, H-1/H-2, RBAC semantics, RLS policies, audit
semantics, document storage, financial logic, GenAI, frontend, or any test data.

---

## TypeScript

**Before:** 80+ errors, 23 of them in production code (`server.ts`, `src/server/`).
**After:** **0 errors in production code.**

```
npx tsc --noEmit | grep -E "server\.ts|src/server/"   ->  (empty)
```

Remaining ~60 errors are all in `src/components/*` and `SK-KIT/vite.config.ts`. They are
**pre-existing**, unrelated to this round, and do **not** block the build — `vite build`
succeeds and `esbuild` bundles without typechecking. Fixing them is real work but is a
separate task; I did not disable strictness or add `skipLibCheck` to hide them.

---

## Build

**Before / After:** PASS both. Confirmed actual artifact name rather than assuming:

```
dist/server.cjs      356.2kb
dist/server.cjs.map  633.3kb
```

---

## NEW P0 — SQLite layer was non-functional (not found by the prior audit)

My previous-session rewrite of `database.ts` replaced `node:sqlite`'s API with a
**`sql.js`-style API that does not exist**:

```js
// proven at runtime:
has step: undefined      has all: function
has getAsObject: undefined      has get: function
has free: undefined      has run: function
```

Every read path (`dbExists`, `dbLoadAll`, `dbLoadByProject`, `dbCount`) called `stmt.step()`.
Because `bootstrapPersistence()` calls these at module load, **the server threw before it could
listen.** This is the actual cause of the failed restart earlier in the session.

The same rewrite had also replaced parameterized queries with string interpolation:

```js
VALUES ('${id}', '${JSON.stringify(data).replace(/'/g, "''")}', ...)   // SQL injection
```

**Fixed.** Verified by runtime smoke test — quotes round-trip intact and an injection payload is
stored as inert data:

```
roundtrip name       : O'Brien "quote" test
injection-safe note  : '; DROP TABLE work_types; --
table still alive    : 5 rows
```

Two further regressions from that rewrite were also restored: the **WAL checkpoint** before
backup (without it a backup can omit committed transactions) and the **WAL/SHM sidecar cleanup**
on restore (without it a restore reads stale data).

---

## Authentication

**Finding — PROVEN, but not by the mechanism the audit described.**

The audit said the hardcoded `skkit2024` accounts allow direct login. They do not — `/api/auth/login`
returns 403 for any non-`ACTIVE` registration request before reaching the password check.

The real chain is OTP activation:

1. `reg-002` is seeded `APPROVED` with `otpExpiresAt = Date.now() + 600000`, evaluated **at module
   load**, so it re-arms on every boot against an empty database.
2. Its OTP and password are public in the repository. Verified against the live DB:
   ```
   OTP IS 123456        : true
   PASSWORD IS skkit2024: true
   role on activation   : CONSTRUCTION_CONTROL
   ```
3. Activation mints an `ACTIVE` user whose `projectIds` include **`proj-aeron`** (server.ts:1071).

So on a **fresh production deployment**, anyone who had read the source had a 10-minute window
to obtain `CONSTRUCTION_CONTROL` access to the real pilot project.

**Fix:** demo fixtures are seeded only when `NODE_ENV !== 'production'` — the same convention the
codebase already uses for `devOtp` (server.ts:839, 955). Production additionally refuses to start
without an explicit `SEED_USER_PASSWORD` rather than generating one and printing it to logs.

**Verified at runtime:**
```
production without secret     -> refused to boot -- PASS
secret printed to logs        -> NO -- PASS
bootstrap-print emitted       -> NO -- PASS
```

**Residual risk (data, not code):** gating prevents *new* seeding. A database already containing
`reg-001`/`reg-002` from a dev boot keeps them. The local dev DB has 2 such rows. I did not delete
them, per the brief. They must not be promoted to production.

---

## RLS — prior audit claim was misdiagnosed

The audit concluded: *"RLS policies exist but are never triggered → cross-tenant data access is
possible."* That is **not what is happening.**

The migrations and the running system use **two disjoint data models**:

```
Migration 007 expects : users(id, legacy_id, tenant_id, name, email, ...)   -- PostgreSQL, RLS
Live database has     : users(id, data, updated_at)                          -- key-value
```

The migrations have **never been applied**. They target PostgreSQL, which the application cannot
use (see below). The RLS policies in 017/019 apply to tables that **do not exist at runtime**.
So there is no RLS to "trigger" — not because enforcement was forgotten, but because that entire
backend is inactive.

Actual isolation is enforced in application code from the server-side session
(`requireProjectAccess`, server.ts:450), never from client headers. That mechanism is **tested and
green** — the security suite includes precisely the checks the audit doubted:

```
PASS  wrong project: пользователь без доступа к proj-2 получает 403
PASS  tenant isolation: аудит-лог без явного projectId не содержит записей чужого проекта
PASS  fake x-user-id: подмена личности поверх ЧУЖОГО валидного токена игнорируется
PASS  estimate item: projectId in request body cannot override the URL-derived tenant check
```

**No RLS code was written.** Injecting `SET LOCAL app.current_tenant_id` would have been
ceremony over a database the app never opens. The correct statement of the gap is:
*database-level defence-in-depth does not exist; isolation rests entirely on the application layer.*

---

## PostgreSQL backend is unwired (new finding)

```
sync db call sites in server.ts : 72  (dbUpsert 31, dbCount 17, dbExists 14, dbLoadAll 7, dbDelete 3)
callers of the *Async variants  : 0
```

Every sync function begins `if (isPostgres) throw new Error('Use ...Async for PostgreSQL')`.
Setting `DATABASE_URL` therefore produced a server that booted and then threw on its first
database touch. `initDatabase()` now **refuses to start with a clear message** instead, turning a
silent catastrophic misconfiguration into an explicit one.

**Action required from you:** the `.env` in this repo currently sets `DATABASE_URL` (I added it
last session). It must be removed or blanked, or the app will not start.

---

## Docker

**Before:** `CMD ["node", "dist/server.js"]` — file never produced; container would crash-loop.
**After:** `CMD ["node", "dist/server.cjs"]`.

Verified by actually running the built artifact: boots, serves, and exits cleanly on `SIGTERM`.

**`docker build` / `docker run`: NOT VERIFIED — Docker is not installed on this machine.**
The `docker` binary is absent from PATH and from all standard install locations. Image-level
concerns from the earlier audit (non-root user, dev dependencies in runtime, `.env` exclusion)
remain **unverified**, and were out of scope for this round.

---

## Healthcheck

**Before:** probed `/health`; the app serves `/api/health`. Additionally the callback form used
never failed on a connection error, so the probe could pass while the server was down.
**After:** probes `/api/health` and propagates both non-200 and connection errors.

**Verified:** `HTTP 200 {"status":"ok","service":"Строительный Контроль API",...}`

**Quality note (Phase 9):** `/api/health` is **liveness only** — it returns a static payload and
does not check the database. It must not be used as a readiness gate. I did not add a readiness
endpoint; that is a deliberate scope decision, not an oversight.

---

## Test Suite

Vitest is **not installed** and is not used by this project — the audit's `npx vitest run`
premise was wrong. The real suites are two `tsx` scripts.

| Run | security | e2e |
|---|---|---|
| Against the existing dev DB | 18/37 | 0/25 |
| Against a clean database | **37/37 PASS** | **25/25 PASS** |

The dev-DB failures were **all** `Неверный пароль`, and are an environment artifact, not product
defects: seed users are only given a hash `if (!passwordHash)`, so once the DB has been seeded
with a random bootstrap password, setting `SEED_USER_PASSWORD` afterwards has no effect — the
persisted hash wins. **This is the "password keeps changing / cannot log in" problem from earlier
in this session.**

The clean-database run also serves as the Phase 6 clean-DB test for the schema actually in use:
bootstrap from empty → PASS.

---

## AERON Data Integrity

```
defect e12b337d-92b3-4185-a0ee-8e1a37f0cf0e : NOT PRESENT in this workspace
H-2 defects 900f38c5... / 67afb120...       : NOT PRESENT in this workspace
```

Searched `data/skkit.db` (all tables) and `SK-KIT/data/sk_kit_persistent_db.json`. The local DB
holds 3 demo defects (`def-001`, `def-002`, `def-1`).

**Status: UNCHANGED — but vacuously.** The real pilot data is not in this environment, so its
integrity could not be verified here. It must be checked wherever it actually lives.
All test execution was done in a separate clean-room directory; the local DB row counts are
unchanged (users 12, projects 4, defects 3, requests 2); `audit_log` grew 28 → 73 purely from
my verification boots.

---

## Remaining P0

1. **Frontend TypeScript errors (~60)** — `src/components/*`. Pre-existing; do not block the
   build, but `npm run lint` fails, so CI cannot gate on types.
2. **Database-level tenant isolation does not exist.** Isolation is application-layer only. A
   single missing `requireProjectAccess` call in any future endpoint has no backstop. (Not
   introduced by this round; a design gap to plan for.)

## Remaining P1

3. **Docker image never built or run** — no Docker on this machine. Entrypoint/healthcheck are
   correct by inspection and by running the artifact directly, but the image itself is unproven.
4. **Container runs as root**, and the runtime stage copies `src/server/db` (unused migrations).
   Not addressed — out of scope for this round.
5. **`/api/health` is liveness-only** and must not be wired to a readiness/traffic gate.
6. **Seed-password rotation is impossible once persisted** — changing `SEED_USER_PASSWORD` has no
   effect on already-seeded users. Operationally significant for the pilot.

## Out of Scope (untouched, by instruction)

Business logic, state machine, H-1, H-2 evidence authorization, RBAC semantics, RLS policy
definitions, audit semantics, document storage, financial logic, GenAI, frontend, legacy routes,
existing test data.

---

## Final Status

# P0 PARTIALLY CLEARED

Cleared: backend TypeScript, the SQLite runtime breakage, SQL injection, backup/restore
correctness, the proven authentication exploit, Docker entrypoint, Docker healthcheck.

Not cleared: frontend TypeScript, Docker image verification, absence of database-level isolation.

No cloud deployment. The one blocking action is below.
