import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { WorkerEnv } from './types.js';
import { authenticate, csrfGuard, registerAuth } from './auth.js';
import { registerCatalog } from './catalog.js';
import { registerSessions } from './sessions.js';
import { registerBackups } from './backups.js';
import { registerInternal } from './internal.js';
import { assertVaultConfigured } from './vault.js';
import { fail, testMode } from './http.js';

export const app = new Hono<WorkerEnv>();

app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if (new URL(c.req.url).protocol === 'https:') c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'private, no-store');
  await next();
});
app.onError((error, c) => {
  if (error instanceof HTTPException) {
    const response = error.getResponse();
    return c.newResponse(response.body, response);
  }
  // Never log request bodies, cookies, upstream responses, or exceptions that could contain credentials.
  return c.json({ error: 'The request could not be completed.', code: 'internal_error' }, 500);
});
app.get('/api/health', async c => {
  let vaultReady = false;
  try { await assertVaultConfigured(c.env); vaultReady = true; } catch { /* Readiness only; no configuration values are exposed. */ }
  return c.json({ ok: true,
    githubConfigured: !!c.env.GITHUB_CLIENT_ID && !!c.env.GITHUB_CLIENT_SECRET && vaultReady,
    runnerConfigured: !!c.env.RUNNER_URL && !!c.env.RUNNER_SHARED_SECRET && c.env.RUNNER_SHARED_SECRET.length >= 32,
    databaseConfigured: !!c.env.DB, backupsConfigured: !!c.env.BUCKET, testMode: testMode(c.env),
  });
});
registerAuth(app);
registerInternal(app);
app.use('/api/*', authenticate, csrfGuard);
registerCatalog(app);
registerSessions(app);
registerBackups(app);
app.all('/api/*', () => fail(404, 'not_found', 'API route not found.'));
app.all('*', c => {
  if (!c.env.ASSETS || !['GET', 'HEAD'].includes(c.req.method)) return c.json({ error: 'Not found.', code: 'not_found' }, 404);
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
