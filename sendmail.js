'use strict';

/**
 * Motum Digital Repository — Netlify mail proxy
 *
 * This endpoint:
 * - Accepts POST requests only from the GitHub Pages app origin.
 * - Requires a valid Supabase access token.
 * - Confirms the caller has the Administrador role and an active profile.
 * - Reads CX_MAIL_API_KEY only from Netlify runtime environment variables.
 * - Forwards the existing API payload: { subject, textMail, emails }.
 *
 * Never place CX_MAIL_API_KEY in this file, netlify.toml, GitHub, or browser code.
 */

const MAIL_ENDPOINT = 'https://secure.tecnomotum.com/apis/cxdesign/sendMail';
const ALLOWED_ORIGINS = new Set([
  'https://karlaramirez-star.github.io'
]);
const MAX_RECIPIENTS = 100;
const MAX_SUBJECT_LENGTH = 250;
const MAX_BODY_LENGTH = 25000;
const REQUEST_TIMEOUT_MS = 20000;

function response(statusCode, body, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    headers['Access-Control-Max-Age'] = '600';
  }
  return { statusCode, headers, body: body === '' ? '' : JSON.stringify(body) };
}

function getHeader(headers, name) {
  if (!headers) return '';
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] || '') : '';
}

async function supabaseGet(url, publishableKey, accessToken) {
  return fetch(url, {
    method: 'GET',
    headers: {
      'apikey': publishableKey,
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json'
    }
  });
}

async function verifyAdministrator(supabaseUrl, publishableKey, accessToken) {
  const base = supabaseUrl.replace(/\/+$/, '');

  // Verify the access token directly with Supabase Auth.
  const authResponse = await supabaseGet(`${base}/auth/v1/user`, publishableKey, accessToken);
  if (!authResponse.ok) return { ok: false, status: 401 };

  const user = await authResponse.json().catch(() => null);
  if (!user || !user.id || !user.email) return { ok: false, status: 401 };
  if (!String(user.email).toLowerCase().endsWith('@tecnomotum.com')) {
    return { ok: false, status: 403 };
  }

  // Confirm the account is still active.
  const profileUrl = new URL(`${base}/rest/v1/perfiles`);
  profileUrl.searchParams.set('select', 'activo');
  profileUrl.searchParams.set('id', `eq.${user.id}`);
  const profileResponse = await supabaseGet(profileUrl.toString(), publishableKey, accessToken);
  if (!profileResponse.ok) return { ok: false, status: 503 };
  const profiles = await profileResponse.json().catch(() => []);
  if (!Array.isArray(profiles) || profiles.length !== 1 || profiles[0].activo !== true) {
    return { ok: false, status: 403 };
  }

  // Read only the role assignments belonging to the authenticated user.
  const assignmentsUrl = new URL(`${base}/rest/v1/usuario_roles`);
  assignmentsUrl.searchParams.set('select', 'rol_id');
  assignmentsUrl.searchParams.set('usuario_id', `eq.${user.id}`);
  const assignmentsResponse = await supabaseGet(assignmentsUrl.toString(), publishableKey, accessToken);
  if (!assignmentsResponse.ok) return { ok: false, status: 503 };
  const assignments = await assignmentsResponse.json().catch(() => []);
  const roleIds = [...new Set((Array.isArray(assignments) ? assignments : [])
    .map((row) => row && row.rol_id)
    .filter((id) => typeof id === 'string' || typeof id === 'number'))];
  if (!roleIds.length) return { ok: false, status: 403 };

  const rolesUrl = new URL(`${base}/rest/v1/roles`);
  rolesUrl.searchParams.set('select', 'nombre');
  rolesUrl.searchParams.set('id', `in.(${roleIds.join(',')})`);
  const rolesResponse = await supabaseGet(rolesUrl.toString(), publishableKey, accessToken);
  if (!rolesResponse.ok) return { ok: false, status: 503 };
  const roles = await rolesResponse.json().catch(() => []);
  const isAdmin = Array.isArray(roles) && roles.some((role) =>
    String(role && role.nombre || '').trim().toLowerCase() === 'administrador'
  );

  return isAdmin ? { ok: true, userId: user.id } : { ok: false, status: 403 };
}

exports.handler = async function handler(event) {
  const origin = getHeader(event.headers, 'origin');

  // CORS preflight must be handled before checking for POST.
  if (event.httpMethod === 'OPTIONS') {
    if (!ALLOWED_ORIGINS.has(origin)) return response(403, { error: 'Origen no autorizado.' }, origin);
    return response(204, '', origin);
  }

  if (!ALLOWED_ORIGINS.has(origin)) {
    return response(403, { error: 'Origen no autorizado.' }, origin);
  }
  if (event.httpMethod !== 'POST') {
    return response(405, { error: 'Método no permitido.' }, origin);
  }

  const apiKey = process.env.CX_MAIL_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!apiKey || !supabaseUrl || !publishableKey) {
    console.error('[sendmail] Faltan variables de entorno requeridas.');
    return response(503, { error: 'El servicio de correo no está configurado completamente.' }, origin);
  }

  const authorization = getHeader(event.headers, 'authorization');
  const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (!tokenMatch) return response(401, { error: 'Se requiere una sesión autenticada.' }, origin);
  const accessToken = tokenMatch[1].trim();

  let verification;
  try {
    verification = await verifyAdministrator(supabaseUrl, publishableKey, accessToken);
  } catch (error) {
    console.error('[sendmail] No fue posible validar la sesión con Supabase.');
    return response(503, { error: 'No fue posible validar la sesión. Intenta nuevamente.' }, origin);
  }
  if (!verification.ok) {
    const status = verification.status || 403;
    return response(status, {
      error: status === 401
        ? 'La sesión no es válida o expiró. Inicia sesión nuevamente.'
        : status === 403
          ? 'Tu cuenta no tiene autorización para enviar notificaciones.'
          : 'No fue posible validar los permisos de la cuenta.'
    }, origin);
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (_) {
    return response(400, { error: 'El contenido de la solicitud no es JSON válido.' }, origin);
  }

  const subject = typeof payload.subject === 'string' ? payload.subject.trim() : '';
  const textMail = typeof payload.textMail === 'string' ? payload.textMail : '';
  const rawEmails = payload.emails;

  if (!subject || subject.length > MAX_SUBJECT_LENGTH) {
    return response(400, { error: `El asunto es obligatorio y no debe superar ${MAX_SUBJECT_LENGTH} caracteres.` }, origin);
  }
  if (!textMail.trim() || textMail.length > MAX_BODY_LENGTH) {
    return response(400, { error: `El contenido es obligatorio y no debe superar ${MAX_BODY_LENGTH} caracteres.` }, origin);
  }
  if (!Array.isArray(rawEmails) || rawEmails.length === 0 || rawEmails.length > MAX_RECIPIENTS) {
    return response(400, { error: `Se requiere una lista de 1 a ${MAX_RECIPIENTS} destinatarios.` }, origin);
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const emails = [...new Set(rawEmails
    .filter((email) => typeof email === 'string')
    .map((email) => email.trim())
    .filter((email) => emailPattern.test(email)))];
  if (!emails.length || emails.length !== rawEmails.length) {
    return response(400, { error: 'La lista contiene correos vacíos o con formato no válido.' }, origin);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let apiResponse;
  let apiText = '';
  try {
    apiResponse = await fetch(MAIL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      body: JSON.stringify({ subject, textMail, emails }),
      signal: controller.signal
    });
    apiText = await apiResponse.text();
  } catch (error) {
    console.error('[sendmail] No fue posible contactar el servicio de correo.');
    return response(502, { error: 'No fue posible contactar el servicio de correo.' }, origin);
  } finally {
    clearTimeout(timeout);
  }

  let apiBody;
  try { apiBody = JSON.parse(apiText); }
  catch (_) { apiBody = { message: apiText.slice(0, 4000) }; }

  // Audit without recording access tokens, API keys, or recipient addresses.
  console.log('[sendmail]', {
    adminUserId: verification.userId,
    status: apiResponse.status,
    recipientCount: emails.length,
    timestamp: new Date().toISOString()
  });

  return response(apiResponse.status, apiBody, origin);
};
