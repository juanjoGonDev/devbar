# Changelog

Todas las novedades relevantes de DevBar. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es/1.1.0/) y versionado semántico.

## [0.9.6] - 2026-09-19

### Corregido

- **En Raspberry Pi, el icono anterior seguía viéndose detrás del nuevo.**
  El applet de la bandeja compone cada pixmap sobre el buffer anterior en
  lugar de reemplazarlo: los píxeles transparentes del icono nuevo dejaban
  ver todos los estados viejos (p. ej. al pulsar «quitar» tras forzar un
  conteo en el panel de desarrollo). En Linux, los cambios que pueden
  dejar ver el icono anterior crean ahora un elemento nuevo con superficie
  limpia y después destruyen el anterior — sin fondo opaco y sin tocar el
  icono en otras plataformas. Dos refinamientos para que el canje no se
  note: el elemento nuevo se registra antes de destruir el viejo (nunca
  hay un momento sin icono) y, cuando el icono nuevo cubre todo lo que
  había (badge que crece, cambio de color, tema), basta un empuje en
  sitio sin reconstruir nada.

- **En Ubuntu y otros escritorios GNOME, cada cambio de estado dejaba un
  icono fantasma nuevo en la bandeja.** El canje de icono que arregla la
  Raspberry Pi hace que el appindicator de GNOME pierda el registro del
  elemento viejo al recrearlo. Ahí (detectado por entorno de escritorio)
  el icono vuelve a empujarse en sitio, que es lo que esos paneles hacen
  bien; el canje queda para los paneles que lo necesitan.

### Añadido

- **Diálogo de reporte de fallo.** El botón de «Acerca de» abre ahora un
  diálogo que explica qué se va a copiar y da dos caminos: «Reportar bug
  en GitHub» (copia el informe y abre el formulario) o «📋 Copiar
  reporte» (solo lo copia, para pegarlo donde quieras). El diálogo no se
  cierra al actuar: el resultado queda en él, por si hay que volver a
  copiar o deshacer el paso.

- **El formulario de GitHub vuelve a pre-rellenarse en más casos.** El
  cuerpo solo cabía bajo un límite conservador de URL y con el log
  crecido la codificación de espacios y símbolos lo desbordaba (quedaba
  solo el título). Cuando se puede detectar el navegador por defecto
  (Firefox, Chrome/Chromium, Edge y otros modernos), el límite sube a lo
  que ese navegador tolera; sin detección se mantiene el prudente y en
  Windows el del sistema. Si no cabe, el informe íntegro sigue en el
  portapapeles.

## [0.9.5] - 2026-09-19

### Corregido

- **En Raspberry Pi, los estados del icono de la bandeja seguían
  solapándose.** Cada evento de estado volvía a empujar el icono al panel
  —aunque la imagen fuese idéntica a la anterior, porque la caché
  devolvía los mismos píxeles— y el applet pintaba encima del pixmap
  anterior en lugar de reemplazarlo. Ahora se salta todo empuje cuya
  imagen no ha cambiado y, en Linux, las ráfagas de cambios dentro de
  250 ms se colapsan en un único empuje con el estado final; macOS y
  Windows siguen empujando al instante.

- **El interruptor «Ejecutar automáticamente al arrancar» del pipeline
  decía «el Mac».** Ahora dice «el sistema», como el resto de la
  interfaz; el ajuste funciona igual en los tres sistemas. También se
  generaliza su explicación, que mencionaba «Login Item» (término solo
  de macOS).

### Añadido

- **Las muestras de recursos incluyen la memoria y la carga del sistema
  completo.** Cada línea registra la RAM libre/total de la máquina y la
  carga media de 1 minuto (`sys-mem=204.8MB/4096.0MB load1=3.90`), para
  distinguir un problema de DevBar de una Raspberry sin memoria libre.

## [0.9.4] - 2026-09-19

### Corregido

- **La fuente de emojis ya no «roba» símbolos de texto en Linux.** Noto
  Color Emoji también trae glifos como `▶` —el que abre cada línea de
  arranque de servicio— y, al estar al final de todas las pilas de
  fuentes, acababa repintando los logs monocromo con emojis grandes a
  color y volviéndolos ilegibles. Ahora la fuente declara un
  `unicode-range` con los bloques de emoji reales: flechas, símbolos de
  caja y todo lo que era texto vuelve a resolverse en la fuente de texto,
  igual que antes de incluirla.

- **El icono de apagar de la ventana de la bandeja volvía a no verse en
  Raspberry Pi OS.** `⏻` no es un emoji: ninguna fuente del sistema lo
  trae y Noto Color Emoji tampoco lo cubre, así que quedaba como un
  cuadro vacío mientras el resto sí se veía. Se cambia por `⏹` (cubierto
  en todos los sistemas, mismo estilo al pasar el ratón).

### Añadido

- **Botón «Reportar fallo en GitHub» en Acerca de.** Prepara un informe
  con la versión, el sistema (plataforma, arquitectura, OS, Electron y
  Node) y el final de `app.log`, lo copia completo al portapapeles y abre
  el formulario de issues de GitHub con el título y el cuerpo ya
  rellenos; si el cuerpo no cabe en la URL, basta con pegar (el informe
  íntegro sigue en el portapapeles). Antes de salir, el log se limpia de
  credenciales: tokens, claves, cadenas de conexión con contraseña, claves
  privadas y tu ruta de usuario. El `app.log` de tu equipo se queda
  completo; lo que se recorta es solo lo que sale hacia fuera.

- **Muestreo de CPU y RAM en el log de la app.** Cada apertura de ventana
  y una línea periódica registran CPU, RSS/heap y número de procesos de
  Chromium (`[resources] cpu=12.3% rss=180.2MB … (window-open)`), para
  que un «se disparan los ventiladores al abrir el menú» llegue con
  números y no a base de anécdotas.

### Cambiado

- **El selector de emojis se pinta por bloques.** Hasta ahora abría
  construyendo de golpe todos los botones de la categoría activa (hasta
  ~1900 nodos con su escucha cada uno): en una Raspberry Pi eso disparaba
  la CPU —y los ventiladores— al abrirlo. Ahora pinta los primeros 96 al
  instante y el resto va llegando en segundo plano; escribir en el
  buscador o cerrar el selector cancela el trabajo pendiente.

## [0.9.3] - 2026-09-19

### Corregido

- **En Linux, `install-local` fallaba en Raspberry Pi (y en cualquier host
  que no sea x64).** El build de empaquetado terminaba bien pero la
  instalación buscaba el ejecutable en `linux-unpacked`, cuando
  electron-builder escribe `linux-arm64-unpacked` en un host arm64 (y solo
  deja el nombre sin sufijo en x64). Ahora el directorio se deduce de la
  arquitectura del host con el mismo criterio que el empaquetador, así que
  `pnpm install-local` vuelve a funcionar en la Pi.

- **En Raspberry Pi OS no se veía ningún emoji** (iconos de grupos, rejilla
  del selector, glifos de la propia interfaz): el sistema no trae ninguna
  fuente de emoji a color y todo se pintaba como cuadros vacíos. La app
  ahora lleva incorporada Noto Color Emoji (SIL OFL) y la sirve como
  última opción de cada pila de fuentes, así que solo se usa donde no hay
  ninguna fuente nativa que cubra el glifo. El archivo viaja únicamente en
  los artefactos de Linux (macOS y Windows tienen fuentes propias).

- **En Linux, la notificación emergente se veía como una caja negra.** Las
  sesiones sin compositor (Raspberry Pi OS entre ellas) no pueden pintar
  ventanas transparentes: el banner ahora es opaco y ocupa la ventana
  completa en Linux; macOS y Windows conservan el banner flotante con
  esquinas redondeadas.

- **En Linux, los estados del icono de la bandeja se solapaban.** Varios
  paneles componen los dos pixmaps multi-escala que se les enviaban en
  lugar de elegir uno, y cada cambio de estado estampaba el icono nuevo
  sobre el anterior. Ahora Linux recibe un único pixmap de 32 px que el
  panel reduce; macOS y Windows mantienen el par 18 px + 2x.

- **Los logs de servicio ya no muestran los avisos de job control de
  bash.** Cada comando lanzado con el shell interactivo (`-ic`, el que
  carga tus rc y tu PATH) imprimía «bash: cannot set terminal process
  group (-1)…» y «bash: no job control in this shell» antes de la salida
  real; eran ruido del propio shell (el comando se ejecutaba bien) y ahora
  se filtran, igual que ya se hacía con su equivalente de zsh.

## [0.9.2] - 2026-09-18

### Añadido

- **En Windows y Linux, el icono de la bandeja muestra el número de errores** (o de avisos, si no hay errores) como insignia dibujada sobre el icono —en macOS ya aparecía como texto al lado del icono, y los títulos de bandeja no se renderizan en los otros dos sistemas—, con tope en «99+».
- **El panel Dev de Configuración puede forzar el contador de la bandeja.** Los botones «Errores: 5 / 14 / 99+» (y «Sin contador») prueban la insignia de la bandeja sin provocar errores reales; en macOS se muestra como texto junto al icono, igual que el real.

- **En Linux, el panel se abre junto al icono de la bandeja (como en
  macOS)** cuando la sesión informa la posición real del icono (X11):
  bajo una barra superior cuelga del icono centrado en él, y se adapta
  para no salirse de la pantalla. En sesiones Wayland el compositor
  decide la colocación (Electron no puede forzarla), así que se mantiene
  el comportamiento habitual de menubar.
- **El lanzador de la instalación local incluye icono.** Si
  electron-builder no incluyó uno en la copia empaquetada, `install-local`
  copia el del proyecto dentro de la instalación y la entrada del menú
  de aplicaciones (Linux) / Menú Inicio (Windows) lo referencia.

- **Tras `install-local`, la app aparece en el menú del sistema.** En Linux la instalación registra su entrada en el menú de aplicaciones (`~/.local/share/applications/devbar.desktop`, con icono) y en Windows crea su acceso directo en el Menú Inicio; antes la copia local funcionaba pero era invisible desde el lanzador, a diferencia de los instaladores oficiales.

- **Windows, Linux y Raspberry Pi.** DevBar ya no es solo de macOS: el mismo
  runtime funciona en los tres sistemas, cada uno con su empaquetado —
  **instalador de un clic y portable** en Windows (x64 y arm64), **AppImage y
  .deb** en Linux (x64, arm64 y armv7 para Raspberry Pi 4/5) y el DMG de
  siempre en macOS. En la release aparecen los 14 artefactos de las tres
  plataformas, cada uno con su suma SHA-256.
- **Actualización automática en los tres SO.** El auto-actualizador de la
  0.7.0 ahora cubre Windows (instalado: reinstalación silenciosa; portable:
  sustituye el propio ejecutable en su sitio) y Linux (AppImage in-place con
  rollback; .deb con reinstalación asistida). En Windows y Linux cada descarga
  se verifica contra SHA-256 antes de instalarse. En Windows portable y
  Linux AppImage, si la copia falla a medias la versión anterior se
  restaura y se relanza.
- **Arranque con el sistema en los tres SO.** «Iniciar al arrancar el sistema»
  funciona en Windows (clave Run de usuario) y en Linux (entrada XDG
  `~/.config/autostart/devbar.desktop`), además del login item de macOS. En
  Windows y Linux la app distingue un arranque de inicio de uno manual, de
  modo que el comportamiento programado al arrancar (pre-scripts) es el mismo
  en las tres plataformas.
- **CI que construye, verifica y lanza cada build en los tres SO.** Cada
  cambio compila los tres empaquetados, comprueba el contenido (cabecera PE en
  Windows, magic y escritorio del AppImage en Linux, checks habituales en
  macOS) y arranca el binario empaquetado en modo smoke —tray real, sin
  ventanas ni comandos— antes de dejar la verificación en verde. La validación
  de release añade dry-runs de Windows y Linux al de macOS.

### Cambiado

- **La interfaz se adapta al SO en marcha.** Los textos de la app (avisos de
  actualización, instrucciones de instalación, atajos) ya no asumen macOS: en
  Windows y Linux describen y enlazan a los lugares de tu sistema, no de otro.
- **Los comandos de desarrollo mantienen su nombre y funcionan en cualquier
  SO.** `pack`, `dist`, `verify`, `dist:mac`, `release:verify`,
  `install-local` y `install-local:dev` son los mismos de siempre: un
  enrutador los interpreta según el SO (el pipeline original en macOS,
  electron-builder en Windows y Linux) y la compilación de desarrollo corre en
  Node, de modo que `pnpm start` ya no necesita bash en Windows.
- **`install-local` mata la instancia anterior antes de reinstalar.** Antes
  podía dejar corriendo el proceso viejo y quedarse con dos instancias —justo
  donde una actualización automática a medio resolver se complica más—. Ahora
  detiene la copia instalada y la de desarrollo, instala y relanza; el ciclo
  completo se prueba en CI tanto con una instancia corriendo como simulando
  una actualización automática.
- **En Windows y Linux, la insignia de errores del icono de la bandeja es
  más grande y más gruesa** para que se lea de un vistazo (burbuja redonda
  con el número en blanco sobre el icono). El número también aparece en el
  tooltip del icono («DevBar — 14 errores»); que el número se dibuje _junto_
  al icono, como en macOS, no es posible en estos sistemas porque el área de
  la bandeja es un cuadrado de tamaño fijo impuesto por el sistema
  operativo.

### Corregido

- **En Windows, `install-local` no detuvo la instancia de desarrollo** (un `pnpm start` de este checkout): el patrón que buscaba electron.exe le doblaba los backslashes y nunca coincidía con la línea de comandos real, así que podía quedar corriendo la copia vieja. Ahora el kill encuentra el proceso y lo detiene.

- **En la bandeja, los grupos que no usan git seguían mostrando el selector de ramas** —sin ruta aparecía un «Rama…» y con una ruta que no es un repositorio el selector se quedaba para siempre en «Cargando…». Ahora el selector solo se muestra en proyectos que son repositorios git de verdad: la app recuerda la decisión de «no es un repositorio» (de modo que no relanza git a cada refresco del panel) y el selector vuelve a aparecer si el grupo apunta luego a un repositorio.

- **En Linux, los logs y el staging de actualizaciones se escribían en una
  carpeta con el nombre del paquete (`~/.config/devbar/…`) mientras la
  configuración vivía en `~/.config/DevBar`.** Electron fija la carpeta XDG
  desde el nombre del paquete al arrancar, antes de que la app pueda
  renombrarse, así que los datos quedaban repartidos en dos sitios y
  `pnpm logs` no encontraba el log. Ahora configuración, logs y
  actualizaciones comparten la carpeta «DevBar» en los tres SO.
- **Los contadores ⚠ y ✕ del panel de la bandeja abrían una búsqueda con
  regex** en lugar del filtro por nivel. Ahora abren el pill «sólo ⚠ warnings»
  / «sólo ⛔ errores» de la ventana de logs —el mismo mecanismo, visible y
  quitable con su ✕, que usan el panel lateral y los totales de alerta.
- **Un grupo guardado en Configuración seguía marcado con cambios sin
  guardar.** El botón Guardar quedaba activo, la barra de «cambios sin guardar»
  se negaba a irse y al cambiar de grupo o cerrar la ventana volvía a saltar el
  aviso. La comparación se hacía contra una forma normalizada que el borrador
  nunca tiene, así que nunca coincidía; ahora se compara contra el estado real
  del borrador.
- **Los argumentos estructurados conservan los signos de porcentaje en
  Windows**, sin que `cmd.exe` expanda por accidente valores como `%TEMP%`.
  La migración de la configuración heredada en Linux tampoco puede sobrescribir
  un archivo nuevo creado al mismo tiempo por otra instancia.
- **Los comandos que DevBar ejecuta ya no se quedan huérfanos cuando la app
  se cierra.** Antes, al salir (o en la swap de la actualización
  automática) solo se detenía el primer servicio y el resto seguía vivo
  ocupando su puerto —el siguiente arranque fallaba con «dirección ya en
  uso»—. Ahora TODAS las salidas (menú «Salir», `app:quit`, swap de
  actualización) esperan a que termine de pararse cada servicio (escalando
  a fuerza si hace falta) antes de morir, y Ctrl+C en el terminal de
  `pnpm start` o `kill <pid>` limpian igual. En Windows, además, los
  servicios heredan la consola del terminal (antes no la recibían y un
  Ctrl+C los dejaba vivos), y `install-local` mata el árbol completo de la
  instancia en los tres sistemas (antes dejaba los servicios corriendo).
  Las únicas vías que aún pueden dejar un huérfano son un kill duro
  (SIGKILL / `taskkill` sin /T), que no permite ejecutar ninguna limpieza,
  y un servicio que se desprende de su propio grupo de procesos
  (por ejemplo con `setsid`, doble fork o reasignación de proceso
  padre): el cierre trabaja por grupos, así que un descendiente que se
  salga del grupo escapa tanto al kill como al cierre de DevBar.
- **En Windows y Linux, el panel de la bandeja ya no aparece en la barra de
  tareas.** Al abrirlo desde el icono, la barra de tareas solo muestra
  Configuración y/o Logs cuando esas ventanas están abiertas; el panel es
  siempre sin marco y no genera botón.
- **En 32-bit ARM (p. ej. Raspberry Pi), la actualización ya encuentra su
  instalador.** Node informa la arquitectura como `arm`, pero los artefactos
  se llaman `linux-armv7.*`: el chequeo no proponía ninguna actualización
  en sitio.
- **La insignia de la bandeja ya no puede mostrar «99+» con exactamente 99
  errores** (colisión de caché entre las etiquetas «99» y «99+»).
- **En macOS, la actualización se aborta si no se puede descargar
  SHA256SUMS.txt**, igual que en Windows y Linux (antes seguía instalando
  sin verificación).
- **En la ventana de Configuración, elegir tema ya no puede sobrescribir
  autostart/notificaciones** si se hace antes de que terminen de cargar los
  ajustes, y ahora solo guarda el campo del tema.
- **El historial de releases de GitHub mostraba como máximo 5 releases**
  aunque se pidiera más.

- **Algunas ventanas se quedaban con datos viejos hasta que algo sin relación
  las refrescaba.** Al abrirse, cada ventana pide su estado al proceso
  principal; si mientras tanto llegaba un cambio —arrancar un servicio,
  renombrar un grupo, borrar otro—, la respuesta tardía pisaba lo recién
  llegado y la pantalla se quedaba atrás sin ninguna señal. Pasaba en la lista
  de grupos de la bandeja, en el listado lateral de la ventana de logs, en la
  lista de grupos de Configuración, en los pasos del pipeline y en la ventana
  de patrones silenciados. Ahora manda siempre el valor más reciente.

- **Guardar un grupo dos veces seguidas podía dejar el nombre anterior en la
  lista.** El botón «Guardar» solo se desactiva cuando no queda nada por
  guardar, nunca mientras guarda, así que dos guardados rápidos se solapaban y
  se veía el que respondía el último, no el más nuevo.

- **El aviso de actualización disponible podía apagarse solo.** El punto rojo
  junto al número de versión —en la bandeja y en Configuración— desaparecía si
  la comprobación automática encontraba la actualización justo mientras la
  ventana estaba leyendo el estado al abrirse, y no volvía hasta la siguiente
  comprobación.

- **El interruptor «Ejecutar automáticamente al arrancar el Mac» podía quedar
  marcado al revés de lo guardado.** Si fallaba el guardado de un clic
  anterior, la casilla se revertía por encima del clic siguiente, que sí se
  había guardado.

- **Al actualizar desde una versión antigua se perdía la lista de servicios.**
  La conversión al formato de grupos guarda antes una copia de seguridad de
  los servicios originales, y solo la escribe si no había una ya. El almacén
  creaba esa copia vacía por su cuenta al arrancar, antes de la conversión, de
  modo que esta creía que el respaldo ya existía y no lo hacía: la única copia
  de los servicios originales desaparecía.

- **En Windows, una actualización podía descargar el paquete de Linux.** Si la
  release no traía instalador de Windows, el aviso ofrecía el `.deb` y lo
  dejaba en Descargas pidiendo instalarlo a mano. Ahora, sin instalador para
  tu sistema, se abre la página de la release.

- **En el selector de rama, Enter cambiaba a una rama distinta de la
  resaltada.** La lista sube arriba la rama activa, pero el teclado contaba
  las posiciones sobre la lista sin reordenar: con cualquier rama checkouteada,
  bajar una posición y pulsar Enter hacía checkout de otra. Pasaba igual al
  elegir con el ratón.

- **El selector de rama solo mostraba la rama actual al abrirlo.** Filtraba por
  el texto de la caja, que el propio selector rellena con la rama activa, así
  que había que borrarlo a mano para ver las demás.

- **El selector de rama era invisible para un lector de pantalla.** No se
  anunciaba como lista desplegable ni decía qué opción estaba resaltada al
  moverse con las flechas.

- **Renombrar un grupo no se veía en una ventana de logs ya abierta.** El
  nombre y los iconos se quedaban como estaban hasta reabrirla.

- **La ventana de logs aparecía vacía si no había nada configurado**, en vez de
  decir que no hay grupos.

- **Guardar un grupo deshacía el rayo de arranque automático y devolvía
  comandos borrados.** Ambas acciones se aplican al momento, pero el formulario
  seguía trabajando con la lista anterior, así que al guardar la reescribía.

- **Reordenar grupos arrastrando enviaba el cambio varias veces.** Cada
  repintado de la lista añadía otro manejador, así que un solo arrastre
  disparaba tantas reordenaciones y recargas como veces se hubiera repintado.

- **No se podía cambiar de rama si había ficheros sin seguimiento.** Cualquier
  archivo que git no sigue —la carpeta de un editor, una nota suelta, la
  configuración de una herramienta— se contaba como trabajo sin guardar y
  bloqueaba el cambio, aunque git lo habría hecho sin tocarlos. Ahora solo
  frenan los cambios de verdad, los de ficheros con seguimiento.

- **Cambiar a una rama que nunca se subió avisaba de un error que no existía.**
  El cambio se hacía correctamente y después DevBar intentaba traer novedades
  de un remoto que esa rama no tiene, y presentaba ese fallo como si el cambio
  no se hubiera hecho. Una rama local no tiene nada que traer.

- **Si el cambio de rama fallaba, el selector se quedaba mostrando la rama
  equivocada** —la que habías elegido, no en la que seguías estando.

- **Los fallos de git no quedaban registrados en ninguna parte.** El aviso rojo
  desaparecía a los pocos segundos y no dejaba rastro, así que no había forma
  de saber después qué había pasado. Ahora el motivo completo se escribe en el
  log (`pnpm logs`), igual que los errores inesperados de las ventanas.

- **En un repositorio clonado, el selector de rama ofrecía una rama «origin»
  que no existe.** Es el puntero que `git clone` deja apuntando a la rama por
  defecto del remoto, y se colaba en la lista como si fuera una rama más.

- **«Nuevo acción» y «Acción guardado»** ahora concuerdan en femenino.

## [0.8.0] - 2026-09-10

### Añadido

- **Pipeline de pre-scripts global.** Los pasos de pre-scripts dejan de vivir
  dentro de cada grupo por separado: ahora hay **un único pipeline ordenado**,
  compartido por todos los grupos, con una nueva sección **«Pipeline»** en
  Configuración. Cada paso puede mezclar scripts de distintos grupos y
  ejecutarlos en paralelo o en serie; arrastra un script entre pasos para
  reordenar el arranque.
- El disparador **▶▶** de la barra pasa a ser **uno solo para todo el
  pipeline**, con su propio log agregado, indicador de progreso y botón de
  cancelar — ya no hay un disparador por grupo.
- Al arrancar sesión, los comandos de auto-arranque de cada grupo esperan,
  **por defecto, a que termine todo el pipeline** antes de arrancar: un paso
  posterior de OTRO grupo (por ejemplo, un segundo `make setup` que reinicia
  Docker) podía romper un grupo que ya había arrancado. Cada grupo tiene un
  nuevo interruptor **«Esperar a que termine todo el pipeline antes de
  arrancar»** en su configuración para liberarlo antes —en cuanto termina el
  último paso que usa alguno de sus scripts— si es realmente independiente
  del resto del pipeline.
- **Todas las listas reordenables ahora se pueden manejar con el teclado**:
  grupos, la biblioteca de pre-scripts de cada grupo, comandos, acciones, los
  pasos del pipeline y los scripts dentro de cada paso. Con el foco en el
  asa (**⋮⋮**), Espacio o Intro la agarra, las flechas la mueven —incluso
  entre pasos del pipeline—, y Espacio, Intro o Escape la suelta o cancela el
  movimiento.

### Cambiado

- **El interruptor «ejecutar automáticamente al arrancar el Mac» de los
  pre-scripts ahora es global**, no por grupo. Al actualizar, DevBar migra tu
  configuración anterior de forma conservadora: el ajuste global sólo queda
  **activado** si TODOS los grupos que aportaban pasos al pipeline lo tenían
  activado; si alguno lo tenía desactivado, el nuevo ajuste global queda
  **desactivado**. **Revisa este ajuste en la sección «Pipeline» después de
  actualizar** si dependías del auto-arranque de pre-scripts al iniciar
  sesión.
- **La actualización de la configuración no tiene vuelta atrás.** En cuanto
  abres DevBar 0.8.0, tu configuración se convierte al nuevo formato de forma
  automática. Hecho esto, ya no podrás abrirla con una versión anterior de
  DevBar (0.7.1 o anterior): esa versión antigua no sabe leer el formato
  nuevo. Si quieres conservar la posibilidad de volver atrás, haz una copia
  de seguridad desde **Configuración → Copias de seguridad** antes de
  actualizar.
- Si el pipeline falla o cancelas su confirmación a mitad de camino, los
  grupos cuyos pasos aún no habían llegado se **retienen** (no arrancan sus
  comandos de auto-arranque); se avisa con un log y una notificación
  nombrándolos.

## [0.7.1] - 2026-09-09

Solo cambios internos de mantenimiento (dependencias y proceso de
compilación/publicación); sin novedades de cara al usuario.

## [0.7.0] - 2026-08-26

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
- **El visor carga por tramos según te desplazas.** Las líneas se guardan en
  memoria y sólo unos cientos están dibujadas: al acercarte a un borde se
  extiende por ahí, arriba o abajo. Sin indicadores de carga y sin saltos —
  ya están en memoria, sólo se decide qué se pinta—, así que se recorre el
  historial completo como si fuera continuo. El filtro busca en **todo** lo
  retenido, no sólo en lo dibujado, y copiar sin selección copia el resultado
  entero del filtro.
- **Seleccionar líneas desengancha la vista de la cola.** Al elegir filas has
  dicho que no estás mirando el final, así que las nuevas se acumulan sin
  arrastrarte: la selección se queda quieta hasta que pulses ↓ o la limpies.
- Un servicio que arranca **después** de abrir una vista combinada ya aparece
  en ella. Antes el reenvío se decidía con una foto de identificadores tomada
  al abrir, así que un pre-script en su primera ejecución no existía para esa
  vista hasta reabrirla; ahora se decide por ámbito.

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
  El banner queda de reserva para cuando el sistema las rechaza (por ejemplo en
  desarrollo, sin empaquetar). Contrapartida: las nativas respetan el modo **No
  molestar**; el banner no lo hacía.
- La app se firma **ad-hoc** al empaquetarla, y cada bundle anidado con **su
  propio** identificador. Sin cuenta de desarrollador de Apple ni certificado:
  `codesign --sign -` es gratis. Es lo que exige `UNUserNotificationCenter`
  para entregar notificaciones, y de paso permite al instalador automático
  verificar el sello del bundle descargado antes de sustituir la app.
- En **Configuración → Notificaciones**, un enlace que abre **Ajustes del
  sistema directamente en la ficha de DevBar**. macOS pide permiso para
  notificar una sola vez por app, así que si se denegó no vuelve a preguntar y
  no hay pista de por qué no se ve nada: ese enlace es el atajo a la única
  pantalla donde se arregla.
- **Fuera el ajuste «Cerrar notificación tras N segundos».** Con notificaciones
  nativas esa duración la manda macOS, a través del estilo de notificación de
  la app en Ajustes del sistema: **Avisos** se cierran solos, **Alertas** se
  quedan hasta que las cierras. El ajuste sólo gobernaba ya el aviso de
  reserva, así que prometía más de lo que hacía.
- La app pasa a identificarse como **`io.github.juanjogondev.devbar`**. Antes
  usaba `com.electron.devbar`, el valor por defecto de packager — el espacio de
  nombres de Electron, no el nuestro. Tus ajustes se conservan: viven bajo el
  nombre de la app, no bajo el identificador. La primera vez que arranque,
  macOS pedirá permiso para mostrar notificaciones.

### Corregido

- **DevBar no se cerraba** al pedirle que se actualizara —ni al pulsar
  «Salir»— si la ventana de **configuración** estaba abierta. Esa ventana veta
  su propio cierre para preguntar por cambios sin guardar, y ese veto abortaba
  en silencio el apagado entero. Ahora el veto se levanta en cuanto la decisión
  de salir ya está tomada. Contrapartida: al salir —o al instalar una
  actualización— los cambios de configuración sin guardar se descartan sin
  preguntar.
- **La ventana de logs se congelaba** con un límite de líneas alto. Retención y
  renderizado eran la misma cifra, así que un ajuste de 20 000 líneas
  significaba 20 000 filas en el DOM.
- El botón **↓** llevaba al final de lo dibujado, no del log.
- **El límite de líneas no se aplicaba a las vistas combinadas** (grupo y
  telemetría general): usaban un tope fijo que ignoraba tu ajuste.
- Los contadores de warnings, errores y tiempo del panel lateral se partían en
  dos líneas al convertirse en botones.
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
