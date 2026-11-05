// Modified from the mod `tabs` 0.1.12 shipped with the Herdr app, under the Apache License 2.0.
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Colors and cell width of the tab bar of the Herdr TUI with the theme dracula.
const TUI = { bar: "#282a36", tab: "#44475a", text: "#828cb4", dim: "#6272a4", active: "#bd93f9" };
const CELL = 7.8;

export default class Tabs extends View {
  init() {
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  // Herdr opens a new tab right of the active one; the TUI puts it last, so a tab
  // not seen before moves to the end of its space. The first render only records.
  placeNew(all) {
    const first = !this.seen;
    this.seen ??= new Set();
    for (const s of all) (s.tabs ?? []).forEach((c, i, tabs) => {
      if (this.seen.has(c.id)) return;
      this.seen.add(c.id);
      if (!first && i < tabs.length - 1) run("tab.move", { id: c.id, index: tabs.length });
    });
  }

  // Ends a drag: a tab let go over an accent bar moves there.
  drop(shown, cx) {
    const from = this.pressed, insert = this.insert;
    this.pressed = null; this.insert = null;
    if (from !== null && insert !== null && shown[from]) run("tab.move", { id: shown[from].id, index: (insert > from ? insert - 1 : insert) + 1 });
    cx.notify();
  }

  render() {
    const t = theme();
    const all = spaces();
    this.placeNew(all);
    const space = all.find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    // The cells of Herdr 0.9.5 (src/client/shell/tabs.rs): a tab is its label plus four cells,
    // at least eight, with the label centered; the focused tab is accent, bold when named; an
    // unnamed tab has dimmer text. The number leads every label, for cmd+number.
    const item = (c, i) => {
      const named = !/^tb\d+$/.test(c.name) && !/^\d+$/.test(c.name);
      const label = `${named ? `${i + 1} ${c.name}` : `${i + 1}`}${c.zoomed ? " Z" : ""}`;
      const dot = c.status === "blocked" || c.status === "done";
      const cells = Math.max([...label].length + (dot ? 2 : 0) + 4, 8);
      return h_flex().id(`tab-${c.id}`).h_full().w(CELL * cells).min_w(0).flex_shrink_1().justify_center().items_center().text_size(13)
        .bg(c.active ? TUI.active : TUI.tab).text_color(c.active ? TUI.bar : named ? TUI.text : TUI.dim)
        .when(c.active && named, el => el.font_bold())
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; this.insert = null; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        // While a tab is held, the half of the tab under the pointer says where it would land.
        .on_mouse_move((e, cx) => {
          if (this.pressed === null || !e.bounds) return;
          const at = e.local_position.x < e.bounds.width / 2 ? i : i + 1;
          const insert = at === this.pressed || at === this.pressed + 1 ? null : at;
          if (insert !== this.insert) { this.insert = insert; cx.notify(); }
        })
        .on_mouse_up("left", (_e, cx) => {
          if (this.pressed === i && this.insert === null) run("tab.select", { id: c.id });
          this.drop(shown, cx);
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "tui-menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .child(div().min_w(0).truncate().child(label))
        .when(dot, el => el.child(div().ml(CELL).flex_none().text_color(c.active ? TUI.bar : t[c.status]).child("●")));
    };
    // The cell between two tabs; it shows the accent bar where a held tab would land.
    // The outer gaps are slim, since the TUI starts the first tab at the edge.
    const gap = k => div().id(`tab-gap-${k}`).w(k === 0 ? 3 : CELL).h_full().flex_none().flex().justify_center()
      .when(this.pressed !== null && this.insert === k, el => el.child(div().w(2).h_full().bg(TUI.active)));
    const strip = shown.flatMap((c, i) => i === 0 ? [gap(0), item(c, i)] : [gap(i), item(c, i)]).concat([gap(shown.length)]);
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    return h_flex().size_full().min_w(0).pl(lightsPadding - 10).items_center().bg(TUI.bar).text_size(13)
      .on_mouse_up("left", (_e, cx) => this.drop(shown, cx))
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().overflow_x_scrollbar().children(strip)
        .child(div().id("tab-new").h_full().px(CELL).flex().items_center().flex_none().text_color(TUI.text).hover(s => s.text_color(TUI.active))
          .on_mouse_down("left", stop).on_click(() => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })).child("+")))
      // Shows or hides the sidebar on the right, as cmd-e does; the TUI's sidebar has no such button.
      .child(div().id("panel-toggle").h_full().px(CELL).flex().items_center().flex_none().cursor_pointer()
        .text_color(panel && !panel.hidden ? TUI.active : TUI.text).hover(s => s.text_color(TUI.active))
        .tooltip(panel && !panel.hidden ? "Hide the sidebar (cmd-e)" : "Show the sidebar (cmd-e)")
        .on_mouse_down("left", stop).on_click(() => run("layout.toggle", { id: "panel" }))
        .child(panel && !panel.hidden ? "\u00bb" : "\u00ab"))
      .when(w?.buttons, el => el.child(button("minimize", "−", () => run("window.minimize")))
        .child(button("maximize", "□", () => run("window.maximize")))
        .child(button("close-window", svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
