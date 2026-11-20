
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json(405, { error: 'Método no permitido.' })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const secretKey = Deno.env.get('MOTUM_SUPABASE_SECRET_KEY')

  if (!supabaseUrl || !anonKey || !secretKey) {
    return json(500, { error: 'Faltan variables de entorno de Supabase.' })
  }

  const authorization = req.headers.get('Authorization') || ''
  if (!authorization.startsWith('Bearer ')) {
    return json(401, { error: 'Sesión no válida.' })
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const adminClient = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: authData, error: authError } = await userClient.auth.getUser()

  if (authError || !authData.user) {
    return json(401, { error: 'No se pudo validar la sesión.' })
  }

  const callerId = authData.user.id

  const { data: callerProfile, error: profileError } = await adminClient
    .from('perfiles')
    .select('activo')
    .eq('id', callerId)
    .maybeSingle()

  if (profileError || !callerProfile?.activo) {
    return json(403, { error: 'La cuenta administradora no está activa.' })
  }

  const { data: adminRole, error: adminRoleError } = await adminClient
    .from('roles')
    .select('id,nombre')
    .ilike('nombre', 'Administrador')
    .maybeSingle()

  if (adminRoleError || !adminRole) {
    return json(500, { error: 'No fue posible validar el rol Administrador.' })
  }

  const { data: callerRoles, error: callerRolesError } = await adminClient
    .from('usuario_roles')
    .select('rol_id')
    .eq('usuario_id', callerId)

  if (callerRolesError) {
    return json(500, { error: 'No fue posible validar los permisos.' })
  }

  if (!(callerRoles || []).some((row: any) => row.rol_id === adminRole.id)) {
    return json(403, { error: 'Solo un Administrador puede eliminar usuarios.' })
  }

  let body: any

  try {
    body = await req.json()
  } catch {
    return json(400, { error: 'El cuerpo de la solicitud no contiene JSON válido.' })
  }

  const targetUserId = String(body.user_id || '').trim()

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetUserId)) {
    return json(400, { error: 'El identificador del usuario no es válido.' 

// Protección temporal: solo permite eliminar la cuenta
// de prueba expresamente autorizada.
const allowedTestUserId = Deno.env.get('MOTUM_DELETE_ALLOWED_USER_ID')

if (!allowedTestUserId || targetUserId !== allowedTestUserId) {
  return json(403, {
    error: 'Durante las pruebas, únicamente está autorizada la eliminación de la cuenta de prueba.'
                     })
  }

  if (targetUserId === callerId) {
    return json(409, { error: 'No puedes eliminar tu propia cuenta.' })
  }

  const { data: targetProfile, error: targetProfileError } = await adminClient
    .from('perfiles')
    .select('id,correo')
    .eq('id', targetUserId)
    .maybeSingle()

  if (targetProfileError) {
    return json(500, { error: 'No fue posible consultar el perfil.' })
  }

  if (!targetProfile) {
    return json(404, { error: 'El usuario no existe en la aplicación.' })
  }

  // Validar que siempre quede al menos un administrador activo.
  const { data: adminAssignments, error: assignmentsError } = await adminClient
    .from('usuario_roles')
    .select('usuario_id')
    .eq('rol_id', adminRole.id)

  if (assignmentsError) {
    return json(500, { error: 'No fue posible validar los administradores.' })
  }

  const adminIds = [...new Set(
    (adminAssignments || []).map((row: any) => row.usuario_id)
  )]

  if (adminIds.includes(targetUserId)) {
    const { data: activeAdmins, error: activeAdminsError } = await adminClient
      .from('perfiles')
      .select('id')
      .in('id', adminIds)
      .eq('activo', true)

    if (activeAdminsError) {
      return json(500, { error: 'No fue posible validar los administradores activos.' })
    }

    const otherActiveAdmins = (activeAdmins || []).filter(
      (row: any) => row.id !== targetUserId
    )

    if (otherActiveAdmins.length === 0) {
      return json(409, {
        error: 'No puedes eliminar al último Administrador activo del sistema.'
      })
    }
  }

  // Eliminar la identidad de Auth.
  const { error: deleteError } = await adminClient.auth.admin.deleteUser(targetUserId)

  if (deleteError) {
    return json(409, {
      error: 'Supabase no pudo eliminar la cuenta. Detalle: ' + deleteError.message
    })
  }

  return json(200, {
    ok: true,
    user_id: targetUserId,
    email: targetProfile.correo,
    message: 'La cuenta fue eliminada correctamente.'
  })
})
