"""
FamilyPoints — banca de puntos familiar
Servidor Flask + SQLite. Se sirve en el LAN de casa para que toda la familia
acceda desde sus móviles Android (misma red WiFi).

Roles:
  - padre  (admin): crea tareas, aprueba/deniega puntos, tasa canjes, ve TODO.
  - miembro: marca tareas hechas (queda PENDIENTE), propone un canje, ve su saldo.

Todos los cambios de puntos pasan por aprobación de un padre.
"""

import os
import base64
import secrets
import hashlib
import sqlite3
import json
import urllib.request
from datetime import datetime, timedelta
from functools import wraps

from flask import Flask, request, jsonify, send_from_directory, g

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data", "familypoints.db")
STATIC_DIR = os.path.join(BASE_DIR, "static")
PORT = int(os.environ.get("FAMILYPOINTS_PORT", "8890"))
HOST = os.environ.get("FAMILYPOINTS_HOST", "0.0.0.0")

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="")
app.config["JSON_SORT_KEYS"] = False

# --------------------------------------------------------------------------
# DB helpers
# --------------------------------------------------------------------------

def db():
    if "db" not in g:
        # WAL + timeout evita el error "database is locked" cuando hay escrituras
        # simultáneas (varios móviles marcando/aprobando a la vez).
        g.db = sqlite3.connect(DB_PATH, timeout=30)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
        g.db.execute("PRAGMA journal_mode = WAL")
        g.db.execute("PRAGMA busy_timeout = 30000")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    d = g.pop("db", None)
    if d is not None:
        d.close()


# --------------------------------------------------------------------------
# Notificaciones por Telegram (avisa al padre de puntos/canjes/ocio pendientes)
# --------------------------------------------------------------------------

def get_setting(clave, default=None):
    r = db().execute("SELECT valor FROM settings WHERE clave = ?", (clave,)).fetchone()
    return r["valor"] if r else default


def enviar_telegram(mensaje):
    """Envía un mensaje al padre por Telegram vía el bot. Silencioso si no está configurado."""
    if get_setting("tg_activado", "0") != "1":
        return False
    token = get_setting("tg_token", "")
    chat = get_setting("tg_chat", "")
    if not token or not chat:
        return False
    try:
        import urllib.parse
        data = urllib.parse.urlencode({"chat_id": chat, "text": mensaje}).encode()
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{token}/sendMessage",
            data=data,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode())["ok"]
    except Exception:
        return False


def avisar_pendientes():
    """Resume y avisa al padre si hay puntos, canjes u ocio pendientes de aprobar."""
    if get_setting("tg_activado", "0") != "1":
        return
    try:
        pp = db().execute("SELECT COUNT(*) c FROM puntos WHERE estado='pendiente'").fetchone()["c"]
        pc = db().execute("SELECT COUNT(*) c FROM canjes WHERE estado IN ('propuesto','tasado','aprobado')").fetchone()["c"]
        # ocio pendiente = solicitudes de gasto sin decidir (minutos < 0, pendiente)
        po = db().execute("SELECT COUNT(*) c FROM ocio WHERE estado='pendiente' AND minutos<0").fetchone()["c"]
        total = pp + pc + po
        if total == 0:
            return
        partes = []
        if pp: partes.append(f"🔵 {pp} punto(s) por aprobar")
        if pc: partes.append(f"🎁 {pc} canje(s) por aprobar")
        if po: partes.append(f"⏱️ {po} petición(es) de ocio")
        enviar_telegram("📲 FamilyPoints — tienes " + " + ".join(partes))
    except Exception:
        pass


SCHEMA = """
CREATE TABLE IF NOT EXISTS members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre     TEXT NOT NULL UNIQUE,
  rol        TEXT NOT NULL CHECK (rol IN ('padre','miembro')),
  pin_hash   TEXT NOT NULL,
  emoji      TEXT NOT NULL DEFAULT '🙂',
  color      TEXT NOT NULL DEFAULT '#4C8C4A',
  activo     INTEGER NOT NULL DEFAULT 1,
  creado     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo     TEXT NOT NULL,
  puntos     INTEGER NOT NULL,
  asignado_a INTEGER,             -- NULL = cualquier miembro activo
  prioritaria INTEGER NOT NULL DEFAULT 0,  -- 1 = tarea que el padre quiere que se haga primero (leer, deberes, cuarto...)
  higiene    INTEGER NOT NULL DEFAULT 0,   -- 1 = rutina personal (dientes, ducha, cama...) que NO se bloquea por la regla
  min_ocio   INTEGER NOT NULL DEFAULT 0,   -- minutos de ocio que regala la tarea (recompensa doble, no afecta a puntos)
  academica  INTEGER NOT NULL DEFAULT 0,   -- 1 = tarea académica (leer, deberes, estudiar...) — de las 3 prioritarias, 2 deben ser académicas
  activo     INTEGER NOT NULL DEFAULT 1,
  creado     TEXT NOT NULL,
  FOREIGN KEY (asignado_a) REFERENCES members(id)
);

CREATE TABLE IF NOT EXISTS puntos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  miembro_id INTEGER NOT NULL,
  task_id    INTEGER,
  puntos     INTEGER NOT NULL,
  estado     TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','aprobado','denegado')),
  creado     TEXT NOT NULL,
  decidido   TEXT,
  decidido_por INTEGER,
  FOREIGN KEY (miembro_id) REFERENCES members(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (decidido_por) REFERENCES members(id)
);

CREATE TABLE IF NOT EXISTS ocio (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  miembro_id INTEGER NOT NULL,
  categoria  TEXT NOT NULL,              -- 'tv'|'movil'|'switch'|'play'|'general'
  minutos    INTEGER NOT NULL,           -- + = gana (tarea aprobada), - = consume
  estado     TEXT NOT NULL DEFAULT 'aprobado' CHECK (estado IN ('pendiente','aprobado','denegado')),
  familia    INTEGER NOT NULL DEFAULT 0, -- 1 = TV con papás (NO consume del saldo)
  motivo     TEXT,                       -- texto informativo (tarea / elemento)
  creado     TEXT NOT NULL,
  decidido   TEXT,
  decidido_por INTEGER,
  FOREIGN KEY (miembro_id) REFERENCES members(id),
  FOREIGN KEY (decidido_por) REFERENCES members(id)
);

CREATE TABLE IF NOT EXISTS canjes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  miembro_id INTEGER NOT NULL,
  titulo     TEXT NOT NULL,
  puntos     INTEGER,
  tipo       TEXT NOT NULL DEFAULT 'cosa' CHECK (tipo IN ('cosa','paga')),
  estado     TEXT NOT NULL DEFAULT 'propuesto' CHECK (estado IN ('propuesto','tasado','aprobado','denegado')),
  canjeado   INTEGER NOT NULL DEFAULT 0,   -- 1 = la recompensa ya se entregó (puntos descontados)
  creado     TEXT NOT NULL,
  decidido   TEXT,
  decidido_por INTEGER,
  FOREIGN KEY (miembro_id) REFERENCES members(id),
  FOREIGN KEY (decidido_por) REFERENCES members(id)
);

CREATE TABLE IF NOT EXISTS settings (
  clave  TEXT PRIMARY KEY,
  valor  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token   TEXT PRIMARY KEY,
  miembro_id INTEGER NOT NULL,
  creado  TEXT NOT NULL,
  FOREIGN KEY (miembro_id) REFERENCES members(id)
);
"""


def init_db():
    with sqlite3.connect(DB_PATH) as con:
        con.executescript(SCHEMA)
        # Migración: añadir columna 'canjeado' a canjes si no existe (BD previas)
        cols = [r[1] for r in con.execute("PRAGMA table_info(canjes)").fetchall()]
        if "canjeado" not in cols:
            con.execute("ALTER TABLE canjes ADD COLUMN canjeado INTEGER NOT NULL DEFAULT 0")
        # Migración: añadir columna 'estado' a ocio si no existe (para pedir/aprobar el gasto)
        ocols = [r[1] for r in con.execute("PRAGMA table_info(ocio)").fetchall()]
        if "estado" not in ocols:
            con.execute("ALTER TABLE ocio ADD COLUMN estado TEXT NOT NULL DEFAULT 'aprobado'")
        if "decidido" not in ocols:
            con.execute("ALTER TABLE ocio ADD COLUMN decidido TEXT")
        if "decidido_por" not in ocols:
            con.execute("ALTER TABLE ocio ADD COLUMN decidido_por INTEGER")
        # Migración: añadir columna 'prioritaria' a tasks si no existe (BD previas)
        tcols = [r[1] for r in con.execute("PRAGMA table_info(tasks)").fetchall()]
        if "prioritaria" not in tcols:
            con.execute("ALTER TABLE tasks ADD COLUMN prioritaria INTEGER NOT NULL DEFAULT 0")
        if "higiene" not in tcols:
            con.execute("ALTER TABLE tasks ADD COLUMN higiene INTEGER NOT NULL DEFAULT 0")
        if "min_ocio" not in tcols:
            con.execute("ALTER TABLE tasks ADD COLUMN min_ocio INTEGER NOT NULL DEFAULT 0")
        if "academica" not in tcols:
            con.execute("ALTER TABLE tasks ADD COLUMN academica INTEGER NOT NULL DEFAULT 0")
        # settings por defecto
        con.execute(
            "INSERT OR IGNORE INTO settings(clave, valor) VALUES ('pts_euro', '10')"
        )  # 10 puntos = 1 euro de paga


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------

def hash_pin(pin: str) -> str:
    salt = "familypoints-salt"
    return hashlib.sha256((salt + pin).encode()).hexdigest()


def current_member():
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth.split(" ", 1)[1]
    row = db().execute(
        "SELECT m.* FROM sessions s JOIN members m ON m.id = s.miembro_id "
        "WHERE s.token = ? AND m.activo = 1",
        (token,),
    ).fetchone()
    return row


def login_required(f):
    @wraps(f)
    def wrapper(*a, **kw):
        m = current_member()
        if m is None:
            return jsonify({"error": "no_auth"}), 401
        g.member = m
        return f(*a, **kw)
    return wrapper


def padre_required(f):
    @wraps(f)
    @login_required
    def wrapper(*a, **kw):
        if g.member["rol"] != "padre":
            return jsonify({"error": "solo_padres"}), 403
        return f(*a, **kw)
    return wrapper


def puede_gestionar_canje(canje):
    """Un padre NO puede tasar/aprobar/canjear su PROPIO canje: lo gestiona el otro padre."""
    if canje is None:
        return True
    owner = db().execute("SELECT rol FROM members WHERE id = ?", (canje["miembro_id"],)).fetchone()
    if owner and owner["rol"] == "padre" and canje["miembro_id"] == g.member["id"]:
        return False
    return True


def saldo(miembro_id):
    """puntos aprobados menos canjes REALIZADOS (canjeados). Un canje aprobado
    (aceptado) pero aún no canjeado NO descuenta del saldo."""
    ganado = db().execute(
        "SELECT COALESCE(SUM(puntos),0) FROM puntos WHERE miembro_id=? AND estado='aprobado'",
        (miembro_id,),
    ).fetchone()[0]
    canjeado = db().execute(
        "SELECT COALESCE(SUM(puntos),0) FROM canjes WHERE miembro_id=? AND canjeado=1",
        (miembro_id,),
    ).fetchone()[0]
    return ganado - canjeado


TOPE_OCIO_AL_DIA = 300  # 5 horas/día máximo de ocio

def saldo_ocio(miembro_id):
    """Minutos de ocio disponibles (ganado por tareas aprobadas - lo consumido Y APROBADO).
    Las solicitudes de gasto 'pendientes' no descuentan hasta que el padre las aprueba.
    La TV 'en familia' no consume. El saldo nunca es negativo."""
    s = db().execute(
        "SELECT COALESCE(SUM(minutos),0) FROM ocio WHERE miembro_id=? AND estado='aprobado'",
        (miembro_id,),
    ).fetchone()[0]
    return max(0, s)


def ocio_ganado_hoy(miembro_id):
    """Minutos de ocio ganados hoy (para el tope diario de 5h)."""
    hoy = datetime.now().date().isoformat()
    s = db().execute(
        "SELECT COALESCE(SUM(minutos),0) FROM ocio WHERE miembro_id=? AND minutos>0 "
        "AND estado='aprobado' AND substr(creado,1,10)=?",
        (miembro_id, hoy),
    ).fetchone()[0]
    return s


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# API: auth
# --------------------------------------------------------------------------

@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(force=True)
    nombre = (data.get("nombre") or "").strip()
    pin = data.get("pin") or ""
    row = db().execute(
        "SELECT * FROM members WHERE nombre = ? AND activo = 1", (nombre,)
    ).fetchone()
    if row is None or hash_pin(pin) != row["pin_hash"]:
        return jsonify({"error": "credenciales_invalidas"}), 401
    token = secrets.token_hex(24)
    db().execute(
        "INSERT INTO sessions(token, miembro_id, creado) VALUES (?,?,?)",
        (token, row["id"], now_iso()),
    )
    db().commit()
    return jsonify({"token": token, "member": member_json(row)})


@app.route("/api/logout", methods=["POST"])
@login_required
def logout():
    auth = request.headers.get("Authorization", "").split(" ", 1)[1]
    db().execute("DELETE FROM sessions WHERE token = ?", (auth,))
    db().commit()
    return jsonify({"ok": True})


def member_json(m, include_pin=False):
    d = {
        "id": m["id"],
        "nombre": m["nombre"],
        "rol": m["rol"],
        "emoji": m["emoji"],
        "color": m["color"],
    }
    return d


@app.route("/api/public/members")
def public_members():
    """Lista SOLO nombre + emoji de miembros activos, SIN auth.
    Necesario para que la pantalla de login muestre a quién elegir antes de meter PIN."""
    rows = db().execute(
        "SELECT id, nombre, emoji FROM members WHERE activo = 1 ORDER BY nombre"
    ).fetchall()
    return jsonify({"members": [dict(r) for r in rows]})


# --------------------------------------------------------------------------
# API: sesión actual
# --------------------------------------------------------------------------

@app.route("/api/me")
@login_required
def me():
    sid = g.member["id"]
    pts = saldo(sid)
    # Canjes visibles para el miembro: propuesto, tasado (pendientes) y aprobado (aceptados,
    # pendientes de alcanzar/canjear). Los denegados y ya canjeados se ocultan o se muestran resueltos.
    canjes = [
        canje_json(c)
        for c in db().execute(
            "SELECT * FROM canjes WHERE miembro_id = ? AND estado IN ('propuesto','tasado','aprobado') ORDER BY id DESC",
            (sid,),
        ).fetchall()
    ]
    return jsonify({"member": member_json(g.member), "saldo": pts, "canjes": canjes})


# --------------------------------------------------------------------------
# API: tareas
# --------------------------------------------------------------------------

@app.route("/api/tasks", methods=["GET"])
@login_required
def list_tasks():
    q = ("SELECT t.*, m.nombre AS asignado_nombre FROM tasks t "
         "LEFT JOIN members m ON m.id = t.asignado_a WHERE t.activo = 1 ")
    params = []
    if g.member["rol"] != "padre":
        q += "AND (t.asignado_a IS NULL OR t.asignado_a = ?) "
        params.append(g.member["id"])
    q += "ORDER BY t.prioritaria DESC, t.puntos ASC, t.id ASC"
    rows = db().execute(q, params).fetchall()
    return jsonify({"tasks": [dict(r) for r in rows]})


@app.route("/api/tasks", methods=["POST"])
@padre_required
def create_task():
    data = request.get_json(force=True)
    titulo = (data.get("titulo") or "").strip()
    puntos = int(data.get("puntos", 0))
    asignado_a = data.get("asignado_a")  # int | None
    if not titulo:
        return jsonify({"error": "titulo_requerido"}), 400
    if puntos == 0:
        return jsonify({"error": "puntos_no_cero"}), 400
    mo = int(data.get("min_ocio", 0) or 0)
    db().execute(
        "INSERT INTO tasks(titulo, puntos, asignado_a, prioritaria, higiene, academica, min_ocio, activo, creado) VALUES (?,?,?,?,?,?,?,1,?)",
        (titulo, puntos, asignado_a, 1 if data.get("prioritaria") else 0, 1 if data.get("higiene") else 0, 1 if data.get("academica") else 0, mo, now_iso()),
    )
    db().commit()
    return jsonify({"ok": True})


@app.route("/api/tasks/<int:task_id>", methods=["PATCH"])
@padre_required
def update_task(task_id):
    """El padre puede cambiar los puntos de una tarea y marcarla/desmarcarla
    como prioritaria o de higiene. Afecta solo a la tarea (plantilla), no a los
    puntos ya registrados."""
    task = db().execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if task is None:
        return jsonify({"error": "tarea_no_existe"}), 404
    data = request.get_json(force=True)
    campos, vals = [], []
    if "puntos" in data:
        try:
            p = int(data["puntos"])
        except (TypeError, ValueError):
            return jsonify({"error": "puntos_invalidos"}), 400
        if p == 0:
            return jsonify({"error": "puntos_no_cero"}), 400
        campos.append("puntos = ?"); vals.append(p)
    if "prioritaria" in data:
        campos.append("prioritaria = ?"); vals.append(1 if data["prioritaria"] else 0)
    if "higiene" in data:
        campos.append("higiene = ?"); vals.append(1 if data["higiene"] else 0)
    if "academica" in data:
        campos.append("academica = ?"); vals.append(1 if data["academica"] else 0)
    if "min_ocio" in data:
        try:
            mo = int(data["min_ocio"])
        except (TypeError, ValueError):
            return jsonify({"error": "min_ocio_invalido"}), 400
        if mo < 0:
            return jsonify({"error": "min_ocio_invalido"}), 400
        campos.append("min_ocio = ?"); vals.append(mo)
    if not campos:
        return jsonify({"error": "sin_cambios"}), 400
    vals.append(task_id)
    db().execute(f"UPDATE tasks SET {', '.join(campos)} WHERE id = ?", vals)
    db().commit()
    return jsonify({"ok": True})


@app.route("/api/tasks/<int:task_id>", methods=["DELETE"])
@padre_required
def delete_task(task_id):
    db().execute("UPDATE tasks SET activo = 0 WHERE id = ?", (task_id,))
    db().commit()
    return jsonify({"ok": True})


@app.route("/api/tasks/<int:task_id>/hecho", methods=["POST"])
@login_required
def mark_done(task_id):
    task = db().execute("SELECT * FROM tasks WHERE id = ? AND activo = 1", (task_id,)).fetchone()
    if task is None:
        return jsonify({"error": "tarea_no_existe"}), 404
    # Sin asignar (ganar, para todos): la marca cualquiera y los puntos van a quien la hace.
    if task["asignado_a"] is None:
        # Penalización (negativa) sin dueño: la aplica el PADRE a un hijo concreto.
        if task["puntos"] < 0:
            if g.member["rol"] != "padre":
                return jsonify({"error": "solo_padres"}), 403
            data = request.get_json(silent=True) or {}
            target = data.get("miembro_id")
            if target:
                t = db().execute("SELECT id FROM members WHERE id = ? AND activo = 1", (target,)).fetchone()
                if t is None:
                    return jsonify({"error": "miembro_no_existe"}), 400
                sid = target
            else:
                return jsonify({"error": "elegir_miembro"}), 400
        else:
            sid = g.member["id"]
    else:
        # Asignada a un hijo concreto: si es POSITIVA la marca SOLO ese hijo
        # (los padres solo la ven, no pueden "darla"); si es NEGATIVA (sanción)
        # el padre sí puede aplicarla al hijo asignado. Los puntos van al hijo.
        es_padre = g.member["rol"] == "padre"
        if g.member["id"] != task["asignado_a"]:
            # Un padre puede aplicar una sanción (negativa) asignada, pero NO
            # marcar una tarea POSITIVA de un hijo (solo el hijo la hace).
            if not (es_padre and task["puntos"] < 0):
                asignado_nombre = db().execute("SELECT nombre FROM members WHERE id = ?", (task["asignado_a"],)).fetchone()
                quien = asignado_nombre["nombre"] if asignado_nombre else "otro"
                msg = f"Esto es solo para {quien}. ¡No puedes marcarla tú!"
                if es_padre and task["puntos"] > 0:
                    msg = f"Esa tarea es solo de {quien}: los papás no podemos marcarla 😅"
                return jsonify({"error": msg}), 403
        sid = task["asignado_a"]
    # REGLA: botella de agua — máximo 2 veces al día por miembro.
    if (task["puntos"] > 0 and "botella" in (task["titulo"] or "").lower()):
        hoy = datetime.now().date().isoformat()
        n = db().execute(
            "SELECT COUNT(*) FROM puntos p JOIN tasks t ON t.id = p.task_id "
            "WHERE p.miembro_id = ? AND t.titulo LIKE '%botella%' "
            "AND p.estado IN ('aprobado','pendiente') AND substr(p.creado,1,10) = ?",
            (sid, hoy),
        ).fetchone()[0]
        if n >= 2:
            return jsonify({
                "error": "botella_limite",
                "mensaje": "La botella de agua se puede llenar como máximo 2 veces al día 💧"
            }), 403
    # REGLA: la mesa — si uno la pone, el otro la recoge (no puede hacer las dos el mismo).
    if (task["puntos"] > 0 and "mesa" in (task["titulo"] or "").lower()):
        hoy = datetime.now().date().isoformat()
        # Si el miembro ya marcó hoy la OTRA tarea de la mesa (poner o quitar) -> bloqueo
        n_otra = db().execute(
            f"SELECT COUNT(*) FROM puntos p JOIN tasks t ON t.id = p.task_id "
            f"WHERE p.miembro_id = ? AND t.titulo LIKE '%mesa%' AND t.id != ? "
            f"AND p.estado IN ('aprobado','pendiente') AND substr(p.creado,1,10) = ?",
            (sid, task_id, hoy),
        ).fetchone()[0]
        if n_otra > 0:
            return jsonify({
                "error": "mesa_alterna",
                "mensaje": "Si un hermano ha puesto la mesa, el otro la recoge (no puedes hacer las dos tú 😄)"
            }), 403
    # REGLA DURA: antes de marcar una tarea POSITIVA no prioritaria (para todos),
    # el miembro debe haber marcado HOY al menos 3 tareas prioritarias, y de esas
    # al menos 2 deben ser ACADÉMICAS (leer, deberes, estudiar...).
    # Se aplica a los miembros (no a los padres) y solo a tareas de ganar
    # (positivas, sin asignar a nadie en particular). Se EXCLUYEN las de HIGIENE
    # (dientes, ducha, cama...) — esas se pueden marcar siempre. Las penalizaciones
    # y las tareas asignadas a un hijo concreto también se saltan la regla.
    if (g.member["rol"] != "padre"
            and task["puntos"] > 0
            and task["asignado_a"] is None
            and task["higiene"] == 0
            and not task["prioritaria"]):
        hoy = datetime.now().date().isoformat()
        # Totales de prioritarias y de prioritarias académicas marcadas hoy
        counts = db().execute(
            "SELECT COUNT(*) AS tot, SUM(CASE WHEN t.academica=1 THEN 1 ELSE 0 END) AS acad "
            "FROM puntos p JOIN tasks t ON t.id = p.task_id "
            "WHERE p.miembro_id = ? AND t.prioritaria = 1 AND t.puntos > 0 "
            "AND p.estado IN ('aprobado','pendiente') AND substr(p.creado,1,10) = ?",
            (g.member["id"], hoy),
        ).fetchone()
        ya = counts["tot"] or 0
        acad = counts["acad"] or 0
        if ya < 3 or acad < 2:
            # Buscar los nombres para el mensaje
            ps = db().execute(
                "SELECT titulo FROM tasks WHERE prioritaria = 1 AND puntos > 0 AND activo = 1 "
                "ORDER BY puntos DESC LIMIT 3"
            ).fetchall()
            prior = ", ".join(p["titulo"] for p in ps) if ps else "leer, hacer los deberes y limpiar tu cuarto"
            if ya < 3:
                msg = f"Antes de esto marca {3 - ya} prioritaria(s) más hoy: {prior} 📚"
            else:
                msg = f"Te falta(n) {2 - acad} prioritaria(s) académica(s) hoy (leer, deberes, estudiar...) 🎓"
            return jsonify({"error": "falta_prioritaria", "mensaje": msg}), 403

    db().execute(
        "INSERT INTO puntos(miembro_id, task_id, puntos, estado, creado) VALUES (?,?,?,'pendiente',?)",
        (sid, task_id, task["puntos"], now_iso()),
    )
    db().commit()
    avisar_pendientes()  # avisar al padre por Telegram de que hay algo que aprobar
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# API: puntos (aprobación de padre)
# --------------------------------------------------------------------------

@app.route("/api/puntos/pendientes")
@padre_required
def puntos_pendientes():
    rows = db().execute(
        "SELECT p.*, m.nombre AS miembro, t.titulo AS tarea, t.min_ocio FROM puntos p "
        "JOIN members m ON m.id = p.miembro_id "
        "LEFT JOIN tasks t ON t.id = p.task_id "
        "WHERE p.estado = 'pendiente' ORDER BY p.creado ASC",
    ).fetchall()
    return jsonify({"puntos": [dict(r) for r in rows]})


@app.route("/api/puntos/<int:pid>/decidir", methods=["POST"])
@padre_required
def decidir_punto(pid):
    data = request.get_json(force=True)
    accion = data.get("accion")
    if accion not in ("aprobar", "denegar"):
        return jsonify({"error": "accion_invalida"}), 400
    if accion == "aprobar":
        estado = "aprobado"
    else:
        estado = "denegado"
    res = db().execute(
        "UPDATE puntos SET estado = ?, decidido = ?, decidido_por = ? WHERE id = ? AND estado='pendiente'",
        (estado, now_iso(), g.member["id"], pid),
    )
    if res.rowcount == 0:
        return jsonify({"ok": False, "error": "ya_decidido", "mensaje": "Este punto ya fue decidido."}), 409
    # RECOMPENSA DOBLE de ocio: al aprobar la tarea se regalan los minutos de la
    # tarea (min_ocio), sin tocar los puntos. Se respeta el tope de 5h/día.
    if estado == "aprobado":
        p = db().execute(
            "SELECT p.miembro_id, p.task_id, t.min_ocio, t.titulo FROM puntos p "
            "LEFT JOIN tasks t ON t.id = p.task_id WHERE p.id = ?", (pid,)
        ).fetchone()
        if p and p["min_ocio"] and p["min_ocio"] > 0:
            mid = p["miembro_id"]
            restante = TOPE_OCIO_AL_DIA - ocio_ganado_hoy(mid)
            minutos = min(p["min_ocio"], max(0, restante))
            if minutos > 0:
                db().execute(
                    "INSERT INTO ocio(miembro_id, categoria, minutos, familia, motivo, creado) "
                    "VALUES (?, 'general', ?, 0, ?, ?)",
                    (mid, minutos, f"Tarea: {p['titulo']}", now_iso()),
                )
    db().commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# API: tiempo de ocio (recompensa doble)
# --------------------------------------------------------------------------

@app.route("/api/ocio", methods=["GET"])
@login_required
def get_ocio():
    """Estado del tiempo de ocio del miembro autenticado: saldo disponible,
    tope diario, minutos consumidos hoy, y las 4 categorías + el historial."""
    mid = g.member["id"]
    hoy = datetime.now().date().isoformat()
    saldo = saldo_ocio(mid)
    ganado_hoy = ocio_ganado_hoy(mid)
    consumido_hoy = db().execute(
        "SELECT COALESCE(SUM(-minutos),0) FROM ocio WHERE miembro_id=? AND minutos<0 "
        "AND estado='aprobado' AND substr(creado,1,10)=?", (mid, hoy),
    ).fetchone()[0]
    pendientes = db().execute(
        "SELECT * FROM ocio WHERE miembro_id=? AND estado='pendiente' ORDER BY id DESC LIMIT 20", (mid,),
    ).fetchall()
    historial = db().execute(
        "SELECT * FROM ocio WHERE miembro_id=? AND estado != 'denegado' ORDER BY id DESC LIMIT 30", (mid,),
    ).fetchall()
    cats = {
        "tv":    {"label": "📺 Tele",    "id": "tv"},
        "movil": {"label": "📱 Móvil",   "id": "movil"},
        "switch":{"label": "🎮 Switch",  "id": "switch"},
        "play":  {"label": "🎮 Playstation", "id": "play"},
    }
    return jsonify({
        "saldo": saldo,
        "tope_dia": TOPE_OCIO_AL_DIA,
        "ganado_hoy": ganado_hoy,
        "consumido_hoy": consumido_hoy,
        "pendientes": [dict(p) for p in pendientes],
        "cats": cats,
        "historial": [dict(h) for h in historial],
    })


@app.route("/api/ocio/consumir", methods=["POST"])
@login_required
def consumir_ocio():
    """El usuario SOLICITA gastar X minutos de un elemento (tv/movil/switch/play).
    No descuenta: queda 'pendiente' hasta que el padre lo aprueba."""
    data = request.get_json(force=True)
    cat = data.get("categoria")
    try:
        minutos = int(data.get("minutos", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "minutos_invalidos"}), 400
    if cat not in ("tv", "movil", "switch", "play"):
        return jsonify({"error": "categoria_invalida"}), 400
    if minutos <= 0:
        return jsonify({"error": "minutos_invalidos"}), 400
    mid = g.member["id"]
    saldo = saldo_ocio(mid)
    if minutos > saldo:
        return jsonify({
            "error": "ocio_insuficiente",
            "mensaje": f"No tienes suficientes minutos de ocio: tienes {saldo} min",
        }), 400
    db().execute(
        "INSERT INTO ocio(miembro_id, categoria, minutos, estado, familia, motivo, creado) "
        "VALUES (?, ?, ?, 'pendiente', 0, ?, ?)",
        (mid, cat, -minutos, f"Solicitud: {cat}", now_iso()),
    )
    db().commit()
    avisar_pendientes()  # avisar al padre de que hay una petición de ocio por aprobar
    return jsonify({"ok": True, "mensaje": "Solicitud enviada; espera a que tus padres la aprueben."})


@app.route("/api/ocio/pendientes", methods=["GET"])
@padre_required
def ocio_pendientes():
    """Solicitudes de gasto de ocio pendientes de aprobar (para el padre)."""
    rows = db().execute(
        "SELECT o.*, m.nombre AS miembro FROM ocio o "
        "JOIN members m ON m.id=o.miembro_id "
        "WHERE o.estado='pendiente' AND o.minutos<0 ORDER BY o.creado ASC",
    ).fetchall()
    return jsonify({"solicitudes": [dict(r) for r in rows]})


@app.route("/api/ocio/<int:oid>/decidir", methods=["POST"])
@padre_required
def decidir_ocio(oid):
    """El padre aprueba o deniega una solicitud de gasto de ocio."""
    data = request.get_json(force=True)
    accion = data.get("accion")
    if accion not in ("aprobar", "denegar"):
        return jsonify({"error": "accion_invalida"}), 400
    soc = db().execute("SELECT * FROM ocio WHERE id=? AND estado='pendiente'", (oid,)).fetchone()
    if soc is None:
        return jsonify({"error": "solicitud_no_existe"}), 404
    estado = "aprobado" if accion == "aprobar" else "denegado"
    db().execute(
        "UPDATE ocio SET estado=?, decidido=?, decidido_por=? WHERE id=?",
        (estado, now_iso(), g.member["id"], oid),
    )
    db().commit()
    return jsonify({"ok": True})


@app.route("/api/ocio/familia", methods=["POST"])
@login_required
def ocio_familia():
    """TV en familia: queda registrado pero NO consume del saldo."""
    data = request.get_json(force=True)
    try:
        minutos = int(data.get("minutos", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "minutos_invalidos"}), 400
    if minutos <= 0:
        return jsonify({"error": "minutos_invalidos"}), 400
    db().execute(
        "INSERT INTO ocio(miembro_id, categoria, minutos, familia, motivo, creado) "
        "VALUES (?, 'tv', 0, 1, ?, ?)",
        (g.member["id"], f"TV en familia ({minutos} min, no cuenta)", now_iso()),
    )
    db().commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# API: clasificación y actividad (estilo FamilyPoints TikTok)
# --------------------------------------------------------------------------

from datetime import datetime, timedelta

def periodo_inicio(periodo):
    """Devuelve el datetime de inicio del periodo actual."""
    now = datetime.now()
    if periodo == "mes":
        return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if periodo == "anio":
        return now.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
    # semana (lunes 00:00)
    lunes = now - timedelta(days=now.weekday())
    return lunes.replace(hour=0, minute=0, second=0, microsecond=0)


@app.route("/api/clasificacion")
@login_required
def clasificacion():
    periodo = request.args.get("periodo", "mes")
    if periodo not in ("semana", "mes", "anio"):
        return jsonify({"error": "periodo_invalido"}), 400
    inicio = periodo_inicio(periodo).isoformat(timespec="seconds")
    # Los padres ven el ranking completo; cada hijo SOLO ve sus propios puntos
    # (para que no haya comparaciones ni conflictos entre hermanos).
    if g.member["rol"] == "padre":
        rows = db().execute(
            "SELECT m.id, m.nombre, m.emoji, m.rol, COALESCE(SUM(p.puntos),0) AS pts "
            "FROM members m LEFT JOIN puntos p ON p.miembro_id = m.id "
            "AND p.estado = 'aprobado' AND p.creado >= ? "
            "WHERE m.activo = 1 GROUP BY m.id ORDER BY pts DESC",
            (inicio,),
        ).fetchall()
    else:
        rows = db().execute(
            "SELECT m.id, m.nombre, m.emoji, m.rol, COALESCE(SUM(p.puntos),0) AS pts "
            "FROM members m LEFT JOIN puntos p ON p.miembro_id = m.id "
            "AND p.estado = 'aprobado' AND p.creado >= ? "
            "WHERE m.activo = 1 AND m.id = ? GROUP BY m.id",
            (inicio, g.member["id"]),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["pts"] = int(d["pts"])
        out.append(d)
    return jsonify({"clasificacion": out, "periodo": periodo})


@app.route("/api/actividad")
@login_required
def actividad():
    limit = min(max(int(request.args.get("limit", 15)), 1), 50)
    # Los hijos solo ven SU actividad; los padres ven la de toda la familia.
    filtro_miembro = ""
    params = [limit]
    if g.member["rol"] != "padre":
        filtro_miembro = "AND p.miembro_id = ?"
        params.insert(0, g.member["id"])
    rows = db().execute(
        "SELECT p.id, p.puntos, p.estado, p.creado, p.decidido, "
        "m.nombre AS miembro, m.emoji AS miembro_emoji, t.titulo AS tarea "
        "FROM puntos p JOIN members m ON m.id = p.miembro_id "
        "LEFT JOIN tasks t ON t.id = p.task_id "
        f"WHERE p.estado IN ('aprobado','pendiente') {filtro_miembro} "
        "ORDER BY p.creado DESC LIMIT ?",
        tuple(params),
    ).fetchall()
    return jsonify({"actividad": [dict(r) for r in rows]})


@app.route("/api/actividad/<int:punto_id>", methods=["DELETE"])
@padre_required
def eliminar_actividad(punto_id):
    """Elimina una actividad (fila de puntos) por equivocación. Solo padres.
    No toca la tarea ni el canje; solo quita ese registro de puntos, lo que
    recalcula el saldo automáticamente."""
    row = db().execute("SELECT id FROM puntos WHERE id = ?", (punto_id,)).fetchone()
    if row is None:
        return jsonify({"error": "actividad_no_existe"}), 404
    db().execute("DELETE FROM puntos WHERE id = ?", (punto_id,))
    db().commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# API: canjes
# --------------------------------------------------------------------------

def canje_json(c):
    return {
        "id": c["id"],
        "miembro_id": c["miembro_id"],
        "titulo": c["titulo"],
        "puntos": c["puntos"],
        "tipo": c["tipo"],
        "estado": c["estado"],
        "canjeado": c["canjeado"],
        "creado": c["creado"],
    }


@app.route("/api/canjes", methods=["POST"])
@login_required
def crear_canje():
    data = request.get_json(force=True)
    titulo = (data.get("titulo") or "").strip()
    tipo = data.get("tipo", "cosa")
    if tipo not in ("cosa", "paga"):
        return jsonify({"error": "tipo_invalido"}), 400
    if not titulo:
        return jsonify({"error": "titulo_requerido"}), 400
    sid = g.member["id"]
    if g.member["rol"] == "miembro":
        # Los miembros proponen; los padres también pueden pedir paga
        pass
    db().execute(
        "INSERT INTO canjes(miembro_id, titulo, puntos, tipo, estado, creado) VALUES (?,?,NULL,?,'propuesto',?)",
        (sid, titulo, tipo, now_iso()),
    )
    db().commit()
    avisar_pendientes()  # avisar al padre de que hay un canje que tasar/aprobar
    return jsonify({"ok": True})


@app.route("/api/canjes/pendientes")
@padre_required
def canjes_pendientes():
    rows = db().execute(
        "SELECT c.*, m.nombre AS miembro FROM canjes c "
        "JOIN members m ON m.id = c.miembro_id "
        "WHERE c.estado IN ('propuesto','tasado','aprobado') ORDER BY c.creado ASC",
    ).fetchall()
    return jsonify({"canjes": [dict(r) for r in rows]})


@app.route("/api/canjes/<int:cid>/tasar", methods=["POST"])
@padre_required
def tasar_canje(cid):
    data = request.get_json(force=True)
    puntos = data.get("puntos")
    if puntos is None:
        return jsonify({"error": "puntos_requerido"}), 400
    try:
        puntos = int(puntos)
    except (TypeError, ValueError):
        return jsonify({"error": "puntos_invalidos"}), 400
    canje = db().execute("SELECT * FROM canjes WHERE id = ?", (cid,)).fetchone()
    if canje is None:
        return jsonify({"error": "canje_no_existe"}), 404
    if not puede_gestionar_canje(canje):
        return jsonify({"error": "no_puedes_gestionar_tu_canje", "mensaje": "Tu canje lo tiene que revisar el otro padre."}), 403
    db().execute(
        "UPDATE canjes SET puntos = ?, estado = 'tasado' WHERE id = ?",
        (puntos, cid),
    )
    db().commit()
    return jsonify({"ok": True})


@app.route("/api/canjes/<int:cid>/decidir", methods=["POST"])
@padre_required
def decidir_canje(cid):
    data = request.get_json(force=True)
    accion = data.get("accion")
    if accion not in ("aprobar", "denegar"):
        return jsonify({"error": "accion_invalida"}), 400
    estado = "aprobado" if accion == "aprobar" else "denegado"

    canje = db().execute("SELECT * FROM canjes WHERE id = ?", (cid,)).fetchone()
    if canje is None:
        return jsonify({"error": "canje_no_existe"}), 404
    if canje["puntos"] is None:
        return jsonify({"error": "sin_tasar"}), 400
    if not puede_gestionar_canje(canje):
        return jsonify({"error": "no_puedes_gestionar_tu_canje", "mensaje": "Tu canje lo tiene que revisar el otro padre."}), 403

    # Aprobar = ACEPTAR el capricho (compromiso). NO se descuenta todavía ni se
    # exige saldo. El descuento ocurre al CANJEAR (recompensa entregada).
    db().execute(
        "UPDATE canjes SET estado = ?, decidido = ?, decidido_por = ? WHERE id = ?",
        (estado, now_iso(), g.member["id"], cid),
    )
    db().commit()
    return jsonify({"ok": True})


@app.route("/api/canjes/<int:cid>/canjear", methods=["POST"])
@padre_required
def canjear_canje(cid):
    """Marcar un canje aceptado como ENTREGADO: aquí sí se descuentan los puntos.
    Solo un padre puede confirmar la entrega de la recompensa. Verifica que el
    miembro tenga saldo suficiente en este momento."""
    canje = db().execute("SELECT * FROM canjes WHERE id = ?", (cid,)).fetchone()
    if canje is None:
        return jsonify({"error": "canje_no_existe"}), 404
    if canje["estado"] != "aprobado":
        return jsonify({"error": "canje_no_aceptado"}), 400
    if canje["puntos"] is None:
        return jsonify({"error": "sin_tasar"}), 400
    if not puede_gestionar_canje(canje):
        return jsonify({"error": "no_puedes_gestionar_tu_canje", "mensaje": "Tu canje lo tiene que revisar el otro padre."}), 403
    # Comprobar saldo suficiente en el momento de canjear
    s = saldo(canje["miembro_id"])
    if s < canje["puntos"]:
        return jsonify({"error": "saldo_insuficiente", "saldo": s, "necesario": canje["puntos"]}), 400
    db().execute(
        "UPDATE canjes SET canjeado = 1 WHERE id = ?",
        (cid,),
    )
    db().commit()
    return jsonify({"ok": True})


@app.route("/api/canjes/<int:cid>", methods=["DELETE"])
@login_required
def eliminar_canje(cid):
    canje = db().execute("SELECT * FROM canjes WHERE id = ?", (cid,)).fetchone()
    if canje is None:
        return jsonify({"error": "canje_no_existe"}), 404
    # Solo se bloquea el canje YA ENTREGADO (canjeado=1): ese ya descontó puntos y
    # no se debe borrar (rompería el saldo). Un canje aprobado/aceptado pero aún no
    # canjeado (canjeado=0) NO ha descontado → se puede eliminar sin problema.
    if canje["canjeado"] == 1:
        return jsonify({"error": "canje_descontado"}), 400
    # Un miembro solo puede borrar SUS propios canjes; un padre cualquiera.
    if g.member["rol"] != "padre" and canje["miembro_id"] != g.member["id"]:
        return jsonify({"error": "no_te_corresponde"}), 403
    db().execute("DELETE FROM canjes WHERE id = ?", (cid,))
    db().commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# API: settings
# --------------------------------------------------------------------------

@app.route("/api/settings", methods=["GET"])
@login_required
def get_settings():
    rows = db().execute("SELECT clave, valor FROM settings").fetchall()
    data = {r["clave"]: r["valor"] for r in rows}
    # No exponer credenciales del bot de Telegram a los hijos
    if g.member["rol"] != "padre":
        data.pop("tg_token", None)
        data.pop("tg_chat", None)
    return jsonify(data)


@app.route("/api/settings/pts_euro", methods=["PUT"])
@padre_required
def set_pts_euro():
    data = request.get_json(force=True)
    v = data.get("pts_euro")
    try:
        v = int(v)
    except (TypeError, ValueError):
        return jsonify({"error": "entero_invalido"}), 400
    db().execute("INSERT OR REPLACE INTO settings(clave, valor) VALUES ('pts_euro', ?)", (str(v),))
    db().commit()
    return jsonify({"ok": True})


@app.route("/api/settings/telegram", methods=["PUT"])
@padre_required
def set_telegram():
    """Configura las notificaciones por Telegram. Acepta activar/desactivar, token y chat."""
    data = request.get_json(force=True)
    if "activado" in data:
        db().execute("INSERT OR REPLACE INTO settings(clave, valor) VALUES ('tg_activado', ?)", ("1" if data["activado"] else "0",))
    if "token" in data and data["token"]:
        db().execute("INSERT OR REPLACE INTO settings(clave, valor) VALUES ('tg_token', ?)", (str(data["token"]).strip(),))
    if "chat" in data and data["chat"]:
        db().execute("INSERT OR REPLACE INTO settings(clave, valor) VALUES ('tg_chat', ?)", (str(data["chat"]).strip(),))
    db().commit()
    return jsonify({"ok": True})


@app.route("/api/settings/telegram/test", methods=["POST"])
@padre_required
def test_telegram():
    """Envía un mensaje de prueba. Devuelve si se envió correctamente."""
    ok = enviar_telegram("✅ FamilyPoints — notificaciones activadas y funcionando")
    if ok:
        return jsonify({"ok": True, "mensaje": "Mensaje de prueba enviado"})
    return jsonify({"ok": False, "error": "no_envia", "mensaje": "No se pudo enviar. Revisa token y chat."}), 400


# --------------------------------------------------------------------------
# API: administración de miembros (solo padre)
# --------------------------------------------------------------------------

@app.route("/api/me/emoji", methods=["PUT"])
@login_required
def set_my_emoji():
    data = request.get_json(force=True)
    emoji = (data.get("emoji") or "").strip()
    if not emoji:
        return jsonify({"error": "emoji_requerido"}), 400
    # Un emoji normal (hasta 4-5 chars) o una ruta de avatar (ej. avatars/hero/h00.png)
    if len(emoji) > 60:
        return jsonify({"error": "avatar_demasiado_largo"}), 400
    if not emoji.startswith("avatars/"):
        # es un emoji: validar que sea corto
        if len(emoji) > 5:
            return jsonify({"error": "emoji_muy_largo"}), 400
    db().execute("UPDATE members SET emoji = ? WHERE id = ?", (emoji, g.member["id"]))
    db().commit()
    return jsonify({"ok": True})


@app.route("/api/stats", methods=["GET"])
@padre_required
def stats():
    periodo = request.args.get("periodo", "semana")
    if periodo == "anio":
        periodo = "año"
    if periodo not in ("semana", "mes", "año"):
        periodo = "semana"
    hijo_param = request.args.get("hijo", "todos")

    hoy = datetime.now().date()
    if periodo == "semana":
        desde = hoy - timedelta(days=hoy.weekday())
    elif periodo == "mes":
        desde = hoy.replace(day=1)
    else:  # año
        desde = hoy.replace(month=1, day=1)
    desde_str = desde.isoformat()

    hijos_sql = "SELECT id, nombre, emoji, color FROM members WHERE rol='miembro' AND activo=1"
    params = []
    if hijo_param and hijo_param != "todos":
        hijos_sql += " AND id=?"
        params.append(int(hijo_param))
    hijos_sql += " ORDER BY id"
    hijos = db().execute(hijos_sql, params).fetchall()

    hijos_out = []
    for h in hijos:
        mid = h["id"]
        por_dia = db().execute(
            "SELECT substr(creado,1,10) AS dia, COUNT(*) AS acciones, "
            "SUM(CASE WHEN estado='aprobado' THEN 1 ELSE 0 END) AS aprobadas, "
            "SUM(CASE WHEN estado='aprobado' THEN puntos ELSE 0 END) AS puntos "
            "FROM puntos WHERE miembro_id=? AND substr(creado,1,10)>=? GROUP BY dia ORDER BY dia",
            (mid, desde_str),
        ).fetchall()
        por_tarea = db().execute(
            "SELECT t.id AS task_id, t.titulo, t.puntos, t.prioritaria, t.higiene, t.academica, t.min_ocio, "
            "SUM(CASE WHEN p.estado='aprobado' THEN 1 ELSE 0 END) AS veces, "
            "SUM(CASE WHEN p.estado='aprobado' THEN 1 ELSE 0 END) AS aprobadas, "
            "SUM(CASE WHEN p.estado='aprobado' THEN p.puntos ELSE 0 END) AS puntos_total "
            "FROM puntos p JOIN tasks t ON t.id=p.task_id "
            "WHERE p.miembro_id=? AND substr(p.creado,1,10)>=? GROUP BY t.id ORDER BY puntos_total DESC",
            (mid, desde_str),
        ).fetchall()
        denegadas = db().execute(
            "SELECT COUNT(*) c FROM puntos WHERE miembro_id=? AND estado='denegado' AND substr(creado,1,10)>=?",
            (mid, desde_str),
        ).fetchone()["c"]

        aprobadas = sum(r["aprobadas"] for r in por_dia)
        puntos_aprobados = sum(r["puntos"] for r in por_dia)
        pendientes = db().execute(
            "SELECT COUNT(*) c FROM puntos WHERE miembro_id=? AND estado='pendiente' AND substr(creado,1,10)>=?",
            (mid, desde_str),
        ).fetchone()["c"]

        cat = {"higiene": 0, "academica": 0, "min_ocio": 0, "otras": 0, "prioritarias": 0}
        for t in por_tarea:
            v = t["veces"]
            if t["prioritaria"]:
                cat["prioritarias"] += v
            if t["higiene"]:
                cat["higiene"] += v
            elif t["academica"]:
                cat["academica"] += v
            elif t["min_ocio"]:
                cat["min_ocio"] += v
            else:
                cat["otras"] += v

        dias_aprob = set(r["d"] for r in db().execute(
            "SELECT DISTINCT substr(creado,1,10) AS d FROM puntos WHERE miembro_id=? AND estado='aprobado' "
            "ORDER BY d DESC", (mid,),
        ).fetchall())
        racha = 0
        cur = hoy
        if cur.isoformat() not in dias_aprob:
            cur = cur - timedelta(days=1)
        while cur.isoformat() in dias_aprob:
            racha += 1
            cur = cur - timedelta(days=1)

        cumplimiento = None
        if (aprobadas + denegadas) > 0:
            cumplimiento = round(aprobadas * 100 / (aprobadas + denegadas))

        hijos_out.append({
            "id": h["id"], "nombre": h["nombre"], "emoji": h["emoji"], "color": h["color"],
            "resumen": {
                "acciones": aprobadas, "aprobadas": aprobadas, "denegadas": denegadas,
                "pendientes": pendientes,
                "puntos_aprobados": puntos_aprobados,
                "cumplimiento": cumplimiento,
                "racha": racha,
                "prioritarias_pct": round(cat["prioritarias"] * 100 / aprobadas) if aprobadas else 0,
            },
            "por_dia": [dict(r) for r in por_dia],
            "por_tarea": [dict(r) for r in por_tarea],
            "por_categoria": cat,
        })

    total_puntos = sum(h["resumen"]["puntos_aprobados"] for h in hijos_out)
    return jsonify({"periodo": periodo, "desde": desde_str, "total_puntos": total_puntos, "hijos": hijos_out})


@app.route("/api/members", methods=["GET"])
@login_required
def list_members():
    is_padre = g.member["rol"] == "padre"
    rows = db().execute(
        "SELECT id, nombre, rol, emoji, color, activo FROM members ORDER BY rol, nombre"
    ).fetchall()
    out = []
    hoy = datetime.now().date().isoformat()
    for r in rows:
        d = dict(r)
        # Especificación: clasificación y ocio OCULTOS a los hijos (backend-enforced).
        if is_padre:
            d["saldo"] = saldo(r["id"])
            d["saldo_ocio"] = saldo_ocio(r["id"])
            d["ocio_consumido_hoy"] = db().execute(
                "SELECT COALESCE(SUM(-minutos),0) FROM ocio WHERE miembro_id=? AND minutos<0 AND estado='aprobado' AND substr(creado,1,10)=?",
                (r["id"], hoy),
            ).fetchone()[0]
            d["ocio_pendiente_hoy"] = db().execute(
                "SELECT COALESCE(SUM(-minutos),0) FROM ocio WHERE miembro_id=? AND minutos<0 AND estado='pendiente' "
                "AND substr(creado,1,10)=?", (r["id"], hoy),
            ).fetchone()[0]
            # Última actividad de ocio (ganada o consumida) para el aviso del padre
            uo = db().execute(
                "SELECT categoria, minutos, familia, motivo, creado FROM ocio WHERE miembro_id=? AND estado!='denegado' "
                "ORDER BY id DESC LIMIT 1", (r["id"],),
            ).fetchone()
            d["ultimo_ocio"] = dict(uo) if uo else None
        out.append(d)
    return jsonify({"members": out})


@app.route("/api/members", methods=["POST"])
@padre_required
def create_member():
    data = request.get_json(force=True)
    nombre = (data.get("nombre") or "").strip()
    pin = data.get("pin") or ""
    rol = data.get("rol", "miembro")
    emoji = data.get("emoji", "🙂")
    color = data.get("color", "#4C8C4A")
    if not nombre or not pin:
        return jsonify({"error": "nombre_pin_requerido"}), 400
    if rol not in ("padre", "miembro"):
        return jsonify({"error": "rol_invalido"}), 400
    try:
        db().execute(
            "INSERT INTO members(nombre, rol, pin_hash, emoji, color, activo, creado) VALUES (?,?,?,?,?,1,?)",
            (nombre, rol, hash_pin(pin), emoji, color, now_iso()),
        )
        db().commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "nombre_existe"}), 409
    return jsonify({"ok": True})


@app.route("/api/members/<int:mid>/reset_pin", methods=["PUT"])
@padre_required
def reset_pin(mid):
    data = request.get_json(force=True)
    pin = data.get("pin") or ""
    if len(pin) < 4:
        return jsonify({"error": "pin_min4"}), 400
    db().execute("UPDATE members SET pin_hash = ? WHERE id = ?", (hash_pin(pin), mid))
    db().commit()
    return jsonify({"ok": True})


@app.route("/api/me/pin", methods=["PUT"])
@login_required
def change_my_pin():
    """Cualquier miembro cambia SU propio PIN (exige el actual para verificarlo)."""
    data = request.get_json(force=True)
    actual = data.get("actual") or ""
    nuevo = data.get("nuevo") or ""
    if len(nuevo) < 4:
        return jsonify({"error": "pin_min4"}), 400
    if hash_pin(actual) != g.member["pin_hash"]:
        return jsonify({"error": "pin_actual_incorrecto"}), 401
    db().execute("UPDATE members SET pin_hash = ? WHERE id = ?", (hash_pin(nuevo), g.member["id"]))
    db().commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# API: Reset (solo padres) — borra todos los puntos y canjes para empezar de 0
# --------------------------------------------------------------------------

@app.route("/api/reset", methods=["POST"])
@padre_required
def reset():
    db().execute("DELETE FROM puntos")
    db().execute("DELETE FROM canjes")
    db().execute("DELETE FROM ocio")
    db().commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# API: Juez IA (resolver disputas con IA)
# --------------------------------------------------------------------------

def _deepseek_key():
    """Lee la clave DeepSeek de ~/.hermes/.env (no la expone en config/logs)."""
    env_path = os.path.expanduser("~/.hermes/.env")
    try:
        with open(env_path) as f:
            for line in f:
                if line.startswith("DEEPSEEK_API_KEY="):
                    return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return None


@app.route("/api/ai-judge", methods=["POST"])
@login_required
def ai_judge():
    key = _deepseek_key()
    if not key:
        return jsonify({"error": "sin_clave_ia"}), 503
    data = request.get_json(force=True)
    caso = (data.get("caso") or "").strip()
    if not caso:
        return jsonify({"error": "caso_requerido"}), 400
    prompt = (
        "Eres el Juez IA de una app familiar de puntos por tareas. "
        "El padre no está seguro de si aceptar o no unos puntos. "
        "Decide de forma justa y razonable. Responde en español con una línea que empiece "
        "exactamente por 'VEREDICTO: APROBADO' o 'VEREDICTO: DENEGADO', seguida de una razón breve "
        "y justa (una o dos frases). Es para una familia; sé amable y pedagógico.\n\n"
        "CASO A JUZGAR:\n" + caso
    )
    body = json.dumps({
        "model": "deepseek-v4-flash",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 800,
        "temperature": 0.3,
        "stream": False,
        "chat_template_kwargs": {"enable_thinking": False},
    }).encode()
    req = urllib.request.Request(
        "https://api.deepseek.com/v1/chat/completions",
        data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            d = json.loads(resp.read().decode())
        m = d.get("choices", [{}])[0].get("message", {})
        texto = (m.get("content") or "").strip()
        # DeepSeek a veces mete la respuesta en reasoning_content y content viene vacío
        if not texto:
            rc = (m.get("reasoning_content") or "").strip()
            # buscar el VEREDICTO en el reasoning (al final suele estar)
            if "VEREDICTO:" in rc.upper():
                idx = rc.upper().find("VEREDICTO:")
                texto = rc[idx:].strip()
    except urllib.error.HTTPError as e:
        return jsonify({"error": "ia_error", "detalle": str(e)}), 502
    except Exception as e:
        return jsonify({"error": "ia_error", "detalle": str(e)}), 502

    veredicto = "APROBADO" if texto.upper().startswith("VEREDICTO: APROBADO") else (
        "DENEGADO" if texto.upper().startswith("VEREDICTO: DENEGADO") else "DESCONOCIDO")
    # Quitar el prefijo 'VEREDICTO: APROBADO/DENEGADO' de la razón
    import re as _re
    razon = _re.sub(r"^[\s\W]*VEREDICTO:\s*(APROBADO|DENEGADO)[\s\W]*", "", texto, flags=_re.I | _re.M).strip() or texto.split(":", 1)[-1].strip()
    return jsonify({"veredicto": veredicto, "razon": razon})


# --------------------------------------------------------------------------
# Frontend
# --------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/<path:name>")
def static_files(name):
    return send_from_directory(STATIC_DIR, name)


@app.route("/rootca")
@app.route("/rootca.crt")
def rootca_download():
    """Sirve el certificado raíz como descarga (.crt) para instalarlo como CA en los móviles."""
    path = os.path.join(BASE_DIR, "certs", "rootCA.pem")
    if not os.path.exists(path):
        return jsonify({"error": "no_rootca"}), 404
    resp = send_from_directory(
        os.path.dirname(path), os.path.basename(path),
        mimetype="application/x-x509-ca-cert",
    )
    resp.headers["Content-Disposition"] = 'attachment; filename="rootCA.crt"'
    resp.headers["Content-Type"] = "application/x-x509-ca-cert"
    return resp


# --------------------------------------------------------------------------
# Arranque
# --------------------------------------------------------------------------

def main():
    init_db()
    # HTTP se mantiene en PORT (8890) para no romper a quien use la URL antigua.
    # HTTPS (contexto seguro, necesaria para PWA standalone) se añade en 8443.
    HTTPS_PORT = int(os.environ.get("FAMILYPOINTS_HTTPS_PORT", "8443"))
    cert = os.path.join(BASE_DIR, "certs", "cert.pem")
    key = os.path.join(BASE_DIR, "certs", "key.pem")
    use_https = os.environ.get("FAMILYPOINTS_HTTPS", "0") == "1" and os.path.exists(cert) and os.path.exists(key)
    if use_https:
        import threading
        from werkzeug.serving import run_simple
        print("[FamilyPoints] HTTPS también en", HTTPS_PORT)
        def _https():
            try:
                run_simple(HOST, HTTPS_PORT, app, ssl_context=(cert, key), threaded=True)
            except Exception as e:
                print("[FamilyPoints] HTTPS falló:", e)
        threading.Thread(target=_https, daemon=True).start()
    app.run(host=HOST, port=PORT, debug=False)


if __name__ == "__main__":
    main()
