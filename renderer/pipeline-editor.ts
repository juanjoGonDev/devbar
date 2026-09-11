import { byId } from './dom.js';
import {
  attachDragHandlers,
  attachCrossContainerDragHandlers,
} from './dnd-helper.js';
import type { Group, PreScript, PreStep } from '../src/domain-types.js';

/** Joins/splits a `PreStepScriptRef` for use as a DOM `data-id` — UUIDs never
 * contain `::`, so the split is unambiguous. */
const REF_SEP = '::';
function refToDataId(groupId: string, scriptId: string): string {
  return `${groupId}${REF_SEP}${scriptId}`;
}
function dataIdToRef(
  dataId: string,
): { groupId: string; scriptId: string } | null {
  const [groupId, scriptId] = dataId.split(REF_SEP);
  return groupId && scriptId ? { groupId, scriptId } : null;
}

/** Same deterministic name→hue hash as `renderer/logs.ts`'s `sourceColor` —
 * duplicated rather than shared, matching this codebase's existing pattern
 * of small per-module helpers (e.g. `errorMessage` in config.ts/tray.ts). */
function groupColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1)
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 70% 68%)`;
}

const PIPELINE_DND_ZONE = 'pipeline-scripts';

/** One lane of the summary strip: a resolved `{group, script}` pair, or a
 * broken marker when the ref no longer resolves (matches the dimmed "ref
 * rota" treatment `buildScriptRow` already gives a dangling ref). */
export interface PipelineSummaryLane {
  readonly groupName: string;
  readonly scriptName: string;
  readonly broken: boolean;
}

/** The summary strip's view model for one step — everything `buildSummaryStrip`
 * needs and nothing it has to compute itself. */
export interface PipelineSummaryStep {
  readonly index: number;
  readonly mode: PreStep['mode'];
  /** Worth the accent treatment: parallel AND more than one script. A
   * single-script "parallel" step behaves identically to serial, so it is
   * never highlighted (matches `arranque-prototipo.html`'s `.par` rule). */
  readonly isParallel: boolean;
  readonly isEmpty: boolean;
  readonly lanes: readonly PipelineSummaryLane[];
}

/**
 * Pure view-model builder for the pipeline summary strip — no DOM, so it is
 * directly unit-testable (`tests/pipeline-summary.test.ts`) the same way
 * `renderer/tooltip.ts` keeps `placeTip` pure alongside its DOM-touching code.
 */
export function summarizePipeline(
  steps: readonly PreStep[],
  resolveScript: (
    groupId: string,
    scriptId: string,
  ) => { groupName: string; scriptName: string } | null,
): readonly PipelineSummaryStep[] {
  return steps.map((step, i) => {
    const lanes: PipelineSummaryLane[] = step.scripts.map((ref) => {
      const resolved = resolveScript(ref.groupId, ref.scriptId);
      return resolved
        ? {
            groupName: resolved.groupName,
            scriptName: resolved.scriptName,
            broken: false,
          }
        : { groupName: '', scriptName: '', broken: true };
    });
    return {
      index: i + 1,
      mode: step.mode,
      isParallel: step.mode === 'parallel' && lanes.length > 1,
      isEmpty: lanes.length === 0,
      lanes,
    };
  });
}

export interface PipelineEditorDeps {
  /** Read-only — the editor never reads `draftGroup` (one-way dependency,
   * unsaved group edits must never leak into the pipeline view). */
  getGroups(): readonly Group[];
  showToast(message: string, kind?: string): void;
}

export interface PipelineEditorHandle {
  refresh(): Promise<void>;
  isPipelineDirty(): boolean;
}

export function initPipelineEditor(
  host: HTMLElement,
  deps: PipelineEditorDeps,
): PipelineEditorHandle {
  const saveBarHost = byId('prescripts-save-bar', HTMLElement);

  // storedSteps/draftSteps mirror storedGroup/draftGroup structurally, but
  // every mutation here (add/delete/reorder step, assign/unassign a script,
  // mode toggle) is instant-write — exactly like the group pane's own
  // command/action sub-lists. Both copies are re-synced from the same fresh
  // response right after each write succeeds, so isPipelineDirty() stays the
  // interlock the close-guard needs without ever needing a visible save
  // affordance for the actions this editor currently exposes.
  let storedSteps: PreStep[] = [];
  let draftSteps: PreStep[] = [];
  let openPickerStepId: string | null = null;

  // Global auto-run setting, read ONCE (loadAutoRunSetting, below) rather
  // than on every render(): render() runs after every step mutation and
  // every picker toggle, and a fresh getSettings() call each time left the
  // checkbox disabled — dead to clicks — until that call resolved, even for
  // renders that have nothing to do with this setting.
  let autoRunEnabled = false;
  let autoRunSettingLoaded = false;

  function isPipelineDirty(): boolean {
    return JSON.stringify(draftSteps) !== JSON.stringify(storedSteps);
  }

  function findScript(
    groupId: string,
    scriptId: string,
  ): { group: Group; script: PreScript } | null {
    const group = deps.getGroups().find((g) => g.id === groupId);
    const script = group?.preScripts.find((s) => s.id === scriptId);
    return group && script ? { group, script } : null;
  }

  function placedRefs(): Set<string> {
    const placed = new Set<string>();
    for (const step of draftSteps) {
      for (const ref of step.scripts)
        placed.add(refToDataId(ref.groupId, ref.scriptId));
    }
    return placed;
  }

  async function reload(): Promise<void> {
    const steps = await window.api.getPreSteps();
    storedSteps = steps;
    draftSteps = structuredClone(steps);
  }

  async function refresh(): Promise<void> {
    await reload();
    render();
  }

  function renderSaveBar(): void {
    saveBarHost.innerHTML = '';
    if (!isPipelineDirty()) return;
    const bar = document.createElement('div');
    bar.className = 'save-bar';
    const msg = document.createElement('span');
    msg.className = 'save-bar-message';
    msg.textContent = 'Cambios sin guardar en el pipeline';
    bar.appendChild(msg);
    const discardBtn = document.createElement('button');
    discardBtn.className = 'ghost';
    discardBtn.textContent = 'Descartar';
    discardBtn.addEventListener('click', () => {
      draftSteps = structuredClone(storedSteps);
      render();
    });
    bar.appendChild(discardBtn);
    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.textContent = 'Guardar';
    saveBtn.addEventListener('click', () => {
      storedSteps = structuredClone(draftSteps);
      render();
    });
    bar.appendChild(saveBtn);
    saveBarHost.appendChild(bar);
  }

  /** Reads the global auto-run setting exactly once (called from
   * `initPipelineEditor` below), caching it so every subsequent render()
   * paints from memory instead of racing a fresh IPC call. */
  function loadAutoRunSetting(): void {
    void window.api
      .getSettings()
      .then((settings) => {
        autoRunEnabled = !!settings.preScriptsAutoRun;
      })
      .catch(() => {
        deps.showToast('No se pudieron leer los ajustes', 'error');
      })
      .finally(() => {
        autoRunSettingLoaded = true;
        render();
      });
  }

  // ── Auto-run toggle (now a GLOBAL setting, not per-group) ───────────────
  //
  // Reads the cached `autoRunEnabled`/`autoRunSettingLoaded` state (set once
  // by `loadAutoRunSetting`, below) instead of firing its own getSettings()
  // call — this function now runs on every render() without re-fetching or
  // re-disabling the control.
  function buildAutoRunToggle(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'detail-section';
    const label = document.createElement('label');
    label.className = 'toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = autoRunEnabled;
    // Disabled until the cached value has loaded once: an early click would
    // be saved and then silently overwritten by the resolving read, leaving
    // the control contradicting the setting it just wrote.
    input.disabled = !autoRunSettingLoaded;
    input.addEventListener('change', async () => {
      try {
        await window.api.saveSettings({ preScriptsAutoRun: input.checked });
        autoRunEnabled = input.checked;
        deps.showToast('Ajustes guardados', 'ok');
      } catch {
        // Put the control back where the stored setting still is, so it
        // never claims a value that was not persisted.
        input.checked = !input.checked;
        deps.showToast('No se pudo guardar el ajuste', 'error');
      }
    });
    label.appendChild(input);
    const span = document.createElement('span');
    span.textContent = 'Ejecutar automáticamente al arrancar el Mac';
    label.appendChild(span);
    const hint = document.createElement('small');
    hint.className = 'muted';
    hint.style.cssText = 'display:block; margin:2px 0 0 42px; font-size:10px;';
    hint.textContent =
      'Solo dispara cuando DevBar abre como Login Item del sistema; no en relanzados manuales.';
    section.append(label, hint);
    return section;
  }

  /**
   * Every pipeline mutation is an instant write, so a rejected IPC call must
   * not fail silently: without this the handlers left the UI showing a change
   * that was never persisted, and the rejection surfaced as an unhandled
   * promise. On failure we re-read the persisted pipeline so the screen shows
   * what is actually stored, never an optimistic guess.
   */
  async function write(action: () => Promise<unknown>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch {
      deps.showToast('No se pudo guardar el pipeline', 'error');
      // The recovery read is best-effort: if it fails too, `write` must still
      // settle, or every handler awaiting it produces an unhandled rejection.
      try {
        await refresh();
      } catch {
        deps.showToast('No se pudo recargar el pipeline', 'error');
      }
      return false;
    }
  }

  // ── Summary strip ────────────────────────────────────────────────────────
  //
  // `summarizePipeline` is the pure view-model seam: it turns raw steps into
  // exactly what the strip below renders, with no DOM involved, so the
  // approved layout (header line + one lane per script, matching
  // `arranque-prototipo.html`) can be driven from plain fixtures in
  // `tests/pipeline-summary.test.ts`.
  function buildSummaryStrip(): HTMLElement {
    const strip = document.createElement('div');
    strip.className = 'pipeline-summary';
    const track = document.createElement('div');
    track.className = 'pipeline-summary-steps';

    for (const step of summarizePipeline(draftSteps, (groupId, scriptId) => {
      const resolved = findScript(groupId, scriptId);
      return resolved
        ? { groupName: resolved.group.name, scriptName: resolved.script.name }
        : null;
    })) {
      const block = document.createElement('div');
      block.className = 'pipeline-summary-step';
      if (step.isEmpty) block.classList.add('is-empty');
      if (step.isParallel) block.classList.add('is-parallel');
      block.title = `Paso ${step.index} (${step.mode === 'serial' ? 'serie' : 'paralelo'})`;

      const head = document.createElement('span');
      head.className = 'pipeline-summary-step-head';
      head.textContent =
        step.lanes.length > 1
          ? `${step.index} · ${step.mode === 'parallel' ? '∥' : '→'}`
          : `${step.index}`;
      block.appendChild(head);

      if (step.isEmpty) {
        const lane = document.createElement('span');
        lane.className = 'pipeline-summary-lane is-muted';
        lane.textContent = 'vacío';
        block.appendChild(lane);
      } else {
        for (const lane of step.lanes) {
          const laneEl = document.createElement('span');
          laneEl.className = 'pipeline-summary-lane';
          if (lane.broken) {
            laneEl.classList.add('is-muted');
            laneEl.textContent = 'Referencia rota';
          } else {
            const dot = document.createElement('span');
            dot.className = 'pipeline-group-dot';
            dot.style.setProperty('--group-color', groupColor(lane.groupName));
            laneEl.append(dot, document.createTextNode(lane.scriptName));
          }
          block.appendChild(laneEl);
        }
      }
      track.appendChild(block);
    }
    strip.appendChild(track);

    const scriptCount = draftSteps.reduce(
      (sum, step) => sum + step.scripts.length,
      0,
    );
    const groupCount = new Set(
      draftSteps.flatMap((step) => step.scripts.map((ref) => ref.groupId)),
    ).size;
    const count = document.createElement('div');
    count.className = 'pipeline-summary-count muted small';
    count.textContent = `${draftSteps.length} paso${draftSteps.length === 1 ? '' : 's'} · ${scriptCount} script${scriptCount === 1 ? '' : 's'} · ${groupCount} grupo${groupCount === 1 ? '' : 's'}`;
    strip.appendChild(count);
    return strip;
  }

  // ── Script picker ("+ Añadir script") ───────────────────────────────────
  function buildScriptPicker(stepId: string): HTMLElement {
    const picker = document.createElement('div');
    picker.className = 'script-picker';
    const placed = placedRefs();
    const groupsWithScripts = deps
      .getGroups()
      .filter((g) => g.preScripts.length > 0);
    if (groupsWithScripts.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted small';
      empty.textContent =
        'No hay pre-scripts definidos. Créalos primero en la ficha de cada grupo.';
      picker.appendChild(empty);
      return picker;
    }
    for (const group of groupsWithScripts) {
      const groupBlock = document.createElement('div');
      groupBlock.className = 'script-picker-group';
      const header = document.createElement('div');
      header.className = 'script-picker-group-header';
      const dot = document.createElement('span');
      dot.className = 'pipeline-group-dot';
      dot.style.setProperty('--group-color', groupColor(group.name));
      header.append(dot, document.createTextNode(group.name));
      groupBlock.appendChild(header);
      for (const script of group.preScripts) {
        const dataId = refToDataId(group.id, script.id);
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'script-picker-item';
        item.textContent = script.name;
        const alreadyPlaced = placed.has(dataId);
        item.disabled = alreadyPlaced;
        if (alreadyPlaced) item.title = 'Ya está en el pipeline';
        item.addEventListener('click', async () => {
          if (
            !(await write(() =>
              window.api.assignScriptToStep(stepId, group.id, script.id),
            ))
          )
            return;
          openPickerStepId = null;
          await refresh();
        });
        groupBlock.appendChild(item);
      }
      picker.appendChild(groupBlock);
    }
    return picker;
  }

  // ── Script row ───────────────────────────────────────────────────────────
  function buildScriptRow(
    ref: { groupId: string; scriptId: string },
    step: PreStep,
  ): HTMLElement {
    const li = document.createElement('li');
    li.className = 'prescript-row drag-row';
    li.dataset.id = refToDataId(ref.groupId, ref.scriptId);
    const resolved = findScript(ref.groupId, ref.scriptId);

    const dragHandle = document.createElement('span');
    dragHandle.className = 'drag-handle';
    dragHandle.draggable = true;
    dragHandle.title = 'Arrastra para mover a otro paso';
    dragHandle.textContent = '⋮⋮';
    li.appendChild(dragHandle);

    if (!resolved) {
      // Referential integrity is normally enforced server-side on every
      // persist (prunePipelineRefs), but a hand-edited store file could
      // still leave a dangling ref — render it, don't throw.
      const broken = document.createElement('span');
      broken.className = 'muted small';
      broken.textContent = 'Referencia rota (script eliminado)';
      li.appendChild(broken);
    } else {
      const { group, script } = resolved;
      const badge = document.createElement('span');
      badge.className = 'pipeline-group-badge';
      badge.title = `${group.name} — ${group.path || 'sin path'}`;
      const dot = document.createElement('span');
      dot.className = 'pipeline-group-dot';
      dot.style.setProperty('--group-color', groupColor(group.name));
      const name = document.createElement('span');
      name.className = 'pipeline-group-name';
      name.textContent = group.name;
      badge.append(dot, name);
      li.appendChild(badge);

      const nameEl = document.createElement('strong');
      nameEl.textContent = script.name || 'Unnamed';
      li.appendChild(nameEl);

      const cmdEl = document.createElement('code');
      cmdEl.textContent = [script.command, ...(script.args || [])].join(' ');
      li.appendChild(cmdEl);

      if (script.timeoutMs) {
        const timeout = document.createElement('span');
        timeout.className = 'muted small';
        timeout.textContent = `⏱ ${Math.round(script.timeoutMs / 1000)}s`;
        li.appendChild(timeout);
      }
    }

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    li.appendChild(spacer);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'small-btn danger';
    removeBtn.title = 'Quitar del paso';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', async () => {
      if (
        !(await write(() =>
          window.api.unassignScriptFromStep(step.id, ref.groupId, ref.scriptId),
        ))
      )
        return;
      await refresh();
    });
    li.appendChild(removeBtn);

    return li;
  }

  // ── Step card ────────────────────────────────────────────────────────────
  function buildStepCard(step: PreStep, stepNumber: number): HTMLElement {
    const card = document.createElement('div');
    card.className = 'prestep-card drag-row';
    card.dataset.id = step.id;

    const header = document.createElement('div');
    header.className = 'prestep-card-header';

    const dragHandle = document.createElement('span');
    dragHandle.className = 'drag-handle';
    dragHandle.draggable = true;
    dragHandle.title = 'Arrastra para reordenar';
    dragHandle.textContent = '⋮⋮';
    header.appendChild(dragHandle);

    const stepLabel = document.createElement('span');
    stepLabel.className = 'step-label';
    stepLabel.textContent = `Paso ${stepNumber}`;
    header.appendChild(stepLabel);

    const modeToggle = document.createElement('div');
    modeToggle.className = 'prestep-mode-toggle';
    modeToggle.setAttribute('role', 'group');
    modeToggle.setAttribute('aria-label', 'Modo de ejecución');
    for (const mode of ['parallel', 'serial'] as const) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mode-btn';
      btn.textContent = mode === 'parallel' ? 'Paralelo ⇉' : 'Serie →';
      btn.setAttribute('aria-pressed', String(step.mode === mode));
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await write(() => window.api.savePreStep({ ...step, mode }))))
          return;
        await refresh();
      });
      modeToggle.appendChild(btn);
    }
    header.appendChild(modeToggle);

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    header.appendChild(spacer);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'small-btn danger';
    delBtn.title = 'Eliminar paso';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`¿Eliminar el paso ${stepNumber}?`)) return;
      if (!(await write(() => window.api.deletePreStep(step.id)))) return;
      await refresh();
    });
    header.appendChild(delBtn);
    card.appendChild(header);

    const scriptList = document.createElement('ul');
    scriptList.className = 'prescript-list';
    scriptList.dataset.containerId = step.id;
    if (step.scripts.length === 0) {
      scriptList.classList.add('prestep-empty-dropzone');
      const hint = document.createElement('li');
      hint.className = 'prestep-drop-hint';
      hint.textContent = 'Suelta un script aquí';
      scriptList.appendChild(hint);
    } else {
      for (const ref of step.scripts) {
        scriptList.appendChild(buildScriptRow(ref, step));
      }
    }
    card.appendChild(scriptList);

    attachCrossContainerDragHandlers(
      scriptList,
      PIPELINE_DND_ZONE,
      async (move) => {
        const ref = dataIdToRef(move.itemId);
        if (!ref) return;
        if (
          !(await write(() =>
            window.api.assignScriptToStep(
              move.targetContainerId,
              ref.groupId,
              ref.scriptId,
              move.index,
            ),
          ))
        )
          return;
        await refresh();
      },
    );

    const addScriptBtn = document.createElement('button');
    addScriptBtn.type = 'button';
    addScriptBtn.className = 'small-btn';
    addScriptBtn.textContent = '+ Añadir script';
    addScriptBtn.style.marginTop = '4px';
    addScriptBtn.addEventListener('click', () => {
      openPickerStepId = openPickerStepId === step.id ? null : step.id;
      render();
    });
    card.appendChild(addScriptBtn);

    if (openPickerStepId === step.id) {
      card.appendChild(buildScriptPicker(step.id));
    }

    return card;
  }

  function render(): void {
    host.innerHTML = '';
    host.appendChild(buildAutoRunToggle());

    const helpText = document.createElement('p');
    helpText.className = 'help-text muted';
    helpText.style.cssText = 'font-size:11px; margin:4px 0 8px;';
    helpText.textContent =
      'Un único pipeline ordenado, compartido por todos los grupos. Cada paso puede correr en paralelo o en serie.';
    host.appendChild(helpText);

    host.appendChild(buildSummaryStrip());

    const headerRow = document.createElement('div');
    headerRow.className = 'sub-list-header';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'section-label';
    titleSpan.textContent = 'Pasos del pipeline';
    headerRow.appendChild(titleSpan);
    const addStepBtn = document.createElement('button');
    addStepBtn.className = 'small-btn';
    addStepBtn.textContent = '+ Añadir paso';
    addStepBtn.addEventListener('click', async () => {
      if (
        !(await write(() =>
          window.api.savePreStep({ mode: 'parallel', scripts: [] }),
        ))
      )
        return;
      await refresh();
    });
    headerRow.appendChild(addStepBtn);
    host.appendChild(headerRow);

    if (draftSteps.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'prestep-empty';
      empty.textContent = 'Sin pasos. Pulsa «+ Añadir paso» para comenzar.';
      host.appendChild(empty);
    } else {
      const stepsRoot = document.createElement('div');
      stepsRoot.className = 'presteps-list';
      draftSteps.forEach((step, index) => {
        stepsRoot.appendChild(buildStepCard(step, index + 1));
      });
      host.appendChild(stepsRoot);
      attachDragHandlers(stepsRoot, async (orderedIds) => {
        if (!(await write(() => window.api.reorderPreSteps(orderedIds))))
          return;
        await refresh();
      });
    }

    renderSaveBar();
  }

  loadAutoRunSetting();

  return { refresh, isPipelineDirty };
}
