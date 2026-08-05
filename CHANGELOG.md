# Changelog

Todas las novedades relevantes de DevBar. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es/1.1.0/) y versionado semántico.

## [0.4.0]

### Añadido

- **Menú de configuración con barra lateral.** La configuración pasa de una
  única página larga a una barra lateral contraíble con secciones —
  **General**, **Notificaciones**, **Grupos**, **Copias de seguridad** y
  **Acerca de**— al estilo de Ajustes del sistema de macOS: iconos con color,
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
