// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { buildEnvEditor } from '../renderer/config/env-editor.js';
import type { EnvEntry } from '../src/domain-types.js';

function host(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.env-entry')];
}

function master(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(
    '.env-master-row input[type=checkbox]',
  );
  if (!el) throw new Error('the editor drew no master toggle');
  return el;
}

function addButton(container: HTMLElement): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('.env-add-btn');
  if (!el) throw new Error('the editor drew no add button');
  return el;
}

function fieldIn(row: HTMLElement, selector: string): HTMLInputElement {
  const el = row.querySelector<HTMLInputElement>(selector);
  if (!el) throw new Error(`row has no ${selector}`);
  return el;
}

function entries(...values: Array<Partial<EnvEntry>>): EnvEntry[] {
  return values.map((v, i) => ({
    key: v.key ?? `K${i}`,
    value: v.value ?? `v${i}`,
    enabled: v.enabled ?? true,
  }));
}

describe('renderer/config/env-editor.ts', () => {
  it('renders one row per entry and hands back a copy of them', () => {
    const container = host();
    const initial = entries({ key: 'A' }, { key: 'B' });
    const handle = buildEnvEditor(container, initial);
    expect(rows(container)).toHaveLength(2);
    const read = handle.getEntries();
    expect(read).toEqual(initial);
    // A copy: mutating what the caller got must not reach the editor.
    read[0].key = 'MUTATED';
    expect(handle.getEntries()[0].key).toBe('A');
  });

  it('dims and unchecks the master toggle when there are no entries', () => {
    const container = host();
    buildEnvEditor(container, []);
    const box = master(container);
    expect(box.checked).toBe(false);
    expect(box.indeterminate).toBe(false);
    expect(box.closest('label')?.style.opacity).toBe('0.45');
  });

  it('checks the master toggle only when every entry is enabled', () => {
    const container = host();
    buildEnvEditor(container, entries({ enabled: true }, { enabled: true }));
    expect(master(container).checked).toBe(true);
    expect(master(container).closest('label')?.style.opacity).toBe('');
  });

  it('shows the master toggle as indeterminate on a mixed selection', () => {
    const container = host();
    buildEnvEditor(container, entries({ enabled: true }, { enabled: false }));
    expect(master(container).checked).toBe(false);
    expect(master(container).indeterminate).toBe(true);
  });

  it('leaves the master toggle plain when every entry is disabled', () => {
    const container = host();
    buildEnvEditor(container, entries({ enabled: false }, { enabled: false }));
    expect(master(container).indeterminate).toBe(false);
  });

  it('applies the master toggle to every entry', () => {
    const container = host();
    const handle = buildEnvEditor(
      container,
      entries({ enabled: true }, { enabled: false }),
    );
    const box = master(container);
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(handle.getEntries().every((e) => e.enabled)).toBe(true);
  });

  it('tracks a per-entry toggle and re-syncs the master', () => {
    const container = host();
    const handle = buildEnvEditor(
      container,
      entries({ enabled: true }, { enabled: true }),
    );
    const toggle = fieldIn(rows(container)[0], 'input[type=checkbox]');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(handle.getEntries()[0].enabled).toBe(false);
    expect(master(container).indeterminate).toBe(true);
  });

  it('tracks typing in the key and value fields', () => {
    const container = host();
    const handle = buildEnvEditor(container, entries({}));
    const row = rows(container)[0];
    const keyInput = fieldIn(row, '.env-key');
    keyInput.value = 'PORT';
    keyInput.dispatchEvent(new Event('input'));
    const valueInput = fieldIn(row, '.env-value');
    valueInput.value = '3000';
    valueInput.dispatchEvent(new Event('input'));
    expect(handle.getEntries()[0]).toEqual({
      key: 'PORT',
      value: '3000',
      enabled: true,
    });
  });

  it('renders an entry with no key or value as empty fields', () => {
    const container = host();
    const handle = buildEnvEditor(container, [
      { key: '', value: '', enabled: false },
    ]);
    const row = rows(container)[0];
    expect(fieldIn(row, '.env-key').value).toBe('');
    expect(fieldIn(row, '.env-value').value).toBe('');
    expect(handle.getEntries()).toHaveLength(1);
  });

  it('removes the row the delete button belongs to', () => {
    const container = host();
    const handle = buildEnvEditor(
      container,
      entries({ key: 'A' }, { key: 'B' }),
    );
    const del =
      rows(container)[0].querySelector<HTMLButtonElement>('.env-delete');
    del?.click();
    expect(handle.getEntries().map((e) => e.key)).toEqual(['B']);
    expect(rows(container)).toHaveLength(1);
  });

  it('appends an enabled empty entry and focuses its key field', () => {
    const container = host();
    const handle = buildEnvEditor(container, entries({ key: 'A' }));
    addButton(container).click();
    expect(handle.getEntries()).toHaveLength(2);
    expect(handle.getEntries()[1]).toEqual({
      key: '',
      value: '',
      enabled: true,
    });
    expect(document.activeElement).toBe(
      rows(container)[1].querySelector('.env-key'),
    );
  });

  it('still accepts the legacy third options argument', () => {
    const container = host();
    const handle = buildEnvEditor(container, entries({ key: 'A' }), {});
    expect(handle.getEntries()).toHaveLength(1);
  });

  it('keeps setDisabled as an accepted no-op', () => {
    const container = host();
    const handle = buildEnvEditor(container, entries({ key: 'A' }));
    handle.setDisabled?.(true);
    expect(handle.getEntries()).toHaveLength(1);
  });
});
