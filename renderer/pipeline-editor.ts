import {
  attachDragHandlers,
  attachCrossContainerDragHandlers,
} from './dnd-helper.js';
import { latestWins } from './latest-wins.js';
import { buildAutoRunToggle } from './pipeline/auto-run-toggle.js';
import {
  buildSummaryStrip,
  dataIdToRef,
  groupColor,
  refToDataId,
} from './pipeline/summary.js';
import type { Group, PreScript, PreStep } from '../src/domain-types.js';

export {
  summarizePipeline,
  type PipelineSummaryLane,
  type PipelineSummaryStep,
} from './pipeline/summary.js';

const PIPELINE_DND_ZONE = 'pipeline-scripts';

export interface PipelineEditorDeps {
  /** Read-only — the editor never reads `draftGroup` (one-way dependency,
   * unsaved group edits must never leak into the pipeline view). */
  getGroups(): readonly Group[];
  showToast(message: string, kind?: string): void;
}

export interface PipelineEditorHandle {
  refresh(): Promise<void>;
}

export function initPipelineEditor(
  host: HTMLElement,
  deps: PipelineEditorDeps,
): PipelineEditorHandle {
  // Every pipeline mutation here (add/delete/reorder step, assign/unassign a
  // script, mode toggle) is an instant IPC write immediately followed by a
  // full refresh() — there is no local-only draft to save or discard, unlike
  // the group pane's storedGroup/draftGroup. `draftSteps` is simply the last
  // state fetched from main, kept as its own copy (not shared with
  // findScript's group lookups) so re-renders never need to re-fetch it.
  let draftSteps: PreStep[] = [];
  let openPickerStepId: string | null = null;

  // Global auto-run setting, read ONCE (loadAutoRunSetting, below) rather
  // than on every render(): render() runs after every step mutation and
  // every picker toggle, and a fresh getSettings() call each time left the
  // checkbox disabled — dead to clicks — until that call resolved, even for
  // renders that have nothing to do with this setting.
  let autoRunEnabled = false;
  let autoRunSettingLoaded = false;
  /**
   * Ticket for the in-flight auto-run save. The toggle writes on every change
   * with nothing serializing the writes, so a rejected OLD save must not roll
   * the control back over a NEWER value that already persisted — the same
   * rule the theme picker in `config.ts` follows.
   */
  const autoRunSaves = latestWins();

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

  /**
   * Ticket for the in-flight steps read. Every mutation above is an instant
   * write followed by a full re-read, and nothing serializes them: two quick
   * clicks put two reads in flight, and the older answer landing last drops
   * whatever the second click had just persisted.
   */
  const stepReads = latestWins();

  async function reload(): Promise<void> {
    // Issuing this read retires every older one still in flight.
    stepReads.invalidate();
    const current = stepReads.claim();
    const steps = await window.api.getPreSteps();
    if (!current()) return; // a newer read already answered
    draftSteps = steps;
  }

  async function refresh(): Promise<void> {
    await reload();
    render();
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

  /** The global auto-run control; `buildAutoRunToggle` owns its markup, this
   *  only hands it the cached state and the save ticket. */
  function autoRunToggle(): HTMLElement {
    return buildAutoRunToggle({
      enabled: autoRunEnabled,
      loaded: autoRunSettingLoaded,
      saves: autoRunSaves,
      onSaved: (enabled) => {
        autoRunEnabled = enabled;
      },
      showToast: (message, kind) => deps.showToast(message, kind),
    });
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

  /** The read-only strip above the step list; `buildSummaryStrip` owns its
   *  markup, this only feeds it the current steps and a name resolver. */
  function summaryStrip(): HTMLElement {
    return buildSummaryStrip(draftSteps, (groupId, scriptId) => {
      const resolved = findScript(groupId, scriptId);
      return resolved
        ? { groupName: resolved.group.name, scriptName: resolved.script.name }
        : null;
    });
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
    host.appendChild(autoRunToggle());

    const helpText = document.createElement('p');
    helpText.className = 'help-text muted';
    helpText.style.cssText = 'font-size:11px; margin:4px 0 8px;';
    helpText.textContent =
      'Un único pipeline ordenado, compartido por todos los grupos. Cada paso puede correr en paralelo o en serie.';
    host.appendChild(helpText);

    host.appendChild(summaryStrip());

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
  }

  loadAutoRunSetting();

  return { refresh };
}
