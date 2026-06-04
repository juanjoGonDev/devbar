/**
 * silence-ui.js — shared pattern-list rendering helpers.
 *
 * IPC-agnostic: callers pass onAdd / onRemove callbacks.
 * Used by silenced.js (and potentially other renderers in the future).
 */

/**
 * Render a list of silence patterns into a <ul> element.
 *
 * @param {HTMLUListElement} ulEl      - The list to populate
 * @param {string[]}         patterns  - Array of pattern strings
 * @param {string}           level     - 'warn' | 'error'
 * @param {{ onRemove: (pattern: string) => void }} callbacks
 */
export function renderPatternList(ulEl, patterns, level, { onRemove }) {
  ulEl.innerHTML = '';
  if (!patterns || !patterns.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Ninguno';
    ulEl.appendChild(li);
    return;
  }
  for (const p of patterns) {
    const li = document.createElement('li');
    li.className = 'pattern-list-item';

    const span = document.createElement('span');
    span.className = 'pattern';
    span.textContent = p;
    span.title = p;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'unsilence';
    removeBtn.textContent = 'Quitar';
    removeBtn.addEventListener('click', () => {
      if (typeof onRemove === 'function') onRemove(p);
    });

    li.append(span, removeBtn);
    ulEl.appendChild(li);
  }
}

/**
 * Wire an "Add pattern" input + button for a given level.
 *
 * @param {HTMLInputElement}  inputEl  - The text input for the new pattern
 * @param {HTMLButtonElement} btnEl    - The "Añadir" button
 * @param {string}            level    - 'warn' | 'error'
 * @param {{ onAdd: (pattern: string) => void }} callbacks
 */
export function wireAddPattern(inputEl, btnEl, level, { onAdd }) {
  function submit() {
    const pattern = inputEl.value.trim();
    if (!pattern) return;
    if (typeof onAdd === 'function') onAdd(pattern);
    inputEl.value = '';
  }

  btnEl.addEventListener('click', submit);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
}
