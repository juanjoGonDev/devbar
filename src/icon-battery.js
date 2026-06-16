'use strict';

/**
 * icon-battery.js — curated list of 110+ tech/dev emojis for group/command/action icons.
 * Single source of truth — exposed via IPC (icons:get) and consumed by the renderer.
 * Each entry: { emoji, label, keywords: string[] }
 */

const ICON_BATTERY = [
  // ── Languages / Runtimes ────────────────────────────────────────────
  {
    emoji: '🐍',
    label: 'Python',
    keywords: ['python', 'snake', 'language', 'runtime', 'django', 'flask'],
  },
  {
    emoji: '☕',
    label: 'Java',
    keywords: ['java', 'coffee', 'jvm', 'language', 'runtime', 'spring'],
  },
  {
    emoji: '💎',
    label: 'Ruby',
    keywords: ['ruby', 'gem', 'rails', 'language', 'runtime'],
  },
  {
    emoji: '🦀',
    label: 'Rust',
    keywords: ['rust', 'crab', 'language', 'runtime', 'cargo'],
  },
  {
    emoji: '🐹',
    label: 'Go',
    keywords: ['go', 'golang', 'gopher', 'language', 'runtime'],
  },
  {
    emoji: '🐘',
    label: 'PHP',
    keywords: ['php', 'elephant', 'language', 'runtime', 'laravel'],
  },
  {
    emoji: '🌙',
    label: 'Lua',
    keywords: ['lua', 'moon', 'language', 'runtime', 'script'],
  },
  {
    emoji: '🔷',
    label: 'TypeScript',
    keywords: ['typescript', 'ts', 'language', 'types', 'microsoft'],
  },
  {
    emoji: '🟡',
    label: 'JavaScript',
    keywords: ['javascript', 'js', 'language', 'node', 'browser'],
  },
  {
    emoji: '🦕',
    label: 'Deno',
    keywords: ['deno', 'dinosaur', 'runtime', 'typescript', 'secure'],
  },

  // ── Frameworks ─────────────────────────────────────────────────────
  {
    emoji: '⚛️',
    label: 'React',
    keywords: ['react', 'atom', 'frontend', 'framework', 'jsx'],
  },
  {
    emoji: '🅰️',
    label: 'Angular',
    keywords: ['angular', 'framework', 'frontend', 'typescript', 'spa'],
  },
  {
    emoji: '🌀',
    label: 'Vue',
    keywords: ['vue', 'spiral', 'framework', 'frontend', 'nuxt'],
  },
  {
    emoji: '🔺',
    label: 'Nuxt',
    keywords: ['nuxt', 'triangle', 'framework', 'vue', 'ssr'],
  },
  {
    emoji: '🟢',
    label: 'Node',
    keywords: ['node', 'nodejs', 'runtime', 'server', 'javascript'],
  },
  {
    emoji: '🌿',
    label: 'NestJS',
    keywords: ['nest', 'nestjs', 'branch', 'backend', 'framework'],
  },
  {
    emoji: '💨',
    label: 'Tailwind',
    keywords: ['tailwind', 'css', 'wind', 'utility', 'frontend'],
  },
  {
    emoji: '⚗️',
    label: 'Svelte',
    keywords: ['svelte', 'flask', 'frontend', 'framework', 'compiler'],
  },
  {
    emoji: '🏃',
    label: 'Express',
    keywords: ['express', 'run', 'backend', 'http', 'node'],
  },
  {
    emoji: '🦋',
    label: 'Flutter',
    keywords: ['flutter', 'butterfly', 'mobile', 'dart', 'ui'],
  },

  // ── Frontend ───────────────────────────────────────────────────────
  {
    emoji: '🎨',
    label: 'Frontend',
    keywords: ['frontend', 'design', 'css', 'ui', 'styles'],
  },
  {
    emoji: '🌐',
    label: 'Web',
    keywords: ['web', 'browser', 'html', 'internet', 'http'],
  },
  {
    emoji: '🖥',
    label: 'Desktop',
    keywords: ['desktop', 'app', 'electron', 'native', 'screen'],
  },
  {
    emoji: '📱',
    label: 'Mobile',
    keywords: ['mobile', 'app', 'ios', 'android', 'responsive'],
  },
  {
    emoji: '🖼',
    label: 'UI/Assets',
    keywords: ['ui', 'assets', 'images', 'icons', 'graphics'],
  },
  {
    emoji: '✨',
    label: 'Polish',
    keywords: ['polish', 'sparkle', 'animation', 'ux', 'detail'],
  },
  {
    emoji: '🪟',
    label: 'Window',
    keywords: ['window', 'panel', 'modal', 'dialog', 'overlay'],
  },
  {
    emoji: '🎛',
    label: 'Controls',
    keywords: ['controls', 'sliders', 'settings', 'inputs', 'form'],
  },

  // ── Backend / API ──────────────────────────────────────────────────
  {
    emoji: '⚙️',
    label: 'Backend',
    keywords: ['backend', 'server', 'config', 'gear', 'service'],
  },
  {
    emoji: '🛠',
    label: 'Tooling',
    keywords: ['tooling', 'tools', 'build', 'dev', 'scripts'],
  },
  {
    emoji: '🧰',
    label: 'Toolkit',
    keywords: ['toolkit', 'tools', 'utilities', 'kit', 'helpers'],
  },
  {
    emoji: '🔌',
    label: 'API/Plugin',
    keywords: ['api', 'plugin', 'integration', 'connect', 'endpoint'],
  },
  {
    emoji: '📡',
    label: 'Realtime',
    keywords: ['realtime', 'websocket', 'push', 'sse', 'streaming'],
  },
  {
    emoji: '🚀',
    label: 'Deploy',
    keywords: ['deploy', 'launch', 'release', 'ship', 'rocket'],
  },
  {
    emoji: '🛰',
    label: 'Edge',
    keywords: ['edge', 'cdn', 'satellite', 'remote', 'worker'],
  },
  {
    emoji: '🪝',
    label: 'Webhook',
    keywords: ['webhook', 'hook', 'callback', 'event', 'trigger'],
  },
  {
    emoji: '⛓',
    label: 'Chain',
    keywords: ['chain', 'linked', 'middleware', 'pipeline', 'flow'],
  },
  {
    emoji: '🛤',
    label: 'Routes',
    keywords: ['routes', 'router', 'path', 'url', 'endpoint'],
  },

  // ── Data / DB ──────────────────────────────────────────────────────
  {
    emoji: '🗄',
    label: 'Database',
    keywords: ['database', 'db', 'sql', 'storage', 'postgres'],
  },
  {
    emoji: '🗃',
    label: 'Storage',
    keywords: ['storage', 'files', 'filesystem', 'data', 'archive'],
  },
  {
    emoji: '📊',
    label: 'Analytics',
    keywords: ['analytics', 'chart', 'dashboard', 'stats', 'report'],
  },
  {
    emoji: '📈',
    label: 'Metrics',
    keywords: ['metrics', 'growth', 'chart', 'trend', 'monitoring'],
  },
  {
    emoji: '📉',
    label: 'Trend Down',
    keywords: ['downtrend', 'chart', 'analytics', 'metrics', 'decrease'],
  },
  {
    emoji: '🧮',
    label: 'Compute',
    keywords: ['compute', 'math', 'calculation', 'abacus', 'data'],
  },
  {
    emoji: '💾',
    label: 'Cache',
    keywords: ['cache', 'disk', 'save', 'persist', 'redis'],
  },
  {
    emoji: '🪣',
    label: 'Bucket',
    keywords: ['bucket', 's3', 'storage', 'blob', 'object'],
  },
  {
    emoji: '🧠',
    label: 'AI/ML',
    keywords: ['ai', 'ml', 'intelligence', 'brain', 'model'],
  },

  // ── DevOps / Cloud ─────────────────────────────────────────────────
  {
    emoji: '🐳',
    label: 'Docker',
    keywords: ['docker', 'container', 'whale', 'image', 'compose'],
  },
  {
    emoji: '☸️',
    label: 'Kubernetes',
    keywords: ['kubernetes', 'k8s', 'cluster', 'pod', 'helm'],
  },
  {
    emoji: '☁️',
    label: 'Cloud',
    keywords: ['cloud', 'aws', 'gcp', 'azure', 'hosted'],
  },
  {
    emoji: '⛅',
    label: 'Hybrid',
    keywords: ['hybrid', 'cloud', 'mixed', 'infra', 'partial'],
  },
  {
    emoji: '🌩',
    label: 'Storm/CF',
    keywords: ['cloudfront', 'cdn', 'storm', 'thunder', 'serverless'],
  },
  {
    emoji: '🏷',
    label: 'Tag',
    keywords: ['tag', 'label', 'release', 'version', 'git'],
  },
  {
    emoji: '🔁',
    label: 'CI/Loop',
    keywords: ['ci', 'loop', 'cycle', 'repeat', 'pipeline'],
  },
  {
    emoji: '♻️',
    label: 'Recycle',
    keywords: ['recycle', 'ci', 'clean', 'rebuild', 'refresh'],
  },
  {
    emoji: '🏗',
    label: 'Build',
    keywords: ['build', 'scaffold', 'compile', 'construct', 'infra'],
  },
  {
    emoji: '🚦',
    label: 'Traffic',
    keywords: ['traffic', 'queue', 'signals', 'rate', 'throttle'],
  },
  {
    emoji: '🚥',
    label: 'Pipeline',
    keywords: ['pipeline', 'ci', 'stages', 'status', 'checks'],
  },
  {
    emoji: '📦',
    label: 'Package',
    keywords: ['package', 'bundle', 'npm', 'release', 'artifact'],
  }, // DEFAULT
  {
    emoji: '🧱',
    label: 'Brick',
    keywords: ['brick', 'block', 'module', 'component', 'monolith'],
  },

  // ── Tests / Quality ────────────────────────────────────────────────
  {
    emoji: '🧪',
    label: 'Tests',
    keywords: ['tests', 'unit', 'testing', 'vitest', 'jest'],
  },
  {
    emoji: '✅',
    label: 'Pass',
    keywords: ['pass', 'check', 'success', 'done', 'green'],
  },
  {
    emoji: '❌',
    label: 'Fail',
    keywords: ['fail', 'error', 'cross', 'failure', 'reject'],
  },
  {
    emoji: '🧫',
    label: 'E2E',
    keywords: ['e2e', 'integration', 'playwright', 'cypress', 'lab'],
  },
  {
    emoji: '🔬',
    label: 'Deep test',
    keywords: ['debug', 'deep', 'microscope', 'inspect', 'trace'],
  },
  {
    emoji: '🩺',
    label: 'Healthcheck',
    keywords: ['health', 'check', 'monitor', 'probe', 'status'],
  },
  {
    emoji: '🎯',
    label: 'Target',
    keywords: ['target', 'goal', 'focus', 'scope', 'aim'],
  },

  // ── Tools / Editor ─────────────────────────────────────────────────
  {
    emoji: '💻',
    label: 'Terminal',
    keywords: ['terminal', 'cli', 'shell', 'laptop', 'console'],
  },
  {
    emoji: '⌨️',
    label: 'Keyboard',
    keywords: ['keyboard', 'typing', 'input', 'shortcut', 'keys'],
  },
  {
    emoji: '🖱',
    label: 'Mouse',
    keywords: ['mouse', 'cursor', 'click', 'pointer', 'input'],
  },
  {
    emoji: '🪛',
    label: 'Screwdriver',
    keywords: ['screwdriver', 'fix', 'config', 'tweak', 'tool'],
  },
  {
    emoji: '🔧',
    label: 'Config',
    keywords: ['config', 'wrench', 'settings', 'options', 'tweak'],
  },
  {
    emoji: '🔨',
    label: 'Build',
    keywords: ['build', 'hammer', 'compile', 'make', 'task'],
  },
  {
    emoji: '⚒️',
    label: 'Maintenance',
    keywords: ['maintenance', 'repair', 'devops', 'tools', 'fix'],
  },

  // ── Logs / Monitor / Search ────────────────────────────────────────
  {
    emoji: '🔍',
    label: 'Search',
    keywords: ['search', 'find', 'lint', 'grep', 'query'],
  },
  {
    emoji: '🔎',
    label: 'Inspect',
    keywords: ['inspect', 'zoom', 'audit', 'review', 'trace'],
  },
  {
    emoji: '📋',
    label: 'Clipboard',
    keywords: ['clipboard', 'copy', 'list', 'tasks', 'board'],
  },
  {
    emoji: '📜',
    label: 'Logs',
    keywords: ['logs', 'scroll', 'history', 'output', 'stdout'],
  },
  {
    emoji: '📝',
    label: 'Notes',
    keywords: ['notes', 'docs', 'write', 'memo', 'comment'],
  },
  {
    emoji: '📚',
    label: 'Docs',
    keywords: ['docs', 'documentation', 'books', 'reference', 'readme'],
  },
  {
    emoji: '🪧',
    label: 'Signpost',
    keywords: ['signpost', 'guide', 'roadmap', 'label', 'info'],
  },

  // ── Security / Auth ────────────────────────────────────────────────
  {
    emoji: '🔐',
    label: 'Locked+key',
    keywords: ['secure', 'key', 'lock', 'token', 'secret'],
  },
  {
    emoji: '🔒',
    label: 'Security',
    keywords: ['security', 'lock', 'private', 'protected', 'auth'],
  },
  {
    emoji: '🔓',
    label: 'Public',
    keywords: ['public', 'unlock', 'open', 'exposed', 'access'],
  },
  {
    emoji: '🔑',
    label: 'Auth',
    keywords: ['auth', 'key', 'token', 'login', 'jwt'],
  },
  {
    emoji: '🗝',
    label: 'Old Key',
    keywords: ['key', 'legacy', 'session', 'classic', 'access'],
  },
  {
    emoji: '🛡',
    label: 'Shield',
    keywords: ['shield', 'guard', 'protect', 'firewall', 'waf'],
  },
  {
    emoji: '🪪',
    label: 'ID Card',
    keywords: ['identity', 'id', 'card', 'user', 'profile'],
  },

  // ── Network / Realtime ─────────────────────────────────────────────
  {
    emoji: '📶',
    label: 'Signal',
    keywords: ['signal', 'network', 'wifi', 'strength', 'ping'],
  },
  {
    emoji: '🛜',
    label: 'WiFi',
    keywords: ['wifi', 'wireless', 'network', 'connect', 'local'],
  },
  {
    emoji: '📨',
    label: 'Email',
    keywords: ['email', 'message', 'send', 'inbox', 'smtp'],
  },
  {
    emoji: '💬',
    label: 'Chat',
    keywords: ['chat', 'message', 'slack', 'notify', 'webhook'],
  },

  // ── Time / Scheduling ─────────────────────────────────────────────
  {
    emoji: '⏱',
    label: 'Timer',
    keywords: ['timer', 'stopwatch', 'perf', 'benchmark', 'measure'],
  },
  {
    emoji: '⏰',
    label: 'Alarm',
    keywords: ['alarm', 'schedule', 'cron', 'alert', 'reminder'],
  },
  {
    emoji: '⌛',
    label: 'Timeout',
    keywords: ['timeout', 'wait', 'deadline', 'expire', 'ttl'],
  },
  {
    emoji: '⏳',
    label: 'Pending',
    keywords: ['pending', 'loading', 'wait', 'async', 'queue'],
  },
  {
    emoji: '📅',
    label: 'Calendar',
    keywords: ['calendar', 'schedule', 'date', 'cron', 'plan'],
  },

  // ── Dev Workflow ───────────────────────────────────────────────────
  {
    emoji: '🐛',
    label: 'Bug',
    keywords: ['bug', 'issue', 'debug', 'fix', 'error'],
  },
  {
    emoji: '🪲',
    label: 'Debug',
    keywords: ['debug', 'trace', 'breakpoint', 'inspect', 'beetle'],
  },
  {
    emoji: '🌱',
    label: 'Seed',
    keywords: ['seed', 'sprout', 'start', 'new', 'init'],
  },
  {
    emoji: '🔥',
    label: 'Hot',
    keywords: ['hot', 'hot-reload', 'fast', 'critical', 'fire'],
  },
  {
    emoji: '⚡',
    label: 'Fast',
    keywords: ['fast', 'speed', 'perf', 'quick', 'turbo'],
  },
  {
    emoji: '🧩',
    label: 'Plugin',
    keywords: ['plugin', 'module', 'piece', 'addon', 'extension'],
  },
  {
    emoji: '🌾',
    label: 'Harvest',
    keywords: ['harvest', 'branch', 'fresh', 'grow', 'output'],
  },
  {
    emoji: '💡',
    label: 'Idea',
    keywords: ['idea', 'tip', 'hint', 'proposal', 'concept'],
  },
  {
    emoji: '🪄',
    label: 'Magic',
    keywords: ['magic', 'auto', 'generate', 'codegen', 'transform'],
  },
  {
    emoji: '🎁',
    label: 'Release',
    keywords: ['release', 'gift', 'version', 'launch', 'ship'],
  },
  {
    emoji: '🏁',
    label: 'Finish',
    keywords: ['finish', 'done', 'complete', 'end', 'final'],
  },

  // ── AI / ML ───────────────────────────────────────────────────────
  {
    emoji: '🤖',
    label: 'Bot/Worker',
    keywords: ['bot', 'worker', 'robot', 'ai', 'automation'],
  },
  {
    emoji: '🧬',
    label: 'AI/ML',
    keywords: ['ai', 'ml', 'model', 'neural', 'genetics'],
  },
  {
    emoji: '🪞',
    label: 'Mirror',
    keywords: ['mirror', 'reflect', 'sync', 'clone', 'replicate'],
  },

  // ── Misc Dev ──────────────────────────────────────────────────────
  {
    emoji: '🎲',
    label: 'Random',
    keywords: ['random', 'seed', 'test', 'mock', 'dice'],
  },
  {
    emoji: '🎚',
    label: 'Levels',
    keywords: ['levels', 'control', 'slider', 'config', 'tune'],
  },
  {
    emoji: '💰',
    label: 'Billing',
    keywords: ['billing', 'payment', 'money', 'cost', 'price'],
  },
  {
    emoji: '🏦',
    label: 'Finance',
    keywords: ['finance', 'bank', 'payment', 'stripe', 'accounting'],
  },
];

module.exports = { ICON_BATTERY };
