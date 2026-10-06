"""
Seed inicial de FamilyPoints.
Crea los 4 miembros de la familia, unas tareas de ejemplo y la conversión por defecto.
Los PINs se muestran para poder entrar y probar. Cambia los PINs luego desde Admin.
"""
import sqlite3
import hashlib
import os
import sys

from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "familypoints.db")

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
  asignado_a INTEGER,
  activo     INTEGER NOT NULL DEFAULT 1,
  creado     TEXT NOT NULL,
  FOREIGN KEY (asignado_a) REFERENCES members(id)
);
CREATE TABLE IF NOT EXISTS puntos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  miembro_id INTEGER NOT NULL,
  task_id    INTEGER,
  puntos     INTEGER NOT NULL,
  estado     TEXT NOT NULL DEFAULT 'pendiente',
  creado     TEXT NOT NULL,
  decidido   TEXT,
  decidido_por INTEGER,
  FOREIGN KEY (miembro_id) REFERENCES members(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (decidido_por) REFERENCES members(id)
);
CREATE TABLE IF NOT EXISTS canjes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  miembro_id INTEGER NOT NULL,
  titulo     TEXT NOT NULL,
  puntos     INTEGER,
  tipo       TEXT NOT NULL DEFAULT 'cosa',
  estado     TEXT NOT NULL DEFAULT 'propuesto',
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

def hash_pin(pin):
    return hashlib.sha256(("familypoints-salt" + str(pin)).encode()).hexdigest()

def now_iso():
    return datetime.now().isoformat(timespec="seconds")

def main(force=False):
    # Si la DB ya tiene miembros, no sembrar de nuevo salvo --force
    con = sqlite3.connect(DB_PATH)
    con.executescript(SCHEMA)
    existing = con.execute("SELECT COUNT(*) AS c FROM members").fetchone()[0]
    if existing > 0 and not force:
        print(f"Ya hay {existing} miembros. No se siembra (usa --force para resetear).")
        con.close()
        return

    if force and existing > 0:
        # resetear todo
        for t in ("sessions", "canjes", "puntos", "tasks", "members", "settings"):
            con.execute(f"DELETE FROM {t}")
        con.execute("DELETE FROM sqlite_sequence")
        con.commit()

    members = [
        # (nombre, rol, pin, emoji, color) — familia DE EJEMPLO: cámbiala por la tuya
        ("Marcos", "padre",   "1234", "🧔", "#2E3A59"),
        ("Ana",    "padre",   "4321", "👩", "#B5651D"),
        ("Lucía",  "miembro", "1111", "🏍️", "#4C8C4A"),
        ("Hugo",   "miembro", "2222", "🦸", "#C0392B"),
    ]
    ids = {}
    for nombre, rol, pin, emoji, color in members:
        cur = con.execute(
            "INSERT INTO members(nombre, rol, pin_hash, emoji, color, activo, creado) VALUES (?,?,?,?,?,1,?)",
            (nombre, rol, hash_pin(pin), emoji, color, now_iso()),
        )
        ids[nombre] = cur.lastrowid

    # settings por defecto
    con.execute("INSERT OR REPLACE INTO settings(clave, valor) VALUES ('pts_euro', '10')")

    # tareas de ejemplo (estilo FamilyPoints: ganar y penalizar) — TODAS para cualquiera
    tareas = [
        ("Poner la mesa", 15, None),
        ("Pasear al perro", 20, None),
        ("Limpiar la habitación", 25, None),
        ("Deberes hechos", 30, None),
        ("Pasar la aspiradora", 20, None),
        ("Regar plantas", 10, None),
        ("Doblar la ropa", 15, None),
        ("Excelente en el examen", 50, None),
        ("Hacer la cama", 10, None),
        ("Ayudar con los platos", 10, None),
        ("Dar de comer a la mascota", 10, None),
        ("Demasiada TV", -15, None),
        ("Pelear con el hermano", -10, None),
    ]
    for titulo, pts, asignado in tareas:
        con.execute(
            "INSERT INTO tasks(titulo, puntos, asignado_a, activo, creado) VALUES (?,?,?,1,?)",
            (titulo, pts, asignado, now_iso()),
        )

    con.commit()
    con.close()
    print("Seed OK.")
    for nombre, rol, pin, emoji, color in members:
        print(f"  {emoji} {nombre}  ({rol})  PIN: {pin}")


if __name__ == "__main__":
    force = "--force" in sys.argv
    main(force=force)
