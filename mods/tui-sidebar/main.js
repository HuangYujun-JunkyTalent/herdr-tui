// The sidebar of the plugin herdr-sidebar of the Herdr TUI, redrawn for the app: a file tree with git
// marks, a name search, the branch, and a click that opens a file in the editor picked at the bottom.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, hc, run, readTextFile, watchFolder, theme, settings, window, shared, nextCommand, openOverlay } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  if (!on && window()?.platform === "windows") {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Reparse points keep directory attributes even when dangling; check their target.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replaceAll("'", "''") + "'"]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}


// Colors and sizes of herdr-sidebar 0.15.1 in the TUI with the theme dracula, taken from its cells.
const C = { idleIcon: "#9a9a9a", box: "#7f7f7f", hit: "#ffb86c40", frame: "#6272a4", icon: "#90a4ae", chip: "#32363d", chipText: "#c9ced6", modified: "#ffb86c", added: "#50fa7b", removed: "#ff5555" };
const CELL = 7.8, ROW = 17;
const G = { terminal: "\uf120", code: "\uf121", copy: "\uf0c5", newFile: "\uea7f", newFolder: "\uea80", reload: "\ueb37", collapse: "\ueac5", refresh: "\uf021", clear: "\uf00d", chevron: "\uf078", right: "\uf054", folder: "\uf07b", open: "\uf07c", file: "\uf15b", search: "\uf002", git: "\uf126", gear: "\uf013", branch: "\ue725" };

// The editors the picker supports. The picker lists those found on the machine of the folder:
// an `app` is a Mac app, found in an Applications folder of this Mac; a `term` is a terminal editor,
// found with `command -v` on the machine and opened in a split pane there; `cli` is the command
// inside the app that opens a file at a line and on another machine over SSH.
const EDITORS = [
  { id: "preview", name: "Preview" },
  { id: "vscode", name: "VS Code", app: "Visual Studio Code", cli: "Contents/Resources/app/bin/code" },
  { id: "cursor", name: "Cursor", app: "Cursor", cli: "Contents/Resources/app/bin/cursor" },
  { id: "zed", name: "Zed", app: "Zed" },
  { id: "sublime", name: "Sublime Text", app: "Sublime Text" },
  { id: "bbedit", name: "BBEdit", app: "BBEdit" },
  { id: "nova", name: "Nova", app: "Nova" },
  { id: "textmate", name: "TextMate", app: "TextMate" },
  { id: "textedit", name: "TextEdit", app: "TextEdit" },
  { id: "vim", name: "vim", term: "vim", at: n => [`+${n}`] },
  { id: "nvim", name: "Neovim", term: "nvim", at: n => [`+${n}`] },
  { id: "nano", name: "nano", term: "nano", at: n => [`+${n}`] },
  { id: "helix", name: "Helix", term: "hx", at: (n, p) => [`${p}:${n}`] },
  { id: "micro", name: "micro", term: "micro", at: (n, p) => [`${p}:${n}`] },
  { id: "emacs", name: "Emacs", term: "emacs", flags: ["-nw"], at: n => [`+${n}`] },
  { id: "default", name: "Default app", system: true },
];
// The other apps of the right-click menu, found like the editors: file browsers beside Finder,
// and terminals. A terminal with `cli` is started through its command with `args(folder)`;
// the others take the folder through `open -a`.
const OPENERS = [
  { id: "pathfinder", name: "Path Finder", app: "Path Finder", kind: "browser" },
  { id: "forklift", name: "ForkLift", app: "ForkLift", kind: "browser" },
  { id: "commander", name: "Commander One", app: "Commander One", kind: "browser" },
  { id: "qspace", name: "QSpace Pro", app: "QSpace Pro", kind: "browser" },
  { id: "marta", name: "Marta", app: "Marta", kind: "browser" },
  { id: "iterm", name: "iTerm2", app: "iTerm", kind: "terminal" },
  { id: "terminal", name: "Terminal", app: "Terminal", kind: "terminal" },
  { id: "warp", name: "Warp", app: "Warp", kind: "terminal" },
  { id: "ghostty", name: "Ghostty", app: "Ghostty", kind: "terminal" },
  { id: "wezterm", name: "WezTerm", app: "WezTerm", kind: "terminal", cli: "Contents/MacOS/wezterm", args: f => ["start", "--cwd", f] },
  { id: "kitty", name: "kitty", app: "kitty", kind: "terminal", cli: "Contents/MacOS/kitty", args: f => ["--single-instance", "--directory", f] },
  { id: "alacritty", name: "Alacritty", app: "Alacritty", kind: "terminal", cli: "Contents/MacOS/alacritty", args: f => ["--working-directory", f] },
];
// The editors that the menu offers for a folder too.
const FOLDER_EDITORS = ["vscode", "cursor", "zed", "sublime"];
const APP_FOLDERS = ["/Applications", "/System/Applications", "/Applications/Utilities"];

const HINTS = [[["↑↓", "move"], ["←→", "fold"]], [["⏎", "open"], ["r", "refresh"]], [["f", "finder"], ["t", "terminal"]], [["v", "code"], ["m", "menu"]], [[".", "dotfiles"], ["e", "editor"]], [["1", "files"], ["2", "search"]], [["3", "git"], ["b", "hide"]]];

export default class Sidebar extends View {
  init(_props, cx) {
    this.wasFocused = false;
    cx.timer.every(200, cx => { const now = this.handle?.is_focused() ?? false; if (now !== this.wasFocused) { this.wasFocused = now; cx.notify(); } });
    cx.spawn(async cx => { for (;;) { const c = await nextCommand(); if (c === "focus") { this.handle.focus(); cx.notify(); } else if (c === "toggle-focus") this.toggleFocus(cx); } });
    this.handle = cx.focus_handle();
    this.view = "files"; this.at = 0; this.query = ""; this.results = []; this.picking = false;
    this.dotfiles = localStorage.getItem("dotfiles") !== "hidden";
    this.editor = EDITORS.some(e => e.id === localStorage.getItem("editor")) ? localStorage.getItem("editor") : "preview";
    this.branch = null;
    this.found_ = new Map(); // machine ("" for this Mac) → { apps: {id: path}, terms: Set }
    // The search view, as in VS Code: a text search with case, word and regex toggles, and a replace.
    this.options = { case: false, word: false, regex: false }; this.hits = []; this.searching = false; this.closedHits = new Set();
    // The actions VS Code shows over the explorer: a new file or folder is named in this input.
    this.creating = null;
    this.nameInput = InputState.new({ placeholder: "Name" });
    this.nameInput.on("submit", (_e, cx) => this.create(cx));
    this.nameInput.on("focus", (_e, cx) => { this.typing = "name"; cx.notify(); });
    this.nameInput.on("blur", (_e, cx) => { if (this.typing === "name") { this.typing = null; this.creating = null; } cx.notify(); });
    this.findInput = InputState.new({ placeholder: "Search" });
    this.findInput.on("change", (_e, cx) => { this.query = this.findInput.value(); this.search(cx); });
    this.replaceInput = InputState.new({ placeholder: "Replace" });
    this.replaceInput.on("change", (_e, cx) => { this.confirm = null; cx.notify(); });
    for (const [name, input] of [["find", this.findInput], ["replace", this.replaceInput]]) {
      input.on("focus", (_e, cx) => { this.typing = name; cx.notify(); });
      input.on("blur", (_e, cx) => { if (this.typing === name) this.typing = null; cx.notify(); });
    }
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        let branch = null;
        if (top?.code === 0) {
          const name = await exec("git", ["--no-optional-locks", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, on }).catch(() => null);
          const counts = await exec("git", ["--no-optional-locks", "rev-list", "--left-right", "--count", "@{upstream}...HEAD"], { cwd, on }).catch(() => null);
          const [behind, ahead] = counts?.code === 0 ? counts.stdout.trim().split(/\s+/) : ["0", "0"];
          if (name?.code === 0) branch = { name: name.stdout.trim(), behind, ahead };
        }
        if (!this.current(context)) return;
        this.branch = branch;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }


  // Every row the tree shows, in order, as { path, entry, depth }.
  visible(prefix = "", depth = 0, out = []) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (!this.dotfiles && entry.name.startsWith(".")) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push({ path, entry, depth });
      if (entry.dir && this.folders.has(path)) this.visible(path, depth + 1, out);
    }
    return out;
  }

  // The git mark of a file, or the strongest mark under a folder.
  mark(path, dir) {
    const full = `${this.root}/${path}`, own = this.marks[full];
    if (own || !dir) return own;
    let found = null;
    for (const [p, m] of Object.entries(this.marks)) if (p.startsWith(full + "/")) { if (m === "M") return "M"; found = found ?? m; }
    return found;
  }

  markColor(mark, t) {
    return mark === "A" ? C.added : mark === "D" || mark === "U" ? C.removed : mark === "M" ? C.modified : t.foreground;
  }

  // Finds the supported editors on the machine of the folder, once per machine.
  detect(cx) {
    const machine = this.on, on = machine ?? "";
    if (this.found_.has(on)) return;
    this.found_.set(on, null);
    cx.spawn(async cx => {
      const terms = EDITORS.filter(e => e.term).map(e => e.term);
      const r = await exec("sh", ["-c", 'for e in "$@"; do command -v "$e" >/dev/null 2>&1 && echo "$e"; done; exit 0', "detect", ...terms], { on: machine }).catch(() => null);
      const apps = {};
      if (!machine) {
        const names = [...EDITORS, ...OPENERS].filter(e => e.app).map(e => e.app);
        const script = 'for a in "$@"; do for d in /Applications /System/Applications /Applications/Utilities "$HOME/Applications"; do [ -d "$d/$a.app" ] && { printf "%s\\t%s\\n" "$a" "$d/$a.app"; break; }; done; done; exit 0';
        const found = await exec("sh", ["-c", script, "apps", ...names]).catch(() => null);
        for (const line of (found?.stdout ?? "").split("\n").filter(Boolean)) {
          const [name, path] = line.split("\t");
          const e = [...EDITORS, ...OPENERS].find(e => e.app === name);
          if (e) apps[e.id] = path;
        }
      }
      this.found_.set(on, { apps, terms: new Set((r?.stdout ?? "").split("\n").filter(Boolean)) });
      cx.notify();
    });
  }

  // The editors the picker shows for the folder's machine. On another machine, an app shows
  // only when it has an SSH remote (`cli`) on this Mac.
  // The apps of this Mac, which the SSH remote of an app needs on another machine.
  detectMac(cx) {
    if (this.found_.has("")) return;
    const on = this.on; this.on = null; this.detect(cx); this.on = on;
  }

  available() {
    const here = this.found_.get(this.on ?? ""), mac = this.found_.get("");
    return EDITORS.filter(e => {
      if (e.id === "preview") return true;
      if (e.system) return !this.on;
      if (e.term) return here?.terms.has(e.term) ?? false;
      return this.on ? Boolean(e.cli && mac?.apps[e.id]) : Boolean(here?.apps[e.id]);
    });
  }

  // The right-click menu of a row, or of the root folder when `path` is "": its folder in Finder,
  // a terminal or an editor. On another machine only Herdr's own terminals and the SSH remote
  // of an editor reach it.
  // cmd-shift-e: to the sidebar (shown if hidden) and back to the pane that had the keyboard.
  toggleFocus(cx) {
    if (this.handle.is_focused() || this.typing) {
      const back = this.back; this.back = null;
      if (back?.pane) run("pane.focus", { pane: back.pane });
      else if (back?.terminal) run("pane.focus", { terminal: back.terminal });
      else run("pane.go", { direction: "left" });
      return;
    }
    const f = focused(); this.back = f ? { pane: f.pane, terminal: f.terminal } : null;
    run("layout.select", { stack: "panel-body", child: "files" }); run("layout.show", { id: "panel" });
    this.view = "files"; this.show(null);
    cx.spawn(async cx => { await cx.sleep(50); this.handle.focus(); cx.notify(); });
  }

  // A key on the selected row (or the root) runs the item of the menu with that key.
  async menuItems(path, dir) {
    const full = path ? `${this.root}/${path}` : this.root, on = this.on;
    const folder = dir ? full : full.replace(/\/[^/]*$/, "");
    const apps = this.found_.get("")?.apps ?? {};
    {
      let target = null;
      if (on) {
        const r = await hc(["machine", "ls", "--json"]).catch(() => null);
        const m = (r ? JSON.parse(r.stdout).machines ?? [] : []).find(m => m.name === on || m.id === on || m.host === on);
        target = m?.target ?? null;
      }
      const items = [], sep = () => { if (items.length && !items[items.length - 1].sep) items.push({ sep: true }); };
      if (!on) {
        items.push({ label: dir ? "Open in Finder" : "Reveal in Finder", glyph: G.open, key: "f", exec: ["open", dir ? [full] : ["-R", full]] });
        for (const o of OPENERS.filter(o => o.kind === "browser" && apps[o.id])) items.push({ label: `Open in ${o.name}`, glyph: G.open, exec: ["open", ["-a", apps[o.id], folder]] });
        sep();
        for (const o of OPENERS.filter(o => o.kind === "terminal" && apps[o.id]))
          items.push({ label: `Open in ${o.name}`, glyph: G.terminal, exec: o.cli ? [`${apps[o.id]}/${o.cli}`, o.args(folder)] : ["open", ["-a", apps[o.id], folder]] });
      }
      items.push({ label: "Open in New Herdr Tab", glyph: G.terminal, key: "n", run: ["tab.new", { folder }] });
      items.push({ label: "Open in Herdr Split", glyph: G.terminal, key: "s", run: ["terminal.open", { folder, place: "right" }] });
      sep();
      for (const e of EDITORS.filter(e => FOLDER_EDITORS.includes(e.id) && apps[e.id])) {
        if (!on) items.push({ label: `Open in ${e.name}`, glyph: G.code, exec: ["open", ["-a", apps[e.id], full]] });
        else if (e.cli && target) items.push({ label: `Open in ${e.name}`, glyph: G.code, exec: [`${apps[e.id]}/${e.cli}`, ["--remote", `ssh-remote+${target}`, full]] });
      }
      sep();
      items.push({ label: "Copy Path", glyph: G.copy, key: "y", exec: ["sh", ["-c", 'printf %s "$1" | pbcopy', "copy", full]] });
      if (path) items.push({ label: "Copy Relative Path", glyph: G.copy, key: "p", exec: ["sh", ["-c", 'printf %s "$1" | pbcopy', "copy", path]] });
      // The first terminal and the first editor take t and v.
      const term = items.find(it => it.glyph === G.terminal), code = items.find(it => it.glyph === G.code);
      if (term && !term.key) term.key = "t";
      if (code) code.key = "v";
      return items;
    }
  }

  menu(path, dir, cx) {
    if (!this.root) return;
    const root = this.root;
    cx.spawn(async () => {
      const items = await this.menuItems(path, dir);
      if (this.root !== root) return;
      const height = 10 + items.reduce((h, it) => h + (it.sep ? 9 : 31), 0);
      openOverlay({ mod: "tui-open", kind: "popup", width: 260, height, props: { items } });
    });
  }

  act(path, dir, key, cx) {
    if (!this.root) return;
    cx.spawn(async cx => {
      const items = await this.menuItems(path, dir);
      // Without an app on this Mac, t opens a Herdr tab.
      const it = items.find(it => it.key === key) ?? (key === "t" ? items.find(it => it.key === "n") : null);
      if (!it) return;
      if (it.run) { run(it.run[0], it.run[1]); return; }
      const r = await exec(it.exec[0], it.exec[1]).catch(e => ({ code: 1, stderr: String(e) }));
      this.openError = r.code === 0 ? null : (r.stderr || `${it.label} did not start`);
      cx.notify();
    });
  }

  open(path, cx, line = null) {
    const list = this.available(), editor = list.find(e => e.id === this.editor) ?? EDITORS[0];
    const full = `${this.root}/${path}`, on = this.on;
    if (editor.id === "preview") { this.view = "files"; this.show(path, cx); cx.notify(); return; }
    if (editor.term) {
      const at = line ? editor.at(line, full) : [], named = at.some(a => a.startsWith(full));
      const argv = [editor.term, ...(editor.flags ?? []), ...at, ...(named ? [] : [full])];
      run("pane.split", { direction: "right", argv });
      return;
    }
    cx.spawn(async cx => {
      try {
        const app = this.found_.get("")?.apps[editor.id];
        let command;
        if (on) {
          const r = await hc(["machine", "ls", "--json"]);
          const m = (JSON.parse(r.stdout).machines ?? []).find(m => m.name === on || m.id === on || m.host === on);
          if (!m) throw new Error(`No SSH target for ${on}`);
          command = [`${app}/${editor.cli}`, ["--remote", `ssh-remote+${m.target}`, ...(line ? ["--goto", `${full}:${line}`] : [full])]];
        } else if (editor.system) command = ["open", [full]];
        else if (editor.cli && line) command = [`${app}/${editor.cli}`, ["--goto", `${full}:${line}`]];
        else command = ["open", ["-a", app, full]];
        const r = await exec(command[0], command[1]);
        this.openError = r.code === 0 ? null : (r.stderr || `${editor.name} did not start`);
      } catch (e) { this.openError = String(e); }
      cx.notify();
    });
  }

  // The options of ripgrep and of grep; both print lines as "path:line:text", at most 2,000.
  searchArgs() {
    const o = this.options, rg = ["-n", "--no-heading", "--color", "never", "--max-columns", "300", "--max-columns-preview", "--max-count", "100", "--max-filesize", "2M", "-g", "!.git"];
    const grep = ["-rnI", "--exclude-dir=.git"];
    if (!o.regex) { rg.push("-F"); grep.push("-F"); } else grep.push("-E");
    if (!o.case) { rg.push("-i"); grep.push("-i"); }
    if (o.word) { rg.push("-w"); grep.push("-w"); }
    return { rg, grep };
  }

  search(cx) {
    const query = this.query, context = this.context, options = { ...this.options };
    this.confirm = null;
    if (!query || !this.root) { this.hits = []; this.searching = false; cx.notify(); return; }
    const { rg, grep } = this.searchArgs();
    // The search runs on the machine of the folder: ripgrep when it is there, else grep.
    const script = 'q=$1; shift; if [ "$0" = rg ]; then rg "$@" -e "$q" . 2>/dev/null; else grep "$@" -e "$q" . 2>/dev/null; fi | head -2000';
    this.searching = true; cx.notify();
    cx.spawn(async cx => {
      // Waits for a pause in typing, so only the last query of a burst runs.
      await cx.sleep(250);
      if (this.query !== query || JSON.stringify(options) !== JSON.stringify(this.options)) return;
      if (this.hasRg?.on !== this.on) {
        const which = await exec("sh", ["-c", "command -v rg"], { on: this.on }).catch(() => null);
        this.hasRg = { on: this.on, yes: which?.code === 0 };
      }
      const tool = this.hasRg.yes ? "rg" : "grep", args = this.hasRg.yes ? rg : grep;
      const r = await exec("sh", ["-c", script, tool, query, ...args], { cwd: this.root, on: this.on }).catch(() => null);
      if (this.query !== query || JSON.stringify(options) !== JSON.stringify(this.options) || !this.current(context)) return;
      const byFile = new Map();
      for (const line of (r?.stdout ?? "").split("\n")) {
        const m = /^(?:\.\/)?(.+?):(\d+):(.*)$/.exec(line);
        if (!m) continue;
        if (!byFile.has(m[1])) byFile.set(m[1], []);
        byFile.get(m[1]).push({ n: Number(m[2]), text: m[3] });
      }
      this.hits = [...byFile.entries()].map(([path, lines]) => ({ path, lines }));
      this.searching = false; cx.notify();
    });
  }

  // Replaces every match in the files found, with perl on the machine of the folder.
  replaceAll(cx) {
    const query = this.query, with_ = this.replaceInput.value(), files = this.hits.map(h => h.path), o = this.options;
    if (!query || !files.length) return;
    const pattern = o.regex ? "$ENV{Q}" : "\\Q$ENV{Q}\\E", word = o.word ? "\\b" : "";
    const perl = `s/${word}${pattern}${word}/$ENV{R}/g${o.case ? "" : "i"}`;
    const script = 'Q=$1 R=$2; export Q R; shift 2; exec perl -pi -e "$0" "$@"';
    cx.spawn(async cx => {
      const r = await exec("sh", ["-c", script, perl, query, with_, ...files], { cwd: this.root, on: this.on }).catch(e => ({ code: 1, stderr: String(e) }));
      this.openError = r.code === 0 ? null : (r.stderr || "Replace failed");
      this.confirm = null; this.search(cx); this.refresh(cx);
    });
  }

  // The folder a new item goes into: the selected folder, or the folder of the selected file.
  target() {
    const row = this.visible()[this.at];
    if (!row || !this.handle.is_focused() && !this.creating) return "";
    if (row.entry.dir) return row.path;
    return row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : "";
  }

  startCreate(kind, cx) {
    this.creating = { kind, parent: this.target() };
    if (this.creating.parent && !this.folders.has(this.creating.parent)) this.toggle(this.creating.parent, cx);
    this.nameInput.set_value(""); this.nameInput.focus(); cx.notify();
  }

  create(cx) {
    const c = this.creating, name = this.nameInput.value().trim();
    if (!c || !name) { this.creating = null; cx.notify(); return; }
    const path = c.parent ? `${c.parent}/${name}` : name;
    const script = c.kind === "folder"
      ? '[ -e "$1" ] && { echo "$1 exists" >&2; exit 1; }; mkdir -p "$1"'
      : '[ -e "$1" ] && { echo "$1 exists" >&2; exit 1; }; mkdir -p "$(dirname "$1")" && : > "$1"';
    this.creating = null; this.typing = null; this.handle.focus();
    cx.spawn(async cx => {
      const r = await exec("sh", ["-c", script, "create", path], { cwd: this.root, on: this.on }).catch(e => ({ code: 1, stderr: String(e) }));
      this.openError = r.code === 0 ? null : (r.stderr || `Cannot create ${path}`);
      for (const dir of path.split("/").slice(0, -1).map((_, i, all) => all.slice(0, i + 1).join("/"))) this.folders.add(dir);
      this.refresh(cx);
      if (r.code === 0 && c.kind === "file") this.open(path, cx);
      cx.notify();
    });
  }

  collapseAll(cx) {
    this.folders.clear();
    for (const p of [...this.entries.keys()]) if (p) this.entries.delete(p);
    this.at = 0; cx.notify();
  }

  key(e, cx) {
    const k = e.keystroke;
    if (this.typing === "name") { if (k === "escape") { this.creating = null; this.typing = null; this.handle.focus(); cx.stop_propagation(); cx.notify(); } return; }
    if (this.view === "search") {
      if (this.typing) return;
      if (k === "escape") { this.view = "files"; }
      else if (k === "/" || k === "2") this.findInput.focus();
      else if (k === "1") this.view = "files";
      else if (k === "3") run("layout.select", { stack: "panel-body", child: "changes" });
      else if (k === "b") run("layout.hide", { id: "panel" });
      else return;
      cx.stop_propagation(); cx.notify(); return;
    }
    const rows = this.visible(), row = rows[this.at];
    // The root folder is the line above the tree, at -1.
    const target = this.at === -1 ? { path: "", dir: true } : row ? { path: row.path, dir: row.entry.dir } : null;
    if (k === "down" || k === "j") this.at = Math.min(rows.length - 1, this.at + 1);
    else if (k === "up" || k === "k") this.at = Math.max(-1, this.at - 1);
    else if (target && "ftvnsyp".includes(k) && k.length === 1) this.act(target.path, target.dir, k, cx);
    else if (target && (k === "m" || k === "shift-f10")) this.menu(target.path, target.dir, cx);
    else if (this.at === -1 && k === "enter") this.menu("", true, cx);
    else if ((k === "right" || k === "l") && row?.entry.dir && !this.folders.has(row.path)) this.toggle(row.path, cx);
    else if ((k === "left" || k === "h") && row) {
      if (row.entry.dir && this.folders.has(row.path)) this.toggle(row.path, cx);
      else { const parent = row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : null; const i = rows.findIndex(r => r.path === parent); this.at = i >= 0 ? i : -1; }
    }
    else if (k === "enter" && row) row.entry.dir ? this.toggle(row.path, cx) : this.open(row.path, cx);
    else if (k === "r") this.refresh(cx);
    else if (k === ".") { this.dotfiles = !this.dotfiles; localStorage.setItem("dotfiles", this.dotfiles ? "shown" : "hidden"); this.at = 0; }
    else if (k === "e") this.picking = !this.picking;
    else if (k === "2") { this.view = "search"; this.findInput.focus(); }
    else if (k === "3") run("layout.select", { stack: "panel-body", child: "changes" });
    else if (k === "b") run("layout.hide", { id: "panel" });
    else if (k === "escape" && this.file) this.show(null);
    else if (k === "escape") this.toggleFocus(cx);
    else return;
    cx.stop_propagation(); cx.notify();
  }

  // One line of the tree or of the search results.
  line(id, i, depth, glyph, name, color, mark, t, click, menu = null) {
    return h_flex().id(id).h(ROW).flex_none().pl(CELL * (2 * depth)).pr(CELL).items_center().cursor_pointer()
      .when(i === this.at && this.handle.is_focused(), el => el.bg(t.selected)).hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { this.at = i; click(cx); })
      .when(Boolean(menu), el => el.on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.at = i; menu(cx); }))
      .child(glyph)
      .child(div().flex_1().min_w(0).truncate().text_color(color).child(name))
      .when(Boolean(mark), el => el.child(div().flex_none().ml(CELL).text_color(color).child("●")));
  }

  tree(t) {
    return this.visible().map(({ path, entry, depth }, i) => {
      const open = this.folders.has(path), mark = this.mark(path, entry.dir), color = mark ? this.markColor(mark, t) : t.foreground;
      const glyph = h_flex().flex_none().child(div().w(CELL * 2).text_color(t.foreground).child(entry.dir ? (open ? "▾" : "▸") : ""))
        .child(div().w(CELL * 2).text_color(C.icon).child(entry.dir ? (open ? G.open : G.folder) : G.file));
      return this.line(`row-${path}`, i, depth, glyph, entry.name, color, mark, t, cx => entry.dir ? this.toggle(path, cx) : this.open(path, cx), cx => this.menu(path, entry.dir, cx));
    });
  }

  // A line of a result with the match on a colored background, as VS Code marks it.
  marked(text, t) {
    let re = null;
    try {
      const body = this.options.regex ? this.query : this.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(this.options.word ? `\\b(?:${body})\\b` : body, this.options.case ? "" : "i");
    } catch {}
    const m = re ? re.exec(text) : null, start = Math.max(0, (m?.index ?? 0) - 12);
    const clip = s => s.replace(/^\s+/, "");
    if (!m || !m[0]) return h_flex().min_w(0).child(div().truncate().child(clip(text)));
    return h_flex().min_w(0).overflow_hidden().whitespace_nowrap()
      .child(div().flex_none().text_color(t.muted).child((start > 0 ? "…" : "") + clip(text.slice(start, m.index))))
      .child(div().flex_none().bg(C.hit).child(m[0]))
      .child(div().min_w(0).truncate().child(text.slice(m.index + m[0].length)));
  }

  found(t) {
    const out = [];
    for (const hit of this.hits) {
      const shut = this.closedHits.has(hit.path), parts = hit.path.split("/"), name = parts.pop();
      out.push(h_flex().id(`hit-${hit.path}`).h(ROW + 4).flex_none().px(CELL).gap(CELL).items_center().cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { shut ? this.closedHits.delete(hit.path) : this.closedHits.add(hit.path); cx.notify(); })
        .child(div().w(CELL * 1.5).flex_none().text_size(10).text_color(C.idleIcon).child(shut ? G.right : G.chevron))
        .child(div().flex_none().text_color(C.icon).child(G.file))
        .child(div().flex_none().max_w(160).truncate().child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/")))
        .child(div().flex_none().px(5).rounded(8).bg(C.chip).text_size(11).text_color(C.chipText).child(String(hit.lines.length))));
      if (shut) continue;
      if (out.length > 600) break;
      for (const line of hit.lines.slice(0, 50)) out.push(h_flex().id(`hit-${hit.path}:${line.n}`).h(ROW + 2).flex_none().pl(CELL * 4.5).pr(CELL).gap(CELL).items_center().cursor_pointer()
        .hover(s => s.bg(t.hover)).on_click((_e, cx) => this.open(hit.path, cx, line.n))
        .child(div().flex_none().min_w(CELL * 3).text_size(11).text_color(t.dim).child(String(line.n)))
        .child(div().flex_1().min_w(0).child(this.marked(line.text, t))));
    }
    return out;
  }

  // An input with a frame, as the boxes of VS Code; `toggles` sit inside on the right.
  box(id, input, focused, toggles, t) {
    return h_flex().id(`box-${id}`).h(ROW + 12).flex_none().px(CELL).gap(CELL / 2).items_center().border_1().border_color(focused ? t.accent : C.box).cursor_text()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(div().flex_1().min_w(0).child(Input.new(input).text_size(13).text_color(t.foreground)))
      .children(toggles);
  }

  toggle_(id, label, t) {
    const on = this.options[id];
    return div().id(`opt-${id}`).flex_none().px(3).cursor_pointer().text_color(on ? t.foreground : C.idleIcon).when(on, el => el.bg(t.ansi8))
      .tooltip({ case: "Match case", word: "Match whole word", regex: "Use regular expression" }[id])
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { this.options[id] = !this.options[id]; this.search(cx); }).child(label);
  }

  searchView(t) {
    const count = this.hits.reduce((n, h) => n + h.lines.length, 0);
    const iconButton = (id, glyph, tip, click) => div().id(id).px(CELL / 2).cursor_pointer().text_color(C.idleIcon).hover(s => s.text_color(t.foreground)).tooltip(tip).on_click(click).child(glyph);
    return v_flex().flex_1().min_h(0)
      .child(h_flex().h(ROW).flex_none().px(CELL).items_center()
        .child(div().flex_1().font_bold().child("Search"))
        .child(iconButton("search-refresh", G.refresh, "Refresh", (_e, cx) => this.search(cx)))
        .child(iconButton("search-clear", G.clear, "Clear", (_e, cx) => { this.findInput.set_value(""); this.replaceInput.set_value(""); this.query = ""; this.hits = []; this.confirm = null; cx.notify(); })))
      .child(v_flex().flex_none().px(CELL * 3).pt(ROW).gap(ROW / 2)
        .child(this.box("find", this.findInput, this.typing === "find", [this.toggle_("case", "Aa", t), this.toggle_("word", "ab", t), this.toggle_("regex", ".*", t)], t))
        .child(this.box("replace", this.replaceInput, this.typing === "replace",
          [div().id("replace-all").flex_none().px(3).cursor_pointer().text_color(this.hits.length ? C.idleIcon : t.dim).hover(s => s.text_color(t.foreground)).tooltip("Replace all")
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { if (this.hits.length) { this.confirm = { count, files: this.hits.length }; cx.notify(); } }).child("all")], t)))
      .when(Boolean(this.confirm), el => el.child(h_flex().flex_none().mx(CELL * 3).mt(ROW / 2).gap(CELL).items_center()
        .child(div().flex_1().min_w(0).text_size(12).child(`Replace ${this.confirm.count} in ${this.confirm.files} files?`))
        .child(div().id("replace-yes").px(CELL).bg(t.accent).text_color(t.accent_foreground).cursor_pointer().on_click((_e, cx) => this.replaceAll(cx)).child("Replace"))
        .child(div().id("replace-no").px(CELL).bg(C.chip).text_color(C.chipText).cursor_pointer().on_click((_e, cx) => { this.confirm = null; cx.notify(); }).child("Cancel"))))
      .child(div().flex_none().px(CELL * 3).pt(ROW / 2).h(ROW * 1.5).text_size(11).text_color(t.dim)
        .child(this.searching ? "Searching…" : this.query ? `${count} results in ${this.hits.length} files` : ""))
      .child(v_flex().id("sidebar-found").flex_1().min_h(0).overflow_y_scrollbar().children(this.found(t)));
  }

  icon(id, glyph, active, click) {
    return div().id(`view-${id}`).w(CELL * 4).h(ROW * 2).flex_none().flex().items_center().justify_center().cursor_pointer()
      .text_color(active ? "#ffffff" : C.idleIcon).when(active, el => el.bg(C.box))
      .on_click((_e, cx) => click(cx)).child(glyph);
  }

  action(id, glyph, tip, click, t) {
    return div().id(`action-${id}`).flex_none().cursor_pointer().text_color(C.idleIcon).hover(s => s.text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => click(cx)).child(glyph);
  }

  chip(key, label) {
    return h_flex().flex_none().child(div().px(CELL).bg(C.chip).text_color(C.chipText).child(key)).child(div().px(CELL).child(label));
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    // The icons of tui-changes ask for a view here.
    const asked = shared("tui-sidebar.open");
    if (asked && asked.at !== this.asked) {
      this.asked = asked.at; this.show(null);
      if (asked.view === "settings") { this.view = "files"; this.picking = true; }
      else { this.view = asked.view; this.at = 0; }
      if (asked.view === "search") this.findInput.focus();
    }
    const active = this.handle.is_focused() || Boolean(this.typing), edge = active ? theme().accent : C.frame;
    this.detect(cx); if (this.on) this.detectMac(cx);
    const t = theme(), choices = this.available(), editor = choices.find(e => e.id === this.editor) ?? EDITORS[0];
    const titled = this.file ? this.file : (this.root?.split(/[\\/]/).pop() ?? "").toUpperCase();
    const body = this.file
      ? (this.code ? Editor.new(this.code).flex_1().min_h(0) : div().px(CELL).text_color(t.dim).child(this.fileError || "Loading file…"))
      : this.view === "search"
        ? this.searchView(t)
        : v_flex().id("sidebar-tree").flex_1().min_h(0).overflow_y_scrollbar().children(this.tree(t))
          .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().px(CELL).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))));
    const picker = v_flex().flex_none().mx(CELL)
      .when(this.picking, el => el.children(choices.map(e => h_flex().id(`editor-${e.id}`).h(ROW).px(CELL).cursor_pointer()
        .bg(e.id === editor.id ? t.selected : C.chip).text_color(C.chipText).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { this.editor = e.id; localStorage.setItem("editor", e.id); this.picking = false; cx.notify(); })
        .child(div().w(CELL * 2).child(e.id === editor.id ? "●" : "")).child(e.name))))
      .child(h_flex().id("editor-pick").h(ROW).items_center().cursor_pointer().on_click((_e, cx) => { this.picking = !this.picking; cx.notify(); })
        .child(div().px(CELL).bg(C.chip).text_color(C.chipText).child("e")).child(div().px(CELL).child("open in"))
        .child(div().text_color(t.ansi12).font_bold().child(`${editor.name} ${this.picking ? "▾" : "▴"}`)));
    return div().id("sidebar").size_full().min_h(0).pr(2).py(ROW / 2).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_mouse_down("left", () => this.handle.focus()).on_key_down((e, cx) => this.key(e, cx))
      // The frame of the TUI: the title sits in the top line, so that line is drawn in two pieces.
      .child(v_flex().id("sidebar-frame").size_full().min_h(0).border_l(1).border_r(1).border_b(1).border_color(edge)
        .on_hover((on, cx) => { if (this.overTree !== on) { this.overTree = on; cx.notify(); } })
        // The top line is at the very top, level with the frame of the terminal, and the title
        // sits on it, half a row above.
        .child(h_flex().h(1).flex_none().items_start()
          .child(div().w(CELL).h(1).bg(edge))
          .child(div().h(ROW).mt(-ROW / 2).px(CELL / 2).flex().items_center().text_color(edge).when(active, el => el.font_bold()).child("Sidebar"))
          .child(div().flex_1().h(1).bg(edge)))
        .child(div().h(ROW / 2).flex_none())
        .child(h_flex().h(ROW * 2.5).flex_none().px(CELL).items_center().gap(CELL)
          .child(this.icon("files", G.folder, this.view === "files", cx => { this.view = "files"; this.show(null); cx.notify(); }))
          .child(this.icon("search", G.search, this.view === "search", cx => { this.view = "search"; this.show(null); this.findInput.focus(); cx.notify(); }))
          .child(this.icon("git", G.git, false, () => run("layout.select", { stack: "panel-body", child: "changes" })))
          .child(div().flex_1())
          .child(this.icon("settings", G.gear, this.picking, cx => { this.picking = !this.picking; cx.notify(); })))
        .when(this.view !== "search" || Boolean(this.file), el => el.child(h_flex().h(ROW).flex_none().px(CELL).gap(CELL)
          .when(Boolean(this.file), el => el.child(div().id("sidebar-back").cursor_pointer().text_color(t.ansi12).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
          .child(div().id("sidebar-root").flex_1().min_w(0).truncate().text_color(t.ansi12).font_bold().child(titled)
            .when(!this.file && this.at === -1 && this.handle.is_focused(), el => el.bg(t.selected))
            .when(!this.file, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
            .when(!this.file, el => el.on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu("", true, cx); })))
          .when(!this.file && this.view === "files" && (this.overTree || Boolean(this.creating)), el => el.child(h_flex().flex_none().gap(CELL)
            .child(this.action("new-file", G.newFile, "New File…", cx => this.startCreate("file", cx), t))
            .child(this.action("new-folder", G.newFolder, "New Folder…", cx => this.startCreate("folder", cx), t))
            .child(this.action("reload", G.reload, "Refresh Explorer", cx => this.refresh(cx), t))
            .child(this.action("collapse", G.collapse, "Collapse Folders in Explorer", cx => this.collapseAll(cx), t))))))
        .when(Boolean(this.creating), el => el.child(h_flex().h(ROW + 8).flex_none().mx(CELL).px(CELL / 2).gap(CELL).items_center().border_1().border_color(t.accent)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(div().flex_none().text_color(C.icon).child(this.creating.kind === "folder" ? G.folder : G.file))
          .when(Boolean(this.creating.parent), el => el.child(div().flex_none().max_w(120).truncate().text_color(t.dim).child(`${this.creating.parent}/`)))
          .child(div().flex_1().min_w(0).child(Input.new(this.nameInput).text_size(13).text_color(t.foreground)))))
        .child(body)
        .when(Boolean(this.openError), el => el.child(div().px(CELL).text_color(C.removed).child(this.openError)))
        .when(this.view !== "search", el => el.child(v_flex().flex_none().px(CELL).pt(ROW / 2).children(HINTS.map(pair => h_flex().h(ROW).gap(CELL).children(pair.map(([k, l]) => this.chip(k, l)))))))
        .child(div().h(ROW / 2).flex_none())
        .child(picker)
        .child(h_flex().h(ROW).flex_none().px(CELL).items_center()
          .child(div().flex_1().min_w(0).truncate().child(this.branch ? `${G.branch} ${this.branch.name} ⟳ ${this.branch.behind}↓ ${this.branch.ahead}↑` : ""))
          .child(div().id("sidebar-hide").cursor_pointer().text_color(t.ansi12).font_bold().on_click(() => run("layout.hide", { id: "panel" })).child("«"))));
  }
}
