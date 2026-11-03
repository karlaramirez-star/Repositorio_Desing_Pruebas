/* Pruebas de functions/sendmail.js con fetch simulado (sin red, sin llave real).
   Ejecutar: node tests/sendmail.test.js */
const assert = require('assert'); const path = require('path');
const FN = path.resolve(process.argv[2] || path.join(__dirname, '..', 'functions', 'sendmail.js'));
const KEY = 'TEST-KEY-123', TOKEN = 'tok-abc', MAIL = 'destinatario@tecnomotum.com';
const ORIGIN = 'https://karlaramirez-star.github.io';
let logs = [], calls = [], motum = { status: 200, body: '{"ok":true,"message":"sent"}' }, authStatus = 200, admin = true;
for (const k of ['log', 'error']) { const o = console[k]; console[k] = (...a) => logs.push(a.map(String).join(' ')); }
global.fetch = async (url, opt) => {
  calls.push({ url: String(url), opt });
  const j = (s, b) => ({ ok: s < 300, status: s, json: async () => b, text: async () => (typeof b === 'string' ? b : JSON.stringify(b)) });
  if (String(url).includes('/auth/v1/user')) return j(authStatus, { id: 'u1', email: 'karlaramirez@tecnomotum.com' });
  if (String(url).includes('/rest/v1/perfiles')) return j(200, [{ activo: true }]);
  if (String(url).includes('/rest/v1/usuario_roles')) return j(200, [{ rol_id: 'r1' }]);
  if (String(url).includes('/rest/v1/roles')) return j(200, [{ nombre: admin ? 'Administrador' : 'Usuario' }]);
  if (String(url).startsWith('https://secure.tecnomotum.com')) return { ok: motum.status < 300, status: motum.status, text: async () => motum.body };
  throw new Error('URL inesperada ' + url);
};
const setEnv = (key) => { process.env.SUPABASE_URL = 'https://x.supabase.co'; process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_x'; if (key === undefined) delete process.env.CX_MAIL_API_KEY; else process.env.CX_MAIL_API_KEY = key; };
const { handler } = require(FN);
const call = (o) => handler(Object.assign({ httpMethod: 'POST', headers: { origin: ORIGIN, authorization: 'Bearer ' + TOKEN, 'x-nf-request-id': 'req-1' }, body: JSON.stringify({ subject: 'Prueba', textMail: '<p>Prueba de correo</p>', emails: [MAIL] }) }, o), {});
const body = (r) => (r.body ? JSON.parse(r.body) : null);
const motumCall = () => calls.find((c) => c.url.startsWith('https://secure.tecnomotum.com'));
const results = [];
const t = async (name, fn) => { calls = []; logs = []; motum = { status: 200, body: '{"ok":true,"message":"sent"}' }; authStatus = 200; admin = true; setEnv(KEY);
  try { await fn(); results.push('PASA  ' + name); } catch (e) { results.push('FALLA ' + name + ' -> ' + e.message); } };
(async () => {
  await t('OPTIONS se procesa antes de exigir POST (204 + CORS)', async () => {
    const r = await call({ httpMethod: 'OPTIONS', body: '' });
    assert.strictEqual(r.statusCode, 204);
    assert.strictEqual(r.headers['Access-Control-Allow-Origin'], ORIGIN);
    assert.match(r.headers['Access-Control-Allow-Headers'], /Content-Type/); assert.match(r.headers['Access-Control-Allow-Headers'], /Authorization/);
    assert.match(r.headers['Access-Control-Allow-Methods'], /POST/); assert.strictEqual(calls.length, 0);
  });
  await t('OPTIONS desde Deploy Preview del mismo sitio permitido', async () => {
    const r = await call({ httpMethod: 'OPTIONS', headers: { origin: 'https://deploy-preview-8--enchanting-unicorn-63d51b.netlify.app' } });
    assert.strictEqual(r.statusCode, 204);
  });
  await t('Origen desconocido rechazado sin cabeceras CORS', async () => {
    const r = await call({ headers: { origin: 'https://evil.example', authorization: 'Bearer x' } });
    assert.strictEqual(r.statusCode, 403); assert.ok(!r.headers['Access-Control-Allow-Origin']); assert.strictEqual(motumCall(), undefined);
  });
  await t('GET rechazado con 405', async () => { assert.strictEqual((await call({ httpMethod: 'GET' })).statusCode, 405); });
  await t('Sin CX_MAIL_API_KEY: 503, etapa config, sin llamar a Motum', async () => {
    setEnv(undefined); const r = await call(); assert.strictEqual(r.statusCode, 503); assert.strictEqual(body(r).stage, 'config');
    assert.match(body(r).error, /CX_MAIL_API_KEY/); assert.strictEqual(motumCall(), undefined);
    assert.ok(logs.some((l) => l.includes('"CX_MAIL_API_KEY":{"present":false')));
  });
  await t('Supabase rechaza la sesión: 401 etapa session (no Motum)', async () => {
    authStatus = 401; const r = await call(); assert.strictEqual(r.statusCode, 401); assert.strictEqual(body(r).stage, 'session');
    assert.strictEqual(body(r).reason, 'supabase_auth_rejected'); assert.strictEqual(motumCall(), undefined);
  });
  await t('Usuario no administrador: 403', async () => { admin = false; const r = await call(); assert.strictEqual(r.statusCode, 403); assert.strictEqual(motumCall(), undefined); });
  await t('Solicitud a Motum: POST, Content-Type JSON, x-api-key y cuerpo exacto', async () => {
    const r = await call(); assert.strictEqual(r.statusCode, 200); assert.deepStrictEqual(body(r), { ok: true, message: 'sent' });
    const m = motumCall(); assert.ok(m, 'no se llamó a Motum');
    assert.strictEqual(m.url, 'https://secure.tecnomotum.com/apis/cxdesign/sendMail');
    assert.strictEqual(m.opt.method, 'POST'); assert.strictEqual(m.opt.headers['Content-Type'], 'application/json');
    assert.strictEqual(m.opt.headers['x-api-key'], KEY);
    assert.deepStrictEqual(JSON.parse(m.opt.body), { subject: 'Prueba', textMail: '<p>Prueba de correo</p>', emails: [MAIL] });
    assert.deepStrictEqual(Object.keys(JSON.parse(m.opt.body)), ['subject', 'textMail', 'emails']);
  });
  await t('Llave con espacios/salto de línea en Netlify se envía recortada', async () => {
    setEnv('  ' + KEY + '\n'); await call(); assert.strictEqual(motumCall().opt.headers['x-api-key'], KEY);
    assert.ok(logs.some((l) => l.includes('"hadSurroundingWhitespace":true')));
  });
  await t('emails como texto se convierte en arreglo', async () => {
    await call({ body: JSON.stringify({ subject: 'Prueba', textMail: '<p>x</p>', emails: MAIL }) });
    assert.deepStrictEqual(JSON.parse(motumCall().opt.body).emails, [MAIL]);
  });
  await t('Motum responde 401: se devuelve código y mensaje con etapa motum', async () => {
    motum = { status: 401, body: '{"message":"Invalid API key"}' }; const r = await call();
    assert.strictEqual(r.statusCode, 401); assert.strictEqual(body(r).stage, 'motum'); assert.strictEqual(body(r).motumStatus, 401);
    assert.match(body(r).error, /HTTP 401: Invalid API key/); assert.strictEqual(r.headers['Access-Control-Allow-Origin'], ORIGIN);
  });
  await t('Motum responde texto plano 500: mensaje devuelto', async () => {
    motum = { status: 500, body: 'Internal error' }; const r = await call(); assert.strictEqual(r.statusCode, 500); assert.match(body(r).error, /HTTP 500: Internal error/);
  });
  await t('Registros: confirman llave presente y header adjunto', async () => {
    await call(); assert.ok(logs.some((l) => l.includes('"step":"env_check"') && l.includes('"present":true')));
    assert.ok(logs.some((l) => l.includes('"step":"motum_request"') && l.includes('"xApiKeyHeaderAttached":true') && l.includes('"contentType":"application/json"')));
    assert.ok(logs.some((l) => l.includes('"step":"motum_response"') && l.includes('"status":200')));
  });
  await t('Registros: nunca contienen la llave, el token ni los correos', async () => {
    const all = []; for (const s of [200, 401]) { logs = []; motum = { status: s, body: '{"message":"x"}' }; await call(); all.push(...logs); }
    setEnv('  ' + KEY + '\n'); logs = []; await call(); all.push(...logs);
    const joined = all.join('\n'); for (const secret of [KEY, TOKEN, MAIL]) assert.ok(!joined.includes(secret), 'aparece ' + secret);
  });
  console.log = process.stdout.write.bind(process.stdout);
  process.stdout.write(results.join('\n') + '\n');
  const failed = results.filter((r) => r.startsWith('FALLA')).length;
  process.stdout.write(`\n${results.length - failed}/${results.length} pruebas pasaron\n`); process.exit(failed ? 1 : 0);
})();
