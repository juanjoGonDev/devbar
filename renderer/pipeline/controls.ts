import { iconButton } from '../icon.js';

export interface CanvasControls {
  /** The zoom cluster, in the canvas's bottom-right corner. */
  zoom: HTMLElement;
  zoomValue: HTMLElement;
  zoomOut: HTMLButtonElement;
  zoomIn: HTMLButtonElement;
  fit: HTMLButtonElement;
  arrange: HTMLButtonElement;
  minimap: HTMLButtonElement;
}

function span(className: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  return node;
}

/** The canvas's floating controls. Built once; the editor wires them. */
export function buildCanvasControls(): CanvasControls {
  const zoom = document.createElement('div');
  zoom.className = 'pipeline-zoom';
  zoom.setAttribute('role', 'toolbar');
  zoom.setAttribute('aria-label', 'Zoom');
  const button = (
    name: Parameters<typeof iconButton>[0],
    label: string,
  ): HTMLButtonElement => iconButton(name, label, 'pipeline-icon-btn');
  const zoomOut = button('zoom-out', 'Alejar');
  const zoomValue = span('pipeline-zoom-value');
  const zoomIn = button('zoom-in', 'Acercar');
  const fit = button('scan', 'Ajustar a la vista');
  const arrange = button('layout-grid', 'Ordenar automáticamente');
  const minimap = button('map', 'Mostrar minimapa');
  zoom.append(
    zoomOut,
    zoomValue,
    zoomIn,
    span('pipeline-zoom-sep'),
    fit,
    arrange,
    minimap,
  );
  return {
    zoom,
    zoomValue,
    zoomOut,
    zoomIn,
    fit,
    arrange,
    minimap,
  };
}
