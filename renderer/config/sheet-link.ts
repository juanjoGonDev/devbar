import { isLocalHttpUrl, sortPorts } from '../../src/ports/port-links.js';
import type { CommandLink, DetectedPort } from '../../src/domain-types.js';

/**
 * The «Enlace» section of a command's side sheet: what «abrir» opens. A
 * segmented «Automático | Personalizado | Ninguno» picks the mode; automatic
 * names the port the running command listens on and takes an optional path,
 * custom takes a URL that must stay on this machine or the local network.
 */
export interface SheetLinkElements {
  /** The three mode radios, `value` = the link mode. */
  modes: HTMLInputElement[];
  autoPane: HTMLElement;
  customPane: HTMLElement;
  nonePane: HTMLElement;
  /** «Detectado en la última ejecución: …» or the not-yet-detected note. */
  detected: HTMLElement;
  /** The detected `host:port`, muted before the path input. */
  prefix: HTMLElement;
  path: HTMLInputElement;
  url: HTMLInputElement;
  urlError: HTMLElement;
}

export interface SheetLink {
  /** Loads a stored link and the ports the command listens on right now. */
  fill(link: CommandLink | undefined, ports: readonly DetectedPort[]): void;
  /** The link the fields describe, ready to store. */
  read(): CommandLink;
  /** False while a custom URL is missing or not local. */
  isValid(): boolean;
}

type LinkMode = CommandLink['mode'];

const SUMMARIES: Record<LinkMode, string> = {
  auto: 'automático',
  custom: 'personalizado',
  none: 'ninguno',
};

/** The section's badge: «automático», «personalizado» or «ninguno». */
export function linkSummary(mode: LinkMode): string {
  return SUMMARIES[mode];
}

/** A path to open always starts with `/`; blank stays blank. */
function normalizePath(value: string): string {
  const path = value.trim();
  if (!path) return '';
  return path.startsWith('/') ? path : `/${path}`;
}

/** The port «abrir» would use: a web page first, else an HTTP API. */
function primaryPort(ports: readonly DetectedPort[]): DetectedPort | null {
  return sortPorts(ports).find((port) => port.kind !== 'other') ?? null;
}

function urlError(value: string): string | null {
  if (!value) return 'Escribe la URL que se abrirá';
  return isLocalHttpUrl(value)
    ? null
    : 'Usa una URL http(s) de este equipo o de la red local';
}

export function createSheetLink(els: SheetLinkElements): SheetLink {
  function mode(): LinkMode {
    const checked = els.modes.find((radio) => radio.checked)?.value;
    return checked === 'custom' || checked === 'none' ? checked : 'auto';
  }

  function setMode(next: LinkMode): void {
    for (const radio of els.modes) radio.checked = radio.value === next;
  }

  function paint(): void {
    const current = mode();
    els.autoPane.hidden = current !== 'auto';
    els.customPane.hidden = current !== 'custom';
    els.nonePane.hidden = current !== 'none';
    const error = current === 'custom' ? urlError(els.url.value.trim()) : null;
    els.urlError.hidden = error === null;
    els.urlError.textContent = error ?? '';
    if (error === null) els.url.removeAttribute('aria-invalid');
    else els.url.setAttribute('aria-invalid', 'true');
  }

  function paintDetected(ports: readonly DetectedPort[]): void {
    const primary = primaryPort(ports);
    els.detected.classList.toggle('is-detected', primary !== null);
    if (!primary) {
      els.detected.textContent = 'Se detectará al arrancar el comando';
      els.prefix.hidden = true;
      els.prefix.textContent = '';
      return;
    }
    const code = document.createElement('code');
    code.textContent = primary.url.replace(/\/$/, '');
    els.detected.replaceChildren('Detectado en la última ejecución: ', code);
    els.prefix.hidden = false;
    els.prefix.textContent = new URL(primary.url).host;
  }

  for (const radio of els.modes) radio.addEventListener('change', paint);
  els.url.addEventListener('input', paint);
  els.path.addEventListener('change', () => {
    els.path.value = normalizePath(els.path.value);
  });

  return {
    fill(link, ports) {
      const stored = link ?? { mode: 'auto' };
      setMode(stored.mode);
      els.path.value = stored.mode === 'auto' ? (stored.path ?? '') : '';
      els.url.value = stored.mode === 'custom' ? (stored.url ?? '') : '';
      paintDetected(ports);
      paint();
    },
    read() {
      const current = mode();
      if (current === 'none') return { mode: 'none' };
      if (current === 'custom')
        return { mode: 'custom', url: els.url.value.trim() };
      const path = normalizePath(els.path.value);
      return path ? { mode: 'auto', path } : { mode: 'auto' };
    },
    isValid: () =>
      mode() !== 'custom' || urlError(els.url.value.trim()) === null,
  };
}
