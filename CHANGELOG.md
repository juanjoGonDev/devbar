# Changelog

Todas las novedades relevantes de DevBar. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es/1.1.0/) y versionado semántico.

## [0.4.5] - 2026-08-20

### Corregido

- La automatización de release ahora cuenta únicamente commits que pueden cambiar la aplicación empaquetada o la lógica sustantiva de publicación. Actualizaciones mecánicas de GitHub Actions, tests, documentación y mantenimiento ya no acumulan por sí solas hacia el umbral de release automático.
- Las actualizaciones de dependencias y los cambios en código, renderer, assets, configuración de build o scripts de empaquetado continúan contando porque pueden modificar los instaladores macOS.

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
