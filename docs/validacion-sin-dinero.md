# Validación de alertas sin dinero

## Qué mide y qué no

La sección **Señales → Validación sin dinero** mantiene tres comparaciones distintas:

1. **ROI retrospectivo:** $100 teóricos por operación histórica comparable.
2. **Evaluación anterior:** resultado posterior de los avisos al precio público original. No demuestra que ese precio se pudiera obtener.
3. **Nueva prueba:** entrada hipotética posterior a la confirmación de Telegram, consumiendo ofertas observadas, con presupuesto, precio límite, comisiones y capital ficticio.

Nada de esto envía órdenes ni conecta una cartera. No cambia los avisos actuales: mínimo +15%, 50 partidos y 30 operaciones verificadas, con la base bruto/neto elegida.

## Auditoría real del aviso de la captura

Consulta de solo lectura en producción, 17 de noviembre de 2026. Se identificó inequívocamente Wales vs Portugal: SÍ a $0,15, 9.750 contratos, $1.462,50.

| Etapa | Hora UTC | Tiempo desde la etapa anterior |
| --- | --- | --- |
| Operación en Kalshi | 21:00:56.184 | — |
| Primer guardado | 21:17:09.556 | 16 min 13,372 s |
| Encolado | 21:17:10.101 | 0,545 s |
| Decisión congelada | 21:30:02.844 | 12 min 52,743 s |
| Confirmación del envío | 21:30:03.579 | 0,735 s |

**Total: 29 min 7,395 s.** No hubo reintentos registrados para ese aviso. No se conservaban tiempos separados de recepción WebSocket, comienzo de la búsqueda ROI o comienzo del envío. Por eso no se atribuye la demora a Telegram, al cálculo o a la API sin más evidencia. La confirmación tampoco demuestra cuándo llegó o se leyó en el teléfono.

El registro original conserva 100 partidos, 379 operaciones, ROI bruto 61,4207582782% y neto estimado 52,4117936685%. Los $37.900 de compras hipotéticas implican algebraicamente $23.278,47 brutos y $2.240,25 de comisiones. No se conservó la lista exacta de las 379 ejecuciones que originó la instantánea: estas cifras **no son una conciliación fila a fila ni ganancias reales**.

El mercado Wales SÍ se resolvió NO: a ese precio público la entrada teórica posterior perdió $100 más $5,95 de comisión estimada. Un ROI histórico positivo no predijo ese resultado.

El panel también incluye tres avisos SÍ y tres NO auditados. Varios comparten partido; no constituyen seis observaciones independientes. Las muestras auditadas nunca se importan como evidencia prospectiva.

## Publicar y comenzar

1. Publicar los cambios en la aplicación existente. No seleccionar ninguna opción que reemplace datos de producción por datos de desarrollo.
2. Abrir la web publicada, entrar como dueño y elegir **Señales**.
3. Crear y revisar un borrador. Los borradores de desarrollo no se copian a producción.
4. Confirmar **Iniciar**. Guardar, visitar el panel o aplicar el esquema no inicia la prueba.
5. Revisar la fecha de cierre, el latido y los problemas de cobertura. **Detener** impide nuevas entradas pero conserva la evidencia y las liquidaciones posteriores. No se reanuda: otra prueba requiere otra cohorte.

Valores iniciales, modificables antes del inicio: compra de $100 antes de comisión, capital ficticio $10.000, máximo $110 por partido incluyendo comisión, 30 segundos tras la confirmación, límite de +1¢, primera alerta por partido, 28 días con 7 finales reservados, hasta 8 mercados observados simultáneamente. No son parámetros de rentabilidad demostrada.

La prueba principal queda identificada; 0/60 segundos y alertas repetidas son escenarios separados, no alternativas para escoger retrospectivamente el mejor resultado.

## Evidencia y ejecución

- Datos públicos de `orderbook_delta`: snapshot inicial, cambios y secuencias. Una desconexión, hueco, libro cruzado, cotización vieja o captura tardía invalida la entrada.
- Comprar SÍ consume las ofertas complementarias de los bids NO; comprar NO usa los bids SÍ.
- Cantidades enteras y redondeos de comisión por nivel. Es una hipótesis conservadora, no una afirmación de que Kalshi prohíba fracciones.
- Los escenarios no comparten capital entre sí; dentro de cada uno no se reutiliza ficticiamente la misma liquidez ni se inventa su reposición.
- Cada captura debe corresponder al instante previsto (tolerancia 1,5 s). Un reinicio no reconstruye libros pasados.
- Comisiones y evidencia se conservan como se conocían al decidir. Una corrección de liquidación añade historial sin reescribir la entrada.
- Identidad aproximada del partido, historial que incluye el mismo partido o un corte no comprobable impiden certificar una entrada fuera de muestra.

Se distinguen completa, parcial, sin ejecución con motivo y desconocida. Un fallo de datos no se convierte en falta de liquidez, pérdida o comisión cero.

## Interpretación

ROI neto = suma de beneficios netos / suma de compras y comisiones de entradas ejecutadas y liquidadas. Pendientes, pagos no binarios y costes desconocidos no producen una pérdida ficticia.

La ganancia por todas las alertas queda sin determinar mientras haya entradas o resultados desconocidos. El panel expone cobertura, capital comprometido, concentración por partido y resultado sin el mejor partido.

Los intervalos del 95% remuestrean partidos completos (800 remuestreos), no cada operación correlacionada. Se omiten con menos de 10 bloques; también se calcula sensibilidad por fechas. No son una regla para detener la prueba cuando un resultado provisional resulte favorable.

Los controles se fijan cronológicamente y sin reemplazo antes del resultado: mismo deporte, tipo, lado y banda; precio ±1¢, monto y profundidad hasta factor 2, inicio ±15 min y decisión ±5 min. Solo se comparan partidos por empezar con identidad inequívoca y fase reciente. Sin marcador ni reloj contemporáneos no se afirma comparabilidad de partidos en vivo. El control usa confirmación sintética de 1 s y se compara con avisos confirmados entre 0 y 2 s tras decidir.

Estos controles no son aleatorios. Los pares sin ambas entradas ejecutadas y liquidadas quedan fuera del diferencial y reducen explícitamente su cobertura. Un intervalo positivo o 50 partidos no demuestra rentabilidad.

El tramo final permanece oculto hasta la fecha fijada aunque se detenga la prueba; ningún partido se divide entre calibración y tramo final. La exportación también oculta resultados y balances de ese tramo.

## Límites operativos

El observador se ejecuta dentro de la instancia que ya posee el bloqueo del bot. En desarrollo los trabajadores permanecen deshabilitados. No hay otro workflow ni polling de Telegram.

Máximos: 20 mercados simultáneos configurables, 20 niveles guardados por lado, 10.000 candidatos por prueba, 256 trabajos en cola, 100 protocolos conservados. Alcanzar el límite de candidatos o de cola detiene la captación de esta prueba, no las alertas originales. Las oportunidades sin cotización dentro de esos límites permanecen desconocidas.

Los cálculos agregados se hacen fuera del envío y se leen desde un informe guardado; las filas se consultan por páginas y los archivos se exportan en lotes. CSV/JSON incluyen protocolo, decisiones, tiempos, cotizaciones, resultados y exclusiones, pero no credenciales ni identificadores de chat.

## Verificación reproducible

- `pnpm --filter @workspace/api-server test:paper`
- `pnpm --filter @workspace/api-server test:signals`
- `pnpm --filter @workspace/kalshi-sports-alerts test:signals`
- Typecheck de ambos paquetes; build frontend con las variables de su servicio.

Las pruebas de base de datos requieren trabajadores desactivados y usan tablas temporales aisladas. No inscriben señales reales, no envían mensajes ni órdenes.

El funcionamiento del captador publicado y la cobertura real deben observarse después de publicar y activar la prueba; no se sustituyen por los resultados de fixtures. Esta entrega construye la infraestructura, no semanas de resultados ni una conclusión de rentabilidad.

### Primera comprobación de producción

La [revisión de cobertura del 18 de noviembre de 2026](cobertura-primera-prueba.md)
no encontró las tablas de la prueba en producción. Por tanto, la evidencia era
insuficiente para certificar cobertura: faltaba una cohorte publicada e iniciada
voluntariamente por el dueño. Es un diagnóstico fechado, no una lectura del estado
actual ni una conclusión sobre rentabilidad.
