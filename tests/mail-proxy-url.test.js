/*
 * Pruebas de la conexión navegador → función de correo → API Motum.
 *
 * - La plataforma se sirve en un navegador (Playwright) como si estuviera en
 *   producción (GitHub Pages) o en un Deploy Preview de Netlify.
 * - Todas las solicitudes se interceptan: no sale ningún correo ni se usa red real.
 * - La solicitud capturada del navegador se entrega a functions/sendmail.js con
 *   fetch simulado para comprobar lo que Netlify enviaría a Motum.
 *
 * Ejecutar: node tests/mail-proxy-url.test.js   (requiere el paquete "playwright")
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const STABLE = 'https://enchanting-unicorn-63d51b.netlify.app/.netlify/functions/sendmail';
const PROD_PAGE = 'https://karlaramirez-star.github.io/Repositorio_Desing_Pruebas/';
const PREVIEW_PAGE = 'https://deploy-preview-9--enchanting-unicorn-63d51b.netlify.app/';
const PREVIEW_FN = 'https://deploy-preview-9--enchanting-unicorn-63d51b.netlify.app/.netlify/functions/sendmail';
const TOKEN = 'supabase-access-token-de-prueba';
const RECIPIENT = 'destinatario@tecnomotum.com';

const results = [];
async function check(name, fn) {
  try { await fn(); results.push('PASA  ' + name); }
  catch (e) { results.push('FALLA ' + name + ' -> ' + e.message); }
}

// Fake Supabase library: the session is only handed out once the test asks for it,
// so page start-up does not try to load real user data.
function fakeSupabaseInit() {
  window.__giveSession = false;
  const chain = () => {
    const h = { get(_, k) {
      if (k === 'then') return (res) => res({ data: { id: 'notif-1' }, error: null });
      return () => new Proxy({}, h);
    } };
    return new Proxy({}, h);
  };
  window.supabase = { createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: window.__giveSession ? { access_token: 'supabase-access-token-de-prueba', user: { id: 'u1' } } : null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({}), signInWithOAuth: async () => ({})
    },
    from: chain, rpc: async () => ({ data: null, error: null }),
    storage: { from: () => ({}) }
  }) };
}

async function openPlatform(browser, pageUrl) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const mailRequests = [];
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.addInitScript(fakeSupabaseInit);
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.endsWith('/.netlify/functions/sendmail')) {
      // Captured, never forwarded: no real email can leave.
      mailRequests.push({ url, method: req.method(), headers: req.headers(), body: req.postData() });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"simulado":true}' });
    }
    const u = new URL(url);
    if (url.startsWith(pageUrl) && (u.pathname.endsWith('/') || /\.(html|js)$/.test(u.pathname))) {
      const file = path.join(ROOT, u.pathname.endsWith('/') ? 'index.html' : path.basename(u.pathname));
      if (fs.existsSync(file)) {
        return route.fulfill({ status: 200, contentType: file.endsWith('.js') ? 'application/javascript' : 'text/html', body: fs.readFileSync(file) });
      }
    }
    return route.abort();
  });
  await page.goto(pageUrl);
  await page.waitForTimeout(800);
  return { ctx, page, mailRequests, pageErrors };
}

(async () => {
  const browser = await chromium.launch();

  // 1) URL selection logic for several origins (pure function from index.html).
  {
    const { ctx, page } = await openPlatform(browser, PROD_PAGE);
    const table = await page.evaluate(() => ({
      prod: _resolveMailProxyUrl('https://karlaramirez-star.github.io'),
      preview: _resolveMailProxyUrl('https://deploy-preview-9--enchanting-unicorn-63d51b.netlify.app'),
      preview123: _resolveMailProxyUrl('https://deploy-preview-123--enchanting-unicorn-63d51b.netlify.app'),
      stableSite: _resolveMailProxyUrl('https://enchanting-unicorn-63d51b.netlify.app'),
      otherSite: _resolveMailProxyUrl('https://deploy-preview-9--otro-sitio.netlify.app'),
      lookalike: _resolveMailProxyUrl('https://deploy-preview-9--enchanting-unicorn-63d51b.netlify.app.evil.com'),
      empty: _resolveMailProxyUrl(''),
      file: _resolveMailProxyUrl('null')
    }));
    await check('Selección de URL: producción y orígenes ajenos usan el endpoint estable', () => {
      for (const k of ['prod', 'stableSite', 'otherSite', 'lookalike', 'empty', 'file']) assert.strictEqual(table[k], STABLE, k);
    });
    await check('Selección de URL: Deploy Preview usa su propia función', () => {
      assert.strictEqual(table.preview, PREVIEW_FN);
      assert.strictEqual(table.preview123, 'https://deploy-preview-123--enchanting-unicorn-63d51b.netlify.app/.netlify/functions/sendmail');
    });
    await ctx.close();
  }

  // 2) Real page in both environments: endpoint used, headers and body sent.
  const captured = {};
  for (const [env, pageUrl, expected] of [['producción', PROD_PAGE, STABLE], ['Deploy Preview', PREVIEW_PAGE, PREVIEW_FN]]) {
    const { ctx, page, mailRequests, pageErrors } = await openPlatform(browser, pageUrl);
    const proxyUrl = await page.evaluate(() => window.MAIL_PROXY_URL);
    await check(env + ': MAIL_PROXY_URL = ' + expected, () => assert.strictEqual(proxyUrl, expected));

    const result = await page.evaluate((to) => new Promise((resolve) => {
      window.__giveSession = true;
      _callMailProxy('Prueba', '<p>Prueba de correo</p>', [to], resolve);
    }), RECIPIENT);
    const req = mailRequests[0];
    await check(env + ': la solicitud va a ' + expected, () => {
      assert.ok(req, 'no hubo solicitud'); assert.strictEqual(req.url, expected); assert.strictEqual(req.method, 'POST');
    });
    await check(env + ': el navegador envía Authorization: Bearer y Content-Type JSON, sin x-api-key', () => {
      assert.strictEqual(req.headers['authorization'], 'Bearer ' + TOKEN);
      assert.match(req.headers['content-type'], /^application\/json/);
      assert.ok(!('x-api-key' in req.headers), 'el navegador envió x-api-key');
    });
    await check(env + ': cuerpo exactamente { subject, textMail, emails[] }', () => {
      const b = JSON.parse(req.body);
      assert.deepStrictEqual(Object.keys(b), ['subject', 'textMail', 'emails']);
      assert.deepStrictEqual(b, { subject: 'Prueba', textMail: '<p>Prueba de correo</p>', emails: [RECIPIENT] });
    });
    await check(env + ': la respuesta se interpreta como { ok, code, msg, data }', () => {
      assert.strictEqual(result.ok, true); assert.strictEqual(result.code, 200); assert.ok(result.msg); assert.deepStrictEqual(result.data, { ok: true, simulado: true });
    });
    const leaks = await page.evaluate(() => {
      const dump = (s) => { const o = []; try { for (let i = 0; i < s.length; i++) o.push(s.key(i) + '=' + s.getItem(s.key(i))); } catch (_) {} return o.join('\n'); };
      return /x-api-key|CX_MAIL_API_KEY/i.test(dump(localStorage) + dump(sessionStorage) + document.documentElement.outerHTML.replace(/<script[\s\S]*?<\/script>/gi, ''))
        || Object.keys(window).some((k) => /api_?key/i.test(k) && !/^(SUPABASE|MAIL)/.test(k));
    });
    await check(env + ': el navegador no recibe ni almacena x-api-key', () => assert.strictEqual(leaks, false));

    // Automatic emails disabled; manual test send still works.
    mailRequests.length = 0;
    const autoResults = await page.evaluate(async () => {
      const out = [];
      for (const t of ['nueva_plantilla', 'actualiza_plantilla', 'nuevo_contenido']) out.push(await window.sendEmailNotification(t, { nombre: 'X', areaIds: [1] }));
      return out;
    });
    await page.waitForTimeout(300);
    await check(env + ': correos automáticos desactivados (0 solicitudes)', () => {
      assert.deepStrictEqual(autoResults, [null, null, null]); assert.strictEqual(mailRequests.length, 0);
    });
    await page.evaluate((to) => {
      document.body.insertAdjacentHTML('beforeend',
        '<input id="notif-test-email" value="' + to + '"><input id="notif-test-subject" value="[Prueba] Envío manual">' +
        '<textarea id="notif-test-body"><p>Prueba manual</p></textarea><button id="notif-test-btn"></button><div id="notif-test-result"></div>');
      window.renderAdminNotificaciones = () => {};
      return window.runMailTest();
    }, RECIPIENT);
    await page.waitForTimeout(300);
    await check(env + ': la Prueba de Envío manual sigue funcionando (1 solicitud, 1 destinatario)', () => {
      assert.strictEqual(mailRequests.length, 1); assert.strictEqual(mailRequests[0].url, expected);
      assert.deepStrictEqual(JSON.parse(mailRequests[0].body).emails, [RECIPIENT]);
    });
    await check(env + ': sin errores de página', () => assert.deepStrictEqual(pageErrors, []));
    captured[env] = { req, origin: new URL(pageUrl).origin };
    await ctx.close();
  }
  await browser.close();

  // 3) Hand the captured browser request to the Netlify function with a mocked Motum.
  const motumCalls = [];
  global.fetch = async (url, opt) => {
    const u = String(url);
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes('/auth/v1/user')) return json(200, { id: 'u1', email: 'karlaramirez@tecnomotum.com' });
    if (u.includes('/rest/v1/perfiles')) return json(200, [{ activo: true }]);
    if (u.includes('/rest/v1/usuario_roles')) return json(200, [{ rol_id: 'r1' }]);
    if (u.includes('/rest/v1/roles')) return json(200, [{ nombre: 'Administrador' }]);
    if (u === 'https://secure.tecnomotum.com/apis/cxdesign/sendMail') { motumCalls.push(opt); return { ok: true, status: 200, text: async () => '{"message":"ok"}' }; }
    throw new Error('Solicitud inesperada a ' + u);
  };
  process.env.CX_MAIL_API_KEY = 'llave-de-prueba';
  process.env.SUPABASE_URL = 'https://proyecto.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_prueba';
  const originalLog = console.log; console.log = () => {};
  const { handler } = require(path.join(ROOT, 'functions', 'sendmail.js'));
  for (const env of Object.keys(captured)) {
    motumCalls.length = 0;
    const { req, origin } = captured[env];
    const res = await handler({ httpMethod: 'POST', headers: Object.assign({}, req.headers, { origin }), body: req.body }, {});
    await check(env + ' → Netlify → Motum: POST, Content-Type JSON, x-api-key de la variable de entorno y mismo cuerpo', () => {
      assert.strictEqual(res.statusCode, 200);
      const m = motumCalls[0]; assert.ok(m, 'no se llamó a Motum');
      assert.strictEqual(m.method, 'POST');
      assert.strictEqual(m.headers['Content-Type'], 'application/json');
      assert.strictEqual(m.headers['x-api-key'], 'llave-de-prueba');
      assert.deepStrictEqual(JSON.parse(m.body), JSON.parse(req.body));
    });
  }
  console.log = originalLog;

  console.log(results.join('\n'));
  const failed = results.filter((r) => r.startsWith('FALLA')).length;
  console.log('\n' + (results.length - failed) + '/' + results.length + ' pruebas pasaron');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
