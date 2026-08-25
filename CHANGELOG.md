# Changelog

Todas las novedades relevantes de DevBar. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es/1.1.0/) y versionado semántico.

## [Unreleased]

### Añadido

- **Actualizaciones automáticas de verdad.** Cuando DevBar detecta una versión
  nueva ya no te manda a la página de la release: se descarga el `.zip` en
  segundo plano, lo descomprime y lo deja preparado. Solo entonces avisa, y el
  aviso pide una única cosa: **reiniciar**. Al aceptar, DevBar se cierra, se
  sustituye a sí misma y se vuelve a abrir sola. Se acabó montar el DMG y
  arrastrar a Aplicaciones.
- Si la copia falla a medias, la versión anterior se restaura y se vuelve a
  abrir: nunca te quedas sin app.
- El menú de la barra y el panel de configuración distinguen entre «hay una
  actualización» y «ya está descargada, lista para instalar».

### Cambiado

- **El panel lateral de la ventana de logs distingue de un vistazo los grupos
  de su contenido.** Antes el nombre del grupo era un texto gris pequeño
  perdido en la misma columna que los servicios. Ahora cada grupo es una
  **banda** a todo el ancho, con su nombre en claro, que además queda **fija
  arriba** mientras recorres su lista: con diez servicios abiertos siempre
  sabes de quién son los logs que estás mirando.
- Los servicios de un grupo cuelgan de un **raíl vertical** que los agrupa
  visualmente, en lugar de compartir columna con la cabecera.
- Cada cabecera de grupo lleva el **número de servicios** que contiene y un
  **punto con el peor estado** de su interior. Un grupo plegado ya no puede
  esconder un servicio caído.

- **Las notificaciones ahora son las nativas de macOS**, no el banner propio.
  El banner sólo aparece como reserva cuando el sistema las rechaza (por
  ejemplo, ejecutando en desarrollo sin empaquetar). Como contrapartida, las
  notificaciones nativas respetan el modo **No molestar**; el banner no lo
  hacía.
- La app se firma **ad-hoc** al empaquetarla, con el identificador de firma
  igual al `CFBundleIdentifier`. Sin esto macOS rechazaba toda notificación
  nativa con `UNErrorDomain 1`. No requiere cuenta de desarrollador de Apple ni
  certificado: `codesign --sign -` es gratis.

### Corregido

- **DevBar no se cerraba** al pedirle que se actualizara —ni al pulsar
  «Salir»— si la ventana de **configuración** estaba abierta. Esa ventana veta
  su propio cierre para preguntar por cambios sin guardar, y ese veto abortaba
  en silencio el apagado entero. Ahora el veto se levanta en cuanto la decisión
  de salir ya está tomada. Contrapartida: al salir —o al instalar una
  actualización— los cambios de configuración sin guardar se descartan sin
  preguntar.
- **El menú de la barra crecía solo al escribir en el buscador de ramas.** Al
  calcular el alto necesario para el desplegable se tomaba como suelo el alto
  actual de la ventana, de modo que sólo podía crecer; como el proceso
  principal añade unos píxeles de margen, cada pulsación lo inflaba un poco
  más y no volvía a encogerse mientras el desplegable siguiera abierto sin
  resultados. Ahora el suelo es la altura real del contenido, así que el menú
  se ajusta al desplegable y vuelve a su tamaño en cuanto deja de haber
  coincidencias.

## [0.6.0] - 2026-08-21

### Añadido

- Cuando hay una **actualización disponible**, un pequeño **punto rojo** marca
  el chip de versión, tanto en el menú de la barra como en el panel de
  configuración, y el propio **icono de la barra de menús** lleva el mismo
  punto. Es el aviso discreto que usan los juegos para señalar que hay algo
  nuevo en una sección: no interrumpe, pero se ve. El tooltip del chip indica
  qué versión está disponible.
- El punto desaparece solo en cuanto se instala la actualización o deja de
  haber una versión más nueva.

## [0.5.0] - 2026-08-21

### Añadido

- La ventana de **logs** pasa a ser un visor único con **panel lateral**: todos
  los comandos y acciones aparecen agrupados por grupo, y cada grupo se pliega y
  despliega (el estado se recuerda entre sesiones). Un buscador filtra la lista
  por nombre.
- Cada entrada del panel muestra de un vistazo su estado: punto de color,
  número de **warnings** y **errores**, y el **tiempo** que lleva en ejecución o
  lo que duró la última.
- Botón de **arrancar / parar** tanto en la barra superior del log como en cada
  fila del panel lateral, sin tener que volver a la barra de menú.
- Botón **⧉** para abrir el log actual en una **ventana aparte**, de modo que se
  pueden vigilar varios servicios a la vez mientras la ventana principal sigue
  navegando entre logs.
- Botón **◧** que **oculta el panel lateral por completo** para dejar todo el
  ancho al log. La preferencia se recuerda entre sesiones.
- El panel se actualiza **en tiempo real**: los grupos, comandos y acciones que
  se añaden, renombran o borran desde la configuración aparecen y desaparecen
  al instante, sin reabrir la ventana.
- **Selección de líneas** en el log, con el comportamiento habitual del
  explorador de archivos: clic selecciona una, `cmd`/`ctrl`+clic añade o quita
  sueltas y `mayús`+clic marca un rango. `cmd`/`ctrl`+`A` selecciona todo lo
  visible y `Esc` limpia la selección.
- **Copiar** (botón o `cmd`/`ctrl`+`C`) copia lo seleccionado; si no hay nada
  seleccionado, copia todas las líneas visibles con el filtro aplicado.
  Seleccionar texto arrastrando con el ratón sigue funcionando igual.

### Cambiado

- Abrir un log desde la barra de menú reutiliza la ventana compartida en lugar
  de abrir una ventana nueva por servicio.
- La barra superior del visor es más compacta: limpiar, copiar, silenciados y
  abrir en ventana pasan a ser botones de icono.
- El hueco superior de la ventana se reduce a lo justo para despejar los
  botones de la barra de título, de modo que el contenido empieza más arriba.

## [0.4.4] - 2026-08-10

### Cambiado

- Todo el código JavaScript mantenido en el repositorio se ha migrado a **TypeScript estricto**: proceso principal de Electron, preload, renderer, scripts de soporte/release, tests y configuración ejecutable. El JavaScript de runtime pasa a ser únicamente salida generada de `build/`.
- El renderer usa módulos ES explícitos y comparte un único contrato tipado de IPC con main/preload; el preload se empaqueta de forma autocontenida en CommonJS para mantener el aislamiento de Electron.
- CI incorpora type-check de los cuatro targets y rechaza de forma permanente cualquier nuevo `.js`, `.jsx`, `.mjs` o `.cjs` authored.

### Seguridad

- Los argumentos IPC procedentes del renderer se tratan como datos no confiables (`unknown`) y se validan antes de entrar en la lógica de dominio, evitando que los tipos de Electron propaguen `any` implícito a través de la frontera de confianza.

## [0.4.3] - 2026-08-08

### Corregido

- La automatización de **QA requerida para actualizaciones mayores de Dependabot** ya no falla cuando la rama está lista para fusionarse ni intenta elevar permisos para reescribir workflows. Las aprobaciones siguen ligadas al commit exacto y las fusiones automatizadas usan la identidad de confianza para conservar los eventos posteriores de GitHub Actions.

## [0.4.2] - 2026-08-06

### Cambiado

- La **actualización asistida** ahora cierra DevBar automáticamente tras
  descargar el instalador. El modal de confirmación avisa de que la app se
  cerrará (macOS no permite sustituir la app mientras está abierta) y, después
  de abrir el `.dmg`, DevBar se cierra sola para que puedas **arrastrarla a
  Aplicaciones sin el error de "app en uso"**. Instalación más fácil y rápida.
- El icono de la **barra de menú** ya no es un círculo de color: ahora muestra la
  **marca de la app (`>|`) tintada** según el estado agregado (gris parado, verde
  en marcha, amarillo aviso, rojo error). Se dibuja en tiempo de ejecución desde
  la geometría de `assets/icon.svg`, con anti-aliasing y un **contorno de
  contraste que se adapta al tema** (oscuro en barra clara, claro en barra
  oscura) para que se distinga sobre cualquier fondo, incluidos fondos de
  pantalla claros.

### Corregido

- El **icono de la app** (`icon.icns` / `icon.png`) no tenía canal alfa: el fondo
  blanco rellenaba todo el cuadrado y macOS mostraba **esquinas cuadradas** en el
  Dock y el Finder. Se regeneró con esquinas transparentes (rejilla Big Sur) a
  partir del nuevo `assets/icon.svg`.

## [0.4.1]

### Corregido

- El selector de rama ya no **empequeñece la barra** al abrir el desplegable.
  Antes, un desplegable corto anclado arriba (pocas ramas en el primer grupo)
  recortaba la barra a la altura del propio desplegable y ocultaba el resto de
  grupos. Ahora la barra solo crece para acomodar el desplegable y recupera su
  altura natural al cerrarlo; además, si llega un refresco de estado con el
  desplegable abierto, se pospone hasta cerrarlo para no dejar la lista
  huérfana.

## [0.4.0]

### Añadido

- **Menú de configuración con barra lateral.** La configuración pasa de una
  única página larga a una barra lateral contraíble con secciones —
  **General**, **Notificaciones**, **Grupos**, **Logs**, **Copias de
  seguridad** y **Acerca de**— al estilo de Ajustes del sistema de macOS:
  iconos con color,
  fila activa resaltada y estado recordado entre sesiones.
- **Changelog integrado.** Un nuevo apartado muestra las últimas versiones
  publicadas en GitHub (aunque no estén instaladas), cada una en un panel
  colapsable con sus notas renderizadas; solo la más reciente se abre por
  defecto. Cada versión incluye un botón para abrir esa release y hay un acceso
  directo al repositorio. Se abre desde el chip de versión de la barra lateral
  o desde el icono de la barra de menú.
- **Notificaciones accionables.** Los avisos pueden incluir un botón de acción;
  el de «actualización disponible» abre directamente el apartado _Acerca de_.
- **Logs de acciones y pre-scripts revisables tras ejecutarse.** El registro de
  cada acción (manual o programada) y del pipeline de pre-scripts se conserva y
  puede consultarse desde la barra, no solo durante la ejecución.
- **Componente de modal unificado** con cierre honesto (botón ×, Esc y clic
  fuera) y botones de acción opcionales al pie, compartido por todos los
  diálogos internos.
- **Icono de la barra de menú adaptativo.** La bolita de estado se dibuja con un
  anillo de contraste que cambia según la apariencia clara/oscura del sistema,
  para que se vea sobre cualquier fondo de la barra.
- **Explorador de Logs.** Nueva sección _Logs_ que lista todos los registros
  capturados desde que arrancó la app, agrupados por grupo y por tipo (comandos,
  acciones, pre-scripts y pipeline); cada uno se abre en el visor de logs. Con
  hora de última actualización, botón de refrescar y auto-actualización opcional
  (cada 5/10/30 s).

### Cambiado

- **Interfaz más minimalista.** Los botones de _Configuración_ y _Salir_ de la
  barra pasan a iconos con descripción emergente (tooltip). Rediseño de todos
  los botones con acabado tipo macOS (profundidad y estados de interacción).

### Corregido

- Las notificaciones aparecen en la **pantalla activa** (donde está la ventana
  enfocada o el cursor) en lugar de siempre en la pantalla principal, evitando
  además que la ventana de configuración quedara «perdida» en otro espacio con
  configuraciones de varias pantallas.
- El selector de rama en la barra ya no colapsa el grupo al interactuar con él.
- Guardar un grupo sigue siempre el mismo flujo de validación (el path vacío se
  bloquea de forma consistente, también desde el diálogo de cambios sin
  guardar).
- El modal de changelog ahora permite hacer scroll con mucho contenido y
  muestra bien los paneles al mezclar versiones abiertas y colapsadas.
- El botón «Limpiar» del visor de logs ahora borra el buffer de verdad, no solo
  la vista: las líneas ya no reaparecen con la siguiente línea en vivo ni al
  reabrir la ventana.
- Las ventanas (visor de logs, configuración, silenciados) se abren en la
  **pantalla activa** y ya no hacen saltar de espacio, «pierden» la ventana de
  configuración ni **minimizan el resto de ventanas de una pantalla secundaria**
  en configuraciones con varias pantallas.
