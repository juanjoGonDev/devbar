import type { SilenceLevel } from '../src/ipc-contract.js';

export function renderPatternList(
  list: HTMLUListElement,
  patterns: readonly string[],
  _level: SilenceLevel,
  { onRemove }: { onRemove: (pattern: string) => unknown },
): void {
  list.innerHTML = '';
  if (patterns.length === 0) {
    const item = document.createElement('li');
    item.className = 'empty';
    item.textContent = 'Ninguno';
    list.appendChild(item);
    return;
  }
  for (const pattern of patterns) {
    const item = document.createElement('li');
    item.className = 'pattern-list-item';
    const span = document.createElement('span');
    span.className = 'pattern';
    span.textContent = pattern;
    span.title = pattern;
    const remove = document.createElement('button');
    remove.className = 'unsilence';
    remove.textContent = 'Quitar';
    remove.addEventListener('click', () => {
      void onRemove(pattern);
    });
    item.append(span, remove);
    list.appendChild(item);
  }
}
export function wireAddPattern(
  input: HTMLInputElement,
  button: HTMLButtonElement,
  _level: SilenceLevel,
  { onAdd }: { onAdd: (pattern: string) => unknown },
): void {
  const submit = (): void => {
    const pattern = input.value.trim();
    if (!pattern) return;
    void onAdd(pattern);
    input.value = '';
  };
  button.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  });
}
