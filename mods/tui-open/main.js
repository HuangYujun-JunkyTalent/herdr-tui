// The right-click menu of the sidebar: "Open in Finder", a terminal, an editor, and so on.
// Opened as a pointer popup with props { items }, which the sidebar builds from the apps it
// found. An item is { label, glyph, exec: [command, args] } or { label, glyph, run: [name, args] };
// { sep: true } draws a line. ↑/↓ move, Enter runs, Esc closes.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme, exec, notify } from "herdr";

export default class Open extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(it, cx) {
    closeOverlay(props()?.overlay);
    if (it.run) { run(it.run[0], it.run[1]); return; }
    cx.spawn(async () => {
      const r = await exec(it.exec[0], it.exec[1]).catch(e => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) notify({ title: it.label, body: r.stderr || "did not start", level: "error" });
    });
  }

  render() {
    const t = theme();
    const all = props()?.items ?? [], list = all.filter(it => !it.sep);
    return v_flex().id("open-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") { if (list[this.at]) this.choose(list[this.at], cx); }
        else if (e.key === "escape") closeOverlay(props().overlay);
        else if (list.some(it => it.key === e.key)) this.choose(list.find(it => it.key === e.key), cx);
        else return;
        cx.notify();
      })
      .children(all.map((it, k) => {
        if (it.sep) return div().mx(7).my(4).h(1).flex_none().bg(t.border);
        const i = list.indexOf(it);
        return h_flex().id(`oi-${k}`).h(31).flex_none().px(8).gap(9).rounded(7).items_center().text_color(t.foreground)
          .when(i === this.at, el => el.bg(t.selected))
          // One highlight: the pointer moves the same choice as the arrow keys.
          .on_hover((on, cx) => { if (on && this.at !== i) { this.at = i; cx.notify(); } })
          .on_click((_e, cx) => this.choose(it, cx))
          .child(div().w(16).flex_none().text_color(t.muted).child(it.glyph ?? ""))
          .child(div().flex_1().min_w(0).truncate().child(it.label))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(it.key ?? ""));
      }));
  }
}
