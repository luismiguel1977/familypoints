# Tests de FamilyPoints

Tests de regresión que **NUNCA tocan la BD real** — usan una BD temporal (`tempfile`) y el test-cliente de Flask (sin levantar servidor).

## Ejecutar
```bash
.venv/bin/python tests/test_reglas.py
```
(si prefieres pytest: `.venv/bin/python -m pytest tests/ -v`)

## Qué cubre (10 tests)
- T1 Regla dura: sin 3 prioritarias NO se puede tocar tarea de casa → 403 `falta_prioritaria`
- T2 Regla dura: con 3 prioritarias (≥2 académicas) SÍ se puede → 200
- T3 Regla académica: 3 prioritarias pero <2 académicas → 403
- T4 Higiene: se marca siempre, sin necesitar prioritarias → 200
- T5 Botella: máximo 2/día, la 3ª → 403 `botella_limite`
- T6 Mesa: no se pueden hacer "Poner" y "Quitar" el mismo → 403 `mesa_alterna`
- T7 Ranking: un hijo solo ve su propia fila (sin comparaciones)
- T8 Ranking: el padre ve la clasificación completa
- T9 Actividad: un hijo solo ve su propia actividad
- T10 Seguridad: un hijo NO puede decidir aprobar puntos → 403 `solo_padres`

Los tests se ejecutan en orden alfabético de método por defecto; el `setUp()` borra `puntos`/`ocio`/`sessions` antes de **cada** test para garantizar independencia.
