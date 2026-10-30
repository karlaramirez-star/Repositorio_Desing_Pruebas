/**
 * Función serverless: /functions/sendmail.js
 * Compatible con Netlify Functions y Vercel (renombra a /api/sendmail.js para Vercel)
 *
 * CONFIGURACIÓN DE SEGURIDAD:
 * La clave API NUNCA va en el código fuente ni en el repositorio.
 * Configura la variable de entorno en tu plataforma de hosting:
 *
 *   Netlify → Site settings → Environment variables → CX_MAIL_API_KEY
 *   Vercel  → Project Settings → Environment Variables → CX_MAIL_API_KEY
 *   GitHub Actions → Settings → Secrets → CX_MAIL_API_KEY
 *
 * La clave se inyecta en el header x-api-key en el servidor.
 * El navegador NUNCA recibe ni ve la clave.
 */

// ── Configuración ──────────────────────────────────────────────
const MAIL_ENDPOINT = 'https://secure.tecnomotum.com/apis/cxdesign/sendMail';
const ALLOWED_ORIGIN = '*'; // Cambia a tu dominio real en producción, ej: 'https://tudominio.com'

// ── Handler Netlify ────────────────────────────────────────────
exports.handler = async function(event, context) {
  // Solo POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Método no permitido' })
    };
  }

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  // Leer clave de entorno (NUNCA del body ni de la URL)
  const apiKey = process.env.CX_MAIL_API_KEY;
  if (!apiKey) {
    console.error('[sendmail] CX_MAIL_API_KEY no configurada en variables de entorno');
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Configuración del servidor incompleta. Contacta al administrador.' })
    };
  }

  // Parsear body
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Body inválido: debe ser JSON.' })
    };
  }

  const { subject, textMail, emails } = payload;

  // Validar campos requeridos
  if (!subject || typeof subject !== 'string') {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Campo "subject" requerido.' }) };
  }
  if (!textMail || typeof textMail !== 'string') {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Campo "textMail" requerido.' }) };
  }
  if (!Array.isArray(emails) || emails.length === 0) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Campo "emails" debe ser un arreglo no vacío.' }) };
  }

  // Validar formato básico de emails
  const validEmails = emails.filter(e => typeof e === 'string' && e.includes('@'));
  if (validEmails.length === 0) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Sin correos válidos en el arreglo "emails".' }) };
  }

  // Llamada al endpoint real — la clave viaja en el header del servidor
  let apiResponse;
  try {
    apiResponse = await fetch(MAIL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey    // ← Inyectada desde variable de entorno
      },
      body: JSON.stringify({ subject, textMail, emails: validEmails })
    });
  } catch (networkErr) {
    console.error('[sendmail] Error de red al contactar endpoint:', networkErr.message);
    return {
      statusCode: 502,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'No se pudo contactar el servicio de correo.' })
    };
  }

  // Leer respuesta de la API
  let apiBody;
  try {
    apiBody = await apiResponse.json();
  } catch {
    apiBody = { raw: await apiResponse.text().catch(() => '') };
  }

  // Log de auditoría (SIN exponer la clave)
  console.log('[sendmail]', {
    status:     apiResponse.status,
    recipients: validEmails.length,
    subject:    subject.slice(0, 80),
    timestamp:  new Date().toISOString()
  });

  // Reenvía el status y body de la API al cliente (sin la clave)
  return {
    statusCode: apiResponse.status,
    headers: corsHeaders(),
    body: JSON.stringify(apiBody)
  };
};

// ── Vercel (edge/node): exporta también como default ──────────
// Para Vercel, renombra a /api/sendmail.js y exporta:
// export default async function handler(req, res) { ... }

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}
