import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every byId(id, Ctor) assertion in a renderer module runs at load time and
// throws on a tag mismatch, killing the whole window (ES module evaluation
// aborts). This test cross-checks each assertion against the actual tag in
// the window's HTML so a wrong constructor fails here instead of in the app.

const rendererDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../renderer',
);

const WINDOWS: ReadonlyArray<[script: string, html: string]> = [
  ['config.ts', 'config.html'],
  ['tray.ts', 'tray.html'],
  ['logs.ts', 'logs.html'],
  ['notification.ts', 'notification.html'],
  ['prescript-confirm.ts', 'prescript-confirm.html'],
  ['silenced.ts', 'silenced.html'],
];

const TAGS_BY_CONSTRUCTOR: Record<string, readonly string[]> = {
  HTMLInputElement: ['input'],
  HTMLTextAreaElement: ['textarea'],
  HTMLSelectElement: ['select'],
  HTMLButtonElement: ['button'],
  HTMLDialogElement: ['dialog'],
  HTMLDivElement: ['div'],
  HTMLSpanElement: ['span'],
  HTMLUListElement: ['ul'],
  HTMLOListElement: ['ol'],
  HTMLLIElement: ['li'],
  HTMLAnchorElement: ['a'],
  HTMLLabelElement: ['label'],
  HTMLParagraphElement: ['p'],
  HTMLPreElement: ['pre'],
  HTMLImageElement: ['img'],
  HTMLFormElement: ['form'],
  HTMLTableElement: ['table'],
  HTMLHeadingElement: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
};

interface ByIdCall {
  id: string;
  ctor: string;
}

// Matches both single-line and multi-line calls, with or without the generic
// and a trailing comma: byId<HTMLInputElement>('sf-name', HTMLInputElement,)
const BY_ID_CALL = /byId(?:<[^>]+>)?\(\s*'([^']+)'\s*,\s*(\w+)\s*,?\s*\)/g;

function byIdCalls(source: string): ByIdCall[] {
  return Array.from(source.matchAll(BY_ID_CALL), (match) => ({
    id: match[1],
    ctor: match[2],
  }));
}

function tagForId(html: string, id: string): string | null {
  const match = html.match(
    new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)(?:\\s[^>]*)?\\sid="${id}"`),
  );
  return match ? match[1].toLowerCase() : null;
}

describe('renderer byId assertions match their window HTML', () => {
  for (const [script, html] of WINDOWS) {
    describe(script, () => {
      const source = fs.readFileSync(path.join(rendererDir, script), 'utf8');
      const markup = fs.readFileSync(path.join(rendererDir, html), 'utf8');
      const calls = byIdCalls(source);

      it('parses every byId call in the file', () => {
        const occurrences = source.match(/\bbyId(?:<[^>]+>)?\(/g) ?? [];
        // Calls whose id is an expression (e.g. a ternary) can't be checked
        // statically; count them so no literal call slips past unparsed.
        const dynamic = source.match(/\bbyId(?:<[^>]+>)?\(\s*[^'\s]/g) ?? [];
        expect(calls.length + dynamic.length).toBe(occurrences.length);
      });

      for (const call of calls) {
        it(`#${call.id} satisfies ${call.ctor}`, () => {
          const tag = tagForId(markup, call.id);
          expect(tag, `#${call.id} not found in ${html}`).not.toBeNull();
          const allowed = TAGS_BY_CONSTRUCTOR[call.ctor];
          if (allowed === undefined) {
            // HTMLElement/Element and other broad bases accept any tag.
            expect(['HTMLElement', 'Element']).toContain(call.ctor);
            return;
          }
          expect(
            allowed,
            `#${call.id} is <${tag}> but ${script} asserts ${call.ctor}`,
          ).toContain(tag);
        });
      }
    });
  }
});
