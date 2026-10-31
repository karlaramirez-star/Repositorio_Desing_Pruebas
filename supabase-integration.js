/*
 * Motum Digital Repository — Supabase integration layer
 * Built for the supplied single-file HTML application.
 * IMPORTANT: replace SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY before publishing.
 * Do not put a Supabase Secret/service_role key in this file.
 */
(function () {
  'use strict';

  // ── 0. Project configuration ─────────────────────────────────────────────
  const SUPABASE_URL = 'https://zxkmxtthgvwzrqpmfaso.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_DiE3bATktxW8hSniZbYjYg_cBgYITX6';
  const SUPABASE_BUCKET = 'plantillas';
  const SUPABASE_AVATAR_BUCKET = 'avatars';
  const CORPORATE_DOMAIN = 'tecnomotum.com';
  const ADMIN_INVITE_FUNCTION = 'admin-invite-user';

  let sbClient = null;
  let currentSupabaseUser = null;
  let authProcessing = null;
  let lastLoadedUserId = null;

  const $ = (id) => document.getElementById(id);
  const safeText = (value) => String(value == null ? '' : value)
    .replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  const slugify = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const localDepartment = (id) => (window.AREAS || []).find((area) => String(area.id) === String(id));
  const departmentUuid = (id) => { const area = localDepartment(id); return area ? area.dbId : null; };
  const localAreaIds = (uuids) => (uuids || []).map((uuid) => {
    const area = (window.AREAS || []).find((item) => item.dbId === uuid);
    return area ? area.id : null;
  }).filter((id) => id != null);
  const showMessage = (message, type) => {
    if (typeof window.showToast === 'function') window.showToast(message, type || 'error');
    else console[type === 'success' ? 'log' : 'error'](message);
  };
  const ensureClient = () => {
    if (!sbClient) throw new Error('Supabase no está configurado. Completa SUPABASE_URL y SUPABASE_PUBLISHABLE_KEY en supabase-integration.js.');
    return sbClient;
  };
  const getCurrentUser = () => currentSupabaseUser;
  const currentUserId = () => currentSupabaseUser ? currentSupabaseUser.id : null;
  const isAdmin = () => !!(window._isAdminSession && currentSupabaseUser);
  const permissionSet = () => new Set(window._motumPermissionCodes || []);
  const hasPermission = (code) => isAdmin() || permissionSet().has(code);
  const canUseAdminPanel = () => isAdmin() || [
    'plantillas.crear','plantillas.editar',
    'contenido.crear','contenido.editar',
    'categorias.administrar','historial.ver','departamentos.administrar','usuarios.ver'
  ].some((code) => permissionSet().has(code));
  const canUseAdminSection = (section) => {
    if (isAdmin()) return true;
    const required = {
      plantillas: ['plantillas.ver','plantillas.crear','plantillas.editar'],
      contenido: ['contenido.ver','contenido.crear','contenido.editar'],
      categorias: ['categorias.administrar'],
      logs: ['historial.ver'],
      areas: ['departamentos.administrar'],
      users: ['usuarios.ver'],
      profile: [],
      notificaciones: ['notificaciones.ver'],
      adopcion: ['adopcion.ver']
    };
    return (required[section] || []).some((code) => permissionSet().has(code)) || section === 'profile';
  };

  function showAuthError(message) {
    const targets = ['reg-err', 'login-err'];
    targets.forEach((id) => {
      const el = $(id);
      if (el) { el.textContent = message; el.style.display = 'block'; }
    });
    ['auth-status', 'auth-status-admin'].forEach((id) => {
      const el = $(id); if (el) el.style.display = 'none';
    });
    ['btn-google-signin', 'btn-google-signin-admin'].forEach((id) => {
      const el = $(id); if (el) el.disabled = false;
    });
  }

  function setAuthLoading(loading) {
    ['btn-google-signin', 'btn-google-signin-admin'].forEach((id) => {
      const el = $(id); if (el) el.disabled = !!loading;
    });
    ['auth-status', 'auth-status-admin'].forEach((id) => {
      const el = $(id); if (el) el.style.display = loading ? 'flex' : 'none';
    });
  }

  // ── 1. Auth: Supabase Google OAuth (replaces Firebase and static admin login)
  window.signInWithGoogle = async function signInWithGoogle() {
    try {
      const client = ensureClient();
      setAuthLoading(true);
      ['reg-err', 'login-err'].forEach((id) => { if ($(id)) $(id).style.display = 'none'; });
      const redirectTo = window.location.href.split('#')[0].split('?')[0];
      const { error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          queryParams: { hd: CORPORATE_DOMAIN, prompt: 'select_account' }
        }
      });
      if (error) throw error;
    } catch (error) {
      setAuthLoading(false);
      showAuthError('No fue posible iniciar sesión con Google: ' + (error.message || 'verifica la configuración de Supabase.'));
    }
  };

  // Legacy admin form now uses the same Google OAuth provider.
  window.doLogin = function doLogin() { return window.signInWithGoogle(); };
  window.isAuthenticated = function isAuthenticated() { return !!currentSupabaseUser; };
  window.destroySession = function destroySession() {
    currentSupabaseUser = null;
    lastLoadedUserId = null;
    window._supabaseUser = null;
    window._regUser = null;
    window._isAdminSession = false;
    window._canUseAdminPanel = false;
    window._motumPermissionCodes = [];
    window._motumDepartmentIds = [];
    window.currentArea = null;
    window.currentDestino = null;
    window.currentPlantilla = null;
    window.currentAdminUser = null;
  };
  window.logout = async function logout() {
    try { if (sbClient) await sbClient.auth.signOut(); } catch (error) { console.error('Error al cerrar sesión:', error); }
    window.destroySession();
    document.querySelectorAll('.page,.page-flex').forEach((el) => {
      el.className = el.classList.contains('page-flex') ? 'page-flex' : 'page';
    });
    const welcome = $('pg-welcome');
    if (welcome) welcome.className = 'page active';
    window.scrollTo(0, 0);
  };

  async function fetchUserContext(user) {
    const client = ensureClient();
    const email = String(user.email || '').toLowerCase();
    if (!email.endsWith('@' + CORPORATE_DOMAIN)) {
      throw new Error('Acceso restringido. Solo se permiten cuentas @' + CORPORATE_DOMAIN + '.');
    }

    let profile = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, error } = await client.from('perfiles')
        .select('id,nombre_completo,correo,telefono,activo,avatar_url')
        .eq('id', user.id).maybeSingle();
      if (error) throw error;
      profile = data;
      if (profile) break;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    if (!profile) throw new Error('Tu cuenta no tiene un perfil registrado. Contacta al administrador.');
    if (!profile.activo) throw new Error('Tu cuenta está inactiva. Contacta al administrador.');

    const { data: userRoleRows, error: roleRowsError } = await client
      .from('usuario_roles').select('rol_id').eq('usuario_id', user.id);
    if (roleRowsError) throw roleRowsError;
    const roleIds = (userRoleRows || []).map((row) => row.rol_id);
    if (!roleIds.length) throw new Error('Tu cuenta todavía no tiene un rol asignado. Contacta al administrador.');

    const { data: roles, error: rolesError } = await client.from('roles')
      .select('id,nombre').in('id', roleIds);
    if (rolesError) throw rolesError;
    const roleNames = (roles || []).map((row) => row.nombre);
    const admin = roleNames.some((name) => String(name).toLowerCase() === 'administrador');

    let permissionCodes = [];
    if (roleIds.length) {
      const { data: rolePermissionRows, error: rolePermissionError } = await client
        .from('rol_permisos').select('permiso_id').in('rol_id', roleIds);
      if (rolePermissionError) throw rolePermissionError;
      const permissionIds = [...new Set((rolePermissionRows || []).map((row) => row.permiso_id))];
      if (permissionIds.length) {
        const { data: permissionRows, error: permissionError } = await client
          .from('permisos').select('codigo').in('id', permissionIds);
        if (permissionError) throw permissionError;
        permissionCodes = (permissionRows || []).map((row) => row.codigo);
      }
    }

    const { data: userDeptRows, error: deptRowsError } = await client
      .from('usuario_departamentos').select('departamento_id').eq('usuario_id', user.id);
    if (deptRowsError) throw deptRowsError;
    const deptIds = (userDeptRows || []).map((row) => row.departamento_id);
    if (!admin && !deptIds.length) throw new Error('Tu cuenta no tiene un departamento asignado. Contacta al administrador.');

    const { data: allDepartments, error: allDepartmentsError } = await client
      .from('departamentos').select('id,nombre,descripcion,activo').eq('activo', true).order('nombre');
    if (allDepartmentsError) throw allDepartmentsError;

    const myDepartments = (allDepartments || []).filter((row) => deptIds.includes(row.id));
    return { profile, roles: roleNames, permissions: permissionCodes, isAdmin: admin, departments: allDepartments || [], myDepartments };
  }

  function rebuildDepartments(rows) {
    const source = (rows || []).filter((row) => String(row.nombre).toLowerCase() !== 'administrador');
    const mapped = source.map((row, index) => ({
      id: index + 1,
      dbId: row.id,
      nombre: row.nombre,
      descripcion: row.descripcion || '',
      slug: slugify(row.nombre),
      emoji: '📁'
    }));
    if (Array.isArray(window.AREAS)) window.AREAS.splice(0, window.AREAS.length, ...mapped);
    refreshDepartmentSelects();
  }

  function refreshDepartmentSelects() {
    const areaSelect = $('umod-area');
    if (areaSelect) {
      const existing = areaSelect.value;
      areaSelect.innerHTML = '<option value="">Selecciona un departamento...</option>' +
        (window.AREAS || []).map((area) => '<option value="' + area.id + '">' + safeText(area.nombre) + '</option>').join('');
      if (existing) areaSelect.value = existing;
    }
    const categoryArea = $('catmod-area');
    if (categoryArea) {
      const value = categoryArea.value;
      categoryArea.innerHTML = '<option value="">Global (todas las áreas)</option>' +
        (window.AREAS || []).map((area) => '<option value="' + area.id + '">' + safeText(area.nombre) + '</option>').join('');
      categoryArea.value = value;
    }
  }

  function buildCategoryData(rows) {
    const mapped = (rows || []).map((row, index) => {
      const dept = (window.AREAS || []).find((area) => area.dbId === row.departamento_id);
      return {
        id: index + 1,
        dbId: row.id,
        nombre: row.nombre,
        slug: row.slug,
        modulo: row.modulo,
        areaId: dept ? dept.id : null
      };
    });
    if (Array.isArray(window.CATEGORIES_DATA)) window.CATEGORIES_DATA.splice(0, window.CATEGORIES_DATA.length, ...mapped);
    const digital = (rows || []).filter((row) => row.modulo === 'digital' || row.modulo === 'ambos')
      .map((row) => ({ id: row.slug, nombre: row.nombre }));
    if (Array.isArray(DIGITAL_CATS) && digital.length) DIGITAL_CATS.splice(0, DIGITAL_CATS.length, ...digital);
  }

  async function signedPreview(path) {
    if (!path) return '';
    try {
      const { data, error } = await sbClient.storage.from(SUPABASE_BUCKET).createSignedUrl(path, 3600);
      return error ? '' : (data && data.signedUrl) || '';
    } catch (_) { return ''; }
  }

  async function loadApplicationData(context) {
    const client = ensureClient();
    const admin = !!context.isAdmin;
    const profileQuery = client.from('perfiles').select('id,nombre_completo,correo,telefono,activo,avatar_url');
    const profilesPromise = admin ? profileQuery.order('nombre_completo') : profileQuery.eq('id', currentSupabaseUser.id);

    const results = await Promise.all([
      client.from('departamentos').select('id,nombre,descripcion,activo').eq('activo', true).order('nombre'),
      profilesPromise,
      client.from('roles').select('id,nombre'),
      client.from('usuario_roles').select('usuario_id,rol_id'),
      client.from('usuario_departamentos').select('usuario_id,departamento_id'),
      client.from('categorias').select('id,nombre,slug,modulo,departamento_id').order('nombre'),
      client.from('plantillas').select('*').order('created_at', { ascending: false }),
      client.from('plantilla_departamentos').select('plantilla_id,departamento_id'),
      client.from('notificaciones').select('*').order('created_at', { ascending: false }).limit(300),
      client.from('historial_actividades').select('*').order('created_at', { ascending: false }).limit(1000)
    ]);

    const labels = ['departamentos','perfiles','roles','usuario_roles','usuario_departamentos','categorias','plantillas','plantilla_departamentos','notificaciones','historial_actividades'];
    results.forEach((result, index) => {
      if (result.error) throw new Error('No se pudo consultar ' + labels[index] + ': ' + result.error.message);
    });

    const departments = results[0].data || [];
    const profiles = results[1].data || [];
    const roles = results[2].data || [];
    const userRoles = results[3].data || [];
    const userDepartments = results[4].data || [];
    const categories = results[5].data || [];
    const templateRows = results[6].data || [];
    const templateDepartments = results[7].data || [];
    const notifications = results[8].data || [];
    const activities = results[9].data || [];

    rebuildDepartments(departments);
    buildCategoryData(categories);

    const rolesByUser = {};
    userRoles.forEach((link) => {
      const role = roles.find((row) => row.id === link.rol_id);
      if (!rolesByUser[link.usuario_id]) rolesByUser[link.usuario_id] = [];
      if (role) rolesByUser[link.usuario_id].push(role.nombre);
    });
    const deptsByUser = {};
    userDepartments.forEach((link) => {
      if (!deptsByUser[link.usuario_id]) deptsByUser[link.usuario_id] = [];
      deptsByUser[link.usuario_id].push(link.departamento_id);
    });
    if (Array.isArray(window.USERS_DB)) {
      const mappedUsers = profiles.map((row, index) => {
        const deptUuids = deptsByUser[row.id] || [];
        const deptNames = departments.filter((dept) => deptUuids.includes(dept.id)).map((dept) => dept.nombre);
        const userRoleNames = rolesByUser[row.id] || [];
        const userAdmin = userRoleNames.some((name) => name.toLowerCase() === 'administrador');
        return {
          id: index + 1,
          authUserId: row.id,
          nombre: row.nombre_completo || row.correo || 'Usuario',
          email: row.correo || '',
          telefono: row.telefono || '',
          avatarPath: row.avatar_url || '',
          area: userAdmin ? 'Administrador' : (deptNames[0] || 'Sin departamento'),
          areas: deptNames,
          departmentIds: deptUuids,
          rol: userRoleNames[0] || 'Usuario',
          roles: userRoleNames,
          activo: row.activo !== false
        };
      });
      window.USERS_DB.splice(0, window.USERS_DB.length, ...mappedUsers);
    }

    const linksByTemplate = {};
    templateDepartments.forEach((link) => {
      if (!linksByTemplate[link.plantilla_id]) linksByTemplate[link.plantilla_id] = [];
      linksByTemplate[link.plantilla_id].push(link.departamento_id);
    });
    const templateRowsOnly = templateRows.filter((row) => (row.tipo_registro || 'plantilla') === 'plantilla');
    const mappedTemplates = await Promise.all(templateRowsOnly.map(async (row, index) => {
      const deptUuids = linksByTemplate[row.id] || [];
      const areaIds = localAreaIds(deptUuids);
      return {
        id: index + 1,
        dbId: row.id,
        areaId: areaIds[0] || 0,
        areaIds,
        nombre: row.nombre,
        desc: row.descripcion || '',
        categoria: row.categoria || '',
        urlCanva: row.url_canva || '',
        urlDrive: row.url_drive || '',
        preview: await signedPreview(row.preview_url),
        preview_path: row.preview_url || '',
        activa: row.activo !== false && row.estado === 'publicada'
      };
    }));
    if (Array.isArray(plantillas)) plantillas.splice(0, plantillas.length, ...mappedTemplates);

    const digitalRows = templateRows.filter((row) => row.tipo_registro === 'contenido_digital');
    const mappedDigital = digitalRows.map((row, index) => {
      const deptUuids = linksByTemplate[row.id] || [];
      return {
        id: index + 1,
        dbId: row.id,
        catId: row.categoria || 'actualizaciones',
        nombre: row.nombre,
        tipo: (row.tipo_archivo || 'PDF').replace(/^application\//, '').toUpperCase(),
        tam: row.tamano || '—',
        fecha: row.created_at ? row.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10),
        activo: row.activo !== false,
        ruta: row.ruta_archivo || '',
        nombreArchivo: row.nombre_archivo || '',
        areaIds: localAreaIds(deptUuids)
      };
    });
    if (Array.isArray(DIGITAL_ITEMS_DATA)) DIGITAL_ITEMS_DATA.splice(0, DIGITAL_ITEMS_DATA.length, ...mappedDigital);

    const profileById = {};
    profiles.forEach((profile) => { profileById[profile.id] = profile; });
    const mappedLogs = activities.map((row, index) => {
      const profile = profileById[row.usuario_id] || {};
      const details = row.detalles || {};
      const user = (window.USERS_DB || []).find((item) => item.authUserId === row.usuario_id);
      return {
        id: index + 1,
        dbId: row.id,
        authUserId: row.usuario_id,
        nombre: profile.nombre_completo || user?.nombre || 'Usuario',
        email: profile.correo || user?.email || '',
        area: details.area || (user?.area || '—'),
        plantillaNombre: details.plantillaNombre || row.descripcion || row.accion,
        tipo: details.tipo || row.accion,
        fecha: row.created_at,
        modulo: row.modulo,
        accion: row.accion
      };
    });
    if (Array.isArray(logs)) logs.splice(0, logs.length, ...mappedLogs);

    const mappedNotifications = notifications.map((row, index) => ({
      id: index + 1,
      dbId: row.id,
      type: row.tipo || 'general',
      subject: row.titulo,
      htmlBody: row.html_body || '',
      recipients: Array.isArray(row.destinatarios) ? row.destinatarios : [],
      fecha: row.created_at,
      status: row.estado || 'pendiente',
      httpCode: row.http_code || null,
      apiMsg: row.api_mensaje || null,
      apiData: row.api_data || null,
      payload: { nombre: row.titulo, plantillaId: row.plantilla_id }
    }));
    if (Array.isArray(window.notificationLog)) window.notificationLog.splice(0, window.notificationLog.length, ...mappedNotifications);

    if (window.ACADEMY_DATA) {
      window.ACADEMY_DATA.sessions = mappedLogs.filter((row) => row.tipo === 'canva' || row.tipo === 'drive' || row.accion === 'Inicio de sesión')
        .map((row) => {
          const user = (window.USERS_DB || []).find((item) => item.authUserId === row.authUserId);
          return user ? { id: row.id, userId: user.id, nombre: row.nombre, email: row.email, area: row.area, fecha: row.fecha, dur: 0, completado: false } : null;
        }).filter(Boolean);
      window.ACADEMY_DATA.areas = (window.AREAS || []).map((area) => area.nombre);
    }
  }

  async function processAuthSession(session) {
  if (!session || !session.user) return;
  const user = session.user;

  // Evita volver a procesar una sesión que ya fue cargada.
  if (
    currentSupabaseUser &&
    currentSupabaseUser.id === user.id &&
    lastLoadedUserId === user.id
  ) {
    return;
  }

  if (authProcessing) return authProcessing;
    authProcessing = (async () => {
      try {
        setAuthLoading(true);
        const context = await fetchUserContext(user);
        currentSupabaseUser = user;
        window._supabaseUser = user;
        window._isAdminSession = context.isAdmin;
        window._motumPermissionCodes = context.permissions || [];
        window._motumDepartmentIds = context.myDepartments.map((dept) => dept.id);
        window._canUseAdminPanel = canUseAdminPanel();
        const areas = context.myDepartments.map((dept) => dept.nombre);
        const profileName = context.profile.nombre_completo || user.user_metadata?.full_name || user.email.split('@')[0];
        window._regUser = {
          id: user.id,
          nombre: profileName,
          email: user.email,
          area: context.isAdmin ? 'Administrador' : (areas[0] || ''),
          areas,
          foto: user.user_metadata?.avatar_url || null,
          departmentIds: context.myDepartments.map((dept) => dept.id),
          authMethod: 'supabase-google'
        };
        window.currentAdminUser = {
          id: user.id,
          nombre: profileName,
          email: user.email,
          rol: context.isAdmin ? 'Administrador' : (context.roles[0] || 'Usuario')
        };
        window._adminPhotoDataUrl = context.profile.avatar_url
          ? await signedAvatar(context.profile.avatar_url)
          : (user.user_metadata?.avatar_url || '');
        window._regUser.foto = window._adminPhotoDataUrl || null;
        await loadApplicationData(context);
        if (lastLoadedUserId !== user.id) {
          lastLoadedUserId = user.id;
          await writeActivity('Autenticación', 'Inicio de sesión', 'Inicio de sesión con Google mediante Supabase.', { area: window._regUser.area });
        }
        setAuthLoading(false);
        ['reg-err', 'login-err'].forEach((id) => { if ($(id)) $(id).style.display = 'none'; });
        if (window._canUseAdminPanel) window.goTo('pg-admin');
        else window.goTo('pg-landing');
      } catch (error) {
        console.error('No se pudo validar la sesión Supabase:', error);
        await sbClient.auth.signOut();
        window.destroySession();
        setAuthLoading(false);
        showAuthError(error.message || 'No fue posible validar tu cuenta. Contacta al administrador.');
      }
    })().finally(() => { authProcessing = null; });
    return authProcessing;
  }

  // ── 2. Database: activity history ─────────────────────────────────────────
  async function writeActivity(modulo, accion, descripcion, detalles) {
    if (!sbClient || !currentUserId()) return null;
    const row = {
      usuario_id: currentUserId(),
      modulo: modulo || 'General',
      accion: accion || 'Actividad',
      descripcion: descripcion || '',
      detalles: detalles || {}
    };
    const { data, error } = await sbClient.from('historial_actividades').insert(row).select().single();
    if (error) { console.error('No se pudo guardar el historial:', error); return null; }
    const user = window._regUser || {};
    const local = {
      id: Date.now(), dbId: data.id, authUserId: currentUserId(),
      nombre: user.nombre || '', email: user.email || '', area: user.area || '',
      plantillaNombre: descripcion || accion, tipo: (detalles && detalles.tipo) || accion,
      fecha: data.created_at || new Date().toISOString(), modulo, accion
    };
    if (Array.isArray(logs)) logs.unshift(local);
    if (window.ACADEMY_DATA && Array.isArray(window.ACADEMY_DATA.sessions) && (accion === 'Inicio de sesión' || accion === 'Acceso a plantilla')) {
      const usr = (window.USERS_DB || []).find((item) => item.authUserId === currentUserId());
      if (usr) window.ACADEMY_DATA.sessions.unshift({ id: local.id, userId: usr.id, nombre: local.nombre, email: local.email, area: local.area, fecha: local.fecha, dur: 0, completado: false });
    }
    return data;
  }
  window.logMotumActivity = writeActivity;

  // ── 3. Users, roles and departments ────────────────────────────────────────
  function ensurePhoneField() {
    if ($('umod-phone')) return;
    const email = $('umod-email');
    const parent = email && email.closest('.field');
    if (!parent) return;
    const field = document.createElement('div');
    field.className = 'field';
    field.innerHTML = '<label>Teléfono</label><input id="umod-phone" type="tel" placeholder="Número telefónico"/>';
    parent.insertAdjacentElement('afterend', field);
  }

  window.renderAdminUsers = function renderAdminUsers() {
    const sec = $('admin-sec-users'); if (!sec) return;
    const term = String(window.usersSearch || '').toLowerCase();
    const list = (window.USERS_DB || []).filter((u) => [u.nombre,u.email,u.area,u.rol].join(' ').toLowerCase().includes(term));
    const rows = list.map((u) => '<tr>' +
      '<td><div class="td-name">' + safeText(u.nombre) + '</div></td>' +
      '<td style="color:var(--muted);font-size:12px">' + safeText(u.email) + '</td>' +
      '<td><span class="badge" style="background:var(--blue-light);color:var(--blue-main)">' + safeText((u.areas || [u.area]).join(', ')) + '</span></td>' +
      '<td><span class="badge" style="background:#f0f9ff;color:#0369a1">' + safeText(u.rol || 'Usuario') + '</span></td>' +
      '<td><span class="badge" style="background:' + (u.activo ? '#dcfce7' : '#f1f5f9') + ';color:' + (u.activo ? '#16a34a' : '#64748b') + '">' + (u.activo ? 'Activo' : 'Inactivo') + '</span></td>' +
      '<td><div class="row-actions"><button class="icon-btn" title="Editar" onclick="openUserModal(' + u.id + ')">&#9998;</button>' +
      '<button class="icon-btn danger" title="Desactivar" onclick="deleteUser(' + u.id + ')">&#10005;</button></div></td></tr>').join('');
    sec.innerHTML = '<div class="stats-row" style="grid-template-columns:repeat(3,1fr)">' +
      '<div class="stat-card"><div class="stat-label">Total usuarios</div><div class="stat-val">' + (window.USERS_DB || []).length + '</div></div>' +
      '<div class="stat-card"><div class="stat-label">Activos</div><div class="stat-val">' + (window.USERS_DB || []).filter((u) => u.activo).length + '</div></div>' +
      '<div class="stat-card"><div class="stat-label">Áreas cubiertas</div><div class="stat-val">' + new Set((window.USERS_DB || []).flatMap((u) => u.areas || [u.area])).size + '</div></div></div>' +
      '<div class="section-head"><div style="display:flex;align-items:center;gap:10px"><h2>Usuarios registrados</h2>' +
      '<input value="' + safeText(window.usersSearch || '') + '" oninput="usersSearch=this.value;renderAdminUsers()" placeholder="Buscar usuario..." style="width:210px;font-size:13px"/></div>' +
      '<button class="btn-primary btn-sm" onclick="openUserModal(null)">＋ Añadir usuario</button></div>' +
      '<table><thead><tr><th>Nombre</th><th>Correo</th><th>Departamento</th><th>Rol</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="6" style="text-align:center;padding:28px;color:var(--muted)">Sin usuarios registrados.</td></tr>') + '</tbody></table>' +
      '<p style="margin-top:12px;font-size:11px;color:var(--muted)">Los usuarios nuevos reciben una invitación por correo. Deben iniciar sesión con su cuenta Google corporativa.</p>';
  };

  window.openUserModal = function openUserModal(id) {
    ensurePhoneField();
    const user = id ? (window.USERS_DB || []).find((item) => item.id === id) : null;
    window.userModalData = user || null;
    $('umod-title').textContent = user ? 'Editar usuario' : 'Invitar usuario';
    $('umod-id').value = user ? user.id : '';
    $('umod-nombre').value = user ? user.nombre : '';
    $('umod-email').value = user ? user.email : '';
    $('umod-email').readOnly = !!user;
    $('umod-phone').value = user ? (user.telefono || '') : '';
    $('umod-activo').checked = user ? user.activo : true;
    const areaSelect = $('umod-area');
    areaSelect.innerHTML = '<option value="">Selecciona un departamento...</option>' +
      (window.AREAS || []).map((area) => '<option value="' + area.id + '">' + safeText(area.nombre) + '</option>').join('');
    areaSelect.value = user && user.area !== 'Administrador' ? String((window.AREAS || []).find((a) => a.nombre === user.area)?.id || '') : '';
    if (window._isAdminSession && user && user.rol === 'Administrador') {
      areaSelect.innerHTML = '<option value="">Sin departamento (Administrador)</option>' + areaSelect.innerHTML;
      areaSelect.value = '';
    }
    const roleSelect = $('umod-rol');
    roleSelect.innerHTML = ['Administrador','Editor','Usuario','Monitorista'].map((name) =>
      '<option value="' + name + '">' + name + '</option>').join('');
    roleSelect.value = user ? (user.rol || 'Usuario') : 'Usuario';
    $('umod-err').style.display = 'none';
    $('user-modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  };

  window.saveUser = async function saveUser() {
    const errEl = $('umod-err');
    const id = $('umod-id').value;
    const name = $('umod-nombre').value.trim();
    const email = $('umod-email').value.trim().toLowerCase();
    const phone = $('umod-phone') ? $('umod-phone').value.trim() : '';
    const deptLocalId = $('umod-area').value;
    const roleName = $('umod-rol').value;
    const active = $('umod-activo').checked;
    const dept = deptLocalId ? localDepartment(deptLocalId) : null;
    if (!name) { errEl.textContent = 'El nombre es obligatorio.'; errEl.style.display = 'block'; return; }
    if (!email || !email.includes('@')) { errEl.textContent = 'Correo inválido.'; errEl.style.display = 'block'; return; }
    if (!String(email).endsWith('@' + CORPORATE_DOMAIN)) { errEl.textContent = 'Solo se permiten correos @' + CORPORATE_DOMAIN + '.'; errEl.style.display = 'block'; return; }
    if (roleName !== 'Administrador' && !dept) { errEl.textContent = 'Selecciona un departamento para este usuario.'; errEl.style.display = 'block'; return; }
    errEl.style.display = 'none';
    const btn = $('user-modal').querySelector('.modal-foot .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
    try {
      if (!id) {
        const { data, error } = await ensureClient().functions.invoke(ADMIN_INVITE_FUNCTION, {
          body: { nombre: name, email, telefono: phone, rol: roleName, departamento_id: dept ? dept.dbId : null, activo: active }
        });
        if (error) throw new Error(error.message || 'No se pudo invitar al usuario.');
        if (!data || !data.ok) throw new Error(data && data.error ? data.error : 'La función de invitación no confirmó el registro.');
        showMessage('Usuario registrado y permisos asignados. Ya puede ingresar con su cuenta Google corporativa.', 'success');
      } else {
        const user = (window.USERS_DB || []).find((item) => String(item.id) === String(id));
        if (!user || !user.authUserId) throw new Error('No se encontró el identificador de autenticación del usuario.');
        if (email !== user.email.toLowerCase()) throw new Error('El correo de acceso no se cambia desde este formulario; debe actualizarse desde la administración de Auth.');
        const { error: profileError } = await ensureClient().from('perfiles').update({
          nombre_completo: name, telefono: phone || null, activo: active, updated_at: new Date().toISOString()
        }).eq('id', user.authUserId);
        if (profileError) throw profileError;
        const { data: role, error: roleError } = await ensureClient().from('roles').select('id').ilike('nombre', roleName).single();
        if (roleError) throw roleError;
        const { error: deleteRolesError } = await ensureClient().from('usuario_roles').delete().eq('usuario_id', user.authUserId);
        if (deleteRolesError) throw deleteRolesError;
        const { error: insertRoleError } = await ensureClient().from('usuario_roles').insert({ usuario_id: user.authUserId, rol_id: role.id, asignado_por: currentUserId() });
        if (insertRoleError) throw insertRoleError;
        const { error: deleteDeptError } = await ensureClient().from('usuario_departamentos').delete().eq('usuario_id', user.authUserId);
        if (deleteDeptError) throw deleteDeptError;
        if (dept) {
          const { error: insertDeptError } = await ensureClient().from('usuario_departamentos').insert({ usuario_id: user.authUserId, departamento_id: dept.dbId });
          if (insertDeptError) throw insertDeptError;
        }
      }
      await loadApplicationData({ isAdmin: isAdmin() });
      window.closeUserModal();
      window.renderAdminUsers();
      await writeActivity('Usuarios', id ? 'Actualización' : 'Invitación', (id ? 'Se actualizó el usuario ' : 'Se invitó al usuario ') + email, { rol: roleName, departamento: dept?.nombre || 'Sin departamento' });
    } catch (error) {
      console.error(error);
      errEl.textContent = error.message || 'No fue posible guardar el usuario.';
      errEl.style.display = 'block';
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
    }
  };

  window.deleteUser = async function deleteUser(id) {
    const user = (window.USERS_DB || []).find((item) => item.id === id);
    if (!user || !user.authUserId) return;
    if (!confirm('¿Desactivar el acceso de ' + user.nombre + '?')) return;
    const { error } = await ensureClient().from('perfiles').update({ activo: false, updated_at: new Date().toISOString() }).eq('id', user.authUserId);
    if (error) { showMessage('No se pudo desactivar el usuario: ' + error.message, 'error'); return; }
    await loadApplicationData({ isAdmin: isAdmin() });
    window.renderAdminUsers();
    await writeActivity('Usuarios', 'Desactivación', 'Se desactivó el usuario ' + user.email, {});
    showMessage('Usuario desactivado.', 'success');
  };

  window.bulkUploadUsers = async function bulkUploadUsers(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const text = await file.text();
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) { showMessage('El archivo no contiene registros.', 'error'); input.value = ''; return; }
    const header = lines[0].split(',').map((x) => x.trim().toLowerCase());
    if (!['nombre','correo','area','estado'].every((name) => header.includes(name))) {
      showMessage('Encabezados incorrectos. Utiliza la plantilla descargable.', 'error'); input.value = ''; return;
    }
    const index = Object.fromEntries(header.map((name, i) => [name, i]));
    let ok = 0, failed = 0;
    for (const line of lines.slice(1)) {
      const cells = line.split(',').map((x) => x.trim());
      const name = cells[index.nombre] || '';
      const email = (cells[index.correo] || '').toLowerCase();
      const dept = (window.AREAS || []).find((area) => area.nombre.toLowerCase() === (cells[index.area] || '').toLowerCase());
      if (!name || !email || !dept) { failed++; continue; }
      const { data, error } = await ensureClient().functions.invoke(ADMIN_INVITE_FUNCTION, {
        body: { nombre: name, email, rol: 'Usuario', departamento_id: dept.dbId, activo: !['inactivo','0','false'].includes(String(cells[index.estado] || 'activo').toLowerCase()) }
      });
      if (error || !data?.ok) failed++; else ok++;
    }
    await loadApplicationData({ isAdmin: isAdmin() });
    window.renderAdminUsers();
    showMessage('Carga finalizada: ' + ok + ' invitaciones; ' + failed + ' registros no procesados.', failed ? 'error' : 'success');
    input.value = '';
  };

  // ── 4. Templates CRUD and department relations ─────────────────────────────
  const legacyOpenPlantillaModal = window.openPlantillaModal;
  window.openPlantillaModal = function openPlantillaModal(id) {
    if (typeof legacyOpenPlantillaModal === 'function') legacyOpenPlantillaModal(id);
    const input = $('crud-cat');
    if (!input) return;
    const selected = input.value;
    const categories = (window.CATEGORIES_DATA || []).filter((cat) => cat.modulo === 'plantillas' || cat.modulo === 'ambos');
    const unique = [...new Map(categories.map((cat) => [cat.nombre, cat])).values()];
    input.disabled = false;
    input.innerHTML = '<option value="">Selecciona una categoría</option>' + unique.map((cat) =>
      '<option value="' + safeText(cat.nombre) + '">' + safeText(cat.nombre) + '</option>').join('');
    input.value = selected;
  };

  window.savePlantilla = async function savePlantilla() {
    const err = $('crud-err');
    const localId = $('crud-id').value;
    const nombre = $('crud-nombre').value.trim();
    const description = $('crud-desc').value.trim();
    const selectedAreaIds = ($('crud-area').value || '').split(',').map((v) => Number(v)).filter(Boolean);
    const categoria = $('crud-cat').value.trim();
    const urlCanva = $('crud-canva').value.trim();
    const urlDrive = $('crud-drive').value.trim();
    const requestedActive = $('crud-activa').checked;
    const canPublish = isAdmin() || hasPermission('plantillas.publicar');
    const active = requestedActive && canPublish;
    if (requestedActive && !canPublish) showMessage('La plantilla se guardará como borrador; tu rol no tiene permiso para publicarla.', 'info');
    const old = localId ? (plantillas || []).find((item) => String(item.id) === String(localId)) : null;
    if (!nombre) { err.textContent = 'El nombre es obligatorio.'; err.style.display = 'block'; return; }
    if (!selectedAreaIds.length) { err.textContent = 'Selecciona al menos un departamento.'; err.style.display = 'block'; return; }
    if (!categoria) { err.textContent = 'La categoría es obligatoria.'; err.style.display = 'block'; return; }
    const allowedNames = (window._regUser && window._regUser.areas) || [];
    if (!isAdmin() && selectedAreaIds.some((id) => !allowedNames.includes(localDepartment(id)?.nombre))) { err.textContent = 'Solo puedes asignar la plantilla a tus departamentos autorizados.'; err.style.display = 'block'; return; }
    const departmentUuids = selectedAreaIds.map(departmentUuid).filter(Boolean);
    if (departmentUuids.length !== selectedAreaIds.length) { err.textContent = 'Uno de los departamentos seleccionados ya no existe. Actualiza la pantalla.'; err.style.display = 'block'; return; }
    const btn = $('crud-modal').querySelector('.modal-foot .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
    try {
      const payload = {
        nombre,
        descripcion: description,
        categoria,
        tipo_registro: 'plantilla',
        url_canva: urlCanva || null,
        url_drive: urlDrive || null,
        activo: active,
        estado: active ? 'publicada' : 'borrador',
        publicada_en: active ? new Date().toISOString() : null,
        updated_at: new Date().toISOString()
      };
      if (!old) payload.creado_por = currentUserId();
      let row;
      if (old && old.dbId) {
        const { data, error } = await ensureClient().from('plantillas').update(payload).eq('id', old.dbId).select().single();
        if (error) throw error;
        row = data;
      } else {
        const { data, error } = await ensureClient().from('plantillas').insert(payload).select().single();
        if (error) throw error;
        row = data;
      }
      const previewFile = $('crud-preview-file')?.files?.[0];
      let previewPath = old ? old.preview_path : null;
      if (previewFile) {
        const ext = (previewFile.name.split('.').pop() || 'png').toLowerCase();
        previewPath = row.id + '/preview-' + Date.now() + '.' + ext;
        const { error: uploadError } = await ensureClient().storage.from(SUPABASE_BUCKET)
          .upload(previewPath, previewFile, { upsert: true, contentType: previewFile.type });
        if (uploadError) throw uploadError;
        const { error: previewUpdateError } = await ensureClient().from('plantillas').update({ preview_url: previewPath }).eq('id', row.id);
        if (previewUpdateError) throw previewUpdateError;
      } else if ($('crud-preview').value === '' && old?.preview_path) {
        previewPath = null;
        await ensureClient().from('plantillas').update({ preview_url: null }).eq('id', row.id);
      }

      const { error: clearLinksError } = await ensureClient().from('plantilla_departamentos').delete().eq('plantilla_id', row.id);
      if (clearLinksError) throw clearLinksError;
      const links = departmentUuids.map((departmentId) => ({ plantilla_id: row.id, departamento_id: departmentId }));
      const { error: linkError } = await ensureClient().from('plantilla_departamentos').insert(links);
      if (linkError) throw linkError;

      await loadApplicationData({ isAdmin: isAdmin() });
      window.closeCrudModal();
      window.renderAdminPlantillas();
      if (typeof window.renderAreas === 'function') window.renderAreas();
      await writeActivity('Plantillas', old ? 'Actualización' : 'Creación', (old ? 'Se actualizó la plantilla: ' : 'Se creó la plantilla: ') + nombre, { plantillaNombre: nombre, areaIds: selectedAreaIds });
      if (active) await window.sendEmailNotification(old ? 'actualiza_plantilla' : 'nueva_plantilla', {
        id: row.id, dbId: row.id, nombre, area: localDepartment(selectedAreaIds[0])?.nombre || '',
        areaId: selectedAreaIds[0], areaIds: selectedAreaIds, categoria, desc: description
      });
      showMessage('Plantilla guardada en Supabase.', 'success');
    } catch (error) {
      console.error(error);
      err.textContent = error.message || 'No fue posible guardar la plantilla.';
      err.style.display = 'block';
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
    }
  };

  window.deletePlantilla = async function deletePlantilla(id) {
    const item = (plantillas || []).find((row) => row.id === id);
    if (!item || !confirm('¿Eliminar esta plantilla?')) return;
    try {
      const { error } = await ensureClient().from('plantillas').delete().eq('id', item.dbId);
      if (error) throw error;
      const paths = [item.preview_path].filter(Boolean);
      if (paths.length) await ensureClient().storage.from(SUPABASE_BUCKET).remove(paths);
      await loadApplicationData({ isAdmin: isAdmin() });
      window.renderAdminPlantillas();
      await writeActivity('Plantillas', 'Eliminación', 'Se eliminó la plantilla: ' + item.nombre, {});
      showMessage('Plantilla eliminada.', 'success');
    } catch (error) { showMessage('No fue posible eliminar la plantilla: ' + error.message, 'error'); }
  };

  // Users see only departments they belong to; RLS independently enforces this on the database.
  window.renderAreas = function renderAreas() {
    const grid = $('areas-grid'); if (!grid) return;
    grid.innerHTML = '';
    const isAdminUser = isAdmin();
    const myNames = (window._regUser && window._regUser.areas) || [];
    const allowed = (window.AREAS || []).filter((area) => isAdminUser || myNames.includes(area.nombre));
    allowed.forEach((area) => {
      const count = (plantillas || []).filter((item) => item.activa && (item.areaIds || [item.areaId]).includes(area.id)).length;
      const card = document.createElement('div');
      card.className = 'area-card';
      card.innerHTML = '<h3>' + safeText(area.nombre) + '</h3><div class="area-count">' + count + ' plantilla' + (count === 1 ? '' : 's') + '</div><div class="area-arrow">&#8594;</div>';
      card.onclick = () => window.openArea(area);
      grid.appendChild(card);
    });
    if (!allowed.length) grid.innerHTML = '<div class="empty-state">Tu cuenta todavía no tiene departamentos asignados.</div>';
  };

  window.renderAreaTpls = function renderAreaTpls(area, category, search) {
    const container = $('area-tpl-container'); if (!container) return;
    const userAreas = (window._regUser && window._regUser.areas) || [];
    if (!isAdmin() && !userAreas.includes(area.nombre)) {
      container.innerHTML = '<div class="empty-state">No tienes permisos para consultar este departamento.</div>';
      return;
    }
    if (typeof window.renderAreaTplsFiltered === 'function') window.renderAreaTplsFiltered(area, category || 'Todas', search || '');
  };

  // ── 5. Digital content: database records + private Storage files ───────────
  function ensureDigitalFileInput() {
    if ($('cmod-file')) return;
    const modalBody = $('contenido-modal')?.querySelector('.modal-body');
    if (!modalBody) return;
    const field = document.createElement('div');
    field.className = 'field';
    field.innerHTML = '<label>Archivo digital</label><input id="cmod-file" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.mp4,.zip,.doc,.docx,.xlsx,.pptx"/><small style="color:var(--muted)">El documento se almacena en el bucket privado plantillas.</small>';
    const error = $('cmod-err');
    if (error) modalBody.insertBefore(field, error); else modalBody.appendChild(field);
  }

  const legacyOpenContenidoModal = window.openContenidoModal;
  window.openContenidoModal = function openContenidoModal(id) {
    ensureDigitalFileInput();
    if (typeof legacyOpenContenidoModal === 'function') legacyOpenContenidoModal(id);
    if ($('cmod-file')) $('cmod-file').value = '';
  };

  window.saveContenido = async function saveContenido() {
    ensureDigitalFileInput();
    const id = $('cmod-id').value;
    const name = $('cmod-nombre').value.trim();
    const type = $('cmod-tipo').value || 'PDF';
    const size = $('cmod-tam').value.trim();
    const category = $('cmod-cat').value;
    const requestedActive = $('cmod-activo') ? $('cmod-activo').checked : true;
    const canPublish = isAdmin() || hasPermission('contenido.publicar');
    const active = requestedActive && canPublish;
    if (requestedActive && !canPublish) showMessage('El contenido se guardará como borrador; tu rol no tiene permiso para publicarlo.', 'info');
    const file = $('cmod-file')?.files?.[0] || null;
    const err = $('cmod-err');
    if (!name) { err.textContent = 'El nombre es obligatorio.'; err.style.display = 'block'; return; }
    if (!category) { err.textContent = 'Selecciona una categoría.'; err.style.display = 'block'; return; }
    const old = id ? (DIGITAL_ITEMS_DATA || []).find((item) => String(item.id) === String(id)) : null;
    if (!old && !file) { err.textContent = 'Selecciona el archivo que deseas publicar.'; err.style.display = 'block'; return; }
    const btn = $('contenido-modal').querySelector('.modal-foot .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
    try {
      const payload = {
        nombre: name,
        descripcion: 'Contenido digital: ' + name,
        categoria: category,
        tipo_registro: 'contenido_digital',
        tipo_archivo: file ? (file.type || type) : type,
        tamano: file ? formatBytes(file.size) : (size || old?.tam || '—'),
        activo: active,
        estado: active ? 'publicada' : 'borrador',
        publicada_en: active ? new Date().toISOString() : null,
        updated_at: new Date().toISOString()
      };
      if (!old) payload.creado_por = currentUserId();
      let row;
      if (old?.dbId) {
        const { data, error } = await ensureClient().from('plantillas').update(payload).eq('id', old.dbId).select().single();
        if (error) throw error;
        row = data;
      } else {
        const { data, error } = await ensureClient().from('plantillas').insert(payload).select().single();
        if (error) throw error;
        row = data;
      }
      let storagePath = old ? old.ruta : '';
      if (file) {
        const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
        storagePath = row.id + '/contenido-' + Date.now() + '.' + ext;
        const { error: uploadError } = await ensureClient().storage.from(SUPABASE_BUCKET)
          .upload(storagePath, file, { upsert: true, contentType: file.type || 'application/octet-stream' });
        if (uploadError) throw uploadError;
        const { error: updateError } = await ensureClient().from('plantillas').update({
          ruta_archivo: storagePath, nombre_archivo: file.name, tipo_archivo: file.type || type, tamano: formatBytes(file.size)
        }).eq('id', row.id);
        if (updateError) throw updateError;
      }
      const { error: clearError } = await ensureClient().from('plantilla_departamentos').delete().eq('plantilla_id', row.id);
      if (clearError) throw clearError;
      const allowedAreas = isAdmin() ? (window.AREAS || []) : (window.AREAS || []).filter((area) => ((window._regUser?.areas) || []).includes(area.nombre));
      const links = allowedAreas.map((area) => ({ plantilla_id: row.id, departamento_id: area.dbId }));
      if (links.length) {
        const { error: linksError } = await ensureClient().from('plantilla_departamentos').insert(links);
        if (linksError) throw linksError;
      }
      await loadApplicationData({ isAdmin: isAdmin() });
      window.closeContenidoModal();
      window.renderAdminContenido();
      window.renderDigital();
      await writeActivity('Contenido digital', old ? 'Actualización' : 'Publicación', (old ? 'Se actualizó el contenido: ' : 'Se publicó el contenido: ') + name, { tipo: 'contenido_digital' });
      if (active && !old) await window.sendEmailNotification('nuevo_contenido', { id: row.id, dbId: row.id, nombre: name });
      showMessage('Contenido guardado en Supabase Storage y Database.', 'success');
    } catch (error) {
      console.error(error);
      err.textContent = error.message || 'No fue posible guardar el contenido.';
      err.style.display = 'block';
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
    }
  };

  function formatBytes(bytes) {
    if (!bytes) return '—';
    const units = ['B','KB','MB','GB'];
    let value = bytes, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return value.toFixed(unit === 0 ? 0 : 1) + ' ' + units[unit];
  }

  window.deleteContenido = async function deleteContenido(id) {
    const item = (DIGITAL_ITEMS_DATA || []).find((row) => row.id === id);
    if (!item || !confirm('¿Eliminar este contenido? Esta acción no se puede deshacer.')) return;
    try {
      const { error } = await ensureClient().from('plantillas').delete().eq('id', item.dbId);
      if (error) throw error;
      if (item.ruta) await ensureClient().storage.from(SUPABASE_BUCKET).remove([item.ruta]);
      await loadApplicationData({ isAdmin: isAdmin() });
      window.renderAdminContenido(); window.renderDigital();
      await writeActivity('Contenido digital', 'Eliminación', 'Se eliminó el contenido: ' + item.nombre, {});
      showMessage('Contenido eliminado.', 'success');
    } catch (error) { showMessage('No fue posible eliminar el contenido: ' + error.message, 'error'); }
  };

  window.toggleContenido = async function toggleContenido(id) {
    const item = (DIGITAL_ITEMS_DATA || []).find((row) => row.id === id);
    if (!item) return;
    const next = !item.activo;
    if (next && !hasPermission('contenido.publicar')) {
      showMessage('Tu rol no tiene permiso para publicar contenido. Puedes guardar el registro como borrador.', 'error');
      return;
    }
    try {
      const { error } = await ensureClient().from('plantillas').update({
        activo: next, estado: next ? 'publicada' : 'borrador', updated_at: new Date().toISOString()
      }).eq('id', item.dbId);
      if (error) throw error;
      await loadApplicationData({ isAdmin: isAdmin() });
      window.renderAdminContenido(); window.renderDigital();
      await writeActivity('Contenido digital', next ? 'Activación' : 'Desactivación', item.nombre, {});
    } catch (error) { showMessage('No fue posible actualizar el estado: ' + error.message, 'error'); }
  };

  window.renderDigitalItems = function renderDigitalItems() {
    const search = String(($('digital-search') || {}).value || '').toLowerCase();
    const cat = window.digitalCatActiva || 'seguridad';
    const items = (DIGITAL_ITEMS_DATA || []).filter((item) => {
      const permitted = isAdmin() || (item.areaIds || []).some((id) => ((window._regUser?.areas) || []).includes(localDepartment(id)?.nombre));
      return item.activo && permitted && item.catId === cat && item.nombre.toLowerCase().includes(search);
    });
    const container = $('digital-items'); if (!container) return;
    const icons = { PDF:'📄', PNG:'🖼', JPG:'🖼', JPEG:'🖼', WEBP:'🖼', MP4:'🎬', ZIP:'📦', DOC:'📝', DOCX:'📝', XLSX:'📊', PPTX:'📽' };
    container.innerHTML = items.length ? items.map((item) => {
      const date = new Date(item.fecha).toLocaleDateString('es-MX', { day:'2-digit', month:'long', year:'numeric' });
      return '<div class="ditem"><div class="ditem-icon">' + (icons[item.tipo] || '📄') + '</div>' +
        '<div class="ditem-info"><div class="ditem-name">' + safeText(item.nombre) + '</div>' +
        '<div class="ditem-meta">' + safeText(item.tam) + ' · Actualizado: ' + safeText(date) + '</div></div>' +
        '<span class="ditem-tipo">' + safeText(item.tipo) + '</span>' +
        '<button class="btn btn-primary btn-sm" style="margin-left:8px" onclick="downloadDigitalFile(' + item.id + ')">↓ Descargar</button></div>';
    }).join('') : '<div class="empty-state"><p>No se encontraron archivos disponibles.</p></div>';
  };

  window.downloadDigitalFile = async function downloadDigitalFile(id) {
    const item = (DIGITAL_ITEMS_DATA || []).find((row) => row.id === id);
    if (!item || !item.ruta) { showMessage('Este registro todavía no tiene un archivo adjunto.', 'error'); return; }
    const { data, error } = await ensureClient().storage.from(SUPABASE_BUCKET).createSignedUrl(item.ruta, 90);
    if (error || !data?.signedUrl) { showMessage('No fue posible generar el enlace de descarga: ' + (error?.message || ''), 'error'); return; }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    await writeActivity('Contenido digital', 'Descarga', 'Se descargó el contenido: ' + item.nombre, { tipo: 'download' });
  };

  // ── 6. Categories ─────────────────────────────────────────────────────────
  window.saveCat = async function saveCat() {
    const idx = $('catmod-idx').value;
    const name = $('catmod-nombre').value.trim();
    const areaLocalId = $('catmod-area').value;
    const module = $('catmod-modulo').value;
    const err = $('catmod-err');
    if (!name) { err.textContent = 'El nombre es obligatorio.'; err.style.display = 'block'; return; }
    const area = areaLocalId ? localDepartment(areaLocalId) : null;
    const payload = { nombre: name, slug: slugify(name), modulo: module, departamento_id: area ? area.dbId : null };
    try {
      const current = idx !== '' ? (window.CATEGORIES_DATA || [])[Number(idx)] : null;
      let query;
      if (current?.dbId) query = await ensureClient().from('categorias').update(payload).eq('id', current.dbId);
      else query = await ensureClient().from('categorias').insert(payload);
      if (query.error) throw query.error;
      const { data, error } = await ensureClient().from('categorias').select('id,nombre,slug,modulo,departamento_id').order('nombre');
      if (error) throw error;
      buildCategoryData(data || []);
      window.closeCatModal(); window.renderAdminCategorias();
      await writeActivity('Categorías', current ? 'Actualización' : 'Creación', 'Se guardó la categoría: ' + name, {});
    } catch (error) { err.textContent = error.message; err.style.display = 'block'; }
  };
  window.deleteCat = async function deleteCat(idx) {
    const item = (window.CATEGORIES_DATA || [])[idx];
    if (!item || !confirm('¿Eliminar la categoría?')) return;
    try {
      const { error } = await ensureClient().from('categorias').delete().eq('id', item.dbId);
      if (error) throw error;
      const { data } = await ensureClient().from('categorias').select('id,nombre,slug,modulo,departamento_id').order('nombre');
      buildCategoryData(data || []);
      window.renderAdminCategorias();
      await writeActivity('Categorías', 'Eliminación', 'Se eliminó la categoría: ' + item.nombre, {});
    } catch (error) { showMessage('No se pudo eliminar la categoría: ' + error.message, 'error'); }
  };

  // ── 7. Notifications: persistent database log + existing email proxy ───────
  window.getAreaUsers = function getAreaUsers(areaId) {
    const area = localDepartment(areaId);
    if (!area) return [];
    return (window.USERS_DB || []).filter((user) => user.activo && (user.areas || [user.area]).includes(area.nombre));
  };
  window.getAllActiveUsers = function getAllActiveUsers() {
    return (window.USERS_DB || []).filter((user) => user.activo && user.rol !== 'Administrador');
  };
  window._getRecipientsByAreaIds = function _getRecipientsByAreaIds(ids) {
    const recipients = [];
    (ids || []).forEach((id) => window.getAreaUsers(id).forEach((user) => {
      if (user.email && !recipients.includes(user.email)) recipients.push(user.email);
    }));
    return recipients;
  };

  window.sendEmailNotification = async function sendEmailNotification(type, payload) {
    if (!isAdmin()) {
      showMessage('El envío de notificaciones generales por correo está reservado al Administrador.', 'info');
      return null;
    }
    const now = new Date();
    const dateText = now.toLocaleDateString('es-MX', { day:'2-digit', month:'long', year:'numeric' });
    let recipients = [];
    let subject = '';
    let intro = '';
    const areaIds = (payload.areaIds && payload.areaIds.length) ? payload.areaIds : (payload.areaId ? [payload.areaId] : []);
    if (type === 'nueva_plantilla') {
      recipients = window._getRecipientsByAreaIds(areaIds);
      subject = '✨ Nueva plantilla disponible: ' + payload.nombre;
      intro = 'Se ha publicado una nueva plantilla en tu departamento.';
    } else if (type === 'actualiza_plantilla') {
      recipients = window._getRecipientsByAreaIds(areaIds);
      subject = '🔄 Plantilla actualizada: ' + payload.nombre;
      intro = 'La siguiente plantilla fue actualizada.';
    } else if (type === 'nuevo_contenido') {
      recipients = window.getAllActiveUsers().map((user) => user.email);
      subject = '📢 Nuevo contenido digital: ' + payload.nombre;
      intro = 'Se ha publicado nuevo contenido digital en la plataforma.';
    }
    recipients = [...new Set(recipients.filter(Boolean))];
    const htmlBody = typeof window._buildEmailHTML === 'function' ? window._buildEmailHTML(subject, {
      nombre: payload.nombre, area: payload.area || '', categoria: payload.categoria || '',
      desc: payload.desc || '', fecha: dateText, intro
    }) : '<p>' + safeText(intro) + '</p><p>' + safeText(payload.nombre) + '</p>';
    const entry = {
      id: Date.now(), type, subject, htmlBody, recipients,
      payload, fecha: now.toISOString(), status: recipients.length ? 'pendiente' : 'sin_destinatarios',
      httpCode: null, apiMsg: null, apiData: null, dbId: null
    };
    if (Array.isArray(window.notificationLog)) window.notificationLog.unshift(entry);

    const departmentUuids = (type === 'nuevo_contenido')
      ? (window.AREAS || []).map((area) => area.dbId)
      : areaIds.map(departmentUuid).filter(Boolean);
    const templateUuid = payload.dbId || (typeof payload.id === 'string' && payload.id.length > 30 ? payload.id : null);
    const { data: record, error: insertError } = await ensureClient().from('notificaciones').insert({
      titulo: subject || payload.nombre || 'Notificación',
      mensaje: intro || 'Notificación de plataforma',
      tipo: type,
      plantilla_id: templateUuid,
      creado_por: currentUserId(),
      estado: entry.status,
      destinatarios: recipients,
      html_body: htmlBody
    }).select().single();
    if (insertError) {
      console.error('No se pudo persistir la notificación:', insertError);
      showMessage('La notificación no pudo guardarse en la base de datos: ' + insertError.message, 'error');
    } else {
      entry.dbId = record.id;
      if (departmentUuids.length) {
        const links = [...new Set(departmentUuids)].map((departmentId) => ({ notificacion_id: record.id, departamento_id: departmentId }));
        const { error: linkError } = await ensureClient().from('notificacion_departamentos').insert(links);
        if (linkError) console.error('No se pudieron asignar departamentos a la notificación:', linkError);
      }
    }

    if (!recipients.length) {
      showMessage('No hay destinatarios activos para los departamentos seleccionados.', 'error');
      return entry;
    }
    if (typeof window._callMailProxy !== 'function') {
      entry.status = 'error'; entry.apiMsg = 'No está disponible el proxy de correo.';
      showMessage(entry.apiMsg, 'error'); return entry;
    }
    showMessage('Enviando notificación a ' + recipients.length + ' usuario(s)...', 'success');
    window._callMailProxy(subject, htmlBody, recipients, async (result) => {
      entry.status = result.ok ? 'enviado' : 'error';
      entry.httpCode = result.code; entry.apiMsg = result.msg; entry.apiData = result.data || null;
      if (entry.dbId) {
        const { error } = await ensureClient().from('notificaciones').update({
          estado: entry.status, http_code: entry.httpCode, api_mensaje: entry.apiMsg, api_data: entry.apiData
        }).eq('id', entry.dbId);
        if (error) console.error('No se pudo actualizar el estado de la notificación:', error);
      }
      showMessage(result.ok ? 'Notificación enviada a ' + recipients.length + ' usuario(s).' : 'Error al enviar notificación: ' + result.msg, result.ok ? 'success' : 'error');
      if ($('admin-sec-notificaciones')) window.renderAdminNotificaciones();
    });
    return entry;
  };

  window.retryNotif = async function retryNotif(id) {
    const entry = (window.notificationLog || []).find((item) => item.id === id);
    if (!entry || !entry.recipients?.length) { showMessage('No hay destinatarios para reintentar.', 'error'); return; }
    entry.status = 'pendiente';
    if (entry.dbId) await ensureClient().from('notificaciones').update({ estado: 'pendiente' }).eq('id', entry.dbId);
    window.renderAdminNotificaciones();
    window._callMailProxy(entry.subject, entry.htmlBody || '', entry.recipients, async (result) => {
      entry.status = result.ok ? 'enviado' : 'error';
      entry.httpCode = result.code; entry.apiMsg = result.msg; entry.apiData = result.data || null;
      if (entry.dbId) await ensureClient().from('notificaciones').update({
        estado: entry.status, http_code: entry.httpCode, api_mensaje: entry.apiMsg, api_data: entry.apiData
      }).eq('id', entry.dbId);
      window.renderAdminNotificaciones();
      showMessage(result.ok ? 'Reenvío exitoso.' : 'Error en el reenvío: ' + result.msg, result.ok ? 'success' : 'error');
    });
  };

  const legacyRunMailTest = window.runMailTest;
  window.runMailTest = async function runMailTest() {
    const email = ($('notif-test-email') || {}).value?.trim() || '';
    const subject = ($('notif-test-subject') || {}).value?.trim() || '';
    const body = ($('notif-test-body') || {}).value?.trim() || '';
    const result = $('notif-test-result');
    const btn = $('notif-test-btn');
    if (!email.includes('@') || !subject || !body) {
      if (result) { result.className = 'notif-result-box err'; result.style.display = 'block'; result.textContent = 'Completa un correo válido, asunto y contenido.'; }
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando...'; }
    const entry = { id: Date.now(), type:'prueba', subject, htmlBody:body, recipients:[email], fecha:new Date().toISOString(), status:'pendiente', payload:{nombre:'Prueba manual'} };
    const { data: record, error } = await ensureClient().from('notificaciones').insert({
      titulo: subject, mensaje: 'Prueba manual de correo', tipo: 'prueba', creado_por: currentUserId(),
      estado: 'pendiente', destinatarios: [email], html_body: body
    }).select().single();
    if (!error) entry.dbId = record.id; else console.error(error);
    if (Array.isArray(window.notificationLog)) window.notificationLog.unshift(entry);
    window._callMailProxy(subject, body, [email], async (res) => {
      entry.status = res.ok ? 'enviado' : 'error'; entry.httpCode = res.code; entry.apiMsg = res.msg; entry.apiData = res.data || null;
      if (entry.dbId) await ensureClient().from('notificaciones').update({ estado:entry.status, http_code:entry.httpCode, api_mensaje:entry.apiMsg, api_data:entry.apiData }).eq('id', entry.dbId);
      if (btn) { btn.disabled = false; btn.textContent = '✉ Enviar correo de prueba'; }
      if (result) {
        result.className = 'notif-result-box ' + (res.ok ? 'ok' : 'err');
        result.style.display = 'block';
        result.textContent = res.ok ? 'Solicitud aceptada por la API. Verifica el buzón del destinatario.' : res.msg;
      }
      window.renderAdminNotificaciones();
    });
  };

  // ── 8. Access logging and profile persistence ──────────────────────────────
  const legacyOpenAccessModal = window.openAccessModal;
  window.openAccessModal = async function openAccessModal(plantillaId, destino) {
    const item = (plantillas || []).find((row) => row.id === plantillaId);
    if (!item) { showMessage('Plantilla no encontrada.', 'error'); return; }
    const url = destino === 'canva' ? item.urlCanva : item.urlDrive;
    if (!url) { showMessage('No hay URL de ' + (destino === 'canva' ? 'Canva' : 'Google Drive') + ' configurada.', 'error'); return; }
    window.open(url, '_blank', 'noopener,noreferrer');
    await writeActivity('Plantillas', 'Acceso a plantilla', 'Acceso a ' + item.nombre, {
      plantillaNombre: item.nombre, tipo: destino, area: window._regUser?.area || ''
    });
  };

  async function signedAvatar(path) {
    if (!path) return '';
    try {
      const { data, error } = await ensureClient().storage.from(SUPABASE_AVATAR_BUCKET).createSignedUrl(path, 3600);
      return error ? '' : (data && data.signedUrl) || '';
    } catch (_) { return ''; }
  }

  window.handleProfilePhoto = async function handleProfilePhoto(input) {
    const file = input && input.files && input.files[0];
    if (!file) return;
    const allowed = ['image/jpeg','image/png','image/webp'];
    if (!allowed.includes(file.type)) { showMessage('Formato no válido. Usa JPG, JPEG o PNG.', 'error'); input.value=''; return; }
    if (file.size > 10 * 1024 * 1024) { showMessage('La imagen supera el límite de 10 MB.', 'error'); input.value=''; return; }
    const preview = $('profile-photo-preview');
    if (preview) {
      const url = URL.createObjectURL(file);
      preview.innerHTML = '<img src="' + url + '" alt="Vista previa" style="width:80px;height:80px;border-radius:50%;object-fit:cover;border:2px solid var(--blue-main)"/><div style="margin-top:6px"><button class="btn-primary btn-sm" type="button" id="save-profile-photo-btn">Guardar foto</button></div>';
      preview.style.display = 'block';
      $('save-profile-photo-btn').onclick = async () => {
        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
        const path = currentUserId() + '/avatar-' + Date.now() + '.' + ext;
        const { error: uploadError } = await ensureClient().storage.from(SUPABASE_AVATAR_BUCKET).upload(path, file, { upsert: true, contentType: file.type });
        if (uploadError) { showMessage('No se pudo guardar la foto: ' + uploadError.message, 'error'); return; }
        const { error: profileError } = await ensureClient().from('perfiles').update({ avatar_url: path, updated_at: new Date().toISOString() }).eq('id', currentUserId());
        if (profileError) { showMessage('La foto se subió, pero no se pudo actualizar el perfil: ' + profileError.message, 'error'); return; }
        window._adminPhotoDataUrl = await signedAvatar(path);
        if (window._regUser) window._regUser.foto = window._adminPhotoDataUrl;
        if (preview) preview.style.display = 'none';
        if (typeof window.renderAdminProfile === 'function') window.renderAdminProfile();
        const sidebarAvatar = $('sidebar-avatar');
        if (sidebarAvatar && window._adminPhotoDataUrl) sidebarAvatar.innerHTML = '<img src="' + window._adminPhotoDataUrl + '" alt="Foto" style="width:100%;height:100%;border-radius:50%;object-fit:cover"/>';
        await writeActivity('Perfil', 'Actualización de fotografía', 'Se actualizó la fotografía del perfil.', {});
        showMessage('Foto de perfil guardada en Supabase.', 'success');
      };
    }
  };

  window.saveProfile = async function saveProfile() {
    const name = ($('prof-nombre')?.value || '').trim();
    const email = ($('prof-email')?.value || '').trim().toLowerCase();
    if (!name || !email) { showMessage('Completa los campos obligatorios.', 'error'); return; }
    if (currentSupabaseUser && email !== currentSupabaseUser.email.toLowerCase()) {
      showMessage('El correo se administra desde Supabase Auth y no se cambia desde este formulario.', 'error'); return;
    }
    const { error } = await ensureClient().from('perfiles').update({ nombre_completo: name, updated_at: new Date().toISOString() }).eq('id', currentUserId());
    if (error) { showMessage('No se pudo actualizar el perfil: ' + error.message, 'error'); return; }
    window._regUser.nombre = name;
    if (window.currentAdminUser) window.currentAdminUser.nombre = name;
    showMessage('Perfil actualizado correctamente.', 'success');
    await writeActivity('Perfil', 'Actualización', 'Se actualizó el perfil del usuario.', {});
  };
  window.changeAdminPassword = function changeAdminPassword() {
    showMessage('El acceso se realiza mediante Google. La contraseña se administra desde la cuenta corporativa.', 'error');
  };

  // ── 9. Admin departments CRUD ──────────────────────────────────────────────
  window.saveArea = async function saveArea() {
    const id = $('amod-id').value;
    const name = $('amod-nombre').value.trim();
    const errorEl = $('amod-err');
    if (!name) { errorEl.textContent = 'El nombre del departamento es obligatorio.'; errorEl.style.display = 'block'; return; }
    const existing = id ? localDepartment(id) : null;
    try {
      const payload = { nombre: name, descripcion: '', activo: true };
      const query = existing?.dbId
        ? await ensureClient().from('departamentos').update(payload).eq('id', existing.dbId)
        : await ensureClient().from('departamentos').insert(payload);
      if (query.error) throw query.error;
      const { data, error } = await ensureClient().from('departamentos').select('id,nombre,descripcion,activo').eq('activo', true).order('nombre');
      if (error) throw error;
      rebuildDepartments(data || []);
      window.closeAreaModal();
      window.renderAdminAreas();
      await writeActivity('Departamentos', existing ? 'Actualización' : 'Creación', 'Se guardó el departamento: ' + name, {});
    } catch (error) { errorEl.textContent = error.message; errorEl.style.display = 'block'; }
  };

  window.renderAdminAreas = function renderAdminAreas() {
    const sec = $('admin-sec-areas'); if (!sec) return;
    const rows = (window.AREAS || []).map((area) => {
      const total = (plantillas || []).filter((p) => (p.areaIds || [p.areaId]).includes(area.id)).length;
      const active = (plantillas || []).filter((p) => p.activa && (p.areaIds || [p.areaId]).includes(area.id)).length;
      return '<tr><td><span class="td-name">' + safeText(area.nombre) + '</span></td><td>' + total + '</td><td><span class="badge" style="background:#dcfce7;color:#16a34a">' + active + ' activas</span></td>' +
        '<td><button class="icon-btn" title="Editar" onclick="openAreaModal(' + area.id + ')">&#9998;</button></td></tr>';
    }).join('');
    sec.innerHTML = '<div class="section-head"><h2>Departamentos configurados</h2><button class="btn-primary btn-sm" onclick="openAreaModal(null)">＋ Nuevo departamento</button></div>' +
      '<table><thead><tr><th>Departamento</th><th>Plantillas</th><th>Activas</th><th>Acciones</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="4">No hay departamentos. Agrega el primero.</td></tr>') + '</tbody></table>';
  };

  window.renderAdminLogs = function renderAdminLogs() {
    const sec = $('admin-sec-logs'); if (!sec) return;
    const list = (logs || []).filter((row) => [row.nombre,row.email,row.plantillaNombre,row.area,row.modulo,row.accion].join(' ').toLowerCase().includes(String(logsBusq || '').toLowerCase()));
    sec.innerHTML = '<div class="stats-row"><div class="stat-card"><div class="stat-label">Total de actividades</div><div class="stat-val">' + list.length + '</div></div>' +
      '<div class="stat-card"><div class="stat-label">Usuarios únicos</div><div class="stat-val">' + new Set(list.map((row) => row.email)).size + '</div></div></div>' +
      '<div class="section-head"><h2>Historial de actividades</h2><input value="' + safeText(logsBusq || '') + '" oninput="logsBusq=this.value;renderAdminLogs()" placeholder="Buscar..." style="width:220px"/></div>' +
      '<table><thead><tr><th>Usuario</th><th>Correo</th><th>Departamento</th><th>Módulo</th><th>Acción</th><th>Fecha y hora</th></tr></thead><tbody>' +
      list.map((row) => '<tr><td class="td-name">' + safeText(row.nombre) + '</td><td>' + safeText(row.email) + '</td><td>' + safeText(row.area) + '</td><td>' + safeText(row.modulo || '—') + '</td><td>' + safeText(row.accion || row.tipo) + '</td><td>' + safeText(window.fmtF ? window.fmtF(row.fecha) : row.fecha) + '</td></tr>').join('') +
      (list.length ? '' : '<tr><td colspan="6" style="text-align:center;padding:28px;color:var(--muted)">Sin actividades.</td></tr>') + '</tbody></table>';
  };

  // ── 10. Role-based admin panel visibility ───────────────────────────────────
  function applyPanelPermissions() {
    const sections = ['plantillas','contenido','categorias','logs','areas','users','profile','notificaciones','adopcion'];
    sections.forEach((name) => {
      const allowed = canUseAdminSection(name);
      const nav = $('sb-' + name);
      const sec = $('admin-sec-' + name);
      if (nav) nav.style.display = allowed ? '' : 'none';
      if (sec && !allowed) sec.style.display = 'none';
    });
  }
  const originalAdminSec = window.adminSec;
  if (typeof originalAdminSec === 'function') {
    window.adminSec = function adminSecWithPermissions(section) {
      if (!canUseAdminSection(section)) { showMessage('Tu rol no tiene permiso para acceder a este módulo.', 'error'); return; }
      originalAdminSec(section);
      applyPanelPermissions();
    };
  }
  const originalRenderAdmin = window.renderAdmin;
  if (typeof originalRenderAdmin === 'function') {
    window.renderAdmin = function renderAdminWithPermissions() {
      originalRenderAdmin();
      applyPanelPermissions();
    };
  }

  // ── 11. Start-up ────────────────────────────────────────────────────────────
  function hideLegacyAdminPasswordLogin() {
    const style = document.createElement('style');
    style.textContent = [
      '#pg-login .login-field{display:none!important}',
      '#pg-login .login-btn{display:none!important}',
      '#pg-login .reg-divider{display:none!important}',
      '#pg-login .login-forgot{display:none!important}',
      '#pg-login .login-btn{display:none!important}',
      '#pg-login .google-signin-btn{margin-top:16px}',
      '.auth-loading{display:flex;align-items:center;justify-content:center;gap:8px;padding:10px;font-size:13px;color:var(--muted)}'
    ].join('\n');
    document.head.appendChild(style);
    if (Array.isArray(window.ADMIN_ACCOUNTS)) window.ADMIN_ACCOUNTS.length = 0;
    if ($('login-title')) $('login-title').textContent = 'Acceso de Administración';
  }

  async function initialize() {
    hideLegacyAdminPasswordLogin();
    // The shipped arrays are UI defaults only; production rows are loaded from Supabase after authentication.
    if (Array.isArray(window.USERS_DB)) window.USERS_DB.splice(0);
    if (typeof plantillas !== 'undefined' && Array.isArray(plantillas)) plantillas.splice(0);
    if (typeof logs !== 'undefined' && Array.isArray(logs)) logs.splice(0);
    if (typeof DIGITAL_ITEMS_DATA !== 'undefined' && Array.isArray(DIGITAL_ITEMS_DATA)) DIGITAL_ITEMS_DATA.splice(0);
    if (typeof notificationLog !== 'undefined' && Array.isArray(notificationLog)) notificationLog.splice(0);
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      showAuthError('No se pudo cargar la librería de Supabase. Verifica tu conexión a internet.');
      return;
    }
    if (SUPABASE_URL.includes('YOUR_PROJECT_REF') || SUPABASE_PUBLISHABLE_KEY.includes('REPLACE_WITH_YOUR_KEY')) {
      console.warn('Configura SUPABASE_URL y SUPABASE_PUBLISHABLE_KEY en supabase-integration.js antes de publicar.');
      showAuthError('Falta configurar Supabase. Agrega tu Project URL y Publishable Key en supabase-integration.js.');
      return;
    }
    sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
    });
    window.motumSupabase = sbClient;

    sbClient.auth.onAuthStateChange((event, session) => {
      // Keep callback synchronous; run database work on the next event-loop turn.
      if (event === 'SIGNED_OUT') {
        window.destroySession();
        return;
      }
      if (session && (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')) {
        setTimeout(() => processAuthSession(session), 0);
      }
    });

    const { data, error } = await sbClient.auth.getSession();
    if (error) { showAuthError('No se pudo recuperar la sesión: ' + error.message); return; }
    if (data.session) await processAuthSession(data.session);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
  else initialize();
})();
