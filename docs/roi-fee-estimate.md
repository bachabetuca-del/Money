# ROI bruto y neto estimado

## Fuentes consultadas el 2 de noviembre de 2026

- [Tarifario oficial](https://kalshi.com/docs/kalshi-fee-schedule.pdf), identificado como efectivo el 7 de julio de 2026.
- [Lista vigente de tarifas y excepciones](https://kalshi.com/fee-schedule).
- [Redondeo de comisiones](https://docs.kalshi.com/getting_started/fee_rounding).
- [Metadatos de series](https://docs.kalshi.com/api-reference/market/get-series).
- [Cambios de tarifas por serie](https://docs.kalshi.com/api-reference/exchange/get-series-fee-changes).
- [Excepciones por evento](https://docs.kalshi.com/api-reference/events/get-event-fee-changes).

La fórmula taker publicada es `0,07 × M × C × P × (1 − P)`. La tarifa maker general es distinta (0,0175 con multiplicador aplicable); existen series sin maker fees, excepciones de multiplicador y combos con otra tarifa maker. No se deduce una tarifa solo por el deporte. Se consultan los metadatos públicos de serie y las excepciones de evento.

**Precisión:** el texto del tarifario y la documentación de redondeo especifican alineación a $0,0001 para miembros directos. Algunas tablas ilustrativas del PDF aún muestran centavos enteros; no se usa esa tabla antigua para sobrescribir la regla de precisión explícita. Los intermediados pueden tener alineación a $0,01 y sus propios cargos.

## Comparación conservada

El bruto conserva exactamente el método existente: $100 hipotéticos de notional por ejecución guardada válida, lado SÍ/NO al precio propio, resultado binario oficial y cobertura final verificada por defecto. Se conservan el número de operaciones, partidos estimados, aciertos y los grupos por deporte, mercado, lado, odds, importe observado y semana de ejecución.

El nuevo neto usa **esas mismas observaciones**, con:

1. Cantidad teórica `C = 100/P`, sin redondear a contratos negociables.
2. Una entrada taker hipotética independiente por observación, sin división de órdenes ni rebates de redondeo.
3. Comisión calculada por entrada y alineada hacia arriba a $0,0001. La entrada de $100 ya está alineada; el resultado equivale al modelo oficial de comisión a seis decimales y redondeo posterior del débito.
4. Mantenimiento hasta liquidación oficial, sin comisión de liquidación ni venta anticipada.
5. `ROI neto = (resultado bruto − comisiones) / (100 × operaciones + comisiones) × 100`.

Las comisiones se añaden al capital necesario; no reducen los contratos de la simulación bruta. Se cargan tanto en ganadoras como en perdedoras. No se incluyen deslizamiento, diferencial adicional frente al precio observado, costes de financiación, depósitos/retiros, impuestos ni tarifas de FCM. No representa beneficios reales ni identifica operaciones de apertura/cierre de un trader.

## Tarifas actuales, no reconstrucción histórica

La instantánea pública se renueva junto al catálogo deportivo en el runtime existente. Todas las páginas de excepciones se leen antes de guardar una instantánea atómica. Se aplica la última excepción de evento efectiva; los valores nulos vuelven a la regla de serie y el multiplicador cero se respeta. Las reglas futuras no se aplican anticipadamente: vencen la instantánea al entrar en vigor.

La instantánea vence como máximo a las 24 horas. No hay llamadas nuevas a Kalshi desde el ranking, el explorador ni el filtro de notificaciones. La ingesta no espera la consulta de tarifas. Los errores no sustituyen una instantánea por una lista vacía.

Se aplican tarifas actuales a precios/resultados históricos como escenario estimado. **No se afirma conocer la comisión que se cobró en la fecha original.** Series retiradas, eventos sin identidad confirmada, tipos `flat` no modelados, reglas desconocidas o tarifas caducadas dejan el neto no disponible. La interfaz muestra cuántas observaciones tienen tarifa. Si falta una sola, no se calcula un neto global con una submuestra distinta ni se elimina su bruto.

## Telegram

La elección `gross`/`net` se guarda expresamente en Ajustes. El valor inicial es `gross`, preservando el +7% bruto existente. Un cliente que omite la nueva propiedad no modifica la elección guardada. Ordenar la tabla por neto no cambia Telegram.

El umbral sigue siendo **≥ +7% antes del redondeo de presentación**, con 10 partidos y 30 operaciones de historial verificado en el mismo deporte, tipo, lado, odds y banda de importe. En modo neto se exige tarifa para toda la muestra; nunca se vuelve automáticamente al bruto. Las operaciones filtradas no se reenvían al cambiar la elección.

## Operación y comprobación

- La nueva columna de ajustes tiene valor predeterminado `gross`; la instantánea de tarifas es una tabla nueva, sin modificar el historial de operaciones.
- La sincronización del esquema se ejecuta al integrar los cambios mediante el script de post-merge. La publicación y cualquier migración de producción siguen requiriendo una acción explícita del propietario.
- El runtime y las acciones manuales de Telegram permanecen pausados en desarrollo. Puede no haber tarifas guardadas hasta la primera actualización del catálogo en el entorno activo; ese estado se muestra sin inventar netos.
- `pnpm --filter @workspace/api-server run test:roi-costs`: fórmulas, redondeos, excepciones, agregados, muestras y filtro de Telegram con dobles locales, sin mensajes reales.
- `pnpm --filter @workspace/api-server run test:roi-db`: consultas de lectura y fixtures CTE que no modifican las tablas.
- `pnpm --filter @workspace/kalshi-sports-alerts run test:roi`: representación, estados incompletos y elección explícita.
