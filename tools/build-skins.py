#!/usr/bin/env python3
"""Generate Hermes TUI skins (one YAML per catalog profile) from the shipped
desktop/plugin.js catalog. Ports the color math of src/theme-map.mjs 1:1, so a
TUI skin reads like its desktop theme: verbatim bg/fg/ANSI, derived accents,
borders and muted tones, with the same 4.5:1 UI-text floor.

Usage: python3 tools/build-skins.py [--plugin DIR] [--out DIR]
  --plugin  dir containing desktop/plugin.js  (default: repo root of this file)
  --out     skins output dir                  (default: ~/.hermes/skins)
"""
import argparse, json, math, os, re

def hx(c):
    c = c.lstrip('#')
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))

def to_hex(t):
    return '#' + ''.join(f'{max(0, min(255, round(v))):02x}' for v in t)

def mix(a, b, t):
    A, B = hx(a), hx(b)
    return to_hex(A[i] + (B[i] - A[i]) * t for i in range(3))

def lin(c):
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

def lum(h):
    r, g, b = hx(h)
    return 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255)

def contrast(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)

def ensure(color, bg, minr):
    """Walk toward pure black/white until it clears minr against bg."""
    if contrast(color, bg) >= minr:
        return color
    black, white = '#000000', '#ffffff'
    best = black if contrast(black, bg) >= contrast(white, bg) else white
    if contrast(best, bg) < minr:
        return best
    t = 0.05
    while t <= 1.001:
        cand = mix(color, best, t)
        if contrast(cand, bg) >= minr:
            return cand
        t += 0.05
    return best

def load_profiles(plugin_dir):
    src = open(os.path.join(plugin_dir, 'desktop', 'plugin.js')).read()
    start = src.find('const PROFILES = [') + len('const PROFILES = ')
    i, depth, instr, esc = start, 0, False, False
    while i < len(src):
        c = src[i]
        if instr:
            if esc: esc = False
            elif c == '\\': esc = True
            elif c == '"': instr = False
        else:
            if c == '"': instr = True
            elif c == '[': depth += 1
            elif c == ']':
                depth -= 1
                if depth == 0:
                    break
        i += 1
    text = src[start:i + 1]
    text = re.sub(r'([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)', r'\1"\2"\3', text)
    return json.loads(text)

def skin_yaml(p):
    bg, ansi = p['bg'].lower(), p['ansi']
    fg = ensure(p['fg'], bg, 4.5)
    dark = lum(bg) < 0.5
    pool = [ansi[12], ansi[4], ansi[14], ansi[6]]
    seed = next((c for c in pool if contrast(c, bg) >= 3), max(pool, key=lambda c: contrast(c, bg)))
    accent = ensure(seed, bg, 4.5)
    card = mix(bg, fg, 0.05 if dark else 0.04)
    border = mix(bg, fg, 0.22 if dark else 0.18)
    dim = ensure(mix(bg, fg, 0.35), bg, 4.5)
    ok = ensure(ansi[10] if contrast(ansi[10], bg) >= contrast(ansi[2], bg) else ansi[2], bg, 3)
    warn = ensure(ansi[11] if contrast(ansi[11], bg) >= contrast(ansi[3], bg) else ansi[3], bg, 3)
    err = ensure(ansi[9] if contrast(ansi[9], bg) >= contrast(ansi[1], bg) else ansi[1], bg, 3)
    title = ensure(ansi[14] if contrast(ansi[14], bg) >= contrast(ansi[6], bg) else ansi[6], bg, 4.5)
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
  syntax_keyword: {q(ensure(ansi[12], bg, 3))}
  syntax_string: {q(ensure(ansi[10], bg, 3))}
  syntax_number: {q(ensure(ansi[11], bg, 3))}
  syntax_comment: {q(dim)}
  diff_added: {q(ok)}
  diff_removed: {q(err)}
"""

def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser()
    ap.add_argument('--plugin', default=here, help='dir containing desktop/plugin.js')
    ap.add_argument('--out', default=os.path.expanduser('~/.hermes/skins'), help='skins output dir')
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    n = 0
    for p in load_profiles(args.plugin):
        with open(os.path.join(args.out, f"{p['slug']}.yaml"), 'w') as f:
            f.write(skin_yaml(p))
        n += 1
    print(f'wrote {n} skins to {args.out}')

if __name__ == '__main__':
    main()
