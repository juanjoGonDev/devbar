import { openChangelog } from '../changelog.js';

export interface SidebarNavElements {
  nav: HTMLElement;
  windowTitle: HTMLElement;
  navCollapse: HTMLButtonElement;
  groupsCollapse: HTMLButtonElement;
  groupsTwoPane: HTMLElement;
}

export interface SidebarNav {
  showSection(target: string | undefined): void;
}

export function createSidebarNav(els: SidebarNavElements): SidebarNav {
  const navItems = [...document.querySelectorAll<HTMLElement>('.nav-item')];
  const sections = [
    ...document.querySelectorAll<HTMLElement>('.config-section'),
  ];

  function showSection(target: string | undefined): void {
    navItems.forEach((b) =>
      b.classList.toggle('active', b.dataset.target === target),
    );
    sections.forEach((s) =>
      s.classList.toggle('active', s.dataset.section === target),
    );
    // The section name lives in the title bar now. Take it from the nav item so
    // there is exactly one place where a section is named.
    const active = navItems.find((b) => b.dataset.target === target);
    const label =
      active?.querySelector<HTMLElement>('.nav-label')?.textContent?.trim() ??
      '';
    if (label) {
      els.windowTitle.textContent = label;
      document.title = `DevBar — ${label}`;
    }
    try {
      if (target) localStorage.setItem('config-section', target);
    } catch {
      /* localStorage unavailable — session-only nav is fine */
    }
  }

  navItems.forEach((b) =>
    b.addEventListener('click', () => showSection(b.dataset.target)),
  );

  // Dev-only simulation panel. Both the module and its IPC handlers are stripped
  // from packaged builds, so this stays inert there.
  void (async () => {
    if (!(await window.api.isDev())) return;
    const content = document.querySelector<HTMLElement>('.config-content');
    if (!content) return;
    try {
      const { mountDevPanel } = await import('../dev/dev-panel.js');
      const { navButton, section } = mountDevPanel(els.nav, content);
      navItems.push(navButton);
      sections.push(section);
      navButton.addEventListener('click', () => showSection('dev'));
    } catch {
      /* panel absent — nothing to mount */
    }
  })();

  function setNavCollapsed(on: boolean): void {
    els.nav.classList.toggle('collapsed', on);
    els.navCollapse.textContent = on ? '▨' : '◧';
    try {
      localStorage.setItem('config-nav-collapsed', on ? '1' : '0');
    } catch {
      /* ignore */
    }
  }
  els.navCollapse.addEventListener('click', () =>
    setNavCollapsed(!els.nav.classList.contains('collapsed')),
  );

  // Restore persisted nav state.
  try {
    const saved = localStorage.getItem('config-section');
    if (saved && navItems.some((b) => b.dataset.target === saved)) {
      showSection(saved);
    }
    setNavCollapsed(localStorage.getItem('config-nav-collapsed') === '1');
  } catch {
    /* ignore */
  }

  const aboutGithub = document.getElementById('about-github');
  if (aboutGithub) {
    aboutGithub.addEventListener('click', () =>
      window.api.openExternal('https://github.com/juanjoGonDev/devbar'),
    );
  }

  const reportIssue = document.getElementById('report-issue');
  if (reportIssue instanceof HTMLButtonElement) {
    reportIssue.addEventListener('click', () => {
      void reportIssueClick(reportIssue);
    });
  }

  // Collapsible groups list (focus the editor by hiding the list).
  function setGroupsListCollapsed(on: boolean): void {
    els.groupsTwoPane.classList.toggle('list-collapsed', on);
    // Same glyph and same semantics as the logs window's sidebar toggle: it
    // shows which side is folded rather than which way you are travelling.
    els.groupsCollapse.textContent = on ? '▨' : '◧';
    try {
      localStorage.setItem('groups-list-collapsed', on ? '1' : '0');
    } catch {
      /* ignore */
    }
  }
  if (els.groupsCollapse && els.groupsTwoPane) {
    els.groupsCollapse.addEventListener('click', () =>
      setGroupsListCollapsed(
        !els.groupsTwoPane.classList.contains('list-collapsed'),
      ),
    );
    try {
      setGroupsListCollapsed(
        localStorage.getItem('groups-list-collapsed') === '1',
      );
    } catch {
      /* ignore */
    }
  }

  // Deep-link from the tray version chip: jump to "Acerca de" + open changelog.
  if (window.api.onConfigGoto) {
    window.api.onConfigGoto((target) => {
      if (target === 'about' || target === 'about-changelog')
        showSection('about');
      if (target === 'about-changelog') {
        const el = document.getElementById('app-version');
        openChangelog(el ? el.textContent.replace(/^v/, '') : '');
      }
    });
  }

  return { showSection };
}

async function reportIssueClick(btn: HTMLButtonElement): Promise<void> {
  const original = btn.textContent;
  btn.disabled = true;
  try {
    const res = await window.api.reportIssue();
    // bodyIncluded: GitHub's form already carries the report — asking for
    // a paste would duplicate it. copied (with ok false): the browser did
    // not open, but the report IS on the clipboard — manual pasting works.
    btn.textContent = res.ok
      ? res.bodyIncluded
        ? '✓ Formulario preparado en GitHub'
        : '✓ Copiado — pégalo en GitHub'
      : res.copied
        ? '✓ Copiado — el navegador no se abrió; pégalo en GitHub'
        : 'No se pudo preparar';
  } catch {
    btn.textContent = 'No se pudo preparar';
  }
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 2500);
}
