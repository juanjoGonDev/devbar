import { describe, expect, it } from 'vitest';

import { ansiToHtml, stripAnsi } from '../renderer/logs/ansi.js';

const ESC = '';

describe('renderer/logs/ansi.ts', () => {
  describe('stripAnsi', () => {
    it('removes colour without touching the text it wrapped', () => {
      expect(stripAnsi(`${ESC}[31mboom${ESC}[0m`)).toBe('boom');
    });

    it('removes sequences that are not colour at all', () => {
      // Cursor moves and screen clears live in the same stream as colour: a
      // filter that only knew about SGR would leave them in the copied line.
      expect(stripAnsi(`${ESC}[2J${ESC}[1;1Hhola`)).toBe('hola');
    });

    it('answers for an empty line instead of throwing', () => {
      expect(stripAnsi('')).toBe('');
    });
  });

  describe('ansiToHtml', () => {
    it('leaves a plain line as plain text', () => {
      expect(ansiToHtml('nada que colorear')).toBe('nada que colorear');
    });

    it('escapes markup so a log line can never inject HTML', () => {
      expect(ansiToHtml(`<img src=x onerror="alert('&')">`)).toBe(
        '&lt;img src=x onerror=&quot;alert(&#39;&amp;&#39;)&quot;&gt;',
      );
    });

    it('escapes markup inside a styled run too', () => {
      expect(ansiToHtml(`${ESC}[31m<b>${ESC}[0m`)).toBe(
        '<span style="color:#ff6961">&lt;b&gt;</span>',
      );
    });

    it('drops carriage returns, which a progress bar emits by the hundred', () => {
      expect(ansiToHtml('uno\rdos')).toBe('unodos');
    });

    it('paints a foreground colour from the 16-colour palette', () => {
      expect(ansiToHtml(`${ESC}[32mok`)).toBe(
        '<span style="color:#5fdb86">ok</span>',
      );
    });

    it('paints a background colour from the 16-colour palette', () => {
      expect(ansiToHtml(`${ESC}[41mstop`)).toBe(
        '<span style="background:#ff453a">stop</span>',
      );
    });

    it('combines every attribute a single SGR run can set', () => {
      const html = ansiToHtml(`${ESC}[1;2;3;4;31mtodo`);
      expect(html).toBe(
        '<span style="color:#ff6961;font-weight:600;opacity:0.65;' +
          'font-style:italic;text-decoration:underline">todo</span>',
      );
    });

    it('treats an empty parameter list as a reset', () => {
      // `ESC[m` is the shorthand form: no digits at all means code 0.
      expect(ansiToHtml(`${ESC}[31ma${ESC}[mb`)).toBe(
        '<span style="color:#ff6961">a</span>b',
      );
    });

    it('turns bold and dim off together on code 22', () => {
      expect(ansiToHtml(`${ESC}[1;2ma${ESC}[22mb`)).toBe(
        '<span style="font-weight:600;opacity:0.65">a</span>b',
      );
    });

    it('turns italic off on 23 and underline off on 24', () => {
      expect(ansiToHtml(`${ESC}[3;4ma${ESC}[23m${ESC}[24mb`)).toBe(
        '<span style="font-style:italic;text-decoration:underline">a</span>b',
      );
    });

    it('clears only the foreground on 39 and only the background on 49', () => {
      expect(ansiToHtml(`${ESC}[31;41ma${ESC}[39mb${ESC}[49mc`)).toBe(
        '<span style="color:#ff6961;background:#ff453a">a</span>' +
          '<span style="background:#ff453a">b</span>c',
      );
    });

    it('reads a 256-colour foreground from the low 16 slots', () => {
      expect(ansiToHtml(`${ESC}[38;5;1mrojo`)).toBe(
        '<span style="color:#ff6961">rojo</span>',
      );
    });

    it('reads a 256-colour foreground from the 6×6×6 cube', () => {
      // 16 + 36*5 + 6*0 + 0 = 196, the cube's pure red corner.
      expect(ansiToHtml(`${ESC}[38;5;196mcubo`)).toBe(
        '<span style="color:rgb(255,0,0)">cubo</span>',
      );
    });

    it('reads a 256-colour foreground from the grey ramp', () => {
      expect(ansiToHtml(`${ESC}[38;5;232mgris`)).toBe(
        '<span style="color:rgb(8,8,8)">gris</span>',
      );
    });

    it('reads a 256-colour background', () => {
      expect(ansiToHtml(`${ESC}[48;5;21mfondo`)).toBe(
        '<span style="background:rgb(0,0,255)">fondo</span>',
      );
    });

    it('reads a truecolor foreground', () => {
      expect(ansiToHtml(`${ESC}[38;2;10;20;30mrgb`)).toBe(
        '<span style="color:rgb(10,20,30)">rgb</span>',
      );
    });

    it('reads a truecolor background', () => {
      expect(ansiToHtml(`${ESC}[48;2;1;2;3mrgb`)).toBe(
        '<span style="background:rgb(1,2,3)">rgb</span>',
      );
    });

    it('clamps truecolor components a stream got wrong', () => {
      expect(ansiToHtml(`${ESC}[38;2;999;20mclamp`)).toBe(
        '<span style="color:rgb(255,20,0)">clamp</span>',
      );
    });

    it('ignores a sequence that is not an SGR one', () => {
      // `H` moves the cursor. It is consumed — never printed — but it must not
      // be mistaken for a style change either.
      expect(ansiToHtml(`${ESC}[1;1Htexto`)).toBe('texto');
    });

    it('ignores an SGR code it has no rule for', () => {
      expect(ansiToHtml(`${ESC}[53msobrelinea`)).toBe('sobrelinea');
    });

    it('starts each line from a clean style, not from the previous one', () => {
      // The regex is a module-level /g/: a call that forgot to rewind it would
      // make the second line start mid-match and lose its colour.
      ansiToHtml(`${ESC}[31mprimera`);
      expect(ansiToHtml(`${ESC}[32msegunda`)).toBe(
        '<span style="color:#5fdb86">segunda</span>',
      );
    });
  });
});
