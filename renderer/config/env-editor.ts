import type { EnvEntry } from '../../src/domain-types.js';

export interface EnvEditorHandle {
  getEntries(): EnvEntry[];
  setDisabled?(disabled: boolean): void;
}

/** A detail-pane section that owns an env editor, so the handle can be found
 * again from the element itself. */
export interface EnvSectionElement extends HTMLDivElement {
  _envEditor?: EnvEditorHandle;
}

/**
 * Build a reusable env editor widget.
 *
 * @param {HTMLElement} container  — element to render the editor into
 * @param {Array} initialEntries  — EnvEntry[] initial value
 * @param {object} opts  — currently unused, kept for API compat
 * @returns {{ getEntries: () => EnvEntry[] }}
 */
export function buildEnvEditor(
  container: HTMLElement,
  initialEntries: EnvEntry[],
  _opts: Record<string, never> = {},
): EnvEditorHandle {
  const entries = initialEntries.map((e) => ({ ...e }));

  function updateMasterToggle(masterInput: HTMLInputElement): void {
    if (entries.length === 0) {
      masterInput.checked = false;
      masterInput.indeterminate = false;
      const label = masterInput.closest<HTMLElement>('label');
      if (label) {
        label.style.opacity = '0.45';
        label.style.pointerEvents = 'none';
      }
    } else {
      const label = masterInput.closest<HTMLElement>('label');
      if (label) {
        label.style.opacity = '';
        label.style.pointerEvents = '';
      }
      const allOn = entries.every((e) => e.enabled);
      masterInput.checked = allOn;
      masterInput.indeterminate = !allOn && entries.some((e) => e.enabled);
    }
  }

  function render(): void {
    container.innerHTML = '';
    container.className = 'env-editor';

    // ── Master toggle row ──────────────────────────────────────────────
    const masterRow = document.createElement('div');
    masterRow.className = 'env-master-row';

    const masterLabel = document.createElement('label');
    masterLabel.className = 'toggle inline';
    masterLabel.style.cssText = 'margin:0; padding:2px 0;';
    const masterInput = document.createElement('input');
    masterInput.type = 'checkbox';
    masterInput.title = 'Activar/desactivar todas';
    masterLabel.appendChild(masterInput);
    const masterSpan = document.createElement('span');
    masterSpan.textContent = 'Activar todas';
    masterSpan.style.cssText = 'font-size:11px; color:var(--muted);';
    masterLabel.appendChild(masterSpan);
    masterRow.appendChild(masterLabel);
    container.appendChild(masterRow);

    updateMasterToggle(masterInput);

    masterInput.addEventListener('change', () => {
      const val = masterInput.checked;
      for (const e of entries) e.enabled = val;
      render();
    });

    // ── Hairline separator ─────────────────────────────────────────────
    const sep = document.createElement('div');
    sep.className = 'env-separator';
    container.appendChild(sep);

    // ── Entry rows ─────────────────────────────────────────────────────
    for (const [i, entry] of entries.entries()) {
      const row = document.createElement('div');
      row.className = 'env-entry';

      // Per-entry toggle switch
      const toggleLabel = document.createElement('label');
      toggleLabel.className = 'toggle inline';
      toggleLabel.style.cssText = 'margin:0; padding:0; flex-shrink:0;';
      const toggleInput = document.createElement('input');
      toggleInput.type = 'checkbox';
      toggleInput.checked = !!entry.enabled;
      toggleInput.addEventListener('change', () => {
        entry.enabled = toggleInput.checked;
        updateMasterToggle(masterInput);
      });
      toggleLabel.appendChild(toggleInput);
      row.appendChild(toggleLabel);

      // Key input
      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.className = 'env-key';
      keyInput.placeholder = 'KEY';
      keyInput.value = entry.key || '';
      keyInput.addEventListener('input', () => {
        entry.key = keyInput.value;
      });
      row.appendChild(keyInput);

      // Value input
      const valInput = document.createElement('input');
      valInput.type = 'text';
      valInput.className = 'env-value';
      valInput.placeholder = 'value';
      valInput.value = entry.value || '';
      valInput.addEventListener('input', () => {
        entry.value = valInput.value;
      });
      row.appendChild(valInput);

      // Delete button
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'env-delete';
      delBtn.title = 'Eliminar';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', () => {
        entries.splice(i, 1);
        render();
      });
      row.appendChild(delBtn);

      container.appendChild(row);
    }

    // ── Add button ─────────────────────────────────────────────────────
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'env-add-btn';
    addBtn.textContent = '+ Añadir variable';
    addBtn.addEventListener('click', () => {
      entries.push({ key: '', value: '', enabled: true });
      render();
      // Focus the last key input
      const rows = container.querySelectorAll<HTMLElement>('.env-entry');
      const lastRow = rows[rows.length - 1];
      if (lastRow) {
        const keyEl = lastRow.querySelector<HTMLInputElement>('.env-key');
        if (keyEl) keyEl.focus();
      }
    });
    container.appendChild(addBtn);
  }

  render();

  return {
    getEntries: () => entries.map((e) => ({ ...e })),
    // setDisabled kept for API compat but is a no-op (env editor is always active now)
    setDisabled: (_disabled: boolean) => {},
  };
}
