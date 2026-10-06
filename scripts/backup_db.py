#!/usr/bin/env python3
"""
Backup automático de la BD de FamilyPoints — WAL-safe.

Usa la API sqlite3 `backup()` (no un simple `cp`), que copia de forma consistente
TODO el estado incluyendo el fichero -wal (los datos más recientes viven ahí).
Es seguro ejecutarla con la app corriendo.

Retención: conserva los últimos N backups automáticos (14 por defecto) y borra los viejos.

Se ejecuta vía systemd timer (familypoints-backup.timer) — no hace falta llamarlo a mano,
pero se puede:  python3 scripts/backup_db.py
"""
import os, sys, sqlite3, datetime, glob

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(BASE_DIR, "data", "familypoints.db")
BACKUP_DIR = os.path.join(BASE_DIR, "data", "backups")
RETEN = int(os.environ.get("FAMILYPOINTS_BACKUP_RETEN", "14"))


def main():
    if not os.path.exists(DB):
        print(f"ERROR: BD no encontrada: {DB}")
        return 1
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    dst = os.path.join(BACKUP_DIR, f"auto-{stamp}.db")

    src = sqlite3.connect(DB)
    dest = sqlite3.connect(dst)
    try:
        src.backup(dest)   # copia consistente (incluye WAL)
    finally:
        dest.close(); src.close()

    # retención: borrar los más antiguos que superen RETEN
    backups = sorted(glob.glob(os.path.join(BACKUP_DIR, "auto-*.db")))
    for old in backups[:-RETEN] if len(backups) > RETEN else []:
        try:
            os.remove(old)
        except OSError:
            pass

    size = os.path.getsize(dst)
    print(f"OK backup: {dst} ({size} bytes) | {len(backups)} automáticos (retención {RETEN})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
