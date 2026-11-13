"""One-time-at-load sync: materialize TUI skins + the /themes picker widget.

Kept in __init__.py (register) so `hermes plugins install` + `enable` is the only
setup a new machine needs — no manual skin build or widget copy. Guarded by a
stamp over the catalog + widget + generator inputs, so repeat loads cost one hash.
"""

import glob
import hashlib
import json
import os
import re
import shutil


def _plugin_root():
    return os.path.dirname(os.path.abspath(__file__))


def _hermes_home():
    return os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")


def _hex_rgb(c):
    c = str(c).strip().lstrip("#")
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def _to_hex(t):
    return "#" + "".join(f"{max(0, min(255, round(v))):02x}" for v in t)


def _mix(a, b, t):
    A, B = _hex_rgb(a), _hex_rgb(b)
    return _to_hex(A[i] + (B[i] - A[i]) * t for i in range(3))


def _lin(c):
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def _lum(h):
    r, g, b = _hex_rgb(h)
    return 0.2126 * _lin(r / 255) + 0.7152 * _lin(g / 255) + 0.0722 * _lin(b / 255)


def _contrast(a, b):
    la, lb = _lum(a), _lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def _ensure(color, bg, minr):
    if _contrast(color, bg) >= minr:
        return color
    black, white = "#000000", "#ffffff"
    best = black if _contrast(black, bg) >= _contrast(white, bg) else white
    if _contrast(best, bg) < minr:
        return best
    t = 0.05
    while t <= 1.001:
        cand = _mix(color, best, t)
        if _contrast(cand, bg) >= minr:
            return cand
        t += 0.05
    return best


def _extract_profiles_text(src: str) -> str:
    start = src.find("const PROFILES = [") + len("const PROFILES = ")
    i, depth, instr, esc = start, 0, False, False
    while i < len(src):
        c = src[i]
        if instr:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                instr = False
        else:
            if c == '"':
                instr = True
            elif c == "[":
                depth += 1
            elif c == "]":
                depth -= 1
                if depth == 0:
                    break
        i += 1
    return src[start:i + 1]


def _load_profiles(root):
    src = open(os.path.join(root, "desktop", "plugin.js"), encoding="utf-8").read()
    text = re.sub(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)", r'\1"\2"\3', _extract_profiles_text(src))
    return json.loads(text)


def _skin_yaml(p):
    bg, ansi = p["bg"].lower(), p["ansi"]
    fg = _ensure(p["fg"], bg, 4.5)
    dark = _lum(bg) < 0.5
    pool = [ansi[12], ansi[4], ansi[14], ansi[6]]
    seed = next((c for c in pool if _contrast(c, bg) >= 3), max(pool, key=lambda c: _contrast(c, bg)))
    accent = _ensure(seed, bg, 4.5)
    card = _mix(bg, fg, 0.05 if dark else 0.04)
    border = _mix(bg, fg, 0.22 if dark else 0.18)
    dim = _ensure(_mix(bg, fg, 0.35), bg, 4.5)
    ok = _ensure(ansi[10] if _contrast(ansi[10], bg) >= _contrast(ansi[2], bg) else ansi[2], bg, 3)
    warn = _ensure(ansi[11] if _contrast(ansi[11], bg) >= _contrast(ansi[3], bg) else ansi[3], bg, 3)
    err = _ensure(ansi[9] if _contrast(ansi[9], bg) >= _contrast(ansi[1], bg) else ansi[1], bg, 3)
    title = _ensure(ansi[14] if _contrast(ansi[14], bg) >= _contrast(ansi[6], bg) else ansi[6], bg, 4.5)
    q = json.dumps
    return f"""name: {q(p['slug'])}
description: {q('Terminal profile · iTerm2-Color-Schemes (catalog)')}

colors:
  background: {q(bg)}
  ui_accent: {q(accent)}
  banner_accent: {q(accent)}
  banner_title: {q(title)}
  banner_text: {q(fg)}
  ui_text: {q(fg)}
  ui_label: {q(fg)}
  banner_dim: {q(dim)}
  banner_border: {q(border)}
  ui_border: {q(border)}
  ui_ok: {q(ok)}
  ui_warn: {q(warn)}
  ui_error: {q(err)}
  prompt: {q(fg)}
  input_rule: {q(accent)}
  response_border: {q(title)}
  status_bar_bg: {q(card)}
  status_bar_text: {q(fg)}
  status_bar_good: {q(ok)}
  status_bar_warn: {q(warn)}
  status_bar_critical: {q(err)}
  session_label: {q(title)}
  session_border: {q(border)}
  ui_tool: {q(accent)}
  ui_thinking: {q(dim)}
  ui_primary: {q(fg)}
  ui_muted: {q(dim)}
  syntax_keyword: {q(_ensure(ansi[12], bg, 3))}
  syntax_string: {q(_ensure(ansi[10], bg, 3))}
  syntax_number: {q(_ensure(ansi[11], bg, 3))}
  syntax_comment: {q(dim)}
  diff_added: {q(ok)}
  diff_removed: {q(err)}
"""


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sync(verbose=False) -> str:
    """Write skins + widget if the stamp is stale. Returns a short status."""
    root = _plugin_root()
    home = _hermes_home()

    catalog = open(os.path.join(root, "desktop", "plugin.js"), "rb").read()
    widget = open(os.path.join(root, "tui", "themes.mjs"), "rb").read()
    stamp_path = os.path.join(root, "build", "tui-sync-stamp")
    stamp = f"{_sha(catalog)}:{_sha(widget)}:v1"

    # Fast path: stamp matches AND the artifacts actually exist (a user may
    # delete skins or the widget after the fact — the stamp alone can't see that).
    widgets_dir_probe = os.path.join(home, "tui-widgets", "themes.mjs")
    try:
        expected = len(json.loads(re.sub(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)", r'\1"\2"\3', _extract_profiles_text(catalog.decode("utf-8")))))
    except Exception:
        expected = 0
    skins_present = len(glob.glob(os.path.join(home, "skins", "catalog-*.yaml")))
    if (
        os.path.exists(stamp_path)
        and skins_present >= expected > 0
        and os.path.isfile(widgets_dir_probe)
    ):
        try:
            if open(stamp_path).read() == stamp:
                return "up-to-date"
        except OSError:
            pass

    profiles = _load_profiles(root)
    skins_dir = os.path.join(home, "skins")
    os.makedirs(skins_dir, exist_ok=True)
    written = 0
    for p in profiles:
        target = os.path.join(skins_dir, f"{p['slug']}.yaml")
        body = _skin_yaml(p)
        try:
            if open(target, encoding="utf-8").read() == body:
                continue
        except OSError:
            pass
        with open(target, "w", encoding="utf-8") as f:
            f.write(body)
        written += 1

    widgets_dir = os.path.join(home, "tui-widgets")
    os.makedirs(widgets_dir, exist_ok=True)
    widget_target = os.path.join(widgets_dir, "themes.mjs")
    widget_copied = False
    try:
        widget_copied = open(widget_target, "rb").read() != widget
    except OSError:
        widget_copied = True
    if widget_copied:
        shutil.copyfile(os.path.join(root, "tui", "themes.mjs"), widget_target)

    os.makedirs(os.path.dirname(stamp_path), exist_ok=True)
    with open(stamp_path, "w") as f:
        f.write(stamp)
    return f"{len(profiles)} skins ({written} written), widget {'copied' if widget_copied else 'current'}"
