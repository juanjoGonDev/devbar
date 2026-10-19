import { icon, type IconName } from '../icon.js';
import { groupTile } from './group-tile.js';
import { edgeStatus, nodeCaption, type RunView } from './run-view.js';
import { LOCKED_TIP, frameToolbar, nodeToolbar } from './toolbars.js';
import {
  TRIGGER_RECT,
  blockRect,
  edgeMidpoint,
  edgePath,
  inputPin,
  nodeOffset,
  outputPin,
  rectOf,
} from './geometry.js';
import { PIPELINE_TRIGGER, pipelineRefKey } from '../../src/pipeline-graph.js';
import type {
  Group,
  Pipeline,
  PipelineBlock,
  PreScript,
  PreStepScriptRef,
} from '../../src/domain-types.js';
import type { Point } from './viewport.js';
import { spinPhase } from '../spin-phase.js';

/**
 * DOM builders for the world layer of the canvas — everything that pans and
 * zooms: the edges (SVG), the fixed trigger, each block (a node, or a dashed
 * "En paralelo" frame of nodes) with its pins and "+" stub, and the floating
 * toolbar of the selected node.
 *
 * Builders only. They carry what an interaction needs in `data-*` attributes
 * (`data-block`, `data-ref`, `data-from`/`data-to`, `data-action`) and attach
 * no listener: the editor and its gesture modules handle everything through
 * delegation, so a repaint never re-wires anything.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const DISCONNECTED_TIP = 'Sin conectar: no se ejecutará';
const NO_FREE_SCRIPTS_TIP = 'Todos los pre-scripts ya están en el workflow';
const REQUIRE_ALL_LABEL = 'Todos OK';

export interface ResolvedScript {
  group: Group;
  script: PreScript;
}

export interface WorldInput {
  pipeline: Pipeline;
  resolve: (ref: PreStepScriptRef) => ResolvedScript | null;
  /** Blocks that will actually run; every other one is drawn dimmed. */
  runnable: ReadonlySet<string>;
  selectedKey: string | null;
  /** The block a drag would drop onto, lit while hovered. */
  dropTarget: string | null;
  /** False once every pre-script is placed: each "+" is then disabled. */
  canAdd: boolean;
  canEdit: boolean;
  /** What the trigger node says and shows. */
  trigger: { label: string; icon: IconName; kind: string };
  /** The latest run of this workflow, painted on every node and edge. */
  run: RunView | null;
  /** A run is in flight: only layout edits are allowed. */
  locked: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function place(node: HTMLElement, point: Point): void {
  node.style.left = `${point.x}px`;
  node.style.top = `${point.y}px`;
}

/** A readable name for a block: its script, or "En paralelo (n)". */
export function blockName(
  block: PipelineBlock,
  resolve: WorldInput['resolve'],
): string {
  if (block.scripts.length > 1) return `En paralelo (${block.scripts.length})`;
  const first = block.scripts[0];
  const resolved = first ? resolve(first) : null;
  return resolved?.script.name || 'Referencia rota';
}

function pin(kind: 'in' | 'out', blockId: string, at: Point): HTMLElement {
  const dot = el('span', `pipeline-pin is-${kind}`);
  dot.dataset.block = blockId;
  dot.setAttribute('aria-hidden', 'true');
  place(dot, at);
  return dot;
}

function stub(input: WorldInput, blockId: string, name: string, at: Point) {
  const button = el('button', 'pipeline-stub');
  button.type = 'button';
  button.dataset.block = blockId;
  button.append(icon('plus'));
  if (input.locked) {
    button.setAttribute('aria-disabled', 'true');
    button.title = LOCKED_TIP;
    button.setAttribute('aria-label', LOCKED_TIP);
  } else if (input.canAdd) {
    button.title = `Añadir después de ${name}`;
    button.setAttribute('aria-label', `Añadir después de ${name}`);
  } else {
    // aria-disabled rather than disabled: a disabled button gets no hover,
    // and the tooltip is the only thing saying why it does nothing.
    button.setAttribute('aria-disabled', 'true');
    button.title = NO_FREE_SCRIPTS_TIP;
    button.setAttribute('aria-label', 'No quedan pre-scripts disponibles');
  }
  place(button, at);
  return button;
}

function trigger(input: WorldInput, hasOutput: boolean): HTMLElement[] {
  const { label, kind } = input.trigger;
  const box = el('div', `pipeline-trigger is-${kind}`);
  box.dataset.block = PIPELINE_TRIGGER;
  box.tabIndex = 0;
  box.setAttribute('role', 'button');
  box.setAttribute('aria-haspopup', 'dialog');
  box.setAttribute('aria-label', `Desencadenante: ${label}`);
  place(box, TRIGGER_RECT);
  const bolt = el('span', 'pipeline-trigger-bolt');
  bolt.append(icon(input.trigger.icon));
  const lock = icon('lock');
  lock.classList.add('pipeline-trigger-lock');
  box.append(bolt, el('span', 'pipeline-trigger-title', label), lock);
  const out = outputPin(TRIGGER_RECT);
  const parts = [box, pin('out', PIPELINE_TRIGGER, out)];
  if (!hasOutput) parts.push(stub(input, PIPELINE_TRIGGER, label, out));
  return parts;
}

/** The round badge at the right of a node that says how its script did. */
function stateBadge(status: string): HTMLElement | null {
  const glyphs: Record<string, IconName | '!' | ''> = {
    waiting: 'clock',
    running: '',
    success: 'check',
    warning: '!',
    error: 'x',
    cancelled: 'minus',
  };
  const glyph = glyphs[status];
  if (glyph === undefined) return null;
  const badge = el('span', 'pipeline-node-state');
  if (glyph === '') badge.append(spinPhase(el('span', 'pipeline-spinner')));
  else if (glyph === '!') badge.textContent = '!';
  else badge.append(icon(glyph));
  return badge;
}

function paintRun(
  input: WorldInput,
  card: HTMLElement,
  block: PipelineBlock,
  key: string,
): void {
  const script = input.run?.script(key) ?? null;
  if (!script) return;
  card.classList.add(`is-run-${script.status}`);
  card.dataset.run = script.status;
  // The running card glows; phase-locked so a repaint does not restart it.
  if (script.status === 'running') spinPhase(card);
  if (script.status === 'skipped') {
    card.append(el('span', 'pipeline-node-skipped', 'omitido'));
    return;
  }
  const badge = stateBadge(script.status);
  if (badge) card.append(badge);
  const caption = nodeCaption(script, input.run?.now ?? 0);
  if (!caption) return;
  if (block.scripts.length > 1) card.title = caption;
  else card.append(el('span', 'pipeline-node-caption', caption));
}

function node(
  input: WorldInput,
  block: PipelineBlock,
  ref: PreStepScriptRef,
  index: number,
): HTMLElement {
  const key = pipelineRefKey(ref);
  const resolved = input.resolve(ref);
  const card = el('div', 'pipeline-node');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.dataset.ref = key;
  card.dataset.block = block.id;
  const selected = input.selectedKey === key;
  card.setAttribute('aria-pressed', String(selected));
  if (selected) card.classList.add('is-selected');
  place(card, nodeOffset(index, block.scripts.length));
  const runs = input.runnable.has(block.id);
  if (resolved) {
    const { group, script } = resolved;
    const name = script.name || 'Sin nombre';
    card.append(
      groupTile(group, 'pipeline-node-tile'),
      el('span', 'pipeline-node-name', name),
    );
    card.setAttribute(
      'aria-label',
      `${name}, ${group.name}${runs ? '' : ', sin conectar'}`,
    );
  } else {
    // The store prunes dangling refs on every persist, but a hand-edited
    // file can still hold one — draw it, never throw on it.
    card.classList.add('is-broken');
    const tile = el('span', 'group-tile pipeline-node-tile');
    tile.append(icon('triangle-alert'));
    card.append(tile, el('span', 'pipeline-node-name', 'Referencia rota'));
    card.setAttribute('aria-label', 'Referencia rota');
  }
  paintRun(input, card, block, key);
  return card;
}

function blockParts(
  input: WorldInput,
  block: PipelineBlock,
  hasOutput: boolean,
): HTMLElement[] {
  const rect = blockRect(block);
  const box = el('div', 'pipeline-block');
  box.dataset.block = block.id;
  place(box, rect);
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
  const frame = block.scripts.length > 1;
  if (frame) {
    box.classList.add('is-frame');
    const label = el('span', 'pipeline-frame-label', 'En paralelo');
    if (block.requireAll) {
      const shield = icon('shield-check');
      shield.classList.add('pipeline-frame-shield');
      shield.setAttribute('role', 'img');
      shield.setAttribute('aria-label', REQUIRE_ALL_LABEL);
      shield.removeAttribute('aria-hidden');
      label.append(shield);
    }
    box.appendChild(label);
    box.appendChild(frameToolbar(input, block));
  }
  const status = input.run?.block(block.id);
  if (status && status !== 'idle') box.classList.add(`is-run-${status}`);
  if (input.dropTarget === block.id) box.classList.add('is-drop-target');
  const runs = input.runnable.has(block.id);
  if (!runs) box.classList.add('is-disconnected');
  block.scripts.forEach((ref, index) =>
    box.appendChild(node(input, block, ref, index)),
  );
  if (!runs) {
    const badge = el('span', 'pipeline-block-warning');
    badge.title = DISCONNECTED_TIP;
    badge.setAttribute('role', 'img');
    badge.setAttribute('aria-label', DISCONNECTED_TIP);
    badge.append(icon('triangle-alert'));
    box.appendChild(badge);
  }
  const out = outputPin(rect);
  const parts = [
    box,
    pin('in', block.id, inputPin(rect)),
    pin('out', block.id, out),
  ];
  if (!hasOutput)
    parts.push(stub(input, block.id, blockName(block, input.resolve), out));
  const selectedIndex = block.scripts.findIndex(
    (ref) => pipelineRefKey(ref) === input.selectedKey,
  );
  const selected = block.scripts[selectedIndex];
  if (selected) parts.push(nodeToolbar(input, block, selected, selectedIndex));
  return parts;
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes))
    node.setAttribute(name, value);
  return node;
}

function nameOf(input: WorldInput, id: string): string {
  if (id === PIPELINE_TRIGGER) return input.trigger.label;
  const block = input.pipeline.blocks.find((b) => b.id === id);
  return block ? blockName(block, input.resolve) : id;
}

function edges(input: WorldInput): SVGSVGElement {
  const layer = svg('svg', { class: 'pipeline-edges' });
  for (const edge of input.pipeline.edges) {
    const fromRect = rectOf(input.pipeline, edge.from);
    const toRect = rectOf(input.pipeline, edge.to);
    if (!fromRect || !toRect) continue;
    const from = outputPin(fromRect);
    const to = inputPin(toRect);
    const d = edgePath(from, to);
    const group = svg('g', { class: 'pipeline-edge' });
    group.dataset.from = edge.from;
    group.dataset.to = edge.to;
    if (!input.runnable.has(edge.to)) group.classList.add('is-disconnected');
    const status = edgeStatus(input.run, edge.to);
    if (status) group.classList.add(`is-run-${status}`);
    if (status === 'running') group.classList.add('is-flowing');
    const line = svg('path', { class: 'pipeline-edge-line', d });
    if (status === 'running') spinPhase(line);
    group.append(svg('path', { class: 'pipeline-edge-hit', d }), line);
    const mid = edgeMidpoint(from, to);
    const remove = svg('g', {
      class: 'pipeline-edge-delete',
      role: 'button',
      tabindex: '0',
      transform: `translate(${mid.x} ${mid.y})`,
      'aria-label': `Quitar la conexión de ${nameOf(input, edge.from)} a ${nameOf(input, edge.to)}`,
    });
    remove.dataset.from = edge.from;
    remove.dataset.to = edge.to;
    remove.append(
      svg('circle', { r: '9' }),
      svg('path', { d: 'M -3.5 -3.5 L 3.5 3.5 M 3.5 -3.5 L -3.5 3.5' }),
    );
    group.appendChild(remove);
    layer.appendChild(group);
  }
  const draft = svg('path', { class: 'pipeline-edge-draft', d: '' });
  layer.appendChild(draft);
  return layer;
}

/** Fills the world layer with the whole graph, edges underneath. */
export function renderWorld(world: HTMLElement, input: WorldInput): void {
  const sources = new Set(input.pipeline.edges.map((edge) => edge.from));
  const parts: Element[] = [
    edges(input),
    ...trigger(input, sources.has(PIPELINE_TRIGGER)),
  ];
  for (const block of input.pipeline.blocks)
    parts.push(...blockParts(input, block, sources.has(block.id)));
  world.replaceChildren(...parts);
}

/** Draws (or, with `to` null, clears) the dashed edge of a connection drag. */
export function setDraftEdge(
  world: HTMLElement,
  from: Point | null,
  to: Point | null,
): void {
  const draft = world.querySelector('.pipeline-edge-draft');
  if (!draft) return;
  draft.setAttribute('d', from && to ? edgePath(from, to) : '');
}
