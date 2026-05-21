function tokenize(cmdline) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let hasContent = false;
  for (let i = 0; i < cmdline.length; i++) {
    const ch = cmdline[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && i + 1 < cmdline.length) {
        cur += cmdline[++i];
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasContent = true;
    } else if (ch === ' ' || ch === '\t') {
      if (hasContent) {
        tokens.push(cur);
        cur = '';
        hasContent = false;
      }
    } else if (ch === '\\' && i + 1 < cmdline.length) {
      cur += cmdline[++i];
      hasContent = true;
    } else {
      cur += ch;
      hasContent = true;
    }
  }
  if (hasContent) tokens.push(cur);
  return tokens;
}

const SHELL_META = /[&|;<>$`*?(){}\[\]]/;

function hasShellMeta(s) {
  return SHELL_META.test(s);
}

function splitCommand(command, args) {
  const cmd = (command || '').trim();
  if (!cmd) return { command: '', args: args || [] };
  if (args && args.length > 0) return { command: cmd, args };
  if (!/\s/.test(cmd)) return { command: cmd, args: [] };
  if (hasShellMeta(cmd)) return { command: cmd, args: [] };
  const tokens = tokenize(cmd);
  if (tokens.length <= 1) return { command: cmd, args: [] };
  return { command: tokens[0], args: tokens.slice(1) };
}

function shellQuote(s) {
  if (s === '' || s == null) return "''";
  if (/^[A-Za-z0-9_\-./:=@+,]+$/.test(s)) return s;
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function buildCmdline(command, args) {
  const cmd = (command || '').trim();
  if (!args || args.length === 0) return cmd;
  if (args.some(hasShellMeta)) {
    return cmd + ' ' + args.join(' ');
  }
  return cmd + ' ' + args.map(shellQuote).join(' ');
}

module.exports = { tokenize, splitCommand, hasShellMeta, shellQuote, buildCmdline };
