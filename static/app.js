"use strict";

const API = "";
let token = localStorage.getItem("fp_token") || null;
let me = null;
let state = {
  tasks: [], canjes: [], puntosPend: [], canjesPend: [], ocioPend: [], members: [], settings: {}, ocio: null,
  clasificacion: [], actividad: [], periodo: "mes"
};

const $ = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => Array.from(el.querySelectorAll(s));

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

// Renderiza un avatar: imagen si `emoji` es una ruta avatars/, si no el emoji tal cual.
function avatarHTML(e, cls="") {
  const v = e || "🙂";
  if (typeof v === "string" && v.startsWith("avatars/")) {
    return `<img class="avatar-img ${cls}" src="${esc(v)}" alt="avatar">`;
  }
  return `<span class="avatar-emoji ${cls}">${esc(v)}</span>`;
}

// ---------- API ----------
async function api(path, opts={}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers||{}) };
  if (token) headers["Authorization"] = "Bearer " + token;
  let res;
  try {
    res = await fetch(API + path, { ...opts, headers });
  } catch(err) {
    // El servidor no responde (sin red o sin conexión a casa) → marcar como offline
    const e = new Error("Sin conexión"); e.offline = true; throw e;
  }
  let data = null;
  try { data = await res.json(); } catch(e) {}
  if (res.status === 401) { logout(); throw new Error("Sesión caducada"); }
  if (!res.ok) {
    const m = (data && data.error) || "Error " + res.status;
    const err = new Error(m); err.detail = data; throw err;
  }
  return data;
}

// ---------- OFFLINE / CACHE ----------
function cacheData() {
  try { localStorage.setItem("fp_cache", JSON.stringify({ me, state, ts: Date.now() })); } catch(e){}
}
function loadCache() {
  try { const c = JSON.parse(localStorage.getItem("fp_cache")); return (c && c.me) ? c : null; } catch(e){ return null; }
}
function offlineQueue() {
  try { return JSON.parse(localStorage.getItem("fp_offline_queue") || "[]"); } catch(e){ return []; }
}
function saveOfflineQueue(q) {
  try { localStorage.setItem("fp_offline_queue", JSON.stringify(q)); } catch(e){}
}
function updateOfflineBanner() {
  const n = offlineQueue().length;
  const b = $("#offline-banner");
  if (!b) return;
  if (state._offline) {
    b.hidden = false;
    b.textContent = n ? `📴 Sin conexión · ${n} tarea${n>1?"s":""} por subir al llegar a casa` : "📴 Sin conexión · lo que marques se guardará y subirá al llegar";
  } else if (n > 0) {
    b.hidden = false;
    b.textContent = `⬆️ ${n} tarea${n>1?"s":""} pendiente${n>1?"s":""} de sincronizar…`;
  } else {
    b.hidden = true;
  }
}

function toast(msg, type="info") {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  t.classList.remove("success", "error");
  if (type === "success" || type === "error") t.classList.add(type);
  clearTimeout(t._h); t._h = setTimeout(() => t.hidden = true, 2200);
}

// ---------- Efectos: buzz, flyPts, confetti ----------
function buzz(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern || 30); } catch(e) {}
}

function flyPts(rect, puntos) {
  if (!rect || !(puntos > 0)) return;
  const el = document.createElement("div");
  el.className = "fly-pts";
  el.textContent = "+" + puntos;
  const startX = (rect.left + rect.width / 2) + "px";
  const startY = (rect.top + rect.height / 2) + "px";
  const chip = $(".saldo-chip");
  const endRect = chip ? chip.getBoundingClientRect() : { left: window.innerWidth - 90, top: 20, width: 60, height: 24 };
  el.style.left = startX;
  el.style.top = startY;
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    el.style.left = (endRect.left + endRect.width / 2) + "px";
    el.style.top = (endRect.top + endRect.height / 2) + "px";
    el.style.opacity = "0";
  });
  setTimeout(() => el.remove(), 900);
}

function confetti(emojis, n) {
  const set = emojis || ["🎉","✨","🎊","⭐","💛"];
  const total = n || 14;
  for (let i = 0; i < total; i++) {
    const el = document.createElement("div");
    el.className = "confetti";
    el.textContent = set[Math.floor(Math.random() * set.length)];
    el.style.left = Math.random() * 100 + "vw";
    el.style.fontSize = (14 + Math.random() * 14) + "px";
    el.style.animationDelay = (Math.random() * .5) + "s";
    el.style.animationDuration = (1.8 + Math.random() * 1.2) + "s";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }
}

function shortDate(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString("es-ES", { weekday:"short", hour:"2-digit", minute:"2-digit" }); }
  catch(e) { return iso; }
}

// ---------- LOGIN ----------
async function loadLoginMembers() {
  try {
    const d = await api("/api/public/members");
    const grid = $("#login-members");
    grid.innerHTML = d.members.map(m => `
      <button class="member-card" data-nombre="${esc(m.nombre)}" data-emoji="${esc(m.emoji)}">
        <span class="em">${avatarHTML(m.emoji)}</span><span class="nm">${esc(m.nombre)}</span>
      </button>`).join("");
    $$("#login-members .member-card").forEach(card => {
      card.addEventListener("click", () => {
        $$("#login-members .member-card").forEach(c => c.classList.remove("sel"));
        card.classList.add("sel");
        const pe = $("#pin"); pe.value = ""; pe.focus();
        const errEl = $("#login-error"); if (errEl) { errEl.hidden = true; errEl.textContent = ""; }
      });
    });
  } catch(e) {
    $("#login-members").innerHTML = `<p class="error">No se pudo conectar: ${esc(e.message)}</p>`;
  }
}

async function doLogin() {
  const sel = $("#login-members .member-card.sel");
  const errEl = $("#login-error");
  if (!sel) { errEl.textContent = "Primero toca tu nombre/avatar arriba para elegir quién eres."; errEl.hidden = false; return; }
  const nombre = sel.dataset.nombre;
  const pin = $("#pin").value;
  if (!pin) { errEl.textContent = "Escribe tu PIN de 4 dígitos."; errEl.hidden = false; return; }
  errEl.hidden = true;
  $("#btn-login").disabled = true;
  try {
    const d = await api("/api/login", { method: "POST", body: JSON.stringify({ nombre, pin }) });
    token = d.token; localStorage.setItem("fp_token", token); me = d.member;
    $("#login-error").hidden = true; cacheData(); enterApp();
  } catch(e) {
    if (e.offline) {
      $("#login-error").textContent = "Sin conexión · no se puede entrar ahora mismo.";
      $("#login-error").hidden = false;
    } else {
      $("#login-error").textContent = "PIN incorrecto o nombre no existe.";
      $("#login-error").hidden = false;
    }
  } finally { $("#btn-login").disabled = false; }
}

function logout() {
  token = null; localStorage.removeItem("fp_token"); me = null;
  $("#panel-app").hidden = true; $("#panel-login").hidden = false; loadLoginMembers();
}

function enterApp() {
  $("#panel-login").hidden = true; $("#panel-app").hidden = false;
  setTab("inicio"); refreshAll();
}

// ---------- DATA ----------
async function refreshAll() {
  if (!me) return;
  try {
    state.settings = await api("/api/settings");
    state.tasks = (await api("/api/tasks")).tasks;
    state.clasificacion = (await api("/api/clasificacion?periodo=" + state.periodo)).clasificacion;
    state.actividad = (await api("/api/actividad?limit=15")).actividad;
    const meNow = await api("/api/me");
    me = meNow.member; state._saldo = meNow.saldo; renderSaldo();
    state.canjes = meNow.canjes;
    state.ocio = (await api("/api/ocio"));
    if (me.rol === "padre") {
      state.puntosPend = (await api("/api/puntos/pendientes")).puntos;
      state.canjesPend = (await api("/api/canjes/pendientes")).canjes;
      state.ocioPend = (await api("/api/ocio/pendientes")).solicitudes;
      state.members = (await api("/api/members")).members;
    }
    updateNavBadge();
    state._offline = false;
    cacheData();                       // guardamos lo último para cuando no haya conexión
    setTab(activeTabName());
  } catch(e) {
    if (e.offline) {
      // Sin conexión al servidor → intentar render con lo que tenemos en caché
      const c = loadCache();
      if (c) { me = c.me; Object.assign(state, c.state); state._offline = true; renderSaldo(); setTab(activeTabName()); updateOfflineBanner(); }
      else { state._offline = true; updateOfflineBanner(); toast("Sin conexión a la app de casa · lo que marques se guardará"); }
    } else { toast(esc(e.message), "error"); }
  }
}

function activeTabName() {
  const t = $(".nav-item.active"); return t ? t.dataset.tab : "inicio";
}
function renderSaldo() { $("#me-saldo").textContent = "" + (state._saldo ?? 0) + " pts"; }
function updateNavBadge() {
  const b = $("#nav-pend");
  // Solo cuenta lo que de verdad hay que APROBAR (no lo ya aprobado/consumido)
  const n = (state.puntosPend?.length || 0) + (state.canjesPend?.length || 0)
          + (state.ocioPend?.length || 0);
  if (me.rol === "padre" && n > 0) { b.textContent = n; b.hidden = false; }
  else { b.hidden = true; }
}

// ---------- RENDER ----------
function render(name) {
  const c = $("#content");
  if (name === "inicio") return renderInicio(c);
  if (name === "tareas") return renderTareas(c);
  if (name === "canjes") return renderCanjes(c);
  if (name === "ocio") return renderOcio(c);
  if (name === "ajustes") return renderAjustes(c);
  if (name === "estadisticas") return renderEstadisticas(c);
}

function renderInicio(c) {
  const saldo = state._saldo ?? 0;
  const saldoAntes = state._saldo_prev;
  state._saldo_prev = saldo;
  const ptsPerEuro = parseInt(state.settings.pts_euro || "10");
  const euros = (saldo / ptsPerEuro).toFixed(2).replace(/\.00$/, "");
  const periodo = state.periodo;
  // Saludo personalizado: "Hola, {nombre}!" con su emoji
  const saludo = (me && me.nombre) ? `¡Hola, ${me.nombre}!` : "👋";
  let html = `
    <div class="greeting"><h2>${esc(saludo)}</h2>
      <div class="sub">Tu saldo: <b>${saldo}</b> pts ≈ ${euros} €</div></div>` + avisoTareas() + (me.rol==="padre"?avisoOcio():"") + `
    <div class="period">
      <button class="${periodo==='semana'?'active':''}" onclick="setPeriodo('semana')">Semana</button>
      <button class="${periodo==='mes'?'active':''}" onclick="setPeriodo('mes')">Mes</button>
      <button class="${periodo==='anio'?'active':''}" onclick="setPeriodo('anio')">Año</button>
    </div>`;
  // Podio (top 3 visual) + lista completa de TODOS → SOLO los padres ven el ranking.
  // Cada hijo ve únicamente sus propios puntos y su tiempo de ocio (sin comparaciones).
  const clasif = state.clasificacion || [];
  if (me.rol === "padre") {
    if (clasif.length) {
      const top = clasif.slice(0,3);
      html += `<div class="podium-card">
        <div class="pc-head">🏆 Clasificación familiar</div>
        <div class="pc-sub">¿Quién va ganando este ${periodo}?</div>
        <div class="podium">`;
      const orden = organizarPodio(top);
      orden.forEach(p => {
        const cls = p.pos === 1 ? "first" : "";
        const crown = p.pos === 1 ? '<span class="crown">👑</span>' : "";
        html += `<div class="pod ${cls}">
          ${crown}
          <div class="ava">${avatarHTML(p.emoji)}</div>
          <span class="pos">${p.pos}${p.pos===1?"º · 1st":p.pos===2?"º · 2nd":"º · 3rd"}</span>
          <span class="nm">${esc(p.nombre)}</span>
          <span class="pts">${p.pts} pts</span>
        </div>`;
      });
      html += `</div>`;
      // Lista completa con TODOS los miembros
      html += `<div class="rank-list">`;
      [...clasif].sort((a,b)=> b.pts - a.pts).forEach((p,i) => {
        const lugar = i+1;
        const medal = lugar===1 ? "🥇" : lugar===2 ? "🥈" : lugar===3 ? "🥉" : `${lugar}º`;
        html += `<div class="rank-row">
          <span class="rank-pos">${medal}</span>
          <div class="rank-ava">${avatarHTML(p.emoji)}</div>
          <span class="rank-nm">${esc(p.nombre)}</span>
          <span class="rank-pts">${p.pts} pts</span>
        </div>`;
      });
      html += `</div></div>`;
    } else {
      html += `<div class="podium-card"><div class="pc-head">🏆 Clasificación familiar</div>
        <div class="pc-sub">Sigue sin puntos, ¡a por ellos!</div></div>`;
    }
  } else {
    // Miembro (hijo): SU corona 👑 personal — cada uno es el campeón de su propia app
    // (sin ranking ni comparaciones con el hermano).
    const yo = clasif[0] || { pts: saldo };
    const ocio = state.ocio || {};
    const em = me.emoji || "🙂";
    const subio = saldoAntes != null && saldo > saldoAntes;
    html += `<div class="podium-card">
      <div class="pc-head">🏆 ¡Hoy eres el campeón!</div>
      <div class="crown-big${subio ? ' celebrate' : ''}">👑</div>
      <div class="pod first" style="padding:10px 0 6px">
        <div class="ava" style="width:72px;height:72px;font-size:34px;margin:0 auto">${avatarHTML(em)}</div>
        <div class="nm" style="font-size:16px">${esc(me.nombre)}</div>
        <div class="pts" style="font-size:15px;font-weight:800">${yo.pts} pts este ${periodo}</div>
      </div>
    </div>`;
    if (ocio && typeof ocio.saldo === "number") {
      const h = Math.floor(ocio.saldo/60), m = ocio.saldo%60;
      const ocioTxt = h ? `${h} h ${m} min` : `${m} min`;
      html += `<div class="card" style="margin-top:8px"><div class="pc-head">⏱️ Tu tiempo de ocio</div>
        <div class="pc-sub">Disponible: <b>${ocioTxt}</b></div></div>`;
    }
  }
  // Actividad reciente
  const act = state.actividad || [];
  html += `<div class="section-head"><h3>Actividad reciente</h3><span class="count">${act.length || ""}</span></div>
    <div class="card">`;
  if (!act.length) html += `<div class="empty"><div class="big">🌱</div><p>Todavía no hay actividad</p></div>`;
  act.forEach(a => {
    const signCls = a.puntos > 0 ? "plus" : (a.puntos < 0 ? "minus" : "pend");
    const sign = (a.puntos > 0 ? "+" : "") + a.puntos;
    const estado = a.estado === "pendiente" ? '<span class="muted" style="font-size:11px">· pendiente</span>' : "";
    const del = (me.rol === "padre") ? `<button class="act-del" data-id="${a.id}" title="Eliminar (por equivocación)">🗑️</button>` : "";
    html += `<div class="act-item">
      <div class="act-ava">${avatarHTML(a.miembro_emoji)}</div>
      <div class="act-grow">
        <div class="act-title">${esc(a.tarea||"Actividad")} ${estado}</div>
        <div class="act-meta">${esc(a.miembro)} · ${shortDate(a.creado)}</div>
      </div>
      <div class="act-pts ${signCls}">${sign}</div>
      ${del}
    </div>`;
  });
  html += `</div>`;
  c.innerHTML = html;
  // Eliminar actividad (solo padres): handler delegado en el contenedor
  c.querySelectorAll(".act-del").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      if (!(await confirmar("¿Eliminar esta actividad por equivocación? Se quitarán los puntos de esa acción.", {peligro:true}))) return;
      try {
        await api(`/api/actividad/${id}`, { method: "DELETE" });
        refreshAll();
      } catch (e) {
        toast("No se pudo eliminar: " + (e.error || "error"), "error");
      }
    });
  });
}

function organizarPodio(top) {
  const sorted = [...top].sort((a,b)=> b.pts - a.pts);
  const out = [];
  if (sorted.length >= 2) out.push({...sorted[1], pos:2});
  if (sorted.length >= 1) out.push({...sorted[0], pos:1});
  if (sorted.length >= 3) out.push({...sorted[2], pos:3});
  return out;
}

function avisoTareas() {
  // Todas las tareas son para cualquiera: ya no hay tareas "asignadas" que avisar
  return "";
}

// Aviso para el padre: actividad de OCIO de los hijos hoy (consumos de móvil/TV/Switch/Play)
function avisoOcio() {
  if (me.rol !== "padre") return "";
  const members = state.members || [];
  const consumos = members.filter(m => (m.ocio_consumido_hoy || 0) > 0);
  if (!consumos.length) return "";
  const ico = {tv:"📺",movil:"📱",switch:"🎮",play:"🎮",general:"⭐"};
  const items = consumos.map(m => {
    const u = m.ultimo_ocio || {};
    return `<div class="aviso-o-item">${avatarHTML(m.emoji,"ava-row")} <b>${esc(m.nombre)}</b> ha usado <b>${m.ocio_consumido_hoy} min</b> de ${ico[u.categoria]||"⏱️"} <span class="muted">· le quedan ${m.saldo_ocio} min</span></div>`;
  }).join("");
  const total = consumos.reduce((a,m)=>a+m.ocio_consumido_hoy,0);
  return `<div class="card aviso-ocio"><h3 style="margin-bottom:8px">⏱️ Ocio de hoy (${consumos.length} hijo${consumos.length>1?"s":""} · ${total} min usados)</h3>${items}</div>`;
}

function renderTareas(c) {
  const tasks = state.tasks || [];
  const filtro = state.filtroTareas || "ganar";
  let html = `<div class="greeting"><h2>Tareas</h2><div class="sub">Toca una para marcarla hecha</div></div>
    <div class="period">
      <button class="${filtro==='ganar'?'active':''}" onclick="setFiltroTareas('ganar')">Ganar</button>
      <button class="${filtro==='penalizar'?'active':''}" onclick="setFiltroTareas('penalizar')">Penalizar</button>
    </div>
    <div class="task-grid">`;
  const base = tasks; // todos ven todas las tareas (las de todos)
  const visibles = filtro === "penalizar" ? base.filter(t => t.puntos < 0) : base.filter(t => t.puntos >= 0);
  // Dividir: prioritarias (⭐) primero; resto
  const prior = visibles.filter(t => t.prioritaria);
  const resto = visibles.filter(t => !t.prioritaria);
  if (!visibles.length) {
    html += `<div class="empty" style="grid-column:1/-1"><div class="big">${filtro==="penalizar"?"😇":"🧩"}</div><p>${filtro==="penalizar"?"No hay penalizaciones":"No hay tareas para ganar"}</p></div>`;
  }
  const card = (t) => {
    const cls = (t.puntos < 0) ? "neg" : "";
    const sign = (t.puntos > 0 ? "+" : "") + t.puntos;
    const esSancionSinDueno = (t.puntos < 0) && !t.asignado_a && me.rol === "padre";
    const onclick = esSancionSinDueno ? `onclick="elegirPenalizado(${t.id})"` : `onclick="hacerTarea(${t.id})"`;
    const tituloBtn = esSancionSinDueno ? " ⚠️" : "";
    // Botones del padre: editar + eliminar (en un contenedor flex, lado a lado)
    const actsBtn = (me.rol === "padre")
      ? `<span class="task-acts">
           <button class="task-btn" title="Editar puntos / prioritaria / higiene" onclick="event.stopPropagation();editarTarea(${t.id})">✏️</button>
           <button class="task-btn" title="Eliminar" onclick="event.stopPropagation();eliminarTarea(${t.id})">🗑</button>
         </span>` : "";
    const para = t.asignado_nombre ? `<span class="para">Para ${esc(t.asignado_nombre)}</span>` : "";
    const star = t.prioritaria ? `<span class="tag-star">⭐ prioritaria</span>` : "";
    const acad = t.academica ? `<span class="tag-acad">🎓 académica</span>` : "";
    const hig = t.higiene ? `<span class="tag-hig">🧼 higiene</span>` : "";
    const ocio = t.min_ocio ? `<span class="tag-ocio">⏱️ +${t.min_ocio} min ocio</span>` : "";
    return `<div class="task-card ${t.prioritaria?'prior':''}${t.academica?' acad':''}" ${onclick}>
      <span class="em">${emojiDeTarea(t.titulo)}</span>
      <span class="t">${esc(t.titulo)}${tituloBtn}</span>
      <span class="p ${cls}">${sign} puntos</span>
      <span class="para">${para}${star}${acad}${hig}${ocio}</span>${actsBtn}
    </div>`;
  };
  if (filtro === "ganar") {
    if (prior.length) html += `<div class="task-grid-label">⭐ Primero <span class="muted" style="font-weight:400;font-size:11px">(haz 3, con 2 académicas 🎓)</span></div>`;
    prior.forEach(t => html += card(t));
    if (resto.length) html += `<div class="task-grid-label">Casa</div>`;
    resto.forEach(t => html += card(t));
  } else {
    visibles.forEach(t => html += card(t));
  }
  html += `</div>`;
  c.innerHTML = html;
}

async function eliminarTarea(taskId) {
  const t = (state.tasks || []).find(x => x.id === taskId);
  const nombre = t ? t.titulo : "esta actividad";
  if (!(await confirmar(`¿Eliminar "${nombre}"?`, {peligro:true}))) return;
  try {
    await api(`/api/tasks/${taskId}`, { method: "DELETE" });
    toast("Actividad eliminada");
    refreshAll();
  } catch(e) { toast(esc(e.message), "error"); }
}

function editarTarea(taskId) {
  const t = (state.tasks || []).find(x => x.id === taskId);
  if (!t) return;
  openSheet(`
    <h3>✏️ Editar actividad</h3>
    <p class="muted" style="margin-top:-6px"><b>${esc(t.titulo)}</b></p>
    <div class="field"><label>Puntos (usa − para restar → será sanción)</label>
      <input id="ed-puntos" type="number" inputmode="numeric" value="${t.puntos}"></div>
    <div class="field"><label>⏱️ Minutos de ocio que regala (0 = ninguno, recompensa doble)</label>
      <input id="ed-ocio" type="number" inputmode="numeric" min="0" value="${t.min_ocio||0}">
      <p class="muted">Al aprobar la tarea, además de los puntos, el hijo gana estos minutos de tele/móvil/consola (no se restan de los puntos).</p></div>
    <div class="field"><label><input type="checkbox" id="ed-prior" ${t.prioritaria?'checked':''}> ⭐ Prioritaria (leer, deberes, cuarto...)</label></div>
    <div class="field"><label><input type="checkbox" id="ed-acad" ${t.academica?'checked':''}> 🎓 Académica (leer, deberes, estudiar... — de las 3 prioritarias, 2 deben ser académicas)</label></div>
    <div class="field"><label><input type="checkbox" id="ed-hig" ${t.higiene?'checked':''}> 🧼 Higiene (dientes, ducha, cama... siempre se puede marcar)</label></div>
    <div class="sheet-actions"><button class="btn btn-ghost" onclick="closeSheet()">Cancelar</button>
      <button class="btn btn-primary" onclick="guardarEdicionTarea(${t.id})">Guardar</button></div>`, { focus: "#ed-puntos" });
}

async function guardarEdicionTarea(taskId) {
  const puntos = parseInt($("#ed-puntos").value);
  const prioritaria = $("#ed-prior").checked;
  const academica = $("#ed-acad").checked;
  const higiene = $("#ed-hig").checked;
  const min_ocio = parseInt($("#ed-ocio").value) || 0;
  if (!puntos) { toast("Los puntos no pueden ser 0", "error"); return; }
  try {
    await api(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ puntos, prioritaria, academica, higiene, min_ocio }) });
    closeSheet(); toast("Actividad actualizada", "success"); refreshAll();
  } catch(e) { toast(esc(e.message || "error"), "error"); }
}

async function setFiltroTareas(f) {
  state.filtroTareas = f;
  render("tareas");
}

function emojiDeTarea(titulo) {
  const t = (titulo||"").toLowerCase();
  const map = [
    ["dientes|cepillar|lavarse la boca","🪥"],["uña|uñas|uñitas","✂️"],["cara|crema|granos|granitos","🧼"],
    ["cam|habitacion|cuarto","🛏️"],["mesa|lavavajillas|plato|fregar|cocina","🍽️"],["perro|mascota","🐕"],
    ["limpia|orden|recoger|aspiradora|aspirar","🧹"],["deber|estudi|escuela|ingles","📚"],
    ["plan|regar|planta|flor","🪴"],["doblar|ropa|guardar|guardarla","👕"],["compr|super|merc","🛒"],["basura|reciclar","♻️"],
    ["tv|tele|panta","📺"],["cama","🛏️"],["puntual|hora","⏰"],["comport|bueno|bien","⭐"],["mal|grita|chillar","😤"],
    ["sobresaliente|notable|promedio|nota|por nota|examen","🎓"],["ayud|colabor","🤝"],
    ["leer|libro|leee|hoja","📖"],["deporte|ejerc|entren","⚽"],["pegar|zurra","🤜"],
    ["insult|malo|grosero|mala palabra","🤬"],["pelear|pelea|hermano","😓"],
    ["teléfono|telefono|movil|móvil","📱"],["dormir|acostar|dormir pronto|cama pronto","🌙"],
    ["cena|cocinar|guisar|comida|desayuno","🍳"],["lavadora|colada|lavar la ropa|lavar ropa|tender","🧺"],
    ["botella|agua|llenar la botella|rellenar","💧"],["pijama|camisón|piyama","🩲"],
    ["ducha|duchar","🚿"],["baño|bañar","🛁"]
  ];
  for (const [kw, em] of map) if (kw.split("|").some(k => t.includes(k))) return em;
  return "🧩";
}

function renderOcio(c) {
  const o = state.ocio || {};
  const saldo = o.saldo ?? 0;
  const tope = o.tope_dia ?? 300;
  const cats = o.cats || {};
  const hist = o.historial || [];
  const min = (m) => (m>=60? `${Math.floor(m/60)}h ${m%60}min` : `${m} min`);
  // Saludo + tarjeta de saldo
  let html = `<div class="greeting"><h2>⏱️ Tiempo de ocio</h2><div class="sub">La tele, el móvil, la consola... se paga con tu tiempo de ocio</div></div>
  <div class="card"><h3 style="margin-top:0">Tu tiempo disponible</h3>
    <div class="saldo-big">🕒 <b>${min(saldo)}</b></div>
    <p class="muted">Máximo por día: ${min(tope)}. Hoy tienes ${min(o.ganado_hoy||0)} ganados · ${min(o.consumido_hoy||0)} usados.</p>
  </div>`;
  // Solicitudes pendientes de aprobar por los padres
  const pend = (state.ocio && state.ocio.pendientes) || [];
  if (pend.length) {
    html += `<div class="card aviso-ocio"><h3 style="margin-top:0">⏳ Esperando a tus padres (${pend.length})</h3>
      ${pend.map(p=>`<div class="aviso-o-item">📱 <b>${-p.minutos} min</b> de ${p.categoria} · <span class="muted">pide el permiso</span></div>`).join("")}
    </div>`;
  }
  // Elementos
  html += `<div class="card"><h3 style="margin-top:0">¿Qué vas a usar?</h3>
    <div class="ocio-grid">`;
  Object.values(cats).forEach(ca => {
    html += `<div class="ocio-item" onclick="usarOcio('${ca.id}')">
      <div class="ocio-ico">${ca.label}</div>
      <div class="muted">Toca para pedirlo</div></div>`;
  });
  html += `</div>
    <p class="muted">👨‍👩‍👦 Cuando veáis la tele <b>con los papás</b>, no os descuenta: tocad el botón de abajo.</p>
    <button class="btn btn-ghost" onclick="ocioFamilia()">👨‍👩‍👦 Ver la tele en familia (no cuenta)</button>
  </div>`;
  // Historial
  html += `<div class="card"><h3 style="margin-top:0">Historial de ocio</h3>`;
  const icono = (cat) => ({tv:"📺",movil:"📱",switch:"🎮",play:"🎮",general:"⭐"}[cat]||"⏱️");
  if (!hist.length) html += `<p class="muted">Aún no has ganado ni usado tiempo. ¡Haz tus tareas para ganar!</p>`;
  hist.forEach(h => {
    const cls = h.minutos<0 ? "neg" : "ok";
    const fam = h.familia ? `<span class="tag-hig">👨‍👩‍👦 familia</span>` : "";
    html += `<div class="canje-item"><div class="row"><div style="flex:1">
      <b>${icono(h.categoria)}</b> <span class="muted">${esc(h.motivo||h.categoria)}</span>${fam}
      <div class="muted">${shortDate(h.creado)}</div></div>
      <span class="tag ${cls}">${h.minutos>0?"+":""}${h.minutos} min</span></div></div>`;
  });
  html += `</div>`;
  c.innerHTML = html;
}

function renderCanjes(c) {
  const misCanjes = state.canjes || [];
  let html = `<div class="greeting"><h2>Canjes</h2><div class="sub">Cambia tus puntos por paga o un capricho</div></div>
    <div class="card"><h3 style="margin-top:0">Mis canjes</h3>`;
  if (!misCanjes.length) html += `<div class="empty"><div class="big">🎁</div><p>Aún no has pedido nada</p></div>`;
  misCanjes.forEach(cj => {
    const saldo = state._saldo ?? 0;
    const puntos = cj.puntos;
    let estadoTxt, estadoCls = "pend";
    let progreso = "";
    if (cj.estado === "propuesto") { estadoTxt = "⏳ esperando precio"; }
    else if (cj.estado === "tasado") { estadoTxt = "💰 precio fijado"; }
    else if (cj.estado === "aprobado") {
      const alcanzado = puntos != null && saldo >= puntos;
      estadoCls = alcanzado ? "ok" : "pend";
      estadoTxt = alcanzado
        ? `<span class="reached">🎉 ¡Ya lo has alcanzado!</span> <br><span class="muted">Pide a tus padres que te lo den</span>`
        : `✅ aceptado · te faltan <b>${puntos - saldo}</b> pts`;
      if (puntos != null) {
        const pct = Math.max(0, Math.min(100, Math.round((saldo / puntos) * 100)));
        progreso = `<div class="progress-track"><div class="progress-fill${alcanzado ? ' done' : ''}" style="width:${alcanzado ? 100 : pct}%"></div></div>
          <div class="muted" style="font-size:11px;margin-top:3px">${saldo} de ${puntos} pts</div>`;
      }
    }
    const pendiente = cj.estado === "propuesto" || cj.estado === "tasado";
    const delBtn = pendiente ? `<button class="task-btn" title="Eliminar" onclick="event.stopPropagation();eliminarCanje(${cj.id})">🗑</button>` : "";
    html += `<div class="canje-item"><div class="row" style="position:relative"><div style="flex:1"><b>${esc(cj.titulo)}</b>
      <div class="muted">${cj.tipo==="paga"?"Paga (€)":"Capricho"} · <span class="${estadoCls}">${estadoTxt}</span></div>
      ${progreso}</div>
      ${cj.puntos!=null?`<span class="tag ${cj.estado==="tasado"||cj.estado==="aprobado"?"ok":"pend"}">${cj.puntos} pts</span>`:""}${delBtn}</div></div>`;
  });
  html += `</div><div class="card"><h3 style="margin-top:0">Quiero algo</h3>
    <p class="muted">Pide un capricho o saca paga. Los padres le ponen el precio.</p>
    <button class="btn btn-primary" onclick="abrirNuevoCanje()">Pedir un canje</button></div>`;
  c.innerHTML = html;
}

function usarOcio(cat) {
  const nombres = {tv:"📺 la tele", movil:"📱 el móvil", switch:"🎮 la Switch", play:"🎮 la Playstation"};
  const saldo = (state.ocio||{}).saldo ?? 0;
  if (saldo <= 0) { toast("No tienes minutos de ocio todavía. ¡Haz tareas para ganar!", "error"); return; }
  // Hoja propia (NO prompt(): en las PWA standalone de Android el prompt() está bloqueado)
  const precs = [15, 30, 45, 60];
  openSheet(`
    <h3>⏱️ Pedir ${nombres[cat]||cat}</h3>
    <p class="muted" style="margin-top:-6px">Tienes <b>${saldo} min</b> disponibles. Elige cuánto quieres usar (tus padres lo aprueban).</p>
    <div class="ocio-opts">${precs.map(p=>`<button class="btn btn-ghost" onclick="pedirOcio('${cat}',${p})">${p} min</button>`).join("")}</div>
    <div class="field" style="margin-top:12px"><label>O escribe los minutos</label>
      <input id="ocio-min" type="number" inputmode="numeric" min="1" max="${saldo}" placeholder="Ej: 20"></div>
    <div class="sheet-actions"><button class="btn btn-ghost" onclick="closeSheet()">Cancelar</button>
      <button class="btn btn-primary" onclick="pedirOcio('${cat}', parseInt($('#ocio-min').value)||0)">Pedir</button></div>`, { focus: "#ocio-min" });
}
function pedirOcio(cat, m) {
  if (!m || m <= 0) { toast("Indica los minutos", "error"); return; }
  consumirOcio(cat, m);
}
async function consumirOcio(cat, m) {
  try {
    const r = await api("/api/ocio/consumir", { method: "POST", body: JSON.stringify({ categoria: cat, minutos: m }) });
    closeSheet();
    toast(r.mensaje || "Solicitud enviada — espera a tus padres ⏳"); refreshAll();
  } catch(e) { toast(esc(e.message), "error"); }
}
async function ocioFamilia() {
  // Hoja propia (no prompt())
  const precs = [15, 30, 45, 60];
  openSheet(`
    <h3>👨‍👩‍👦 Tele en familia</h3>
    <p class="muted" style="margin-top:-6px">No descuenta de vuestro tiempo de ocio. ¿Cuántos minutos vais a ver la tele juntos?</p>
    <div class="ocio-opts">${precs.map(p=>`<button class="btn btn-ghost" onclick="familiaMin(${p})">${p} min</button>`).join("")}</div>
    <div class="field" style="margin-top:12px"><label>O escribe los minutos</label>
      <input id="ocio-fam" type="number" inputmode="numeric" min="1" placeholder="Ej: 30"></div>
    <div class="sheet-actions"><button class="btn btn-ghost" onclick="closeSheet()">Cancelar</button>
      <button class="btn btn-primary" onclick="familiaMin(parseInt($('#ocio-fam').value)||0)">Registrar</button></div>`, { focus: "#ocio-fam" });
}
async function familiaMin(m) {
  if (!m || m <= 0) { toast("Indica los minutos", "error"); return; }
  try {
    await api("/api/ocio/familia", { method: "POST", body: JSON.stringify({ minutos: m }) });
    closeSheet();
    toast("TV en familia registrada (no cuenta)", "success"); refreshAll();
  } catch(e) { toast(esc(e.message), "error"); }
}

async function eliminarCanje(cid) {
  const cj = (state.canjes || []).find(x => x.id === cid);
  const nombre = cj ? cj.titulo : "este canje";
  if (!(await confirmar(`¿Eliminar "${nombre}"?`, {peligro:true}))) return;
  try {
    await api(`/api/canjes/${cid}`, { method: "DELETE" });
    toast("Canje eliminado");
    refreshAll();
  } catch(e) { toast(esc(e.message), "error"); }
}
async function eliminarCanjePadre(cid) {
  const cj = (state.canjesPend || []).find(x => x.id === cid);
  const nombre = cj ? cj.titulo : "este canje";
  if (!(await confirmar(`¿Eliminar "${nombre}"?`, {peligro:true}))) return;
  try {
    await api(`/api/canjes/${cid}`, { method: "DELETE" });
    toast("Canje eliminado");
    refreshAll();
  } catch(e) { toast(esc(e.message), "error"); }
}

function renderAjustes(c) {
  const pendienteP = state.puntosPend || [];
  const pendienteC = state.canjesPend || [];
  const members = state.members || [];
  let html = `<div class="greeting"><h2>Ajustes</h2><div class="sub">Cambia tu PIN o gestiona la app</div></div>`;
  // Mi avatar (visible para TODO el mundo) — categorías colapsables
  const cats = [
    {name:"🦸 Superhéroes", dir:"hero",   prefix:"h"},
    {name:"🐾 Animales",     dir:"risa",   prefix:"r"},
    {name:"🐶 Pugs",        dir:"pug",    prefix:"p"}
  ];
  const emojisClasicos = ["🙂","😀","😎","🤩","🦸","🦸‍♂️","🦹","🕵️","🧑‍🚀","🧙","🤖","👽","🦇","🐱","🐶","🦊","🐼","🦁","🐸","🦄","🐯","👾","🚀","⚽","🏆","🥇","🎮","🏍️","🚴","🛹","🎧","🎸","⚡","🔥","💎","🍕"];
  const ava = me.emoji || "🙂";
  function avaSel(src){ return src===ava ? "sel" : ""; }
  // ¿qué categoría abre la que contenga mi avatar actual?
  function catOpen(cat){
    const nimg = cat.dir === "pug" ? 6 : 12;
    return Array.from({length:nimg},(_,i)=>`avatars/${cat.dir}/${cat.prefix}${String(i).padStart(2,'0')}.png`).includes(ava);
  }
  let avHTML = `<div class="card"><h3 style="margin-top:0">Mi avatar</h3>
    <p class="muted">Elige un avatar ilustrado (aparece en el podio, la actividad y tu perfil).</p>`;
  cats.forEach((cat,ci) => {
    const nimg = cat.dir === "pug" ? 6 : 12;
    const imgs = Array.from({length:nimg},(_,i)=>`avatars/${cat.dir}/${cat.prefix}${String(i).padStart(2,'0')}.png`);
    const open = catOpen(cat) ? "open" : "";
    avHTML += `
      <div class="cat-head ${open}" onclick="toggleCat('cat${ci}')">
        <span class="cat-chev">▸</span> ${cat.name}
      </div>
      <div id="cat${ci}" class="cat-body ${open}"><div class="avatar-grid">${
        imgs.map(p=>`<button class="avatar-opt ${avaSel(p)}" onclick="elegirAvatar('${p}')"><img src="${p}" alt="avatar"></button>`).join("")
      }</div></div>`;
  });
  avHTML += `<div class="cat-head" onclick="toggleCat('catEmoji')"><span class="cat-chev">▸</span> Emojis</div>
    <div id="catEmoji" class="cat-body"><div class="avatar-grid">${
      emojisClasicos.map(e=>`<button class="avatar-opt ${avaSel(e)}" onclick="elegirAvatar('${e}')">${e}</button>`).join("")
    }</div></div>
    <div class="credit">Animales: OpenMoji (CC BY-SA 4.0) · openmoji.org · Pugs: Wikimedia Commons (CC BY/dominio público)</div></div>`;
  html += avHTML;
  // Mi PIN (visible para TODO el mundo)
  html += `<div class="card"><h3 style="margin-top:0">Mi PIN</h3>
    <p class="muted">Elige un PIN de al menos 4 dígitos para entrar. Si lo cambias, la próxima vez uses este.</p>
    <div class="field-row">
      <div class="field"><label>PIN actual</label><input id="mp-actual" type="password" inputmode="numeric" placeholder="····"></div>
      <div class="field"><label>Nuevo PIN</label><input id="mp-nuevo" type="password" inputmode="numeric" placeholder="····"></div>
    </div>
    <button class="btn btn-primary" onclick="guardarMiPin()">Cambiar mi PIN</button></div>`;
  if (me.rol !== "padre") {
    html += `<div class="empty"><div class="big">🔒</div><p>Los demás ajustes (aprobar puntos, canjes, miembros) solo los ven los padres.</p></div>`;
    c.innerHTML = html; return;
  }
  // Aprobar puntos
  html += `<div class="card"><h3 style="margin-top:0">Puntos por aprobar (${pendienteP.length})</h3>`;
  if (!pendienteP.length) html += `<p class="muted">Nada pendiente.</p>`;
  pendienteP.forEach(p => {
    html += `<div class="canje-item"><div class="row"><div style="flex:1">
      <b>${esc(p.miembro)}</b> · <b style="color:${p.puntos<0?'var(--red)':'var(--green)'}">${p.puntos>0?"+":""}${p.puntos}</b> pts · <span class="muted">${esc(p.tarea||"")}</span>
      ${p.min_ocio?`<span class="tag-hig">⏱️ +${p.min_ocio} min ocio</span>`:""}
      <div class="muted">${shortDate(p.creado)}</div>
      <div id="juez-${p.id}" class="juez-out"></div></div>
      <div style="display:flex;gap:6px;flex-direction:column">
        <button class="btn btn-sm btn-green" title="Aprobar" onclick="decidirPunto(${p.id},'aprobar')">✅</button>
        <button class="btn btn-sm btn-red" title="Denegar" onclick="decidirPunto(${p.id},'denegar')">❌</button>
        <button class="btn btn-sm btn-ghost" onclick="juezPunto(${p.id})" title="Preguntar a la IA">⚖️ IA</button>
      </div></div>`;
  });
  html += `</div>`;
  // Aprobar canjes
  html += `<div class="card"><h3 style="margin-top:0">Canjes por aprobar (${pendienteC.length})</h3>`;
  if (!pendienteC.length) html += `<p class="muted">Nada pendiente.</p>`;
  pendienteC.forEach(cj => {
    const tasado = cj.puntos != null;
    const saldoHijo = (state.members||[]).find(m => m.id === cj.miembro_id)?.saldo ?? 0;
    const ownerRol = (state.members||[]).find(m => m.id === cj.miembro_id)?.rol;
    const esMiCanjePadre = ownerRol === "padre" && cj.miembro_id === me.id;
    let acción;
    if (esMiCanjePadre) {
      const otroPadre = (state.members||[]).find(m => m.rol === "padre" && m.id !== me.id);
      const nombreOtro = otroPadre ? esc(otroPadre.nombre) : "el otro padre";
      acción = cj.estado === "aprobado"
        ? `<span class="muted">↔ Lo entrega <b>${nombreOtro}</b></span>`
        : `<span class="muted">↔ Lo revisa <b>${nombreOtro}</b></span>`;
    } else if (cj.estado === "aprobado") {
      const alcanzado = tasado && saldoHijo >= cj.puntos;
      acción = alcanzado
        ? `<button class="btn btn-sm btn-green" onclick="canjearCanje(${cj.id})" title="Entregar la recompensa y descontar los puntos">🔄 Canjear</button>`
        : `<span class="muted">✅ aceptado · le faltan ${tasado?cj.puntos - saldoHijo:0} pts</span>`;
    } else {
      acción = tasado
        ? `<button class="btn btn-sm btn-primary" title="Aceptar" onclick="decidirCanje(${cj.id},'aprobar')">✅ Aceptar</button><button class="btn btn-sm btn-red" title="Denegar" onclick="decidirCanje(${cj.id},'denegar')">❌</button>`
        : `<button class="btn btn-sm btn-ghost" onclick="tasarCanje(${cj.id})">Tasar</button><button class="btn btn-sm btn-red" title="Denegar" onclick="decidirCanje(${cj.id},'denegar')">❌</button>`;
    }
    html += `<div class="canje-item"><div class="row"><div style="flex:1">
      <b>${esc(cj.miembro)}</b> quiere <b>${esc(cj.titulo)}</b><div class="muted">${cj.tipo==="paga"?"Paga":"Capricho"}${cj.estado==="aprobado"?' · <b>aceptado</b>':''} · saldo ${saldoHijo} pts</div></div>
      ${tasado?`<span class="tag pend">${cj.puntos} pts</span>`:""}
      <div style="display:flex;gap:6px">
        ${acción}
        <button class="btn btn-sm btn-ghost" title="Eliminar" onclick="eliminarCanjePadre(${cj.id})">🗑</button>
      </div></div>`;
  });
  html += `</div>`;
  // Aprobar solicitudes de OCIO (gasto de tiempo de pantalla de los hijos)
  const pendienteO = state.ocioPend || [];
  const icoO = {tv:"📺",movil:"📱",switch:"🎮",play:"🎮",general:"⭐"};
  html += `<div class="card"><h3 style="margin-top:0">⏱️ Ocio por aprobar (${pendienteO.length})</h3>`;
  if (!pendienteO.length) html += `<p class="muted">Nada pendiente.</p>`;
  pendienteO.forEach(s => {
    const saldoO = (state.members||[]).find(m => m.id === s.miembro_id)?.saldo_ocio ?? 0;
    html += `<div class="canje-item"><div class="row"><div style="flex:1">
      <b>${esc(s.miembro)}</b> quiere usar <b>${-s.minutos} min</b> de ${icoO[s.categoria]||"⏱️"} <span class="muted">· le quedan ${saldoO} min</span>
      <div class="muted">${shortDate(s.creado)}</div></div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-sm btn-green" title="Aprobar" onclick="decidirOcio(${s.id},'aprobar')">✅</button>
        <button class="btn btn-sm btn-red" title="Denegar" onclick="decidirOcio(${s.id},'denegar')">❌</button>
      </div></div>`;
  });
  html += `</div>`;
  // Nueva actividad/tarea: positiva = para todos, negativa = sanción (puede asignarse a un hijo)
  html += `<div class="card"><h3 style="margin-top:0">Nueva actividad</h3>
    <div class="field"><label>Qué hay que hacer</label><input class="nt-titulo" placeholder="Ej: Limpiar la habitación"></div>
    <div class="field"><label>Puntos (usa − para restar → será sanción)</label><input class="nt-puntos" type="number" inputmode="numeric" placeholder="+25 o -15" oninput="toggleAsignado(this)"></div>
    <div class="field"><label>⏱️ Minutos de ocio que regala (0 = ninguno)</label><input class="nt-ocio" type="number" inputmode="numeric" min="0" placeholder="0"></div>
    <div class="field nt-asignado-wrap" hidden><label>¿Para quién?</label>
      <select class="nt-asignado"><option value="">Todos (la puede hacer cualquiera)</option>
      ${members.filter(m=>m.rol==="miembro").map(m=>`<option value="${m.id}">${esc(m.nombre)}</option>`).join("")}</select>
      <p class="muted">Si es una sanción (negativa), puedes asignarla a un hijo concreto.</p></div>
    <div class="field nt-prior-wrap"><label><input type="checkbox" class="nt-prior"> ⭐ Prioritaria (leer, deberes, cuarto...)</label>
      <p class="muted">Se hace antes que el resto. Los hijos deben marcar una al día antes de las de casa.</p></div>
    <div class="field nt-acad-wrap"><label><input type="checkbox" class="nt-acad"> 🎓 Académica (leer, deberes, estudiar...)</label>
      <p class="muted">De las 3 prioritarias del día, 2 deben ser académicas.</p></div>
    <div class="field nt-hig-wrap"><label><input type="checkbox" class="nt-hig"> 🧼 Higiene (dientes, ducha, cama...)</label>
      <p class="muted">Las de higiene se pueden marcar siempre (no bloquean con las prioritarias).</p></div>
    <button class="btn btn-primary" onclick="crearTarea()">Añadir</button></div>`;
  // Miembros
  html += `<div class="card"><h3 style="margin-top:0">Miembros (${members.length})</h3>`;
  members.forEach(m => {
    const ocioMin = m.saldo_ocio ?? 0;
    const ocioTxt = ocioMin>=60 ? `${Math.floor(ocioMin/60)}h ${ocioMin%60}m` : `${ocioMin} min`;
    // Última actividad de ocio (para enterarse de lo que hacen)
    let ocioAct = "";
    if (m.ultimo_ocio) {
      const u = m.ultimo_ocio;
      const cls = u.minutos<0 ? "neg" : "ok";
      const fam = u.familia ? "·👨‍👩‍👦familia" : "";
      const ico = {tv:"📺",movil:"📱",switch:"🎮",play:"🎮",general:"⭐"}[u.categoria]||"⏱️";
      ocioAct = `<div class="muted" style="font-size:11px;color:${u.minutos<0?'var(--red)':'var(--green)'}">${ico} ${u.minutos>0?'+':''}${u.minutos} min ${fam} · ${shortDate(u.creado)}</div>`;
    }
    const aviso = m.ocio_consumido_hoy ? `<span class="badge-ocio">hoy: ${m.ocio_consumido_hoy} min usados</span>` : "";
    html += `<div class="row" style="margin-bottom:8px"><div style="flex:1">${avatarHTML(m.emoji,"ava-row")} <b>${esc(m.nombre)}</b>
      <span class="tag">${m.rol}</span> <span class="muted">· ${m.saldo} pts</span> <span class="tag-ocio">⏱️ ${ocioTxt}</span>${aviso}
      ${ocioAct}
      </div>
      <button class="btn btn-sm btn-ghost" onclick="resetPin(${m.id})">PIN</button></div>`;
  });
  html += `</div>`;
  // Nuevo miembro
  html += `<div class="card"><h3 style="margin-top:0">Nuevo miembro</h3>
    <div class="field-row"><div class="field"><label>Nombre</label><input id="nm-nombre"></div>
      <div class="field"><label>PIN (mín 4)</label><input id="nm-pin" inputmode="numeric"></div></div>
    <div class="field-row"><div class="field"><label>Rol</label><select id="nm-rol"><option value="miembro">Miembro</option><option value="padre">Padre</option></select></div>
      <div class="field"><label>Emoji</label><input id="nm-emoji" value="🙂" maxlength="4"></div></div>
    <button class="btn btn-primary" onclick="crearMiembro()">Añadir</button></div>`;
  // Paga
  html += `<div class="card"><h3 style="margin-top:0">Paga</h3>
    <div class="row"><div style="flex:1"><b>Puntos por euro</b><div class="muted">Cuántos puntos valen 1 €</div></div>
      <input id="ptseuro" type="number" value="${esc(state.settings.pts_euro||"10")}" style="width:70px"></div>
    <div style="margin-top:10px"><button class="btn btn-sm btn-ghost" onclick="guardarPtsEuro()">Guardar</button></div></div>`;
  // Notificaciones Telegram
  const tg = state.settings.tg_activado === "1";
  html += `<div class="card"><h3 style="margin-top:0">🔔 Notificaciones por Telegram</h3>
    <p class="muted">Te avisa aquí cuando un hijo marca una tarea, propone un canje o pide tiempo de ocio. Así no tienes que abrir la app.</p>
    <div class="field"><label><input type="checkbox" id="tg-activado" ${tg?'checked':''}> Activar alertas</label></div>
    <div class="field-row"><div class="field"><label>Chat ID</label><input id="tg-chat" value="${esc(state.settings.tg_chat||'')}" placeholder="123456789"></div>
      <div class="field"><label>Bot token</label><input id="tg-token" type="password" value="${esc(state.settings.tg_token||'')}" placeholder="123456:ABC..."></div></div>
    <div style="margin-top:8px;display:flex;gap:8px">
      <button class="btn btn-sm btn-primary" onclick="guardarTelegram()">Guardar</button>
      <button class="btn btn-sm btn-ghost" onclick="probarTelegram()">Enviar prueba</button>
    </div></div>`;
  // Reset (peligro)
  html += `<div class="card" style="border-left:4px solid var(--red)"><h3 style="margin-top:0;color:var(--red)">Zona de peligro</h3>
    <p class="muted">Borrar TODOS los puntos, canjes y tiempo de ocio para empezar de cero. No se puede deshacer.</p>
    <button class="btn btn-sm btn-red" onclick="resetFamilia()">🗑 Resetear todo</button></div>`;
  c.innerHTML = html;
}

async function resetFamilia() {
  if (!(await confirmar("¿Resetear TODOS los puntos, canjes y tiempo de ocio de la familia?", {peligro:true}))) return;
  if (!(await confirmar("¿Seguro? Esto NO se puede deshacer. Los hijos perderán también su tiempo de ocio.", {peligro:true}))) return;
  try {
    await api("/api/reset", { method: "POST" });
    toast("Todo a cero ✓", "success");
    refreshAll();
  } catch(e) { toast(esc(e.message), "error"); }
}

function toggleCat(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const head = el.previousElementSibling;
  const isOpen = el.classList.contains("open");
  if (isOpen) {
    el.classList.remove("open"); el.style.display = "none";
    head && head.classList.remove("open"); head && head.classList.add("closed");
  } else {
    el.classList.add("open"); el.style.display = "";
    head && head.classList.add("open"); head && head.classList.remove("closed");
  }
}

async function elegirAvatar(emoji) {
  try {
    await api("/api/me/emoji", { method: "PUT", body: JSON.stringify({ emoji }) });
    me.emoji = emoji;
    toast("Avatar actualizado ✓", "success");
    refreshAll();
  } catch(e) { toast(esc(e.message), "error"); }
}

async function guardarMiPin() {
  const actual = $("#mp-actual").value;
  const nuevo = $("#mp-nuevo").value;
  if (nuevo.length < 4) { toast("El nuevo PIN debe tener al menos 4 dígitos", "error"); return; }
  try {
    await api("/api/me/pin", { method: "PUT", body: JSON.stringify({ actual, nuevo }) });
    toast("PIN actualizado ✓", "success");
    $("#mp-actual").value = ""; $("#mp-nuevo").value = "";
  } catch(e) {
    toast(e.message === "PIN actual incorrecto" || e.detail?.error === "pin_actual_incorrecto" ? "Tu PIN actual no es correcto" : esc(e.message), "error");
  }
}

// ---------- PERIODO ----------
async function setPeriodo(p) {
  state.periodo = p;
  try {
    state.clasificacion = (await api("/api/clasificacion?periodo=" + p)).clasificacion;
    render("inicio");
  } catch(e) { toast(esc(e.message), "error"); }
}

// ---------- FAB ----------
function onFab() {
  if (me.rol === "padre") abrirNuevaTarea();
  else abrirNuevoCanje();
}

// ---------- ACTIONS ----------
function elegirPenalizado(taskId) {
  const t = (state.tasks || []).find(x => x.id === taskId);
  const hijos = (state.members || []).filter(m => m.rol === "miembro");
  if (!hijos.length) { toast("No hay hijos a quien aplicar la sanción", "error"); return; }
  const lista = hijos.map(m => `<div class="sancion-hijo" onclick="aplicarPenalizacion(${taskId}, ${m.id})">
      <span class="ava-sm">${avatarHTML(m.emoji)}</span> ${esc(m.nombre)}</div>`).join("");
  openSheet(`<h3>⚠️ Sanción: ${esc(t ? t.titulo : "")}</h3>
    <p class="muted">¿A quién se la aplicas? ${t ? `(−${Math.abs(t.puntos)} pts)` : ""}</p>
    <div class="sancion-list">${lista}</div>`);
}

async function aplicarPenalizacion(taskId, miembroId) {
  try {
    await api(`/api/tasks/${taskId}/hecho`, { method: "POST", body: JSON.stringify({ miembro_id: miembroId }) });
    closeSheet();
    toast("Sanción aplicada · a la espera de aprobación");
    refreshAll();
  } catch(e) { toast(esc(e.message), "error"); }
}

async function hacerTarea(taskId) {
  try {
    const t = (state.tasks || []).find(x => x.id === taskId);
    await api(`/api/tasks/${taskId}/hecho`, { method: "POST" });
    const card = $(`.task-card[onclick*="hacerTarea(${taskId})"]`);
    const esPrior = !!t?.prioritaria;
    const esAcad = !!t?.academica;
    if (t && t.puntos > 0) flyPts(card ? card.getBoundingClientRect() : null, t.puntos);
    if (esPrior) {
      confetti((esAcad ? ["🎓","⭐","✨","📚","💛","🏆"] : ["⭐","✨","💛","🎉"]), esAcad ? 34 : 22);
      buzz(esAcad ? [50,60,50,60,50] : [30,50,30]);
    } else {
      buzz(30);
    }
    toast(esAcad ? "🎓⭐ ¡Prioritaria académica!" : (esPrior ? "⭐ ¡Prioritaria!" : "Marcado · a la espera de aprobación"), "success");
    refreshAll();
  } catch(e) {
    if (e.offline) {
      // Sin conexión → guardar en cola local para subir al llegar a casa
      const t = (state.tasks || []).find(x => x.id === taskId);
      const q = offlineQueue();
      if (!q.some(x => x.task_id === taskId)) {
        q.push({ task_id: taskId, titulo: t ? t.titulo : "Tarea", puntos: t ? t.puntos : 0, fecha: new Date().toISOString() });
        saveOfflineQueue(q);
      }
      toast("📴 Sin conexión · guardado para subir al llegar a casa");
      // Marcarla como hecha localmente para que no la vuelva a intentar
      const card = $(`.task-card[onclick*="hacerTarea(${taskId})"]`);
      if (card) card.classList.add("done");
      updateOfflineBanner();
    } else {
      // Mensaje claro si es la regla de tareas prioritarias
      const m = e.detail?.mensaje || (e.detail?.error === "falta_prioritaria" ? "Haz primero una tarea prioritaria (leer, deberes o limpiar tu cuarto) 📚" : e.message);
      toast(esc(m), "error");
    }
  }
}

async function decidirPunto(id, accion) {
  try {
    await api(`/api/puntos/${id}/decidir`, { method: "POST", body: JSON.stringify({ accion }) });
    if (accion === "aprobar") { buzz([20, 40, 20]); confetti(); }
    toast(accion === "aprobar" ? "Puntos aprobados ✓" : "Puntos denegados", accion === "aprobar" ? "success" : "info");
    refreshAll();
  } catch(e) { toast(esc(e.message), "error"); }
}

async function juezPunto(id) {
  const p = (state.puntosPend || []).find(x => x.id === id);
  if (!p) return;
  const out = document.getElementById("juez-" + id);
  if (!out) return;
  out.innerHTML = `<div class="muted">⚖️ Consultando a la IA...</div>`;
  const caso = `${p.miembro} dice que ha hecho "${p.tarea || "la tarea"}" (${p.puntos>0?"+":""}${p.puntos} puntos). ¿Aprobar o denegar?`;
  try {
    const d = await api("/api/ai-judge", { method: "POST", body: JSON.stringify({ caso }) });
    const color = d.veredicto === "APROBADO" ? "var(--green)" : (d.veredicto === "DENEGADO" ? "var(--red)" : "var(--muted)");
    out.innerHTML = `<div style="margin-top:6px;padding:8px;background:var(--blue-soft);border-radius:8px;font-size:13px">
      <b style="color:${color}">⚖️ ${d.veredicto}</b> <span class="muted">${esc(d.razon||"")}</span></div>
      <div style="display:flex;gap:6px;margin-top:6px">
        ${d.veredicto === "APROBADO" ? `<button class="btn btn-sm btn-green" onclick="decidirPunto(${id},'aprobar')">Aplicar aprobar</button>` : ""}
        ${d.veredicto === "DENEGADO" ? `<button class="btn btn-sm btn-red" onclick="decidirPunto(${id},'denegar')">Aplicar denegar</button>` : ""}
      </div>`;
  } catch(e) {
    out.innerHTML = `<div class="muted">⚠️ No se pudo consultar la IA: ${esc(e.message)}</div>`;
  }
}

async function crearTarea() {
  const titulo = $(".nt-titulo").value.trim();
  const puntos = parseInt($(".nt-puntos").value);
  if (!titulo || !puntos) { toast("Rellena título y puntos (puede ser negativo)", "error"); return; }
  // Solo las sanciones (negativas) pueden asignarse a un hijo concreto; positivas = para todos
  let asignado_a = null;
  if (puntos < 0) {
    const sel = $(".nt-asignado");
    asignado_a = sel && sel.value ? parseInt(sel.value) : null;
  }
  // Prioritaria: solo deja marcarla si es positiva (para todos) — las sanciones no aplican
  const priChk = $(".nt-prior");
  const prioritaria = !!(priChk && priChk.checked && puntos > 0);
  const acadChk = $(".nt-acad");
  const academica = !!(acadChk && acadChk.checked && puntos > 0);
  const higChk = $(".nt-hig");
  const higiene = !!(higChk && higChk.checked && puntos > 0);
  const ocioChk = $(".nt-ocio");
  const min_ocio = (ocioChk && parseInt(ocioChk.value) > 0) ? parseInt(ocioChk.value) : 0;
  try {
    const r = await api("/api/tasks", { method: "POST", body: JSON.stringify({ titulo, puntos, asignado_a, prioritaria, academica, higiene, min_ocio }) });
    const destino = asignado_a ? " · asignada al hijo elegido" : "";
    toast((prioritaria ? "⭐ Actividad prioritaria creada" : (higiene ? "🧼 Actividad de higiene creada" : "Actividad creada")) + destino, "success");
    const t = $(".nt-titulo"); const p = $(".nt-puntos"); if (t) t.value = ""; if (p) p.value = "";
    const pc = $(".nt-prior"); if (pc) pc.checked = false;
    const ac = $(".nt-acad"); if (ac) ac.checked = false;
    const hc = $(".nt-hig"); if (hc) hc.checked = false;
    const oc = $(".nt-ocio"); if (oc) oc.value = "";
    refreshAll();
  } catch(e) { toast(esc(e.message), "error"); }
}

function abrirNuevaTarea() {
  const hijas = (state.members || []).filter(m => m.rol === "miembro");
  openSheet(`
    <h3>Nueva actividad</h3>
    <div class="field"><label>Qué hay que hacer</label><input class="nt-titulo" placeholder="Ej: Limpiar la habitación"></div>
    <div class="field"><label>Puntos (usa − para restar → será sanción)</label><input class="nt-puntos" type="number" inputmode="numeric" placeholder="+25 o -15" oninput="toggleAsignado(this)"></div>
    <div class="field"><label>⏱️ Minutos de ocio que regala (0 = ninguno)</label><input class="nt-ocio" type="number" inputmode="numeric" min="0" placeholder="0"></div>
    <div class="field nt-asignado-wrap" hidden><label>¿Para quién?</label>
      <select class="nt-asignado"><option value="">Todos (la puede hacer cualquiera)</option>
      ${hijas.map(m=>`<option value="${m.id}">${esc(m.nombre)}</option>`).join("")}
      </select>
      <p class="muted">Si es una sanción (negativa), puedes asignarla a un hijo concreto. Positiva = para todos.</p>
    </div>
    <div class="field nt-prior-wrap"><label><input type="checkbox" class="nt-prior"> ⭐ Prioritaria (leer, deberes, cuarto...)</label>
      <p class="muted">Las prioritarias se hacen antes que el resto. Los hijos deben marcar una al día antes de las de casa.</p>
    </div>
    <div class="field nt-acad-wrap"><label><input type="checkbox" class="nt-acad"> 🎓 Académica (leer, deberes, estudiar...)</label>
      <p class="muted">De las 3 prioritarias del día, 2 deben ser académicas.</p>
    </div>
    <div class="field nt-hig-wrap"><label><input type="checkbox" class="nt-hig"> 🧼 Higiene (dientes, ducha, cama...)</label>
      <p class="muted">Las de higiene se pueden marcar siempre (no bloquean con las prioritarias).</p>
    </div>
    <button class="btn btn-primary" onclick="crearTarea()">Añadir</button>`, { focus: ".nt-titulo" });
}
function toggleAsignado(input) {
  const w = document.querySelector(".nt-asignado-wrap");
  if (!w) return;
  const v = parseInt(input.value, 10);
  w.hidden = !(v < 0);   // solo se muestra para penalizaciones (negativas)
}

// ---- Canjes ----
function abrirNuevoCanje() {
  openSheet(`
    <h3>Quiero algo</h3>
    <div class="field"><label>¿Qué quieres?</label><input id="nc-titulo" placeholder="Ej: la paga, un juego..."></div>
    <div class="field"><label>Tipo</label><select id="nc-tipo"><option value="cosa">Un capricho</option><option value="paga">Paga</option></select></div>
    <div class="sheet-actions"><button class="btn btn-ghost" onclick="closeSheet()">Cancelar</button>
      <button class="btn btn-primary" onclick="crearCanje()">Pedir</button></div>`, { focus: "#nc-titulo" });
}

async function crearCanje() {
  const titulo = $("#nc-titulo").value.trim();
  const tipo = $("#nc-tipo").value;
  if (!titulo) { toast("Di qué quieres", "error"); return; }
  try {
    await api("/api/canjes", { method: "POST", body: JSON.stringify({ titulo, tipo }) });
    closeSheet(); toast("Pedido enviado a los padres", "success"); refreshAll();
  } catch(e) { toast(esc(e.message), "error"); }
}

async function tasarCanje(id) {
  openSheet(`
    <h3>Poner precio</h3>
    <div class="field"><label>¿Cuántos puntos vale?</label><input id="ts-puntos" type="number" min="1" inputmode="numeric" placeholder="Ej: 50"></div>
    <div class="sheet-actions"><button class="btn btn-ghost" onclick="closeSheet()">Cancelar</button>
      <button class="btn btn-primary" onclick="guardarTasa(${id})">Fijar precio</button></div>`, { focus: "#ts-puntos" });
}

async function guardarTasa(id) {
  const puntos = parseInt($("#ts-puntos").value);
  if (!(puntos > 0)) { toast("Precio en puntos", "error"); return; }
  try { await api(`/api/canjes/${id}/tasar`, { method: "POST", body: JSON.stringify({ puntos }) }); closeSheet(); toast("Precio fijado", "success"); refreshAll(); }
  catch(e) { toast(esc(e.message), "error"); }
}

async function decidirCanje(id, accion) {
  try {
    await api(`/api/canjes/${id}/decidir`, { method: "POST", body: JSON.stringify({ accion }) });
    toast(accion === "aprobar" ? "Canje aceptado ✓ (se descontará al entregarlo)" : "Canje denegado", accion === "aprobar" ? "success" : "info");
    refreshAll();
  } catch(e) { toast(esc(e.message || "error"), "error"); refreshAll(); }
}

async function decidirOcio(id, accion) {
  try {
    await api(`/api/ocio/${id}/decidir`, { method: "POST", body: JSON.stringify({ accion }) });
    toast(accion === "aprobar" ? "Tiempo de ocio aprobado ⏱️ (se descuenta del hijo)" : "Solicitud de ocio denegada", accion === "aprobar" ? "success" : "info");
    refreshAll();
  } catch(e) { toast(esc(e.message || "error"), "error"); refreshAll(); }
}

async function canjearCanje(id) {
  const cj = (state.canjesPend || []).find(x => x.id === id);
  const nombre = cj ? cj.titulo : "este canje";
  if (!(await confirmar(`¿Confirmar la entrega de "${nombre}"? Se descontarán los puntos al hijo.`))) return;
  try {
    const r = await api(`/api/canjes/${id}/canjear`, { method: "POST" });
    confetti(["🎁","🎉","✨","🎊"]);
    toast("Recompensa entregada 🎁 · puntos descontados", "success");
    refreshAll();
  } catch(e) {
    const err = e.detail?.error || e.error;
    toast(err === "saldo_insuficiente" ? "Aún no tiene suficientes puntos" : ("No se pudo canjear: " + err), "error");
    refreshAll();
  }
}

async function crearMiembro() {
  const nombre = $("#nm-nombre").value.trim();
  const pin = $("#nm-pin").value;
  const rol = $("#nm-rol").value;
  const emoji = $("#nm-emoji").value.trim() || "🙂";
  if (!nombre || pin.length < 4) { toast("Nombre y PIN mínimo 4", "error"); return; }
  try { await api("/api/members", { method: "POST", body: JSON.stringify({ nombre, pin, rol, emoji }) }); toast("Miembro añadido", "success"); $("#nm-nombre").value=""; $("#nm-pin").value=""; refreshAll(); }
  catch(e) { toast(esc(e.message), "error"); }
}

async function resetPin(id) {
  // Hoja propia (no prompt(): bloqueado en PWA standalone de Android)
  openSheet(`
    <h3>🔑 Nuevo PIN</h3>
    <p class="muted" style="margin-top:-6px">Mínimo 4 dígitos.</p>
    <div class="field"><label>Nuevo PIN</label><input id="rp-pin" type="password" inputmode="numeric" maxlength="4" placeholder="····"></div>
    <div class="sheet-actions"><button class="btn btn-ghost" onclick="closeSheet()">Cancelar</button>
      <button class="btn btn-primary" onclick="guardarResetPin(${id}, document.getElementById('rp-pin').value)">Guardar</button></div>`, { focus: "#rp-pin" });
}
async function guardarResetPin(id, pin) {
  if (!pin) { toast("Escribe el PIN", "error"); return; }
  if (pin.length < 4) { toast("Mínimo 4", "error"); return; }
  try { await api(`/api/members/${id}/reset_pin`, { method: "PUT", body: JSON.stringify({ pin }) }); closeSheet(); toast("PIN cambiado", "success"); }
  catch(e) { toast(esc(e.message), "error"); }
}

async function guardarPtsEuro() {
  const v = parseInt($("#ptseuro").value);
  if (!(v > 0)) { toast("Valor inválido", "error"); return; }
  try { await api("/api/settings/pts_euro", { method: "PUT", body: JSON.stringify({ pts_euro: v }) }); toast("Conversión guardada", "success"); refreshAll(); }
  catch(e) { toast(esc(e.message), "error"); }
}

async function guardarTelegram() {
  try {
    await api("/api/settings/telegram", { method: "PUT", body: JSON.stringify({
      activado: $("#tg-activado").checked,
      token: $("#tg-token").value.trim(),
      chat: $("#tg-chat").value.trim(),
    })});
    toast("Configuración de Telegram guardada", "success"); refreshAll();
  } catch(e) { toast(esc(e.message), "error"); }
}

async function probarTelegram() {
  try {
    // Guardar antes de probar, para que use los valores recién escritos
    await api("/api/settings/telegram", { method: "PUT", body: JSON.stringify({
      activado: $("#tg-activado").checked,
      token: $("#tg-token").value.trim(),
      chat: $("#tg-chat").value.trim(),
    })});
  } catch(e) {}
  try {
    const r = await api("/api/settings/telegram/test", { method: "POST" });
    toast(r.mensaje || "Mensaje de prueba enviado ✓", "success");
  } catch(e) {
    toast(esc(e.detail?.mensaje || e.message), "error");
  }
}

// ---------- SHEET ----------
function openSheet(html, opts={}) {
  const back = document.createElement("div");
  back.className = "sheet-backdrop";
  back.innerHTML = `<div class="sheet">${html}</div>`;
  back.addEventListener("click", e => { if (e.target === back) closeSheet(); });
  document.body.appendChild(back);
  if (opts.focus) setTimeout(() => { const el = $(opts.focus); if (el) el.focus(); }, 50);
}
function closeSheet() { const b = $(".sheet-backdrop"); if (b) b.remove(); }

// Confirmación no-nativa (PWA Android bloquea confirm()/alert() en silencio). Devuelve Promise<boolean>.
function confirmar(mensaje, opts={}) {
  return new Promise(resolve => {
    const back = document.createElement("div");
    back.className = "sheet-backdrop";
    const okCls = opts.peligro ? "btn btn-red" : "btn btn-primary";
    back.innerHTML = `
      <div class="sheet">
        <h3 style="margin-top:0">${esc(mensaje)}</h3>
        <div class="sheet-actions">
          <button class="btn btn-ghost" id="cf-no">Cancelar</button>
          <button class="${okCls}" id="cf-yes">${opts.peligro ? "Sí, eliminar" : "OK"}</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const done = v => { back.remove(); resolve(v); };
    back.addEventListener("click", e => { if (e.target === back) done(false); });
    back.querySelector("#cf-no").onclick = () => done(false);
    back.querySelector("#cf-yes").onclick = () => done(true);
  });
}

// ---------- TABS ----------
function setTab(name) {
  // Todos pueden ver Ajustes (para cambiar su PIN); los paneles de admin quedan dentro con guard
  const target = name;
  $$(".nav-item").forEach(t => t.classList.toggle("active", t.dataset.tab === target));
  const c = $("#content");
  c.classList.remove("tab-anim");
  void c.offsetWidth; // reinicia la animación
  c.classList.add("tab-anim");
  render(target);
}

// ---------- INIT ----------
$("#btn-login").addEventListener("click", doLogin);
$("#pin").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
$("#btn-logout").addEventListener("click", () => { api("/api/logout", {method:"POST"}).catch(()=>{}); logout(); });

(async function init() {
  if (token) {
    try {
      const d = await api("/api/me");
      me = d.member; state._saldo = d.saldo; state.canjes = d.canjes;
      enterAppState();
    } catch(e) {
      if (e.offline) {
        // Sin conexión pero con sesión guardada → usar caché y avisar
        const c = loadCache();
        if (c && c.me && c.me.nombre) { me = c.me; Object.assign(state, c.state); state._offline = true; enterAppState(); updateOfflineBanner(); }
        else { token = null; }
      } else { token = null; }
    }
  }
  if (!me) { $("#panel-login").hidden = false; loadLoginMembers(); }
})();

function enterAppState() {
  $("#panel-login").hidden = true; $("#panel-app").hidden = false;
  $$(".role-padre").forEach(b => b.hidden = (me.rol !== "padre"));
  setTab("inicio"); refreshAll();
}

// ---------- ESTADÍSTICAS (solo padre) ----------
const _stats = { periodo: "semana", hijo: "todos" };
function renderEstadisticas(c) {
  if (me.rol !== "padre") { c.innerHTML = `<div class="empty"><p>Esto es solo para padres 👨‍👩‍👧</p></div>`; return; }
  c.innerHTML = `
    <div id="statsRoot">
      <h2>📊 Estadísticas</h2>
      <div class="stats-filtros">
        <div class="chips" id="stPeriodo">
          <button class="chip activo" data-p="semana">Esta semana</button>
          <button class="chip" data-p="mes">Este mes</button>
          <button class="chip" data-p="año">Este año</button>
        </div>
        <div class="chips" id="stHijos"></div>
      </div>
      <div class="kpis" id="stKpis"></div>
      <p class="stats-frase" id="stFrase"></p>
      <div class="card" id="cardTablaDias" hidden>
        <h3 class="card-title">📅 Puntos por día</h3>
        <div class="table-wrap"><table class="tabla" id="tablaDias"></table></div>
      </div>
      <div id="stTarjetas"></div>
    </div>`;
  _stats.periodo = "semana"; _stats.hijo = "todos";
  document.getElementById("stPeriodo").addEventListener("click", e => {
    const b = e.target.closest(".chip"); if (!b) return;
    _stats.periodo = b.dataset.p;
    document.querySelectorAll("#stPeriodo .chip").forEach(x => x.classList.toggle("activo", x === b));
    _statsCargar();
  });
  _statsCargar();
}
async function _statsCargar() {
  const root = $("#statsRoot");
  if (!root) return;
  root.querySelector("#stKpis").innerHTML = `<p class="muted">Cargando…</p>`;
  try {
    const d = await api(`/api/stats?periodo=${encodeURIComponent(_stats.periodo)}&hijo=${_stats.hijo}`);
    _statsPintar(d);
  } catch(e) {
    root.querySelector("#stKpis").innerHTML = `<p class="muted">No se pudo cargar: ${esc(e.message)}</p>`;
  }
}
function _statsPintar(d) {
  const root = $("#statsRoot");
  if (!root) return;
  _statsChipsHijos(root, d);
  root.querySelector("#stKpis").innerHTML = _statsKpis(d);
  root.querySelector("#stFrase").textContent = _statsFrase(d);
  _statsTablaDias(root, d);
  root.querySelector("#stTarjetas").innerHTML = d.hijos.map(h => _statsTarjeta(h, d.periodo)).join("");
}
function _statsChipsHijos(root, d) {
  const el = root.querySelector("#stHijos");
  el.innerHTML = `<button class="chip ${_stats.hijo === "todos" ? "activo" : ""}" data-h="todos">👨‍👩‍👧 Todos</button>` +
    d.hijos.map(h => `<button class="chip ${_stats.hijo == h.id ? "activo" : ""}" data-h="${h.id}">${esc(h.emoji)} ${esc(h.nombre)}</button>`).join("");
  el.querySelectorAll(".chip").forEach(b => b.onclick = () => { _stats.hijo = b.dataset.h; _statsCargar(); });
}
function _statsKpis(d) {
  const pts = d.total_puntos;
  const acc = d.hijos.reduce((s, h) => s + h.resumen.acciones, 0);
  const cums = d.hijos.filter(h => h.resumen.cumplimiento != null);
  const cum = cums.length ? Math.round(cums.reduce((s, h) => s + h.resumen.cumplimiento, 0) / cums.length) : "—";
  const top = [...d.hijos].sort((a, b) => b.resumen.puntos_aprobados - a.resumen.puntos_aprobados)[0];
  return `
    <div class="kpi"><div class="num">${pts}</div><div class="lbl">puntos aprobados</div></div>
    <div class="kpi"><div class="num">${acc}</div><div class="lbl">acciones aprobadas</div></div>
    <div class="kpi"><div class="num">${cum}${typeof cum === "number" ? "%" : ""}</div><div class="lbl">cumplimiento</div></div>
    <div class="kpi"><div class="num">${top ? esc(top.emoji) : "—"}</div><div class="lbl">${top ? "más activo: " + esc(top.nombre) : "sin datos"}</div></div>`;
}
function _statsFrase(d) {
  const fr = [];
  d.hijos.forEach(h => { if (h.resumen.racha >= 2) fr.push(`${esc(h.emoji)} ${esc(h.nombre)} lleva ${h.resumen.racha} días de racha 🔥`); });
  if (!d.hijos.some(h => h.resumen.acciones > 0)) fr.push("Esta semana tranquila… ¡a por ellas! 💪");
  return fr.join(" · ");
}
function _statsTablaDias(root, d) {
  const card = root.querySelector("#cardTablaDias");
  if (d.hijos.length < 2) { card.hidden = true; return; }
  card.hidden = false;
  const dias = [...new Set(d.hijos.flatMap(h => h.por_dia.map(r => r.dia)))].sort();
  const mapa = {};
  d.hijos.forEach(h => h.por_dia.forEach(r => mapa[h.id + r.dia] = r));
  let html = `<tr><th>Día</th>${d.hijos.map(h => `<th>${esc(h.emoji)}</th>`).join("")}</tr>`;
  dias.forEach(dia => {
    html += `<tr><td>${new Date(dia + "T12:00").toLocaleDateString("es-ES", { weekday: "short", day: "numeric" })}</td>` +
      d.hijos.map(h => {
        const r = mapa[h.id + dia];
        return r && r.puntos > 0 ? `<td>${r.puntos}</td>` : `<td class="cero">·</td>`;
      }).join("") + `</tr>`;
  });
  html += `<tr class="total"><td>Total</td>${d.hijos.map(h => `<td>${h.resumen.puntos_aprobados}</td>`).join("")}</tr>`;
  root.querySelector("#tablaDias").innerHTML = html;
}
function _statsTarjeta(h, periodo) {
  const dias = _rellenarDias(h, periodo);
  const max = Math.max(...dias.map(x => x.puntos), 1);
  const cats = [
    ["🧼 Higiene", h.por_categoria.higiene], ["📚 Académica", h.por_categoria.academica],
    ["🎮 Ocio", h.por_categoria.min_ocio], ["Otras", h.por_categoria.otras],
    ["⭐ Prioritarias", h.por_categoria.prioritarias]
  ].filter(c => c[1] > 0).map(c => `<span class="chip-cat">${c[0]} ×${c[1]}</span>`).join("");
  const maxT = Math.max(...h.por_tarea.map(t => t.puntos_total), 1);
  return `
    <div class="card">
      <div class="hijo-head">
        <span class="hijo-emoji">${esc(h.emoji)}</span>
        <div><strong>${esc(h.nombre)}</strong><br><small>🔥 racha ${h.resumen.racha} · ✅ ${h.resumen.aprobadas} · ⏳ ${h.resumen.pendientes}</small></div>
        <span class="hijo-saldo">${h.resumen.puntos_aprobados} pts</span>
      </div>
      ${h.resumen.cumplimiento != null ? `<div class="barra-cump"><div style="width:${h.resumen.cumplimiento}%"></div></div>` : ""}
      ${_barrasSVG(dias, h.color, max)}
      <div class="chips-cat">${cats}</div>
      ${h.por_tarea.length ? `
      <div class="table-wrap"><table class="tabla">
        <tr><th style="text-align:left">Tarea</th><th>Veces</th><th>Pts</th><th style="width:80px"></th></tr>
        ${h.por_tarea.map(t => `<tr>
          <td class="tarea-nom">${t.prioritaria ? "⭐ " : ""}${esc(t.titulo)}</td>
          <td>${t.veces}</td><td>${t.puntos_total}</td>
          <td><div class="minibar" style="width:${Math.round(t.puntos_total * 100 / maxT)}%"></div></td>
        </tr>`).join("")}
      </table></div>` : `<p class="muted">Sin tareas marcadas en este periodo 🌱</p>`}
    </div>`;
}
function _rellenarDias(h, periodo) {
  const mapa = Object.fromEntries(h.por_dia.map(r => [r.dia, r]));
  const out = [];
  const n = periodo === "semana" ? 7 : periodo === "mes" ? 30 : 12;
  const hoy = new Date(); hoy.setHours(12, 0, 0, 0);
  if (periodo === "año") {
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(); d.setMonth(d.getMonth() - i);
      const key = d.toISOString().slice(0, 7);
      const pts = h.por_dia.filter(r => r.dia.startsWith(key)).reduce((s, r) => s + r.puntos, 0);
      out.push({ etiqueta: d.toLocaleDateString("es-ES", { month: "short" }), puntos: pts });
    }
    return out;
  }
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(hoy); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ etiqueta: d.toLocaleDateString("es-ES", { weekday: "narrow" }), puntos: mapa[key]?.puntos || 0 });
  }
  return out;
}
function _barrasSVG(dias, color, max) {
  const W = 320, H = 120, pad = 6, gap = 3;
  const bw = (W - pad * 2 - gap * (dias.length - 1)) / dias.length;
  let bars = "";
  dias.forEach((d, i) => {
    const bh = Math.round((d.puntos / max) * (H - 26));
    const x = pad + i * (bw + gap), y = H - 16 - bh;
    bars += `<rect x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${Math.max(bh, 2)}" rx="4" fill="${d.puntos > 0 ? color : "#E2E8F0"}"></rect>`;
    if (d.puntos > 0 && bw > 18) bars += `<text x="${(x + bw / 2).toFixed(1)}" y="${y - 3}" text-anchor="middle" font-size="11" font-weight="700" fill="#475569" font-family="Nunito">${d.puntos}</text>`;
    if (bw > 14) bars += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle" font-size="10" fill="#94A3B8" font-family="Nunito">${d.etiqueta}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Puntos por día">${bars}</svg>`;
}

// ---------- SYNC OFFLINE ----------
async function syncOffline() {
  const q = offlineQueue();
  if (!q.length) return true;
  for (const item of q) {
    try {
      await api(`/api/tasks/${item.task_id}/hecho`, { method: "POST" });
    } catch(e) {
      if (e.offline) return false;   // seguimos sin conexión, abandonar
      // error real (p.ej. 403/no_te_corresponde) → no reintentar, eliminar de la cola
    }
    saveOfflineQueue(offlineQueue().filter(x => x.task_id !== item.task_id));
  }
  updateOfflineBanner();
  toast("Sincronizado con la app de casa ✓", "success");
  refreshAll();
  return true;
}
window.addEventListener("online", () => { syncOffline(); });
