import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
function load(name, overrides = {}, env = {}) {
  let handler;
  const source = readFileSync(new URL(`${name}/index.ts`, root), 'utf8')
    .replace(/^import\s+[\s\S]*?\sfrom\s+"[^"]+";\s*/gm, '');
  const context = vm.createContext({
    Response, Request, URL, console,
    Deno: { env: { get: (key) => env[key] }, serve: (fn) => { handler = fn; } },
    Stripe: class {
      static createSubtleCryptoProvider() { return {}; }
    },
    STRIPE_KEY: 'test-key', WHITE_LABEL_LICENSE_PRICE: '', OWNER_TENANT_SLUG: 'owner',
    CORS: {}, json: (body, status = 200) => new Response(JSON.stringify(body), { status }),
    callerUserId: async () => 'test-user',
    webpush: { setVapidDetails() {} },
    ...overrides,
  });
  vm.runInContext(stripTypeScriptTypes(source), context);
  return { context, handler };
}

const post = (body) => new Request('http://localhost/', {
  method: 'POST', body: JSON.stringify(body),
});

test('all nine function entrypoints parse and serve health checks without network', async () => {
  for (const name of ['admin-provision-coach', 'challenge-day-close', 'challenge-enroll',
    'get-coach-branding', 'license-provision', 'notify-coach', 'onboarding-nudge',
    'send-nudge', 'stripe-webhook']) {
    const { handler } = load(name);
    const response = await handler(new Request('http://localhost/'));
    assert.equal(response.status, 200, name);
    assert.equal((await response.json()).service, name);
  }
});

test('license verification refuses missing configuration before Stripe retrieval', async () => {
  let calls = 0;
  const { context } = load('license-provision', {
    Stripe: class { checkout = { sessions: { retrieve: async () => { calls++; throw Error('network forbidden'); } } }; },
  });
  const result = await vm.runInContext('verifyLicenseSession("cs_fixture", "test-user")', context);
  assert.equal(result.ok, false);
  assert.equal(result.code, 503);
  assert.equal(result.error, 'STRIPE_PRICE_LICENSE not configured');
  assert.equal(calls, 0);
});

test('configured license verification still requires exact price and purchaser binding', async () => {
  let session = { status: 'complete', payment_status: 'paid',
    metadata: { user_id: 'test-user' }, line_items: { data: [{ price: { id: 'price_fixture' } }] } };
  const { context } = load('license-provision', {
    WHITE_LABEL_LICENSE_PRICE: 'price_fixture',
    Stripe: class { checkout = { sessions: { retrieve: async () => session } }; },
  });
  const verify = () => vm.runInContext('verifyLicenseSession("cs_fixture", "test-user")', context);
  assert.equal((await verify()).ok, true);
  session = { ...session, metadata: { user_id: 'other-user' } };
  assert.equal((await verify()).code, 403);
  session = { ...session, line_items: { data: [{ price: { id: 'price_other' } }] } };
  assert.equal((await verify()).code, 402);
});

function ownerDb(slug, error = null) {
  return { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { slug }, error }) }) }) }) };
}

test('reward owner gate allows only owner and propagates lookup errors', async () => {
  const { context } = load('challenge-day-close');
  for (const [slug, expected] of [['owner', true], ['outside-coach', false]]) {
    context.db = ownerDb(slug);
    assert.equal(await vm.runInContext('isOwnerTenant(db, "tenant-fixture")', context), expected);
  }
  context.db = ownerDb(null, { message: 'lookup failed' });
  await assert.rejects(vm.runInContext('isOwnerTenant(db, "tenant-fixture")', context), /tenant lookup/);
});

test('admin provisioning rejects other tenants and permits the owner coach', async () => {
  for (const [slug, expected] of [['outside-coach', 403], ['owner', 200]]) {
    let provisions = 0;
    const db = {
      from: (table) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
        data: table === 'profiles' ? { tenant_id: 'tenant-fixture', role: 'coach' } : { slug },
      }) }) }) }),
      rpc: async () => { provisions++; return { data: { slug: 'riverside-coaching', invite_token: 'fixture-token' } }; },
    };
    const { handler } = load('admin-provision-coach', { admin: () => db });
    const response = await handler(post({ mode: 'trial' }));
    assert.equal(response.status, expected);
    assert.equal(provisions, slug === 'owner' ? 1 : 0);
  }
});

test('webhook sender and links use neutral defaults and explicit env overrides', () => {
  let { context } = load('stripe-webhook');
  assert.equal(vm.runInContext('FROM', context), 'Coach App <no-reply@example.com>');
  assert.equal(vm.runInContext('APP_ORIGIN', context), 'http://localhost:5173');
  ({ context } = load('stripe-webhook', {}, {
    EMAIL_FROM: 'Example Coach <coach@example.com>', APP_ORIGIN: 'https://app.example.com',
  }));
  assert.equal(vm.runInContext('FROM', context), 'Example Coach <coach@example.com>');
  assert.equal(vm.runInContext('APP_ORIGIN', context), 'https://app.example.com');
});

test('checkout and provisioning refuse missing price configuration before network work', async () => {
  const overrides = {
    allowedOrigins: () => ['localhost'], SYSTEM_ONE_TIME_PRICE: '',
    HOSTING_MONTHLY_PRICE: '', SYSTEM_CHECKOUT_KIND: 'self_serve_plan',
  };
  for (const name of ['system-checkout', 'system-provision', 'license-checkout']) {
    const { handler } = load(name, overrides);
    const response = await handler(post({ session_id: 'cs_fixture', email: 'buyer@example.com' }));
    assert.equal(response.status, 503, name);
    assert.match((await response.json()).error, /STRIPE_PRICE_/);
  }
  const { handler } = load('license-checkout', { ...overrides, WHITE_LABEL_LICENSE_PRICE: 'price_test_license' });
  assert.equal((await (await handler(post({}))).json()).error, 'STRIPE_PRICE_HOSTING not set');
});

test('digest skips an unset recipient before database, email, or push work', async () => {
  const messages = [];
  const { handler } = load('send-digest', {
    console: { log: (message) => messages.push(message) },
    admin: () => { throw Error('database must not be touched'); },
  }, { CRON_SECRET: 'test-secret' });
  const request = new Request('http://localhost/', { method: 'POST', headers: { Authorization: 'Bearer test-secret' } });
  const response = await handler(request);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).skipped, 'DIGEST_RECIPIENT not set');
  assert.deepEqual(messages, ['DIGEST_RECIPIENT not set']);
});

test('push contact and onboarding links have neutral defaults', () => {
  for (const name of ['notify-coach', 'onboarding-nudge', 'send-nudge']) {
    const { context } = load(name);
    assert.equal(vm.runInContext('VAPID_SUBJECT', context), 'mailto:admin@example.com');
    if (name === 'onboarding-nudge') assert.equal(vm.runInContext('APP_ORIGIN', context), 'http://localhost:5173');
  }
});
