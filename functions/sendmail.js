'use strict';

/**
 * Motum Digital Repository — Netlify mail proxy
 *
 * This endpoint:
 * - Accepts POST requests only from the platform origins listed below.
 * - Requires a valid Supabase access token.
 * - Confirms the caller has the Administrador role and an active profile.
 * - Reads CX_MAIL_API_KEY only from Netlify runtime environment variables.
 * - Forwards the existing API payload: { subject, textMail, emails }.
 *
 * Never place CX_MAIL_API_KEY in this file, netlify.toml, GitHub, or browser code.
 * Logs only say whether a variable exists and whether a header was attached;
 * they never contain the key, access tokens, recipients or message contents.
 */

const MAIL_ENDPOINT = 'https://secure.tecnomotum.com/apis/cxdesign/sendMail';
const ALLOWED_ORIGINS = new Set([
  'https://karlaramirez-star.github.io'
]);
// Deploy Previews of this same Netlify site, so a change can be tested before merging.
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/deploy-preview-\d+--enchanting-unicorn-63d51b\.netlify\.app$/
];
const MAX_RECIPIENTS = 100;
const MAX_SUBJECT_LENGTH = 250;
const MAX_BODY_LENGTH = 25000;
const REQUEST_TIMEOUT_MS = 20000;

function isAllowedOrigin(origin) {
  return !!origin && (ALLOWED_ORIGINS.has(origin) || ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin)));
}

function response(statusCode, body, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  };
  if (isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    headers['Access-Control-Max-Age'] = '600';
  }
  return { statusCode, headers, body: body === '' ? '' : JSON.stringify(body) };
}

// Error answers say which stage failed, so a 401 from the session check can be
// told apart from a 401 returned by the Motum API.
function failure(statusCode, stage, message, origin, extra) {
  return response(statusCode, Object.assign({ error: message, stage }, extra || {}), origin);
}

function getHeader(headers, name) {
  if (!headers) return '';
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] || '') : '';
}

function log(requestId, step, details) {
  console.log('[sendmail]', JSON.stringify(Object.assign({ requestId, step }, details || {})));
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

async function verifyAdministrator(supabaseUrl, publishableKey, accessToken, requestId) {
  const base = supabaseUrl.replace(/\/+$/, '');

  // Verify the access token directly with Supabase Auth.
  const authResponse = await supabaseGet(`${base}/auth/v1/user`, publishableKey, accessToken);
  log(requestId, 'supabase_auth_user', { status: authResponse.status });
  if (!authResponse.ok) return { ok: false, status: 401, reason: 'supabase_auth_rejected', upstreamStatus: authResponse.status };

  const user = await authResponse.json().catch(() => null);
  if (!user || !user.id || !user.email) return { ok: false, status: 401, reason: 'supabase_user_missing' };
  if (!String(user.email).toLowerCase().endsWith('@tecnomotum.com')) {
    return { ok: false, status: 403, reason: 'domain_not_allowed' };
  }

  // Confirm the account is still active.
  const profileUrl = new URL(`${base}/rest/v1/perfiles`);
  profileUrl.searchParams.set('select', 'activo');
  profileUrl.searchParams.set('id', `eq.${user.id}`);
  const profileResponse = await supabaseGet(profileUrl.toString(), publishableKey, accessToken);
  if (!profileResponse.ok) return { ok: false, status: 503, reason: 'profile_query_failed', upstreamStatus: profileResponse.status };
  const profiles = await profileResponse.json().catch(() => []);
  if (!Array.isArray(profiles) || profiles.length !== 1 || profiles[0].activo !== true) {
    return { ok: false, status: 403, reason: 'profile_inactive' };
  }

  // Read only the role assignments belonging to the authenticated user.
  const assignmentsUrl = new URL(`${base}/rest/v1/usuario_roles`);
  assignmentsUrl.searchParams.set('select', 'rol_id');
  assignmentsUrl.searchParams.set('usuario_id', `eq.${user.id}`);
  const assignmentsResponse = await supabaseGet(assignmentsUrl.toString(), publishableKey, accessToken);
  if (!assignmentsResponse.ok) return { ok: false, status: 503, reason: 'roles_query_failed', upstreamStatus: assignmentsResponse.status };
  const assignments = await assignmentsResponse.json().catch(() => []);
  const roleIds = [...new Set((Array.isArray(assignments) ? assignments : [])
    .map((row) => row && row.rol_id)
    .filter((id) => typeof id === 'string' || typeof id === 'number'))];
  if (!roleIds.length) return { ok: false, status: 403, reason: 'no_roles' };

  const rolesUrl = new URL(`${base}/rest/v1/roles`);
  rolesUrl.searchParams.set('select', 'nombre');
  rolesUrl.searchParams.set('id', `in.(${roleIds.join(',')})`);
  const rolesResponse = await supabaseGet(rolesUrl.toString(), publishableKey, accessToken);
  if (!rolesResponse.ok) return { ok: false, status: 503, reason: 'roles_query_failed', upstreamStatus: rolesResponse.status };
  const roles = await rolesResponse.json().catch(() => []);
  const isAdmin = Array.isArray(roles) && roles.some((role) =>
    String(role && role.nombre || '').trim().toLowerCase() === 'administrador'
  );

  return isAdmin ? { ok: true, userId: user.id } : { ok: false, status: 403, reason: 'not_admin' };
}

exports.handler = async function handler(event, context) {
  const origin = getHeader(event.headers, 'origin');
  const requestId = getHeader(event.headers, 'x-nf-request-id') || (context && context.awsRequestId) || '';

  // CORS preflight must be handled before checking for POST.
  if (event.httpMethod === 'OPTIONS') {
    if (!isAllowedOrigin(origin)) return failure(403, 'cors', 'Origen no autorizado.', origin);
    return response(204, '', origin);
  }

  if (!isAllowedOrigin(origin)) {
    log(requestId, 'origin_rejected', { originPresent: !!origin });
    return failure(403, 'cors', 'Origen no autorizado.', origin);
  }
  if (event.httpMethod !== 'POST') {
    return failure(405, 'method', 'Método no permitido.', origin);
  }

  // Values are trimmed: a space or line break pasted into Netlify is enough for
  // the Motum API to reject the key.
  const rawApiKey = process.env.CX_MAIL_API_KEY;
  const apiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : '';
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  const publishableKey = String(process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
  log(requestId, 'env_check', {
    CX_MAIL_API_KEY: { present: typeof rawApiKey === 'string' && rawApiKey.length > 0, emptyAfterTrim: !apiKey, hadSurroundingWhitespace: typeof rawApiKey === 'string' && rawApiKey !== apiKey },
    SUPABASE_URL: { present: !!supabaseUrl },
    SUPABASE_PUBLISHABLE_KEY: { present: !!publishableKey },
    context: process.env.CONTEXT || 'unknown'
  });
  if (!apiKey || !supabaseUrl || !publishableKey) {
    const missing = [!apiKey && 'CX_MAIL_API_KEY', !supabaseUrl && 'SUPABASE_URL', !publishableKey && 'SUPABASE_PUBLISHABLE_KEY'].filter(Boolean);
    console.error('[sendmail] Faltan variables de entorno requeridas:', missing.join(', '));
    return failure(503, 'config', 'El servicio de correo no está configurado completamente (faltan variables de entorno en Netlify: ' + missing.join(', ') + ').', origin);
  }

  const authorization = getHeader(event.headers, 'authorization');
  const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
  if (!tokenMatch) return failure(401, 'session', 'Se requiere una sesión autenticada.', origin);
  const accessToken = tokenMatch[1].trim();

  let verification;
  try {
    verification = await verifyAdministrator(supabaseUrl, publishableKey, accessToken, requestId);
  } catch (error) {
    console.error('[sendmail] No fue posible validar la sesión con Supabase.');
    return failure(503, 'session', 'No fue posible validar la sesión. Intenta nuevamente.', origin);
  }
  log(requestId, 'session_check', { ok: verification.ok, reason: verification.reason || null, upstreamStatus: verification.upstreamStatus || null });
  if (!verification.ok) {
    const status = verification.status || 403;
    return failure(status, 'session',
      status === 401
        ? 'La sesión no es válida o expiró. Inicia sesión nuevamente. (Validación de Supabase en Netlify; no proviene del API de Motum.)'
        : status === 403
          ? 'Tu cuenta no tiene autorización para enviar notificaciones.'
          : 'No fue posible validar los permisos de la cuenta.',
      origin, { reason: verification.reason || null });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (_) {
    return failure(400, 'payload', 'El contenido de la solicitud no es JSON válido.', origin);
  }

  const subject = typeof payload.subject === 'string' ? payload.subject.trim() : '';
  const textMail = typeof payload.textMail === 'string' ? payload.textMail : '';
  // `emails` must always be an array; a single address sent as text is wrapped.
  const rawEmails = typeof payload.emails === 'string' ? [payload.emails] : payload.emails;

  if (!subject || subject.length > MAX_SUBJECT_LENGTH) {
    return failure(400, 'payload', `El asunto es obligatorio y no debe superar ${MAX_SUBJECT_LENGTH} caracteres.`, origin);
  }
  if (!textMail.trim() || textMail.length > MAX_BODY_LENGTH) {
    return failure(400, 'payload', `El contenido es obligatorio y no debe superar ${MAX_BODY_LENGTH} caracteres.`, origin);
  }
  if (!Array.isArray(rawEmails) || rawEmails.length === 0 || rawEmails.length > MAX_RECIPIENTS) {
    return failure(400, 'payload', `Se requiere una lista de 1 a ${MAX_RECIPIENTS} destinatarios.`, origin);
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const emails = [...new Set(rawEmails
    .filter((email) => typeof email === 'string')
    .map((email) => email.trim())
    .filter((email) => emailPattern.test(email)))];
  if (!emails.length || emails.length !== rawEmails.length) {
    return failure(400, 'payload', 'La lista contiene correos vacíos, repetidos o con formato no válido.', origin);
  }

  // Outgoing request to Motum: POST, JSON body with exactly { subject, textMail, emails }.
  const outgoingHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'x-api-key': apiKey
  };
  const outgoingBody = JSON.stringify({ subject, textMail, emails });
  log(requestId, 'motum_request', {
    method: 'POST',
    endpoint: MAIL_ENDPOINT,
    contentType: outgoingHeaders['Content-Type'],
    xApiKeyHeaderAttached: typeof outgoingHeaders['x-api-key'] === 'string' && outgoingHeaders['x-api-key'].length > 0,
    bodyKeys: Object.keys(JSON.parse(outgoingBody)),
    emailsIsArray: Array.isArray(emails),
    recipientCount: emails.length
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let apiResponse;
  let apiText = '';
  try {
    apiResponse = await fetch(MAIL_ENDPOINT, {
      method: 'POST',
      headers: outgoingHeaders,
      body: outgoingBody,
      signal: controller.signal
    });
    apiText = await apiResponse.text();
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    console.error('[sendmail]', JSON.stringify({ requestId, step: 'motum_unreachable', timedOut }));
    return failure(timedOut ? 504 : 502, 'motum',
      timedOut ? 'El API de Motum no respondió a tiempo.' : 'No fue posible contactar el API de Motum.', origin);
  } finally {
    clearTimeout(timeout);
  }

  let apiBody;
  try { apiBody = JSON.parse(apiText); }
  catch (_) { apiBody = { message: apiText.slice(0, 4000) }; }

  // Audit without recording access tokens, API keys, or recipient addresses.
  log(requestId, 'motum_response', {
    adminUserId: verification.userId,
    status: apiResponse.status,
    ok: apiResponse.ok,
    recipientCount: emails.length
  });

  if (apiResponse.ok) return response(apiResponse.status, apiBody, origin);

  const apiMessage = (apiBody && (apiBody.message || apiBody.error || apiBody.msg)) || apiText.slice(0, 500) || 'sin detalle';
  return failure(apiResponse.status, 'motum',
    'El API de Motum respondió HTTP ' + apiResponse.status + ': ' + apiMessage, origin,
    { motumStatus: apiResponse.status, motumResponse: apiBody });
};
