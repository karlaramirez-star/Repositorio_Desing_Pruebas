/*
 * Motum Digital Repository — Medición real de duración de sesiones.
 * Requiere que la migración SQL 20261031_motum_session_tracking.sql ya esté ejecutada.
 * No contiene claves secretas. Usa la sesión autenticada de Supabase.
 */
(function () {
  'use strict';

  const IDLE_LIMIT_MS = 5 * 60 * 1000;
  const HEARTBEAT_MS = 60 * 1000;
  const SYNC_MS = 15 * 1000;

  let client = null;
  let currentAuthUserId = null;
  let activeSessionId = null;
  let sessionStorageKey = null;
  let lastActivityAt = 0;
  let lastHeartbeatAt = 0;
  let isPaused = true;
  let heartbeatBusy = false;
  let startPromise = null;
  let heartbeatTimer = null;
  let syncTimer = null;
  let listenersBound = false;
  let originalLogout = null;

  const logWarning = (...args) => console.warn('[Motum sesiones]', ...args);

  function getSessionKey(userId) {
    const keyName = 'motum_tracking_session_key_' + userId;
    let key = '';
    try { key = sessionStorage.getItem(keyName) || ''; } catch (_) {}

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
      key = (window.crypto && typeof window.crypto.randomUUID === 'function')
        ? window.crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
          });
      try { sessionStorage.setItem(keyName, key); } catch (_) {}
    }

    sessionStorageKey = keyName;
    return key;
  }

  function getAcademySessions() {
    if (!window.ACADEMY_DATA) return null;
    if (!Array.isArray(window.ACADEMY_DATA.sessions)) window.ACADEMY_DATA.sessions = [];
    return window.ACADEMY_DATA.sessions;
  }

  function localUserFor(authUserId) {
    return (window.USERS_DB || []).find(function (user) {
      return user.authUserId === authUserId;
    }) || null;
  }

  function updateLocalDuration(sessionId, seconds) {
    const sessions = getAcademySessions();
    if (!sessions) return;
    const item = sessions.find(function (entry) {
      return entry.trackedId === sessionId;
    });
    if (!item) return;
    item.durationSeconds = Number(seconds) || 0;
    item.dur = Math.round((item.durationSeconds / 60) * 10) / 10;
    item.measured = true;
  }

  async function startSession(authUserId) {
    if (!client || !authUserId) return false;
    if (startPromise) return startPromise;
    if (currentAuthUserId === authUserId && activeSessionId) return true;

    startPromise = (async function () {
      try {
        const sessionKey = getSessionKey(authUserId);
        const result = await client.rpc('iniciar_sesion_usuario', {
          p_clave_sesion: sessionKey
        });

        if (result.error || !result.data) {
          logWarning('No se pudo iniciar el registro de sesión:', result.error && result.error.message);
          return false;
        }

        currentAuthUserId = authUserId;
        activeSessionId = result.data;
        lastActivityAt = Date.now();
        lastHeartbeatAt = Date.now();
        isPaused = false;

        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(checkAndRecordTime, HEARTBEAT_MS);

        bindActivityListeners();
        await syncMeasuredSessions();
        return true;
      } catch (error) {
        logWarning('Error al iniciar sesión medida:', error && error.message);
        return false;
      } finally {
        startPromise = null;
      }
    })();

    return startPromise;
  }

  async function sendHeartbeat(seconds) {
    if (!client || !activeSessionId || heartbeatBusy) return null;
    heartbeatBusy = true;
    const sessionId = activeSessionId;

    try {
      const result = await client.rpc('registrar_latido_sesion', {
        p_sesion_id: sessionId,
        p_segundos: Math.max(0, Math.min(75, Math.floor(Number(seconds) || 0)))
      });

      if (result.error) {
        logWarning('No se pudo guardar el tiempo de uso:', result.error.message);
        return null;
      }

      const totalSeconds = Number(result.data);
      if (totalSeconds < 0) {
        activeSessionId = null;
        isPaused = true;
        const userId = currentAuthUserId;
        await startSession(userId);
        return null;
      }

      lastHeartbeatAt = Date.now();
      updateLocalDuration(sessionId, totalSeconds);
      return totalSeconds;
    } finally {
      heartbeatBusy = false;
    }
  }

  async function pauseTracking() {
    if (!activeSessionId || isPaused) return;
    isPaused = true;

    const now = Date.now();
    const activeUntil = Math.min(now, lastActivityAt + IDLE_LIMIT_MS);
    const seconds = Math.max(0, Math.min(75, Math.floor((activeUntil - lastHeartbeatAt) / 1000)));
    await sendHeartbeat(seconds);
  }

  function resumeTracking() {
    if (!activeSessionId || document.visibilityState !== 'visible') return;

    const now = Date.now();
    lastActivityAt = now;

    if (isPaused) {
      isPaused = false;
      lastHeartbeatAt = now;
      void sendHeartbeat(0);
    }
  }

  function markActivity() {
    if (!activeSessionId || document.visibilityState !== 'visible') return;
    lastActivityAt = Date.now();
    if (isPaused) resumeTracking();
  }

  async function checkAndRecordTime() {
    if (!activeSessionId) return;

    if (document.visibilityState !== 'visible') {
      await pauseTracking();
      return;
    }

    const now = Date.now();
    if (now >= lastActivityAt + IDLE_LIMIT_MS) {
      await pauseTracking();
      return;
    }

    const seconds = Math.max(0, Math.min(75, Math.floor((now - lastHeartbeatAt) / 1000)));
    if (seconds > 0) await sendHeartbeat(seconds);
  }

  async function closeTracking(reason) {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    const sessionId = activeSessionId;
    const userId = currentAuthUserId;
    if (!sessionId || !client) {
      activeSessionId = null;
      return;
    }

    let finalSeconds = 0;
    if (!isPaused && document.visibilityState === 'visible') {
      const now = Date.now();
      const activeUntil = Math.min(now, lastActivityAt + IDLE_LIMIT_MS);
      finalSeconds = Math.max(0, Math.min(75, Math.floor((activeUntil - lastHeartbeatAt) / 1000)));
    }

    // Clear first to avoid duplicate close requests during pagehide + logout.
    activeSessionId = null;
    isPaused = true;

    try {
      const result = await client.rpc('cerrar_sesion_usuario', {
        p_sesion_id: sessionId,
        p_segundos_finales: finalSeconds,
        p_motivo: reason || 'cierre_sesion'
      });
      if (result.error) logWarning('No se pudo cerrar la sesión:', result.error.message);
    } catch (error) {
      logWarning('No se pudo completar el cierre de sesión:', error && error.message);
    }

    try {
      if (sessionStorageKey) sessionStorage.removeItem(sessionStorageKey);
    } catch (_) {}

    currentAuthUserId = null;
    sessionStorageKey = null;
  }

  function bindActivityListeners() {
    if (listenersBound) return;
    listenersBound = true;

    ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(function (eventName) {
      document.addEventListener(eventName, markActivity, { passive: true, capture: true });
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') void pauseTracking();
      else resumeTracking();
    });

    window.addEventListener('pagehide', function () {
      void closeTracking('cierre_pestana');
    });
  }

  async function syncMeasuredSessions() {
    if (!client || !window.ACADEMY_DATA || !Array.isArray(window.USERS_DB)) return;

    try {
      const result = await client
        .from('sesiones_usuario')
        .select('id,usuario_id,iniciada_en,duracion_segundos,estado')
        .order('iniciada_en', { ascending: false })
        .limit(2000);

      if (result.error) {
        logWarning('No se pudieron consultar las duraciones. Verifica que se haya ejecutado el SQL:', result.error.message);
        return;
      }

      const existing = getAcademySessions() || [];
      const merged = existing.filter(function (entry) {
        return !entry.measured;
      });

      (result.data || []).forEach(function (row) {
        const user = localUserFor(row.usuario_id);
        if (!user) return;

        const seconds = Number(row.duracion_segundos) || 0;
        const startTime = new Date(row.iniciada_en).getTime();

        // Match the tracked session to its login activity to avoid counting the same
        // login twice in the "Accesos totales" KPI.
        let nearest = null;
        let nearestDiff = 90001;
        merged.forEach(function (entry) {
          if (entry.userId !== user.id || entry.measured) return;
          const entryTime = new Date(entry.fecha).getTime();
          const diff = Math.abs(entryTime - startTime);
          if (Number.isFinite(diff) && diff < nearestDiff && diff <= 90000) {
            nearest = entry;
            nearestDiff = diff;
          }
        });

        const measuredFields = {
          trackedId: row.id,
          durationSeconds: seconds,
          dur: Math.round((seconds / 60) * 10) / 10,
          measured: true,
          estadoSesion: row.estado
        };

        if (nearest) {
          Object.assign(nearest, measuredFields);
        } else {
          merged.push({
            id: 'tracked-' + row.id,
            userId: user.id,
            nombre: user.nombre,
            email: user.email,
            area: user.area,
            fecha: row.iniciada_en,
            ...measuredFields,
            completado: false
          });
        }
      });

      existing.splice(0, existing.length, ...merged);
      installDurationKpiPatch();
      refreshAdoptionIfVisible(merged);
    } catch (error) {
      logWarning('Error al actualizar los indicadores de duración:', error && error.message);
    }
  }

  // Re-render the Adoption dashboard once measured durations arrive, so the default
  // "Todas las áreas" view does not stay with the values computed before the sync.
  let lastDurationSignature = '';
  function refreshAdoptionIfVisible(list) {
    const signature = list.filter(function (entry) { return entry.measured; })
      .map(function (entry) { return entry.trackedId + ':' + entry.durationSeconds; }).join('|');
    if (signature === lastDurationSignature) return;
    const section = document.getElementById('admin-sec-adopcion');
    if (section && section.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
    lastDurationSignature = signature;
    if (!section || section.offsetParent === null || typeof window.renderAdminAdopcion !== 'function') return;
    try { window.renderAdminAdopcion(); } catch (_) {}
  }

  function installDurationKpiPatch() {
    const original = window.calcAdoptionKPIs;
    if (typeof original !== 'function' || original.__motumDurationPatched) return;

    function getPeriodCutoff(period) {
      const now = new Date();
      const cutoff = new Date(now);
      if (period === 'semanal') cutoff.setDate(now.getDate() - 7);
      else if (period === 'mensual') cutoff.setMonth(now.getMonth() - 1);
      else if (period === 'trimestral') cutoff.setMonth(now.getMonth() - 3);
      else cutoff.setMonth(now.getMonth() - 6);
      return cutoff;
    }

    const wrapped = function (filters) {
      const kpi = original.apply(this, arguments);
      const cutoff = getPeriodCutoff(filters && filters.periodo);
      const area = filters && filters.area ? filters.area : 'all';
      const sessions = (window.ACADEMY_DATA && window.ACADEMY_DATA.sessions) || [];
      // Same scope as calcAdoptionKPIs(): standard users only (admins excluded),
      // filtered by the user's assigned department; 'all' = every standard user.
      const scopeIds = {};
      if (Array.isArray(kpi.scopeUserIds)) {
        kpi.scopeUserIds.forEach(function (id) { scopeIds[id] = true; });
      } else {
        (window.USERS_DB || []).forEach(function (user) {
          const isAdmin = user.area === 'Administrador'
            || String(user.rol || '').toLowerCase() === 'administrador'
            || (Array.isArray(user.roles) && user.roles.some(function (r) { return String(r).toLowerCase() === 'administrador'; }));
          if (!isAdmin && (area === 'all' || user.area === area)) scopeIds[user.id] = true;
        });
      }
      const seenTracked = {};
      const measured = sessions.filter(function (session) {
        const date = new Date(session.fecha);
        if (session.measured !== true
          || !(Number(session.durationSeconds) > 0)
          || !(date >= cutoff)
          || !scopeIds[session.userId]) return false;
        // Never count the same tracked session twice.
        const key = session.trackedId != null ? String(session.trackedId) : 'local-' + session.id;
        if (seenTracked[key]) return false;
        seenTracked[key] = true;
        return true;
      });

      kpi.avgDur = measured.length
        ? Math.round((measured.reduce(function (sum, session) {
            return sum + Number(session.durationSeconds);
          }, 0) / measured.length / 60) * 10) / 10
        : 0;

      (kpi.userDetail || []).forEach(function (detail) {
        const user = (window.USERS_DB || []).find(function (candidate) {
          return candidate.nombre === detail.nombre && candidate.area === detail.area;
        });
        const userSessions = user ? measured.filter(function (session) {
          return session.userId === user.id;
        }) : [];

        detail.avgDur = userSessions.length
          ? Math.round((userSessions.reduce(function (sum, session) {
              return sum + Number(session.durationSeconds);
            }, 0) / userSessions.length / 60) * 10) / 10
          : 0;
      });

      return kpi;
    };

    wrapped.__motumDurationPatched = true;
    window.calcAdoptionKPIs = wrapped;
  }

  function onAuthStateChanged(event, session) {
    if (session && session.user) {
      setTimeout(function () {
        void startSession(session.user.id);
        void syncMeasuredSessions();
      }, 700);
    } else if (event === 'SIGNED_OUT') {
      // The normal logout button is wrapped below so it closes before Supabase clears auth.
      // If sign-out comes from another tab, the abandoned-session recovery closes it on next login.
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      activeSessionId = null;
      currentAuthUserId = null;
      isPaused = true;
    }
  }

  function install(clientInstance) {
    if (client || !clientInstance || typeof clientInstance.rpc !== 'function') return;
    client = clientInstance;

    client.auth.onAuthStateChange(onAuthStateChanged);

    client.auth.getSession().then(function (result) {
      if (result.data && result.data.session && result.data.session.user) {
        setTimeout(function () {
          void startSession(result.data.session.user.id);
          void syncMeasuredSessions();
        }, 700);
      }
    }).catch(function (error) {
      logWarning('No se pudo recuperar la sesión de autenticación:', error && error.message);
    });

    if (typeof window.logout === 'function' && !window.logout.__motumTrackingWrapped) {
      originalLogout = window.logout;
      const wrappedLogout = async function () {
        await closeTracking('cierre_sesion');
        return originalLogout.apply(this, arguments);
      };
      wrappedLogout.__motumTrackingWrapped = true;
      window.logout = wrappedLogout;
    }

    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(syncMeasuredSessions, SYNC_MS);

    // Install the KPI wrapper after the main application has declared its global function.
    installDurationKpiPatch();
    logWarning('Medición de sesiones conectada.');
  }

  // supabase-integration.js creates the client asynchronously after loading the page.
  const waitForClient = setInterval(function () {
    if (window.motumSupabase) {
      clearInterval(waitForClient);
      install(window.motumSupabase);
    }
  }, 200);

  // Retry the KPI wrapper in case the main page finishes defining it slightly later.
  const waitForKpi = setInterval(function () {
    if (window.calcAdoptionKPIs) {
      installDurationKpiPatch();
      if (window.calcAdoptionKPIs.__motumDurationPatched) clearInterval(waitForKpi);
    }
  }, 500);
})();
