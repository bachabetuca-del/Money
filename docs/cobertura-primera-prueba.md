# Cobertura de la primera prueba publicada

## Diagnóstico

**Evidencia insuficiente para certificar la cobertura real.** En la base de
producción consultada todavía no existe el esquema de «Validación sin dinero».
No hay una cohorte activa verificable ni una ventana de observaciones
prospectivas que se pueda analizar.

Esto **no significa cobertura del 0 %**, ni que hayan fallado todas las capturas.
La medición aún no puede comenzar. Tampoco es una prueba de rentabilidad.

## Comprobación de solo lectura

- Fecha: **18 de noviembre de 2026, 00:35:58–00:36:33 UTC**. Es el intervalo de
  consulta, no una ventana de tráfico de la cohorte.
- El servicio de publicación informó de una aplicación publicada, con compilación
  satisfactoria, modalidad VM y acceso público:
  <https://kalshi-sports-tracker.replit.app>.
- Se hicieron **dos consultas SELECT** a la réplica de producción. No se
  consultaron filas de resultados, balances ni liquidaciones.
- Las cuatro tablas necesarias no existen en `public`. La comprobación adicional
  no encontró tablas `kalshi_paper_%` en los demás esquemas de aplicación visibles;
  sí encontró la tabla existente `public.kalshi_notifications`.
- No se consultó desarrollo como sustituto de producción, ni se publicaron
  cambios, aplicaron migraciones, iniciaron cohortes o habilitaron trabajadores.
  No se repitió el recorrido del navegador.

### Consultas y resultados reproducibles

```sql
SELECT
  clock_timestamp() AT TIME ZONE 'UTC' AS observed_at_utc,
  to_regclass('public.kalshi_paper_runs')::text AS runs_table,
  to_regclass('public.kalshi_paper_candidates')::text AS candidates_table,
  to_regclass('public.kalshi_paper_executions')::text AS executions_table,
  to_regclass('public.kalshi_paper_reports')::text AS reports_table;
```

Resultado a las `2026-11-18 00:35:58.460580 UTC`: las cuatro referencias fueron
`NULL` (tablas ausentes, no tablas vacías).

```sql
SELECT
  clock_timestamp() AT TIME ZONE 'UTC' AS observed_at_utc,
  table_schema,
  table_name
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
  AND (
    table_name LIKE 'kalshi_paper_%'
    OR table_name IN ('kalshi_notifications', 'kalshi_trades')
  )
ORDER BY table_schema, table_name
LIMIT 20;
```

Única fila a las `2026-11-18 00:36:33.129385 UTC`:
`public.kalshi_notifications`. La ausencia de `kalshi_trades` no se utiliza para
ninguna conclusión; el diagnóstico depende de las cuatro tablas de la prueba.

## Cobertura solicitada

| Dimensión | Resultado de esta revisión |
| --- | --- |
| Cohorte, inicio, cierre y latido | No verificables: falta `kalshi_paper_runs`. |
| Candidatos y ritmo real | No medibles: falta `kalshi_paper_candidates`. |
| Avisos confirmados de la cohorte | No atribuibles a una cohorte; los avisos históricos no la sustituyen. |
| Capturas puntuales y pendientes vencidas | No medibles: falta `kalshi_paper_executions`; no existe denominador para una tasa. |
| Desconexiones y mercados simultáneos | Sin evidencia de una cohorte publicada; no se presume ausencia de incidencias. |
| Razones de entradas desconocidas | No disponibles; no se clasifican artificialmente como falta de liquidez. |
| Controles comparables | Sin candidatos ni pares prospectivos; no se crean retrospectivamente. |
| Tramo final | No se consultó ni reveló ningún resultado reservado. |
| Latencias del explorador y del envío | No hay un período con la prueba activa para contrastar con una línea base. |

### Capacidad de 10.000 candidatos

El límite es **por cohorte y por candidato único**, incluyendo aceptados y
descartados. No es un límite de 10.000 avisos enviados, ni se multiplica por los
escenarios de ejecución.

Para los **28 días predeterminados**, el presupuesto equivale a un máximo medio
de **357,14 candidatos/día**, o **14,88/hora**, sin margen para un aumento del
tráfico. Es aritmética del límite, **no una estimación del ritmo real**. El período
efectivo debe tomarse del protocolo que el dueño haya iniciado, no del valor
predeterminado.

Con datos reales se podrá calcular:

```text
proyección al cierre = candidatos acumulados
                    + ritmo observado × tiempo restante
```

Además de la media deben examinarse los picos y la representatividad de la
ventana. Llegar al límite interrumpe la captación de la prueba; no equivale a
haber cubierto el período previsto. Ahora no puede determinarse si alcanzará.
No se recomienda cambiar su tamaño ni la duración basándose en una tasa inventada.

### Referencia de latencia disponible

La auditoría anterior conserva **un solo aviso** con 29 min 7,395 s entre
operación y confirmación: 16 min 13,372 s hasta el primer guardado, 0,545 s hasta
el encolado, 12 min 52,743 s hasta la decisión y 0,735 s hasta la confirmación.
Véase [la guía de validación](validacion-sin-dinero.md).

Ese caso no es una distribución de latencias, ni una medición del explorador.
No se encontró una línea base cuantitativa del explorador en la documentación
consultada. Sin observaciones contemporáneas comparables no se puede afirmar una
mejora, un deterioro ni ausencia de impacto. Medir el entorno de desarrollo o
consultar la web sin la cohorte activa no resolvería esa comparación.

## Requisito pendiente

La revisión real requiere que la versión con esta infraestructura y su esquema
esté en producción y que **el dueño haya iniciado voluntariamente una cohorte**
desde **Señales → Validación sin dinero**. Guardar un borrador no la activa.
Este diagnóstico no realiza ni solicita una publicación automática.

Si ya se intentó publicar esa versión, corresponde comprobar qué versión y
esquema llegaron a producción; el estado general de compilación satisfactoria
no demuestra que incluyera esta funcionalidad. No se debe reemplazar producción
con datos de desarrollo ni aplicar un arreglo de esquema desde esta revisión.

Una vez cumplido el requisito, otra revisión podrá fijar una ventana corta
posterior al inicio y anterior al tramo reservado, contar decisiones y
confirmaciones, verificar capturas con tolerancia de 1,5 s, desglosar desconocidos
y controles, proyectar el límite y comparar latencias con una referencia
equivalente. Cualquier ajuste de reglas será para otra cohorte; no se reinterpretará
la existente ni se abrirán sus resultados finales.

## Limitación adicional de observabilidad

La inspección del código, **no del tráfico real**, muestra que el observador
conserva el último error y el último latido, pero no un historial duradero de
todas las desconexiones y ocupaciones simultáneas. Rechazar un mercado por falta
de cupo devuelve `false`; el llamador no conserva ese motivo específico. Por
ello un último latido sano, las cotizaciones disponibles o un error vacío no
demuestran que nunca hubo desconexiones o saturación.

Como mejora separada se puede conservar un registro acotado de desconexiones,
reconexiones, ocupación máxima y rechazos por cupo, sin resultados financieros,
sin otro trabajador y sin bloquear Telegram. No se implementa en esta auditoría
ni se reconstruye retrospectivamente.

Fuentes de implementación consultadas: `protocol.ts`, `repository.ts`,
`runtime.ts`, `book-stream.ts` y `lib/db/src/schema/kalshi-paper.ts`.
