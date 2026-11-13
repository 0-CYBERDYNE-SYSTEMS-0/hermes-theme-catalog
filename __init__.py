"""Theme Catalog — 606 iTerm2-Color-Schemes profiles as Hermes themes.

Desktop: Electron loads desktop/plugin.js. Terminal: register() materializes
TUI skins + the /themes picker widget into the Hermes home (stamp-guarded, so
repeat loads cost one hash). Tools/hooks: none.
"""

import os
import sys

try:
    from .sync import sync as _sync
except ImportError:  # loaded as a top-level module, not a package
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from sync import sync as _sync


def register(ctx):
    try:
        status = _sync()
        if status != "up-to-date":
            print(f"[theme-catalog] TUI sync: {status}", flush=True)
    except Exception as exc:  # never block plugin load on cosmetics
        print(f"[theme-catalog] TUI sync failed: {exc}", flush=True)
