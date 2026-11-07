// Modified from the mod `agents` 0.1.12 shipped with the Herdr app, under the Apache License 2.0.
// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, exec, notify, nextCommand, theme, settings, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function lead(tab, all = panes()) {
  const mine = all.filter(p => p.tab === tab.id && p.terminal);
  return mine.find(p => p.program?.agent) ?? mine.find(p => p.focused) ?? mine[0];
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};

// Claude Code runs its subagents and background shells inside its own process, so
// herdr-core never sees them; its files do. The pid in the terminal names the session
// (~/.claude/sessions/<pid>.json), the session's folder holds a meta.json per subagent,
// and its transcript records each background shell and the notice of its end.
const CC_SCRIPT = `
s=$(cat "$HOME/.claude/sessions/$1.json" 2>/dev/null) || exit 0
id=$(printf '%s' "$s" | sed -n 's/.*"sessionId":"\\([^"]*\\)".*/\\1/p')
[ -n "$id" ] || exit 0
for t in "$HOME"/.claude/projects/*/"$id".jsonl; do [ -f "$t" ] && break; done
[ -f "$t" ] || exit 0
echo "P $s"
echo "T $t"
for m in "\${t%.jsonl}"/subagents/*.meta.json; do
  [ -f "$m" ] || continue
  echo "M $(date -r "\${m%.meta.json}.jsonl" +%s 2>/dev/null || echo 0) $(basename "$m" .meta.json) $(tr -d '\\n' < "$m")"
done
grep -F -e '"run_in_background":true' -e '"backgroundTaskId"' -e '<task-notification>' "$t" | grep '^{"parentUuid"'
`;
// Claude Code's word for how a task ended, as the list's status words.
const CC_STATUS = { running: "working", completed: "done", failed: "blocked", killed: "idle", gone: "idle" };
const CC_RECENT = 30 * 60000;
const CC_MAX = 8;

const tag = (text, name) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];
const textOf = (content) => typeof content === "string" ? content : (content ?? []).map((c) => c.text ?? "").join("");

// The session's tasks, running first, then the ones that ended in the last half hour.
async function ccTasks(pid) {
  const r = await exec("sh", ["-c", CC_SCRIPT, "sh", String(pid)]).catch(() => null);
  if (!r?.stdout) return null;
  let session = {}, transcript = null;
  const metas = [], commands = new Map(), launched = new Map(), notes = new Map();
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("P ")) session = JSON.parse(line.slice(2));
    else if (line.startsWith("T ")) transcript = line.slice(2);
    else if (line.startsWith("M ")) {
      const [, at, name, ...meta] = line.split(" ");
      try { metas.push({ id: name.replace(/^agent-/, ""), at: Number(at) * 1000, ...JSON.parse(meta.join(" ")) }); } catch {}
    } else if (line.startsWith("{")) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const at = Date.parse(e.timestamp);
      const content = e.message?.content;
      for (const c of Array.isArray(content) ? content : []) {
        if (c.type === "tool_use" && c.input?.run_in_background) commands.set(c.id, { command: c.input.command, label: c.input.description, at });
      }
      const task = e.toolUseResult?.backgroundTaskId;
      if (task) launched.set(task, { use: content?.[0]?.tool_use_id, output: textOf(content?.[0]?.content).match(/written to: (\S+?\.output)/)?.[1], at });
      // A notice comes as a user message between turns, and as a queued attachment during one.
      const text = textOf(content) || (e.attachment?.prompt ?? "");
      if (text.includes("<task-notification>")) {
        notes.set(tag(text, "task-id"), { status: tag(text, "status"), summary: tag(text, "summary"), output: tag(text, "output-file"), at });
      }
    }
  }
  if (!transcript) return null;
  const dir = transcript.replace(/\.jsonl$/, "");
  // A task with no notice from before this process started died with the old one.
  const lost = (at) => at < (session.startedAt ?? 0);
  // The transcript holds a notice once Claude Code has taken it in, so a shell's notice is
  // also its delivery. A subagent in the foreground hands its result back as it finishes.
  const shells = [...launched].map(([id, l]) => {
    const c = commands.get(l.use) ?? {};
    const n = notes.get(id);
    return { kind: "shell", id, label: c.label || c.command || id, command: c.command, output: n?.output ?? l.output, started: c.at ?? l.at, ended: n?.at ?? null, summary: n?.summary, state: n?.status ?? (lost(l.at) ? "gone" : "running"), delivered: Boolean(n) };
  });
  const subagents = metas.map((m) => {
    const n = notes.get(m.id);
    // A subagent the user stopped is marked so, and gets neither "finished" nor a notice.
    const state = m.stoppedByUser ? "killed" : !m.finished ? (lost(m.at) ? "gone" : "running") : n?.status && n.status !== "completed" ? n.status : "completed";
    return { kind: "agent", id: m.id, label: m.description || m.agentType || m.id, type: m.agentType, transcript: `${dir}/subagents/agent-${m.id}.jsonl`, ended: m.finished || m.stoppedByUser ? m.at : null, summary: n?.summary, state, delivered: Boolean(n) || m.stoppedByUser || m.requestShape !== "background" };
  });
  return [...subagents, ...shells]
    .sort((x, y) => (y.state === "running") - (x.state === "running") || (y.ended ?? y.started ?? 0) - (x.ended ?? x.started ?? 0));
}

// A task leaves the list once its session has the result; a failed one stays until opened.
const listed = (x, seen, now) =>
  x.state === "running" ||
  (x.state !== "gone" && !x.delivered && now - (x.ended ?? 0) < CC_RECENT) ||
  (x.state === "failed" && !seen.has(x.id) && now - (x.ended ?? 0) < CC_RECENT);

// Kills the processes that write a shell's output file: the shell Claude Code started and its children.
const STOP_SCRIPT = `lsof -F pa -- "$1" 2>/dev/null | awk '/^p/{p=substr($0,2)} /^a[wu]/{print p}' | sort -u | xargs kill 2>/dev/null; true`;
// What a shell's window runs: the output as it grows, and ctrl-c stops the shell itself.
// The tail runs in the background, where the shell ignores ctrl-c for it, so the trap ends it.
const VIEW_SCRIPT = `f=$1
stop() { ${STOP_SCRIPT}; }
trap 'stop "$f"; kill $t 2>/dev/null; printf "\\nStopped.\\n"; exit 130' INT
tail -n +1 -f "$1" & t=$!
wait $t`;

// Whether a task window closes by itself: when its task ends, and when another tab is chosen.
const CLOSES = [
  { id: "close-on-end", label: "When the task ends" },
  { id: "close-on-leave", label: "When I leave the tab" },
];
const closes = (id) => shared(`tui-agents.${id}`) ?? true;

// A title wider than its room turns round in it, one character every 180 ms: each frame
// is the title rotated by one, and the box cuts it to its width. The room is guessed from
// the window's width, less the bar's other parts, at 7.5 px a character of the 12.5 px font.
const CHAR_PX = 7.5;
// The bar's width besides the title: icons, Stop, the state and ×.
const barPx = (task) => (task.kind === "shell" && task.state === "running" ? 350 : 220);
function scrolling(el, text, roomPx) {
  if (text.length * CHAR_PX <= roomPx) return el.child(text);
  const loop = `${text}     `;
  return el.frames([...loop].map((_, i) => loop.slice(i) + loop.slice(0, i)), 180);
}

// Failed tasks that were opened or stopped, which then leave the list. Shared, because the
// bar over a shell's terminal is another copy of this mod.
const seenTasks = () => new Set(shared("tui-agents.seen-tasks") ?? []);
function markSeen(id) {
  const seen = seenTasks();
  if (!seen.has(id)) setShared("tui-agents.seen-tasks", [...seen, id].slice(-200));
}

// Opens, or reopens in place at another size, a task's window, and records it in the shared
// list of open task windows, newest last, which the close key takes from.
function showTaskWindow(shown) {
  // Each opening has its own number, so the copy it replaces knows it is no longer the window.
  const task = { ...shown, opening: Date.now() };
  const { width, height, terminal } = task;
  const key = `cc-${task.id}`;
  const overlay = openOverlay(terminal
    ? { kind: "window", key, width, height, layout: { type: "column", children: [
        { type: "block", size: { px: 28 }, content: { mod: "tui-agents-list", props: { task } } },
        { type: "block", content: { terminal } },
      ] } }
    : { mod: "tui-agents-list", kind: "window", key, width, height, props: { task } });
  const open = (shared("tui-agents.task-windows") ?? []).filter((w) => w.key !== key);
  setShared("tui-agents.task-windows", [...open, { key, overlay, terminal: terminal ?? null, task }]);
}

function forgetTaskWindow(key) {
  const open = shared("tui-agents.task-windows") ?? [];
  if (open.some((w) => w.key === key)) setShared("tui-agents.task-windows", open.filter((w) => w.key !== key));
}

// The pid of the program in the foreground of a terminal on this machine.
async function foregroundPid(address) {
  const r = await exec("hc", ["get", address]).catch(() => null);
  try { return JSON.parse(r?.stdout ?? "")?.foreground?.pid ?? null; } catch { return null; }
}

// A subagent's steps from the tail of its transcript: what it said and the tools it called.
function agentSteps(text) {
  const steps = [];
  for (const line of text.split("\n")) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "assistant") continue;
    for (const c of e.message?.content ?? []) {
      if (c.type === "text" && c.text.trim()) steps.push(`› ${c.text.trim().replace(/\s+/g, " ")}`);
      if (c.type === "tool_use") {
        const i = c.input ?? {};
        steps.push(`⏺ ${c.name}(${String(i.description ?? i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.query ?? "").replace(/\s+/g, " ")})`);
      }
    }
  }
  return steps;
}

const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "blocked", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
// How an agent row lays out its text: "two" lines, or one line that "wrap"s.
const ROWS = [{ id: "two", label: "Two lines" }, { id: "wrap", label: "One line, wrapped" }];
const rowStyle = () => (ROWS.some(r => r.id === shared("tui-agents.rows")) ? shared("tui-agents.rows") : "two");

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    if (props()?.task) return this.watchTask(cx);
    this.folded = new Set();
    // A resize asked for before this copy started is not done again.
    this.resized = shared("tui-agents.resize")?.n;
    // Each local Claude Code agent's subagents and background shells, by address.
    this.cc = new Map();
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        if (c === "close-task") this.closeNewestTaskWindow();
        if (c === "grow-task") this.resizeTaskWindow(null, 1.15);
        if (c === "shrink-task") this.resizeTaskWindow(null, 1 / 1.15);
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        if (await this.loadCc()) cx.notify();
        await cx.sleep(3000);
      }
    });
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    cx.timer.every(30000, (cx) => cx.notify());
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Reloads the tasks of every Claude Code agent on this machine; true when any changed.
  async loadCc() {
    const mine = agents().filter((a) => a.app === "claude-code" && !a.address.includes("/"));
    let changed = false;
    for (const addr of this.cc.keys()) if (!mine.some((a) => a.address === addr)) changed = this.cc.delete(addr);
    for (const a of mine) {
      const pid = await foregroundPid(a.address);
      const tasks = (pid && (await ccTasks(pid))) || [];
      const old = this.cc.get(a.address);
      if (old && JSON.stringify(old.tasks) === JSON.stringify(tasks)) continue;
      this.cc.set(a.address, { pid, tasks });
      changed = true;
    }
    return changed;
  }

  // A task's window, or the bar over a shell's terminal: it reloads the task while open,
  // and closes itself when the task ends or another tab is chosen, as the options say.
  watchTask(cx) {
    this.task = null;
    this.lines = [];
    if (props().task.kind === "agent") {
      this.input = InputState.new({ placeholder: "Message to this subagent, through its session" });
    }
    cx.spawn(async (cx) => {
      const { pid, id, kind, terminal } = props().task;
      for (;;) {
        const task = (await ccTasks(pid))?.find((x) => x.id === id) ?? this.task;
        // Only an end seen while open closes it: a task opened after it ended stays to be read.
        if (task?.state === "running") this.sawRunning = true;
        if (this.sawRunning && task.state !== "running" && closes("close-on-end")) return this.close("the task ended");
        // The shell's output runs in its own terminal under the bar; the window shows the subagent's steps.
        const tail = !terminal && task?.transcript ? await exec("tail", ["-n", "80", task.transcript]).catch(() => null) : null;
        this.task = task;
        if (kind === "agent") this.lines = agentSteps(tail?.stdout ?? "").slice(-120);
        cx.notify();
        await cx.sleep(2000);
      }
    });
  }

  // Closes the window and ends the viewer's terminal with a hangup, which its ctrl-c trap
  // doesn't catch, so the task itself keeps running.
  // Why the last task window closed itself is kept in the shared value tui-agents.closed.
  close(reason) {
    if (this.closed) return;
    const mine = (shared("tui-agents.task-windows") ?? []).find((w) => w.key === `cc-${props().task.id}`);
    if (reason !== "×" && mine && mine.task.opening !== props().task.opening) return;
    this.closed = true;
    setShared("tui-agents.closed", { reason, key: `cc-${props().task.id}`, opening: props().task.opening, at: new Date().toISOString() });
    const { terminal, id } = props().task;
    forgetTaskWindow(`cc-${id}`);
    if (terminal) run("terminal.kill", { terminal });
    closeOverlay(props().overlay);
  }

  // Types the message into the parent Claude Code, which alone can reach its subagent.
  send(task) {
    const text = this.input.value().trim();
    if (!text) return;
    this.input.set_value("");
    this.note = "Sending…";
    // The reloaded task knows nothing of the list; the parent's address came with the click.
    const agent = props().task.agent;
    exec("hc", ["send", agent, `Send this message to your subagent "${task.label}" (agent id ${task.id}) with SendMessage: ${text}`])
      .then((r) => { this.note = r.code === 0 ? `Sent to ${agent}.` : r.stderr.trim() || "Not sent."; })
      .catch(() => { this.note = "Not sent: hc did not run."; });
  }

  stop(task) {
    markSeen(task.id);
    if (task.output) exec("sh", ["-c", STOP_SCRIPT, "sh", task.output]);
  }

  button(t, id, label, action) {
    return div()
      .id(id)
      .flex_none()
      .px(6)
      .text_size(11.5)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action();
      })
      .child(label);
  }

  taskBar(t, task) {
    const st = CC_STATUS[task.state] ?? "idle";
    // As wide as its window, not as its title: a longer title would push × out.
    return h_flex()
      .w_full()
      .overflow_hidden()
      .h(28)
      .px(10)
      .gap(8)
      .flex_none()
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t[st] ?? t.border)
      .child(this.status(t, { status: st }))
      // Stop sits on the left, far from ×: closing the window leaves the task running.
      .when(task.kind === "shell" && task.state === "running", (el) => el
        .child(this.button(t, "stop", "■ Stop", () => this.stop(task)))
        .child(div().text_size(11).text_color(t.dim).child("or ctrl-c")))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(task.kind === "shell" ? "$" : "◇"))
      .child(scrolling(div().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().text_size(12.5).text_color(t.foreground),
        task.label, (props().task.width ?? 640) - barPx(task)))
      .child(div().flex_none().text_size(11).text_color(t[st] ?? t.dim).child(task.state))
      .child(this.button(t, "smaller", "−", () => this.resize(1 / 1.15)))
      .child(this.button(t, "larger", "+", () => this.resize(1.15)))
      .child(this.button(t, "close", "×", () => this.close("×")));
  }

  taskWindow(t) {
    const task = this.task ?? props().task;
    // The tab shown when the window first drew; choosing another one closes it.
    this.tab ??= focused()?.tab;
    // A copy that a resize replaced draws once more; only the current window closes itself.
    if (closes("close-on-leave") && focused()?.tab && this.tab && focused().tab !== this.tab) {
      this.close(`left the tab ${this.tab} for ${focused().tab}`);
      return div();
    }
    if (props().task.terminal) return this.taskBar(t, task);
    const when = (ms) => (ms ? new Date(ms).toLocaleTimeString() : null);
    const facts = [`subagent${task.type ? ` · ${task.type}` : ""}`, task.ended ? `ended ${when(task.ended)}` : null].filter(Boolean);
    return v_flex()
      .size_full()
      .bg(t.background)
      .child(this.taskBar(t, task))
      .child(v_flex()
        .px(10)
        .py(6)
        .gap(2)
        .flex_none()
        .border_b(1)
        .border_color(t.border)
        .text_size(11)
        .text_color(t.dim)
        .child(div().child(facts.join(" · ")))
        .when(Boolean(task.summary), (el) => el.child(div().child(task.summary))))
      .child(v_flex()
        .id("task-output")
        .flex_1()
        .min_h(0)
        .px(10)
        .py(6)
        .overflow_y_scrollbar()
        .font_family(settings().font_family ?? "MesloLGS NF")
        .text_size(11.5)
        .text_color(t.foreground)
        .when(this.lines.length === 0, (el) => el.child(div().text_color(t.dim).child(this.task ? "No steps yet." : "Loading…")))
        .children(this.lines.map((l) => div().whitespace_normal().child(l || " "))))
      .child(v_flex()
        .px(10)
        .py(6)
        .gap(4)
        .flex_none()
        .border_t(1)
        .border_color(t.border)
        .child(div()
          .id("message")
          .h(28)
          .px(8)
          .flex()
          .items_center()
          .border_1()
          .border_color(t.input)
          .bg(t.chrome)
          .cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_key_down((e) => { if (e.key === "enter") this.send(task); })
          .child(Input.new(this.input).h_full().w_full().text_size(12).text_color(t.foreground)))
        .when(Boolean(this.note), (el) => el.child(div().text_size(11).text_color(t.dim).child(this.note))));
  }

  // A shell opens as a terminal that follows its output, under a bar of this mod;
  // a subagent opens as this mod's window of its steps.
  async openTask(c, pid, agent) {
    const tab = focused()?.tab;
    markSeen(c.id);
    // Wide enough for the whole title when it fits within 1100 px; a longer one turns round.
    const width = Math.round(Math.min(1100, Math.max(c.kind === "agent" ? 640 : 720, c.label.length * CHAR_PX + barPx(c) + 24)));
    const task = { ...c, pid, agent, tab, width, height: 440 };
    if (c.kind === "agent") return showTaskWindow(task);
    const r = await exec("hc", ["run", "--json", "--bg", "--no-parent", "--no-notify", "--rm", "--label", `tui-agents.task=${c.id}`, "--", "sh", "-c", VIEW_SCRIPT, "sh", c.output]).catch(() => null);
    let terminal = null;
    try { terminal = JSON.parse(r?.stdout ?? "").address; } catch {}
    if (!terminal) return notify({ title: "Could not open the shell's output", body: r?.stderr || c.output, level: "error" });
    showTaskWindow({ ...task, terminal });
  }

  // The close key: the newest task window closes, and its task keeps running.
  closeNewestTaskWindow() {
    const open = shared("tui-agents.task-windows") ?? [];
    const last = open.at(-1);
    if (!last) return;
    setShared("tui-agents.task-windows", open.slice(0, -1));
    if (last.terminal) run("terminal.kill", { terminal: last.terminal });
    closeOverlay(last.overlay);
  }

  // Asks the list to resize this window: a window that reopens itself under its own key closes.
  resize(factor) {
    setShared("tui-agents.resize", { key: `cc-${props().task.id}`, factor, n: Date.now() });
  }

  // Opens a task window again under its key, larger or smaller by a factor: the open one is
  // replaced in its place. Closing it first loses the new one too.
  resizeTaskWindow(key, factor) {
    const open = shared("tui-agents.task-windows") ?? [];
    const w = key ? open.find((x) => x.key === key) : open.at(-1);
    if (!w) return;
    const { task } = w;
    showTaskWindow({ ...task, width: Math.round(Math.max(420, task.width * factor)), height: Math.round(Math.max(240, task.height * factor)) });
  }

  ccRow(t, s) {
    const c = s.cc;
    const st = CC_STATUS[c.state] ?? "idle";
    return h_flex()
      .id(`cc-${c.id}`)
      .pl(39)
      .pr(8)
      .rounded(0)
      .h(26)
      .flex_none()
      .items_center()
      .text_size(12.5)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip(c.kind === "shell" ? `$ ${c.command ?? c.id}` : `${c.type ?? "subagent"}: ${c.label}`)
      .on_click(() => this.openTask(c, s.pid, s.agent))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .child(div().w(14).mr(6).flex_none().text_size(11).text_color(t.dim).child(c.kind === "shell" ? "$" : "◇"))
      .child(div().flex_1().truncate().text_color(c.state === "running" ? t.foreground : t.muted).child(c.label))
      .child(this.status(t, { status: st }, true));
  }

  // A row under an agent: a herdr-core sub-agent, or a task of a Claude Code session.
  subStatus(s) {
    return s.cc ? CC_STATUS[s.cc.state] ?? "idle" : kidStatus(s.t, this.listed);
  }

  // The agent's herdr-core sub-agents, then its Claude Code tasks, on one tree.
  subs(all, a) {
    const kids = this.tree(all, a.address);
    const now = Date.now();
    const seen = seenTasks();
    const tasks = (this.cc?.get(a.address)?.tasks ?? []).filter((x) => listed(x, seen, now)).slice(0, CC_MAX);
    if (!tasks.length) return kids;
    // The last sub-agent is no longer last: its corner becomes a tee, and the line runs on.
    const top = kids.reduce((m, k, i) => (k.lines.length === 1 ? i : m), -1);
    const joined = kids.map((k, i) => (i < top ? k : { ...k, lines: k.lines.map((l, j) => (j > 0 ? l : i === top ? "├" : "│")) }));
    const pid = this.cc.get(a.address).pid;
    return [...joined, ...tasks.map((c, i) => ({ cc: c, pid, agent: a.address, lines: [i === tasks.length - 1 ? "└" : "├"] }))];
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(0)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))))
      .child(div().px(8).pt(8).pb(6).text_size(11).text_color(t.dim).child("Rows"))
      .children(ROWS.map((r) => h_flex()
        .id(`rows-${r.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("tui-agents.rows", r.id);
          closeOverlay(props().overlay);
        })
        .child(div().flex_1().child(r.label))
        .when(r.id === rowStyle(), (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))))
      .child(div().px(8).pt(8).pb(6).text_size(11).text_color(t.dim).child("Close task windows"))
      .children(CLOSES.map((c) => h_flex()
        .id(`closes-${c.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => setShared(`tui-agents.${c.id}`, !closes(c.id)))
        .child(div().flex_1().child(c.label))
        .when(closes(c.id), (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(0)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.peek(k.address))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "blocked".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(0).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("blocked");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    if (props()?.task) return this.taskWindow(t);
    const ask = shared("tui-agents.resize");
    if (ask && ask.n !== this.resized) {
      this.resized = ask.n;
      this.resizeTaskWindow(ask.key, ask.factor);
    }
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.subs(all, a);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => (s.cc ? this.ccRow(t, s) : this.subRow(t, s, shown, byPriority)))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => this.subStatus(s));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    const tabs = spaces().flatMap(s => s.tabs);
    const label = (a) => {
      const tab = tabs.find(tab => tab.id === a.tab);
      return tab ? title(tab, lead(tab)) : a.title || a.program?.name || "";
    };
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      // The row leads with the name of its tab, or the agent's own title for a tab without one. Its space, when no space header is above it
      // (priority, pinned), the program, the machine and the time follow, on a second line or
      // after the name, wrapping, as the shared "tui-agents.rows" says.
      const full = byPriority || isPinned;
      const heading = label(a);
      // Every row names its machine, this Mac as "Local", as the TUI does.
      const facts = [machine ?? "Local", full ? a.space_name : null, a.program?.name, when ? duration(now - when) : null].filter(Boolean);
      const two = rowStyle() === "two";
      const nameEl = div().min_w(0).text_size(12).text_color(idle ? t.muted : t.foreground).when(two, el => el.truncate()).child(heading);
      const factEls = facts.map((f, j) => div().flex_none().text_size(11).text_color(t.dim).child(j === 0 && two ? f : `\u00b7 ${f}`));
      const text = two
        ? v_flex().flex_1().min_w(0).child(nameEl).child(h_flex().min_w(0).gap(6).overflow_hidden().children(factEls))
        : h_flex().flex_1().min_w(0).flex_wrap().items_baseline().gap_x(6).child(nameEl).children(factEls);
      return h_flex()
        .id(`ag-${a.address}`)
        .px(8)
        .py(4)
        .min_h(30)
        .flex_none()
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(text)
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("agents"))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "tui-agents-list", kind: "popup", width: 220, height: 360, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
