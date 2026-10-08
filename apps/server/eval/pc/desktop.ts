/**
 * The scripted PC's screen: a GNOME-like desktop with Terminal, Browser and Files icons, a browser that only reaches
 * the office wiki (start page with a search box, search results, the wiki home, Releases and Roadmap pages), and a
 * terminal window that runs the PC's shell. Pointer and keyboard input move a small state machine; every state has a
 * generated 1280x800 PNG frame (cached).
 *
 * The fact the GUI scenario looks for is on the Releases page: the latest release is 0.7.3 "Copper Golem".
 */

import { Canvas, type Rgb } from './raster.js';

export const SCREEN = { w: 1280, h: 800 } as const;

export type Page = 'start' | 'wiki' | 'results' | 'releases' | 'roadmap' | 'notfound';
export type App = 'desktop' | 'browser' | 'terminal' | 'files';
type Focus = 'none' | 'address' | 'search' | 'terminal';

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function hit(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

const WIKI = 'wiki.office.lan';
export const LATEST_RELEASE = { version: '0.7.3', name: 'Copper Golem', date: '2026-09-28' } as const;

const ICONS: readonly { app: App; label: string; box: Rect }[] = [
  { app: 'terminal', label: 'TERMINAL', box: { x: 40, y: 70, w: 110, h: 110 } },
  { app: 'browser', label: 'BROWSER', box: { x: 40, y: 210, w: 110, h: 110 } },
  { app: 'files', label: 'FILES', box: { x: 40, y: 350, w: 110, h: 110 } },
];

const CLOSE: Rect = { x: 1230, y: 36, w: 40, h: 26 };
const BACK: Rect = { x: 8, y: 70, w: 44, h: 36 };
const ADDRESS: Rect = { x: 60, y: 70, w: 1200, h: 36 };
const SEARCH_BOX: Rect = { x: 340, y: 230, w: 600, h: 48 };
const SEARCH_BUTTON: Rect = { x: 950, y: 230, w: 140, h: 48 };
const BOOKMARK_WIKI: Rect = { x: 340, y: 310, w: 160, h: 30 };

/** Clickable links per page: label, target page, box. */
function links(page: Page, query: string): { label: string; to: Page; box: Rect; snippet?: string }[] {
  switch (page) {
    case 'wiki':
      return [
        { label: 'RELEASES', to: 'releases', box: { x: 340, y: 230, w: 220, h: 32 } },
        { label: 'ROADMAP', to: 'roadmap', box: { x: 340, y: 280, w: 220, h: 32 } },
        { label: 'ONBOARDING', to: 'notfound', box: { x: 340, y: 330, w: 240, h: 32 } },
      ];
    case 'results':
      return matchesWiki(query)
        ? [
            {
              label: 'RELEASES - TEAM WIKI',
              to: 'releases',
              box: { x: 340, y: 310, w: 560, h: 34 },
              snippet: 'ALL MINEVIBE RELEASES, NEWEST FIRST.',
            },
            {
              label: 'ROADMAP - TEAM WIKI',
              to: 'roadmap',
              box: { x: 340, y: 410, w: 560, h: 34 },
              snippet: 'WHAT COMES NEXT.',
            },
          ]
        : [];
    default:
      return [];
  }
}

function matchesWiki(q: string): boolean {
  return /releas|version|latest|minevibe|changelog|wiki|roadmap/i.test(q);
}

function pageOfUrl(url: string): { page: Page; query: string } {
  const u = url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '');
  if (u === '' || u === 'about:home' || u === 'home') return { page: 'start', query: '' };
  const q = /[?&]q=([^&]*)/.exec(u);
  if (u.startsWith(WIKI) && q)
    return { page: 'results', query: decodeURIComponent((q[1] ?? '').replace(/\+/g, ' ')) };
  if (u.startsWith(WIKI) || u === 'wiki') {
    if (u.includes('release')) return { page: 'releases', query: '' };
    if (u.includes('roadmap')) return { page: 'roadmap', query: '' };
    if (u === WIKI || u === `${WIKI}/` || u === 'wiki') return { page: 'wiki', query: '' };
    return { page: 'notfound', query: '' };
  }
  if (!u.includes('.') && !u.includes('/')) return { page: 'results', query: url.trim() };
  return { page: 'notfound', query: '' };
}

function urlOf(page: Page, query: string): string {
  switch (page) {
    case 'start':
      return 'about:home';
    case 'wiki':
      return `${WIKI}/`;
    case 'results':
      return `${WIKI}/search?q=${encodeURIComponent(query)}`;
    case 'releases':
      return `${WIKI}/releases`;
    case 'roadmap':
      return `${WIKI}/roadmap`;
    default:
      return 'about:neterror';
  }
}

export interface DesktopHooks {
  /** Runs a command typed into the GUI terminal; returns its output. */
  runCommand(command: string): string;
}

export class Desktop {
  app: App = 'desktop';
  page: Page = 'start';
  query = '';
  focus: Focus = 'none';
  address = '';
  search = '';
  selectedIcon: App | null = null;
  /** Replace the focused field's text on the next keystroke (a click selects all). */
  #selectAll = false;
  readonly #history: Page[] = [];
  readonly #queries: string[] = [];
  terminalLines: string[] = ['cua@linux-1:~$ '];
  terminalInput = '';
  /** Pages shown, in order (scenario checks). */
  readonly visited: Page[] = [];
  readonly #frames = new Map<string, Uint8Array>();
  readonly #hooks: DesktopHooks;

  constructor(hooks: DesktopHooks) {
    this.#hooks = hooks;
  }

  // --- input ---------------------------------------------------------------------------------------------------

  openBrowser(url: string | null): void {
    this.app = 'browser';
    this.focus = 'none';
    if (url) this.#navigateUrl(url);
    else this.#go('start', '');
  }

  click(x: number, y: number, double = false): void {
    if (this.app !== 'desktop' && hit(CLOSE, x, y)) {
      this.app = 'desktop';
      this.focus = 'none';
      return;
    }
    switch (this.app) {
      case 'desktop': {
        const icon = ICONS.find((i) => hit({ ...i.box, h: i.box.h + 30 }, x, y));
        if (!icon) {
          this.selectedIcon = null;
          return;
        }
        if (double || this.selectedIcon === icon.app) this.#open(icon.app);
        else this.selectedIcon = icon.app;
        return;
      }
      case 'terminal':
        this.focus = 'terminal';
        return;
      case 'files':
        return;
      case 'browser': {
        if (hit(BACK, x, y)) {
          this.back();
          return;
        }
        if (hit(ADDRESS, x, y)) {
          this.focus = 'address';
          this.address = urlOf(this.page, this.query);
          this.#selectAll = true;
          return;
        }
        if ((this.page === 'start' || this.page === 'results') && hit(SEARCH_BOX, x, y)) {
          this.focus = 'search';
          this.#selectAll = this.search.length > 0;
          return;
        }
        if ((this.page === 'start' || this.page === 'results') && hit(SEARCH_BUTTON, x, y)) {
          this.#submitSearch();
          return;
        }
        if (this.page === 'start' && hit(BOOKMARK_WIKI, x, y)) {
          this.#go('wiki', '');
          return;
        }
        const link = links(this.page, this.query).find((l) => hit(l.box, x, y));
        if (link) {
          this.#go(link.to, '');
          return;
        }
        this.focus = 'none';
        return;
      }
    }
  }

  type(text: string): void {
    if (this.focus === 'none' && this.app === 'terminal') this.focus = 'terminal';
    if (this.focus === 'none') return;
    const lines = text.split(/\r?\n/);
    for (const [i, part] of lines.entries()) {
      this.#append(part);
      if (i < lines.length - 1) this.key(['enter']);
    }
  }

  #append(s: string): void {
    if (s.length === 0) return;
    if (this.focus === 'address') {
      this.address = this.#selectAll ? s : this.address + s;
    } else if (this.focus === 'search') {
      this.search = this.#selectAll ? s : this.search + s;
    } else if (this.focus === 'terminal') {
      this.terminalInput += s;
    }
    this.#selectAll = false;
  }

  key(keys: readonly string[]): void {
    const k = keys.map((x) => x.toLowerCase().replace(/^key_/, ''));
    const has = (n: string) => k.includes(n);
    const main =
      k.find((x) => !['ctrl', 'control', 'alt', 'shift', 'super', 'meta', 'cmd'].includes(x)) ?? '';
    if ((has('ctrl') || has('control')) && main === 'l' && this.app === 'browser') {
      this.focus = 'address';
      this.address = urlOf(this.page, this.query);
      this.#selectAll = true;
      return;
    }
    if (has('alt') && main === 'left' && this.app === 'browser') {
      this.back();
      return;
    }
    if ((has('ctrl') || has('control')) && main === 'a') {
      this.#selectAll = true;
      return;
    }
    if (main === 'escape' || main === 'esc') {
      this.focus = 'none';
      return;
    }
    if (main === 'backspace') {
      if (this.focus === 'address') this.address = this.#selectAll ? '' : this.address.slice(0, -1);
      if (this.focus === 'search') this.search = this.#selectAll ? '' : this.search.slice(0, -1);
      if (this.focus === 'terminal') this.terminalInput = this.terminalInput.slice(0, -1);
      this.#selectAll = false;
      return;
    }
    if (['enter', 'return', 'kp_enter'].includes(main)) {
      if (this.app === 'desktop' && this.selectedIcon) {
        this.#open(this.selectedIcon);
        return;
      }
      if (this.focus === 'address') {
        this.#navigateUrl(this.address);
        this.focus = 'none';
      } else if (this.focus === 'search') {
        this.#submitSearch();
      } else if (this.focus === 'terminal') {
        const cmd = this.terminalInput;
        this.terminalInput = '';
        const prompt = this.terminalLines.pop() ?? 'cua@linux-1:~$ ';
        this.terminalLines.push(`${prompt}${cmd}`);
        const out = this.#hooks.runCommand(cmd);
        if (out.length > 0) this.terminalLines.push(...out.replace(/\n$/, '').split('\n'));
        this.terminalLines.push('cua@linux-1:~$ ');
        this.terminalLines = this.terminalLines.slice(-30);
      }
      return;
    }
    if (main.length === 1 && !has('ctrl') && !has('alt')) this.#append(main);
  }

  back(): void {
    const prev = this.#history.pop();
    const q = this.#queries.pop() ?? '';
    if (prev) {
      this.page = prev;
      this.query = q;
      this.visited.push(prev);
    }
  }

  #open(app: App): void {
    this.selectedIcon = null;
    if (app === 'browser') this.openBrowser(null);
    else {
      this.app = app;
      this.focus = app === 'terminal' ? 'terminal' : 'none';
    }
  }

  #submitSearch(): void {
    this.#go('results', this.search.trim());
    this.focus = 'none';
  }

  #navigateUrl(url: string): void {
    const { page, query } = pageOfUrl(url);
    this.#go(page, query);
  }

  #go(page: Page, query: string): void {
    if (this.app === 'browser' && this.visited.length > 0) {
      this.#history.push(this.page);
      this.#queries.push(this.query);
    }
    this.page = page;
    this.query = query;
    if (page === 'results') this.search = query;
    this.visited.push(page);
  }

  // --- frames ----------------------------------------------------------------------------------------------------

  /** The current frame as PNG bytes. */
  frame(): Uint8Array {
    const key = JSON.stringify([
      this.app,
      this.page,
      this.query,
      this.focus,
      this.address,
      this.search,
      this.selectedIcon,
      this.app === 'terminal' ? [this.terminalLines, this.terminalInput] : null,
    ]);
    const cached = this.#frames.get(key);
    if (cached) return cached;
    const png = this.#render().png();
    if (this.#frames.size > 64) this.#frames.clear();
    this.#frames.set(key, png);
    return png;
  }

  /** A text description of the screen (tests and transcripts). */
  describe(): string {
    if (this.app === 'browser') return `browser ${urlOf(this.page, this.query)}`;
    return this.app;
  }

  #render(): Canvas {
    const c = new Canvas(SCREEN.w, SCREEN.h, [44, 0, 30]);
    const ink: Rgb = [20, 20, 20];
    const grey: Rgb = [110, 110, 110];
    const white: Rgb = [255, 255, 255];
    // Top bar.
    c.rect(0, 0, SCREEN.w, 30, [20, 20, 20]);
    c.text(12, 8, 'ACTIVITIES', white, 2);
    c.text(560, 8, 'FRI OCT 9  14:05', white, 2);
    if (this.app === 'desktop') {
      for (const icon of ICONS) {
        const sel = this.selectedIcon === icon.app;
        c.rect(icon.box.x, icon.box.y, icon.box.w, icon.box.h, sel ? [233, 84, 32] : [90, 60, 90]);
        c.frame(icon.box.x, icon.box.y, icon.box.w, icon.box.h, white, 2);
        const glyph = icon.app === 'terminal' ? '>_' : icon.app === 'browser' ? 'WWW' : '[ ]';
        c.text(icon.box.x + 55 - Canvas.textWidth(glyph, 4) / 2, icon.box.y + 40, glyph, white, 4);
        c.text(
          icon.box.x + 55 - Canvas.textWidth(icon.label, 2) / 2,
          icon.box.y + icon.box.h + 10,
          icon.label,
          white,
          2,
        );
      }
      c.text(380, 740, 'DOUBLE-CLICK AN ICON TO OPEN IT', [200, 180, 200], 2);
      return c;
    }
    // A full-screen window with a title bar and a close button.
    c.rect(0, 30, SCREEN.w, SCREEN.h - 30, white);
    c.rect(0, 30, SCREEN.w, 34, [225, 225, 225]);
    const title =
      this.app === 'browser'
        ? `BROWSER - ${pageTitle(this.page)}`
        : this.app === 'terminal'
          ? 'TERMINAL'
          : 'FILES - HOME';
    c.text(16, 40, title, ink, 2);
    c.rect(CLOSE.x, CLOSE.y, CLOSE.w, CLOSE.h, [200, 60, 60]);
    c.text(CLOSE.x + 14, CLOSE.y + 6, 'X', white, 2);
    if (this.app === 'terminal') {
      c.rect(0, 64, SCREEN.w, SCREEN.h - 64, [30, 30, 30]);
      const lines = [...this.terminalLines];
      lines[lines.length - 1] = `${lines.at(-1) ?? ''}${this.terminalInput}_`;
      lines.slice(-28).forEach((l, i) => {
        c.text(16, 76 + i * 25, l.slice(0, 100), [220, 220, 220], 2);
      });
      return c;
    }
    if (this.app === 'files') {
      ['DESKTOP', 'DOCUMENTS', 'DOWNLOADS', 'REPO', 'VIDEOS'].forEach((d, i) => {
        c.rect(40 + i * 200, 120, 140, 100, [240, 200, 120]);
        c.text(40 + i * 200, 236, d, ink, 2);
      });
      return c;
    }
    // Browser chrome.
    c.rect(0, 64, SCREEN.w, 48, [245, 245, 245]);
    c.rect(BACK.x, BACK.y, BACK.w, BACK.h, [225, 225, 225]);
    c.text(BACK.x + 14, BACK.y + 10, '<', ink, 2);
    c.rect(ADDRESS.x, ADDRESS.y, ADDRESS.w, ADDRESS.h, this.focus === 'address' ? [255, 255, 230] : white);
    c.frame(
      ADDRESS.x,
      ADDRESS.y,
      ADDRESS.w,
      ADDRESS.h,
      this.focus === 'address' ? [40, 100, 220] : [180, 180, 180],
      2,
    );
    c.text(
      ADDRESS.x + 12,
      ADDRESS.y + 11,
      this.focus === 'address' ? `${this.address}_` : urlOf(this.page, this.query),
      ink,
      2,
    );
    const blue: Rgb = [20, 70, 200];
    switch (this.page) {
      case 'start': {
        c.text(340, 150, 'START PAGE', ink, 4);
        this.#searchBox(c, 'SEARCH THE TEAM WIKI');
        c.text(BOOKMARK_WIKI.x, BOOKMARK_WIKI.y + 6, 'TEAM WIKI', blue, 2);
        c.rect(BOOKMARK_WIKI.x, BOOKMARK_WIKI.y + 24, Canvas.textWidth('TEAM WIKI', 2), 2, blue);
        c.text(540, BOOKMARK_WIKI.y + 6, 'BOOKMARKS: TEAM WIKI', grey, 2);
        break;
      }
      case 'results': {
        c.text(340, 140, `RESULTS FOR "${this.query.slice(0, 40)}"`, ink, 3);
        this.#searchBox(c, '');
        const ls = links(this.page, this.query);
        if (ls.length === 0) c.text(340, 300, 'NO RESULTS. TRY ANOTHER SEARCH.', grey, 2);
        for (const l of ls) {
          c.text(l.box.x, l.box.y + 4, l.label, blue, 3);
          c.rect(l.box.x, l.box.y + 28, Canvas.textWidth(l.label, 3), 2, blue);
          if (l.snippet) c.text(l.box.x, l.box.y + 40, l.snippet, grey, 2);
        }
        break;
      }
      case 'wiki': {
        c.text(340, 150, 'TEAM WIKI', ink, 4);
        for (const l of links('wiki', '')) {
          c.text(l.box.x, l.box.y + 6, l.label, blue, 3);
          c.rect(l.box.x, l.box.y + 30, Canvas.textWidth(l.label, 3), 2, blue);
        }
        break;
      }
      case 'releases': {
        c.text(200, 140, 'MINEVIBE RELEASES', ink, 4);
        const rows = [
          ['VERSION', 'NAME', 'DATE', ''],
          [LATEST_RELEASE.version, LATEST_RELEASE.name.toUpperCase(), LATEST_RELEASE.date, '(LATEST)'],
          ['0.7.2', 'TUFF TROUBLE', '2026-08-30', ''],
          ['0.7.1', 'MOSS CARPET', '2026-07-19', ''],
          ['0.7.0', 'FIRST LIGHT', '2026-06-02', ''],
        ];
        rows.forEach((r, i) => {
          const y = 230 + i * 50;
          if (i === 0) c.rect(190, y - 10, 900, 40, [230, 230, 240]);
          c.text(200, y, r[0] ?? '', ink, 3);
          c.text(400, y, r[1] ?? '', ink, 3);
          c.text(760, y, r[2] ?? '', ink, 3);
          if (r[3]) c.text(1000, y + 4, r[3], [0, 130, 0], 2);
        });
        break;
      }
      case 'roadmap':
        c.text(200, 140, 'ROADMAP', ink, 4);
        c.text(200, 230, "NEXT: 0.8.0 'DEEP DARK' - NOT RELEASED YET", ink, 3);
        break;
      default:
        c.text(200, 200, 'SERVER NOT FOUND', ink, 4);
        c.text(200, 270, 'THIS PC HAS NO INTERNET: ONLY THE OFFICE WIKI IS REACHABLE.', grey, 2);
        break;
    }
    return c;
  }

  #searchBox(c: Canvas, placeholder: string): void {
    const focused = this.focus === 'search';
    c.rect(
      SEARCH_BOX.x,
      SEARCH_BOX.y,
      SEARCH_BOX.w,
      SEARCH_BOX.h,
      focused ? [255, 255, 230] : [255, 255, 255],
    );
    c.frame(
      SEARCH_BOX.x,
      SEARCH_BOX.y,
      SEARCH_BOX.w,
      SEARCH_BOX.h,
      focused ? [40, 100, 220] : [150, 150, 150],
      2,
    );
    const text = this.search.length > 0 || focused ? `${this.search}${focused ? '_' : ''}` : placeholder;
    c.text(
      SEARCH_BOX.x + 14,
      SEARCH_BOX.y + 16,
      text,
      this.search.length > 0 || focused ? [20, 20, 20] : [150, 150, 150],
      2,
    );
    c.rect(SEARCH_BUTTON.x, SEARCH_BUTTON.y, SEARCH_BUTTON.w, SEARCH_BUTTON.h, [40, 100, 220]);
    c.text(SEARCH_BUTTON.x + 22, SEARCH_BUTTON.y + 16, 'SEARCH', [255, 255, 255], 2);
  }
}

function pageTitle(p: Page): string {
  return {
    start: 'START PAGE',
    wiki: 'TEAM WIKI',
    results: 'SEARCH',
    releases: 'RELEASES - TEAM WIKI',
    roadmap: 'ROADMAP - TEAM WIKI',
    notfound: 'PROBLEM LOADING PAGE',
  }[p];
}
