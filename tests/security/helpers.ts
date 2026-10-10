// Minimal, dependency-free test harness for real HTTP security tests against
// a running СК-КИТ backend. No mocking — every check is a genuine fetch()
// against BASE_URL. Run with: npm run test:security (server must be running).

export const BASE_URL = process.env.SKKIT_TEST_BASE_URL || 'http://localhost:3000';

// Shared bootstrap password for seed/demo accounts, from .env / SEED_USER_PASSWORD.
// Tests read it from the environment so no password is hardcoded in source.
export const SEED_PASSWORD = process.env.SEED_USER_PASSWORD || '';

type TestFn = () => Promise<void>;
interface TestCase { name: string; fn: TestFn; }

const cases: TestCase[] = [];
export function test(name: string, fn: TestFn) {
  cases.push({ name, fn });
}

export function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: ожидалось ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`);
  }
}

export function assertTrue(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, init);
}

export async function loginAs(username: string, password: string): Promise<{ token: string; userId: string }> {
  const res = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (!data.success || !data.token) {
    throw new Error(`Не удалось залогиниться как ${username}: ${JSON.stringify(data)}`);
  }
  return { token: data.token, userId: data.user.id };
}

export async function runAll(): Promise<number> {
  if (!SEED_PASSWORD) {
    console.error('SEED_USER_PASSWORD не задан в окружении — тесты не могут залогиниться. Задайте его перед запуском (см. .env).');
    return 1;
  }

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const { name, fn } of cases) {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (err: any) {
      failed++;
      failures.push(name);
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
    }
  }

  console.log('');
  console.log(`ИТОГО: ${passed}/${passed + failed} PASS`);
  if (failures.length > 0) {
    console.log(`Провалились: ${failures.join(', ')}`);
  }
  return failed === 0 ? 0 : 1;
}
