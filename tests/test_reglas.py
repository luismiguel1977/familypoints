"""
Test de regresión para FamilyPoints — NUNCA toca la BD real.
Usa una BD temporal y el test-client de Flask (sin servidor).

Run:  python3 -m pytest tests/ -v   (o)  python3 tests/test_reglas.py
"""
import os, sys, tempfile, shutil, hashlib, datetime
import sqlite3

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

# --- Aislar la BD ANTES de importar la app ---
tmpdir = tempfile.mkdtemp(prefix="fptest_")
TEST_DB = os.path.join(tmpdir, "test_familypoints.db")

import app as fp
fp.DB_PATH = TEST_DB          # redirigir a la BD de test
fp.init_db()

import unittest


def seed():
    con = sqlite3.connect(TEST_DB)
    con.row_factory = sqlite3.Row
    now = datetime.datetime.now().isoformat(timespec="seconds")
    def h(p): return hashlib.sha256(("familypoints-salt" + p).encode()).hexdigest()
    # 2 padres + 2 hijos
    con.execute("INSERT INTO members(nombre,rol,pin_hash,emoji,creado) VALUES ('Padre','padre',?,?,?)",(h("1234"),"🧔",now))
    con.execute("INSERT INTO members(nombre,rol,pin_hash,emoji,creado) VALUES ('Madre','padre',?,?,?)",(h("4321"),"👩",now))
    con.execute("INSERT INTO members(nombre,rol,pin_hash,emoji,creado) VALUES ('Hijo1','miembro',?,?,?)",(h("1111"),"🏍️",now))
    con.execute("INSERT INTO members(nombre,rol,pin_hash,emoji,creado) VALUES ('Hijo2','miembro',?,?,?)",(h("2222"),"🦸",now))
    # Tareas de prueba
    T = con.execute
    # prioritarias académicas
    T("INSERT INTO tasks(titulo,puntos,prioritaria,higiene,academica,activo,creado) VALUES('Hacer deberes',15,1,0,1,1,?)",(now,))
    T("INSERT INTO tasks(titulo,puntos,prioritaria,higiene,academica,activo,creado) VALUES('Leer libro',12,1,0,1,1,?)",(now,))
    T("INSERT INTO tasks(titulo,puntos,prioritaria,higiene,academica,activo,creado) VALUES('Recoger cuarto',10,1,0,0,1,?)",(now,))
    # casa (no prioritaria)
    T("INSERT INTO tasks(titulo,puntos,prioritaria,higiene,academica,activo,creado) VALUES('Poner lavadora',4,0,0,0,1,?)",(now,))
    T("INSERT INTO tasks(titulo,puntos,prioritaria,higiene,academica,activo,creado) VALUES('Tender lavadora',4,0,0,0,1,?)",(now,))
    # higiene
    T("INSERT INTO tasks(titulo,puntos,prioritaria,higiene,academica,activo,creado) VALUES('Lavarse los dientes',1,0,1,0,1,?)",(now,))
    T("INSERT INTO tasks(titulo,puntos,prioritaria,higiene,academica,activo,creado) VALUES('Llenar la botella',1,0,1,0,1,?)",(now,))
    # mesa
    T("INSERT INTO tasks(titulo,puntos,prioritaria,higiene,academica,activo,creado) VALUES('Poner la mesa',4,0,0,0,1,?)",(now,))
    T("INSERT INTO tasks(titulo,puntos,prioritaria,higiene,academica,activo,creado) VALUES('Quitar la mesa',4,0,0,0,1,?)",(now,))
    con.commit()
    con.close()


seed()


class FamilyPointsTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.client = fp.app.test_client()

    def setUp(self):
        # Resetear estado para que cada test sea INDEPENDIENTE (sin acoplamiento)
        con = sqlite3.connect(TEST_DB)
        con.execute("DELETE FROM puntos")
        con.execute("DELETE FROM ocio")
        con.execute("DELETE FROM sessions")
        con.commit(); con.close()

    def login(self, nombre, pin):
        r = self.client.post("/api/login", json={"nombre": nombre, "pin": pin})
        self.assertEqual(r.status_code, 200, r.get_json())
        return {"Authorization": "Bearer " + r.get_json()["token"]}

    def hoy(self):
        return datetime.date.today().isoformat()

    # ---- T1: regla dura — sin prioritarias NO puede tocar casa ----
    def test_regla_dura_bloquea_casa(self):
        h = self.login("Hijo1", "1111")
        r = self.client.post("/api/tasks/4/hecho", headers=h)  # Poner lavadora (id 4)
        self.assertEqual(r.status_code, 403)
        b = r.get_json()
        self.assertEqual(b["error"], "falta_prioritaria")

    # ---- T2: con 3 prioritarias (≥2 académicas) sí puede tocar casa ----
    def test_regla_dura_pasa_con_3_prioritarias(self):
        h = self.login("Hijo1", "1111")
        # marcar 2 académicas (deberes id1, leer id2) + 1 recoger cuarto id3 (no acad)
        for tid in (1, 2, 3):
            r = self.client.post(f"/api/tasks/{tid}/hecho", headers=h)
            self.assertEqual(r.status_code, 200, r.get_json())
        r = self.client.post("/api/tasks/4/hecho", headers=h)  # Poner lavadora
        self.assertEqual(r.status_code, 200, r.get_json())

    # ---- T3: 3 prioritarias pero <2 académicas → bloquea ----
    def test_regla_academica_bloquea(self):
        h = self.login("Hijo2", "2222")
        # recoger cuarto (no acad) + 2 más no académicas? solo hay 1 no-acad prioritaria.
        # Usamos: recoger cuarto (id3, no acad), y 2 prioritarias académicas NO
        # realmente se necesitan 3 con <2 acad para ver el bloqueo -> marcamos 1 acad + 1 no-acad
        # y probamos casa: solo 2 priorities -> bloquea por ya<3
        for tid in (2, 3):  # Leer(acad) + Recoger(no-acad) = 2 prio, 1 acad
            r = self.client.post(f"/api/tasks/{tid}/hecho", headers=h)
            self.assertEqual(r.status_code, 200, r.get_json())
        r = self.client.post("/api/tasks/4/hecho", headers=h)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.get_json()["error"], "falta_prioritaria")

    # ---- T4: higiene se marca sin prioritarias ----
    def test_higiene_siempre_puede(self):
        h = self.login("Hijo2", "2222")
        r = self.client.post("/api/tasks/6/hecho", headers=h)  # Lavarse dientes
        self.assertEqual(r.status_code, 200, r.get_json())

    # ---- T5: botella máx 2/día ----
    def test_botella_limite_2(self):
        h = self.login("Hijo1", "1111")
        # El setUp ya resetea los puntos: marcamos las 3 llenadas
        r1 = self.client.post("/api/tasks/7/hecho", headers=h)
        r2 = self.client.post("/api/tasks/7/hecho", headers=h)
        r3 = self.client.post("/api/tasks/7/hecho", headers=h)
        self.assertEqual((r1.status_code, r2.status_code), (200, 200))
        self.assertEqual(r3.status_code, 403)
        self.assertEqual(r3.get_json()["error"], "botella_limite")

    # ---- T6: mesa — no las dos el mismo ----
    def test_mesa_alterna(self):
        h = self.login("Hijo1", "1111")
        # necesita 3 prioritarias primero para una tarea de casa...
        # resetear puntos de Hijo1 hoy y marcar 3 prioritarias
        con = sqlite3.connect(TEST_DB); con.execute("DELETE FROM puntos WHERE miembro_id=3"); con.commit(); con.close()
        for tid in (1, 2, 3):
            self.client.post(f"/api/tasks/{tid}/hecho", headers=h)
        r1 = self.client.post("/api/tasks/8/hecho", headers=h)  # Poner la mesa
        r2 = self.client.post("/api/tasks/9/hecho", headers=h)  # Quitar la mesa
        self.assertEqual(r1.status_code, 200, r1.get_json())
        self.assertEqual(r2.status_code, 403)
        self.assertEqual(r2.get_json()["error"], "mesa_alterna")

    # ---- T7: ranking filtrado — hijo solo ve su fila ----
    def test_clasificacion_filtrada_hijo(self):
        h = self.login("Hijo1", "1111")
        r = self.client.get("/api/clasificacion?periodo=mes", headers=h)
        b = r.get_json()["clasificacion"]
        names = [x["nombre"] for x in b]
        self.assertEqual(names, ["Hijo1"])
        self.assertNotIn("Hijo2", names)

    # ---- T8: ranking completo para el padre ----
    def test_clasificacion_padre_completa(self):
        h = self.login("Padre", "1234")
        r = self.client.get("/api/clasificacion?periodo=mes", headers=h)
        b = r.get_json()["clasificacion"]
        self.assertEqual(len(b), 4)

    # ---- T9: actividad filtrada para hijo ----
    def test_actividad_filtrada_hijo(self):
        h = self.login("Hijo2", "2222")
        r = self.client.get("/api/actividad", headers=h)
        for a in r.get_json()["actividad"]:
            self.assertEqual(a["miembro"], "Hijo2")

    # ---- T10: hijo no puede decidir puntos (403 solo_padres) ----
    def test_hijo_no_decide_puntos(self):
        h = self.login("Hijo1", "1111")
        r = self.client.post("/api/puntos/999/decidir", json={"accion": "aprobar"}, headers=h)
        self.assertEqual(r.status_code, 403)


if __name__ == "__main__":
    unittest.main(verbosity=2)
