# SK-КИТ P0 Remediation Round 2

**Scope:** Persistence architecture, auth rotation, isolation proof. No new features, no UI, no
workflow, state-machine, authorization-matrix or H-2 changes.
**Method:** every claim below was reproduced or measured. Nothing is asserted from reading alone
unless marked as such.

---

## Executive Summary

Cross-tenant isolation was **proven by exploit, not assumed** — 29/29 attacks denied. The
persistence architecture is now unambiguous. The auth-rotation P1 from Round 1 was reproduced and
fixed. Three defects **not previously known** were found, all in files I authored in an earlier
session; two of them would have broken the Docker build and silently faked a successful migration.

One Round 1 figure was wrong and is corrected here: the codebase has **94** synchronous DB call
sites in application code, not 72. Round 1 counted only `server.ts` and missed the repositories.

---

## PHASE 1 — Canonical production database

Forensics, whole repo, excluding the separate `SK-KIT/` subrepo:

| Question | Measured answer |
|---|---|
| Storage implementations | **exactly one** — `src/server/database.ts` |
| Files importing `node:sqlite` or `pg` | **only** `src/server/database.ts` |
| Consumers of the storage module | `server.ts` + 6 repositories |
| Sync call sites (app code) | **94** — server.ts 72, construction 7, organizations 4, estimates 4, ksDocuments 3, aosr 3, financial 1 |
| Async (PostgreSQL) callers | **0** |
| App code reading the migrations dir | **none** |
| Migration `.sql` files in the root project | **0** (`src/server/db` does not exist here) |
| Migration `.sql` files in the `SK-KIT/` subrepo | 21, PostgreSQL-targeted |

### Actual runtime path

```
HTTP request
  ↓ server.ts (73 routes)
  ↓ requireAuth        — session token only, never client headers
  ↓ requireProjectAccess / equivalent inline check
  ↓ repositories (aosr, construction, estimates, financial, ksDocuments, organizations)
  ↓ src/server/database.ts  — synchronous API
  ↓ SQLite  data/skkit.db   — schema created in code by initSqlite()
     tables: (id, data, updated_at [, project_id])   key-value, JSON payload
```

### Dead branch

```
PostgreSQL implementation (initPostgres, pg Pool, db*Async family)
  ↓
0 callers — NOT CONNECTED TO RUNTIME

21 SQL migrations (relational schema, tenant_id columns, RLS policies)
  ↓
live in a different repository, never executed, describe tables that do not exist at runtime
```

The two schemas are not variants of each other:

```
migration 007 expects : users(id, legacy_id, tenant_id, name, email, role, status, ...)
live database has     : users(id, data, updated_at)
```

**CANONICAL PRODUCTION DATABASE: SQLite at `data/skkit.db`.**
This is not a preference — it is the only backend any code path reaches.

**Persistence across restart:** `bootstrapPersistence()` inserts missing seed rows, then
`reloadAllStoresFromDb()` (line 2263) makes the database authoritative over in-memory state.
Verified: restart preserves data.
**Backup/restore:** file-copy of the SQLite file with a WAL checkpoint before copy and WAL/SHM
cleanup on restore (both restored in Round 1). Covers the canonical DB correctly.

---

## PHASE 2 — DATABASE_URL: Variant B

Variant A requires a working PostgreSQL runtime. Measured evidence against it:

- 0 async callers; 94 sync call sites, each beginning `if (isPostgres) throw`
- migrations target a different schema, in a different repo, never applied
- no PostgreSQL runtime has ever served a request

**Decision: Variant B — `DATABASE_URL` is dead configuration.** It was added by me last session;
it is not part of the project's architecture.

Implemented: `initDatabase()` refuses to start when `DATABASE_URL` is set, naming the reason. The
system can no longer silently be "sometimes SQLite, sometimes PostgreSQL" — the ambiguous mode
does not boot.

### Requires you (I cannot touch these)

`.env`, `.env.example` and `.env.production.example` are blocked by this session's permission
settings — I can neither read nor write them. **You must remove the `DATABASE_URL` line from
`.env`**, or the app will refuse to start. This is the one blocking manual action.

---

## PHASE 3 — Isolation, proven by exploit

### Static audit

73 routes; 33 project-scoped. Three lacked `requireProjectAccess`:

```
L1164 POST /api/projects/:projectId/access-check
L1189 GET  /api/projects/:projectId/documents
L1211 GET  /api/projects/:projectId/defects
```

**All three were read, and all three enforce the check inline** — equivalent logic, different
shape. This was a false positive from pattern-matching, resolved by reading the code.

One real divergence: the inline checks admit `ADMIN` only and read `user.projectIds`, while the
shared helper admits `ADMIN` **and** `SUPER_ADMIN` and reads `allowedProjectIds || projectIds`.
A `SUPER_ADMIN` is therefore *denied* on those three routes. Fail-closed, so not a hole —
recorded as P2, not fixed (authorization matrix is out of scope).

### Exploit test — executed against a running server

`USER_A = tech@kit-sk.ru` (CONSTRUCTION_CONTROL; holds proj-1, proj-aeron; **not** proj-2).
Target `PROJECT_B = proj-2`. Every project-scoped endpoint, every verb:

```
29 attempts  ->  29 denied (403)  ->  0 leaks
```

Covering GET/POST/PATCH/PUT across defects, documents, inspections, estimates, estimate-items,
financial, aosr, ks-documents (incl. `advance`, `mark-paid`), schedule, members, ai-analysis,
access-check.

```
body-spoof   POST /api/projects/proj-1/defects  body{projectId: proj-2}
             -> 201, stored projectId = proj-1   URL WINS -- SAFE
header-spoof x-user-id / x-tenant-id on foreign project
             -> 403
```

**Application-level isolation is proven, not inferred.** Database-level isolation still does not
exist; that remains the standing architectural gap from Round 1.

### New finding — 9 unauthenticated endpoints

```
200 GET  /api/work-types                     200 POST /api/ai/chat
200 GET  /api/ai/resilience-status           200 POST /api/ai/analyze-document
200 GET  /api/ai/resilience-metrics          200 POST /api/ai/daily-report
200 POST /api/specifications/compare         200 POST /api/ovik/refrigerant-calc
200 POST /api/security/test-prompt-injection
```

I checked whether these leak stored data before classifying them. They do **not** — the AI
handlers take `projectContext` / `projectData` / `documents` from the request body and never read
the database. So this is **not** a cross-tenant data-exposure hole.

What it is: with a real Gemini key configured, `/api/ai/*` become **unauthenticated paid-LLM
endpoints** — cost abuse and billing DoS. `/api/ai/resilience-metrics` additionally discloses
internal circuit-breaker state and logs. Classified **P1**, not fixed — adding auth to these
routes changes the authorization matrix, which this round forbids.

---

## PHASE 4 — Auth rotation

**Reproduced.** `bootstrapPersistence()` ends with `reloadAllStoresFromDb()` (line 2263), which
wipes the freshly-seeded accounts and reloads the persisted ones — including their old password
hash. Seeding is therefore first-boot-wins, and an operator who lost the original bootstrap
password had no supported way back in. This is the same root cause as the "password keeps
changing / can't log in" trouble earlier in this project.

Measured, one run, same database:

```
1) fresh DB seeded with pass-ORIGINAL        login(ORIGINAL): 200
2) restart with pass-NEW, no rotate flag
     login(NEW) : 401     <- bug reproduced: new password rejected
     login(ORIG): 200     <- stale hash still wins
3) restart with SEED_USER_PASSWORD_ROTATE=true
     login(NEW) : 200     <- rotation works
     login(ORIG): 401     <- old password revoked
```

**Fix:** opt-in rotation via `SEED_USER_PASSWORD_ROTATE=true`. It resets **only** identities
defined as seed/demo accounts in source (captured into `SEED_ACCOUNT_IDS` before any persisted
state loads) — never an account created later through `/api/auth/register`, whose password belongs
to a real person. The password is never logged; only the affected ids are. The operator is warned
to unset the flag afterwards.

### Auth requirements from the brief — status

| Requirement (production) | Status |
|---|---|
| does not log the password | PASS (verified Round 1: no secret in captured stdout/stderr) |
| does not log the OTP | PASS — demo fixtures with OTP `123456` are non-production only |
| does not return password / hash via API | PASS — `stripPasswordHash` before every `res.json(user)` |
| no hardcoded production credential | PASS — `skkit2024` / `123456` gated to non-production |
| no unknown random password per restart | PASS — production refuses to boot without `SEED_USER_PASSWORD` |
| credential is retrievable / rotatable | **PASS (new this round)** — `SEED_USER_PASSWORD_ROTATE` |
| does not use dev credentials | PASS |

*(The brief was truncated mid-sentence at "SEED_USER_PASSWORD"; the row above is my reading of the
intended requirement. Tell me if you meant something more specific.)*

---

## New defects found this round (all in files I authored earlier)

**1 — Dockerfile could not build. P0 for deployment.**
```
COPY --from=builder /app/src/server/db ./src/server/db
```
That path does not exist in this project. The image build fails on this line, independently of
Docker being installed. Round 1 could not catch it because Docker is absent — but static
inspection would have, and did not. **Fixed:** COPY removed, with the reason recorded in the file.

**2 — `init-db.sh` reported success having applied nothing. P1.**
Its glob resolves to `src/server/db/migrations` — 0 files — and `ls ... 2>/dev/null` swallowed the
error, so the loop never ran and it printed *"All 0 migrations applied successfully."* False
confidence at precisely the moment the schema is missing. **Fixed:** refuses to report success
when no migration matches. Verified: guard fires on the missing dir, stays silent on the real
21-file dir.

**3 — Round 1 undercounted sync call sites.** 72 → **94**. Corrected above.

---

## Verification

```
TSC (backend)  : 0 errors
TSC (frontend) : ~60 errors -- pre-existing, unchanged, do not block build
BUILD          : PASS (dist/server.cjs)
test:security  : 37/37 PASS
test:e2e       : 25/25 PASS
cross-project  : 29/29 denied
body spoof     : SAFE
rotation       : bug reproduced, fix proven
DOCKER         : NOT VERIFIED -- Docker is not installed on this machine
```

## AERON data

**NOT PRESENT in this workspace** — unchanged from Round 1. `e12b337d-92b3-4185-a0ee-8e1a37f0cf0e`
and the two H-2 defects do not exist in `data/skkit.db` or in the `SK-KIT/` JSON store. No
imitation was created and nothing here should be read as verifying AERON. Its integrity must be
checked wherever the pilot data actually lives. All testing this round ran in throwaway clean-room
directories; the local DB was never written to.

---

## Remaining blockers

**P0**
1. `DATABASE_URL` must be removed from `.env` — I cannot edit it. App will not start until then.
2. Frontend TypeScript (~60 errors) — `npm run lint` fails, so CI cannot gate on types.
3. No database-level isolation. Application-level is proven sound today, but a single missed guard
   on a future endpoint has no backstop.

**P1**
4. 9 unauthenticated endpoints; `/api/ai/*` become paid-LLM endpoints once a key is configured.
5. Docker image still never built (no Docker here). Entrypoint, healthcheck and COPY paths are now
   correct by inspection; the image itself remains unproven.
6. Container runs as root.
7. `/api/health` is liveness-only — must not gate readiness.

**P2**
8. Three routes enforce project access inline rather than via the shared helper, and diverge on
   `SUPER_ADMIN`. Fail-closed; left alone deliberately.

## Out of scope, untouched

Business logic, state machine, H-1, H-2 evidence authorization, authorization matrix, RLS policy
definitions, audit semantics, document storage, financial logic, GenAI logic, frontend, legacy
routes, existing test data. No PostgreSQL migration was performed. No RLS was implemented.

## Final status

# P0 PARTIALLY CLEARED

Cleared this round: persistence architecture is unambiguous and documented; `DATABASE_URL`
ambiguity cannot boot; cross-tenant isolation proven by exploit; auth rotation fixed and proven;
Docker build unblocked; migration script no longer fakes success.

Not cleared: the `.env` edit (yours to make), frontend TypeScript, absence of database-level
isolation, unauthenticated AI endpoints, unverified Docker image.
