import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Defect 2+3 remediation: `.service-row-card`, `.nav-card`, `.sub-item-row`,
// `.prescript-row` and `.prestep-card` used to each carry their own copy of
// the same draggable-row pattern (handle reveal, dragging state, drop
// indicator). This asserts they now share ONE `.drag-row` base, and that
// each context only overrides the custom properties that genuinely differ.
//
// This repo has no DOM environment (vitest.config.ts declares none), so —
// like `renderer-dom-contract.test.ts` — this is a static-source contract
// over the actual shipped CSS/TS text rather than a rendered assertion.

const rendererDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../renderer',
);
const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
const pipelineEditorSource = fs.readFileSync(
  path.join(rendererDir, 'pipeline-editor.ts'),
  'utf8',
);
const configSource = fs.readFileSync(
  path.join(rendererDir, 'config.ts'),
  'utf8',
);
const dndHelperSource = fs.readFileSync(
  path.join(rendererDir, 'dnd-helper.ts'),
  'utf8',
);

function esc(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Body of the LAST `selector { ... }` block found verbatim in `source`. Last
 * rather than first: a selector that is also the tail entry of an earlier
 * comma-separated list (e.g. `.a,\n.b { … }` followed by a standalone
 * `.b { … }` override) would otherwise match that shared list's body
 * instead of its own dedicated rule.
 */
function ruleBody(source: string, selector: string): string {
  const matches = [
    ...source.matchAll(new RegExp(`${esc(selector)}\\s*\\{([^}]*)\\}`, 'g')),
  ];
  const last = matches.at(-1);
  if (!last) throw new Error(`CSS rule not found for selector: ${selector}`);
  return last[1];
}

function declaresExactly(
  body: string,
  property: string,
  value: string,
): boolean {
  return new RegExp(`${esc(property)}:\\s*${esc(value)}\\s*;`).test(body);
}

describe('shared .drag-row pattern (defect 2+3 remediation)', () => {
  it('declares the common handle idle/hover styling once, with fallback defaults', () => {
    const handle = ruleBody(css, '.drag-row .drag-handle');
    expect(
      declaresExactly(
        handle,
        'opacity',
        'var(--drag-handle-idle-opacity, 0.3)',
      ),
    ).toBe(true);
    expect(
      declaresExactly(
        handle,
        'font-size',
        'var(--drag-handle-font-size, 12px)',
      ),
    ).toBe(true);
    expect(
      declaresExactly(handle, 'padding', 'var(--drag-handle-padding, 2px 1px)'),
    ).toBe(true);

    const hover = ruleBody(css, '.drag-row:hover .drag-handle');
    expect(
      declaresExactly(
        hover,
        'opacity',
        'var(--drag-handle-hover-opacity, 0.7)',
      ),
    ).toBe(true);
  });

  it('declares the common dragging state once', () => {
    const dragging = ruleBody(css, '.drag-row.dragging');
    expect(declaresExactly(dragging, 'opacity', '0.35')).toBe(true);
  });

  it('declares the common drop-indicator bar once, with fallback inset/offset', () => {
    const bar = ruleBody(
      css,
      '.drag-row.drag-over-before::before,\n.drag-row.drag-over-after::after',
    );
    expect(
      declaresExactly(bar, 'left', 'var(--drop-indicator-inset, 4px)'),
    ).toBe(true);
    expect(
      declaresExactly(bar, 'right', 'var(--drop-indicator-inset, 4px)'),
    ).toBe(true);

    const before = ruleBody(css, '.drag-row.drag-over-before::before');
    expect(
      declaresExactly(
        before,
        'top',
        'calc(-1 * var(--drop-indicator-offset, 2px))',
      ),
    ).toBe(true);
    const after = ruleBody(css, '.drag-row.drag-over-after::after');
    expect(
      declaresExactly(
        after,
        'bottom',
        'calc(-1 * var(--drop-indicator-offset, 2px))',
      ),
    ).toBe(true);
  });

  it('.service-row-card overrides every custom property with its own distinct values', () => {
    const body = ruleBody(css, '.service-row-card');
    expect(declaresExactly(body, '--drag-handle-idle-opacity', '0.35')).toBe(
      true,
    );
    expect(declaresExactly(body, '--drag-handle-hover-opacity', '0.8')).toBe(
      true,
    );
    expect(declaresExactly(body, '--drag-handle-font-size', '13px')).toBe(true);
    expect(declaresExactly(body, '--drag-handle-padding', '4px 2px')).toBe(
      true,
    );
    expect(declaresExactly(body, '--drop-indicator-inset', '8px')).toBe(true);
    expect(declaresExactly(body, '--drop-indicator-offset', '5px')).toBe(true);
    // The two "where present" extras this context alone keeps.
    expect(
      declaresExactly(
        ruleBody(css, '.service-row-card .drag-handle:hover'),
        'opacity',
        '1',
      ),
    ).toBe(true);
    expect(
      declaresExactly(
        ruleBody(css, '.service-row-card .drag-handle:active'),
        'cursor',
        'grabbing',
      ),
    ).toBe(true);
  });

  it('.nav-card overrides only the drop-indicator offset, and keeps its handle-hover extra', () => {
    const body = ruleBody(css, '.nav-card');
    expect(declaresExactly(body, '--drop-indicator-offset', '2px')).toBe(true);
    expect(body.includes('--drag-handle-idle-opacity')).toBe(false);
    expect(
      declaresExactly(
        ruleBody(css, '.nav-card .drag-handle:hover'),
        'opacity',
        '1',
      ),
    ).toBe(true);
  });

  it('.sub-item-row overrides only the drop-indicator offset, with no extra handle rules', () => {
    const body = ruleBody(css, '.sub-item-row');
    expect(declaresExactly(body, '--drop-indicator-offset', '3px')).toBe(true);
    expect(body.includes('--drag-handle-idle-opacity')).toBe(false);
    expect(/\.sub-item-row \.drag-handle:hover/.test(css)).toBe(false);
  });

  it('the pipeline editor opts prescript rows and step cards into the shared pattern', () => {
    expect(/['"]prescript-row drag-row['"]/.test(pipelineEditorSource)).toBe(
      true,
    );
    expect(/['"]prestep-card drag-row['"]/.test(pipelineEditorSource)).toBe(
      true,
    );
  });

  it('the group nav card and sub-item row creation sites opt into the shared pattern', () => {
    expect(/nav-card drag-row/.test(configSource)).toBe(true);
    expect(/['"]sub-item-row drag-row['"]/.test(configSource)).toBe(true);
  });

  it('keeps the existing empty-container drop-zone affordance working', () => {
    const body = ruleBody(css, '.prescript-list.drop-zone-active');
    expect(declaresExactly(body, 'outline', '2px dashed var(--accent)')).toBe(
      true,
    );
  });

  it('highlights the whole step card while a script is dragged over it, like the approved reference', () => {
    const body = ruleBody(css, '.prestep-card:has(.prescript-list.drop-into)');
    expect(declaresExactly(body, 'border-color', 'var(--accent)')).toBe(true);
    expect(/background:/.test(body)).toBe(true);
    // Something must actually apply that class while dragging over the step.
    expect(/classList\.add\('drop-into'\)/.test(dndHelperSource)).toBe(true);
  });
});
