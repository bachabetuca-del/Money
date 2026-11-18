# ROI verificable por partido

## Respuesta sencilla

Sí: un resultado histórico se calcula sumando lo ganado y restando lo perdido.
El precio importa, además de cuántas selecciones acertaron. No son beneficios
reales del autor de la operación pública, cuyo inventario y costes desconocemos.

- Una entrada de $100 a 40¢ compra 250 contratos hipotéticos.
- Si el lado elegido liquida ganador a $1: recibe $250, gana $150 brutos.
- Si pierde: recibe $0, pierde los $100.
- La apuesta se verifica contra la liquidación oficial del **mercado exacto**,
  no contra el marcador del partido ni contra la última cotización.

Para N entradas iguales:

```
ganancia bruta = suma de ($100 / precio − $100) ganadoras − $100 × perdedoras
ROI bruto = ganancia bruta / ($100 × N) × 100
ROI neto estimado = (ganancia bruta − comisiones estimadas)
                   / ($100 × N + comisiones estimadas) × 100
```

Ejemplo independiente: 100 entradas a 50¢, 60 ganadoras y 40 perdedoras:
$2,000 brutos sobre $10,000 = +20%. Con $3.50 estimados por entrada,
$1,650 / $10,350 = **+15.9420% neto estimado**. Las comisiones se añaden
al capital; no se reduce retroactivamente la cantidad de contratos.
El importe público original solo define el rango observado; no cambia la
apuesta simulada de $100 ni identifica una compra/venta o cierre real.

## Qué cuenta el método principal

Versión: `first-game-pattern-phase-v1`.

1. Solo registros guardados en la ventana elegida, hasta el corte del cálculo.
2. Precio válido (0,1], cantidad positiva, lado conocido y mercado compatible.
3. Identidad inequívoca de partido mediante el milestone de Kalshi.
4. Patrón = deporte × tipo de mercado × lado × banda de precio de 10 puntos
   porcentuales × banda monetaria × fase × partido.
5. Elegir la **primera ejecución** del patrón, por fecha UTC y luego ID
   lexicográfico, **antes de mirar si su mercado ya liquidó o ganó**.
   Diferentes líneas/selecciones del mismo patrón compiten por esa primera
   entrada. La regla no busca retrospectivamente la línea que más ganó.
6. Solo entradas con liquidación binaria final y auditoría histórica completa,
   de la versión de auditoría vigente, entran al ROI verificado. Si la primera
   está pendiente o incompleta no se sustituye por una segunda ganadora.
7. IDs distintos no se borran por tener precio, tamaño y segundo iguales:
   podrían ser ejecuciones legítimas. El análisis por partido reduce su peso
   sin inventar que eran duplicados.

Rangos monetarios: $1,000–$5,000 incluidos; más de $5,000 y menos de $10,000;
$10,000 o más (la banda grande puede tener un umbral configurado superior).
La tabla combinada principal separa las bandas. Agrupaciones amplias suman
patrones: **no representan una única apuesta por partido**. Un mismo partido
puede aparecer en patrones distintos; no son muestras independientes.

“Cada ejecución” sigue disponible como comparación secundaria. Tampoco borra
historial. Conserva el cálculo por operación, pero las fases ya no se mezclan
silenciosamente: deben revisarse individualmente.

## Fases y datos faltantes

- Prepartido: operación al menos 10 minutos antes del horario guardado.
- Cerca del inicio: antes del horario, pero a menos de 10 minutos.
- En vivo: estado live de la fuente de marcador, comprobado antes de la
  operación y como máximo 120 segundos antes; sin retraso/error.
- Desconocida: lo demás, incluida una operación posterior al horario sin
  evidencia contemporánea. Nunca se usa el cierre del mercado como kickoff.

El horario guardado es una programación, no el inicio real confirmado.
El estado actual sustituye al anterior en la tabla de partidos: un estado
final consultado al día siguiente no prueba cuándo empezó el partido.
Por ello puede haber mucha fase desconocida, en especial en el pasado.
No se reconstruye con información posterior. Las alertas congelan la fase y
versión usadas; el ranking retrospectivo puede variar si se corrige el horario.

Los contadores de cobertura muestran ejecuciones, entradas, repeticiones,
fase/identidad desconocida y tipo no compatible. Pueden solaparse. Pendientes,
errores de liquidación, anulaciones/escalares no soportados, precios inválidos
y datos incompletos **no se convierten en pérdidas ni en ceros**.
Las comisiones faltantes dejan el neto desconocido para toda la comparación,
sin seleccionar solo el subconjunto con costes conocidos.

## Alertas y evidencia hacia delante

- Telegram: mantener ROI ≥ +15%, la base bruto/neto elegida y al menos 50
  partidos verificados y 30 entradas. La muestra ahora usa primeras entradas
  del mismo patrón, banda y fase; excluye el propio partido candidato.
- No se amplía al deporte completo, al lado opuesto o a otra fase para
  conseguir que una alerta califique. Una fase desconocida no genera aviso.
- Explorador y colores usan la misma selección y separación de fases.
- Las reglas nuevas se versionan. Reintentos/evidencia anteriores conservan
  su versión y valores originales; no se reescriben rendimientos antiguos.
- Histórico seleccionado, resultado posterior de avisos y ejecución simulada
  con profundidad/demora son tres resultados distintos, no combinables.
- La prueba sin dinero existente conserva su protocolo. Un protocolo activo
  de versión distinta no acepta silenciosamente la nueva regla: sus nuevos
  candidatos se excluyen por `protocol_version_changed`. Para evaluar la
  regla nueva hay que cerrar/revisar esa cohorte y activar otra explícitamente
  mediante los controles existentes. No se inicia aquí ninguna.

El detalle de fila enseña periodo, concentración por partido, ROI sin el mejor
partido, un intervalo descriptivo bruto aproximado agrupado por partido
(mínimo 10 partidos) y una separación cronológica 70/30 sin compartir partidos.
El intervalo no ajusta las comparaciones múltiples ni selección a posteriori.
El tramo posterior tampoco es un holdout independiente si se eligió el patrón
mirando todo el historial. Ni 50 partidos ni un intervalo positivo garantizan
una ventaja futura.

## Conciliación con los archivos aportados

La auditoría externa declara 1,038,092 IDs únicos, 65,282 coincidencias
económicas y 85 patrones con al menos 50 partidos. No se importan sus
porcentajes como si fueran liquidaciones oficiales verificadas.

| Diferencia | Auditoría aportada | Cálculo de la aplicación |
|---|---|---|
| Resultado | Inferido del marcador deportivo | Liquidación oficial exacta del mercado |
| Identidad | Evento deducido del ticker | Milestone; identidad ambigua fuera del principal |
| Duplicados | Excluye coincidencias económicas | Conserva IDs distintos; primera entrada por patrón |
| Inicio | Comparación con horario | Horario explícito; live requiere observación contemporánea |
| Historia | Universo del archivo | Solo lo guardado y auditado completamente, con corte visible |
| Comisiones | Supuesto estándar | Reglas/overrides conocidos; neto desconocido si faltan |
| Validación | División 70/30 retrospectiva | Descriptiva y separada de la prueba prospectiva existente |

Los CSV son resúmenes: no contienen las ejecuciones seleccionadas con sus IDs,
identidades oficiales y liquidaciones para reproducir fila por fila. Por eso
no afirmamos haber replicado sus ROI ni que sus tres p-valores nominales
demuestren ventaja (el propio informe dice que no sobreviven ajuste múltiple).
El JSON/CSV completo exportado incorpora ahora resultado oficial, terminal,
fecha/error de liquidación e identidad/contexto guardados. Un export anterior
sin esos campos no basta para comprobar un mercado solo con el score.
Los campos de enriquecimiento son el estado guardado al descargar, no una
captura histórica inmutable del instante en que ocurrió la operación.

## Cómo reproducir y comprobar

```
pnpm --filter @workspace/api-server test:roi-method
pnpm --filter @workspace/api-server test:roi-db
pnpm --filter @workspace/api-server test:roi-costs
pnpm --filter @workspace/api-server test:signals
pnpm --filter @workspace/api-server test:paper
pnpm --filter @workspace/api-server audit:roi-method
```

El último comando exige trabajadores de desarrollo deshabilitados, usa una
transacción de solo lectura/repeatable-read y un límite de consulta de 30 s.
Emite JSON con totales por método/fase, todos los patrones calculados y hasta
25 primeras selecciones por fase con ID, precio y resultado, sin enviar
Telegram ni escribir resultados en la base. No incorpora todo el millón de
filas al proceso: consulta agregados. El botón del ranking descarga parámetros,
método y cálculos de la **página visible**, no todo el historial.

Comprobación del 18-11-2026 en desarrollo: 797 ejecuciones guardadas,
354 agregados; 91 primeras entradas prepartido, de las cuales ninguna tenía
todavía todos los requisitos de liquidación/auditoría para ROI verificado.
La consulta duró 32 ms en esa base pequeña: **no es una medición de producción**.
No se presentan números de rentabilidad con una muestra verificada vacía.
La lectura de producción no estuvo disponible por falta de sesión autorizada;
no se confirmó su cobertura ni una cohorte activa en ese entorno.

## Fuentes oficiales revisadas

- https://docs.kalshi.com/getting_started/market_settlement
- https://www.kalshi.com/fee-schedule

Una liquidación binaria ganadora paga $1 por contrato. La aplicación de tarifas
actuales a operaciones antiguas es un escenario estimado, no una afirmación de
las tarifas que realmente se pagaron entonces.
