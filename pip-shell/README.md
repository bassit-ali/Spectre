# SPECTRE pip-shell

Thin always-on-top Electron window for the SPECTRE widget.

**Requires** the SPECTRE server on `http://127.0.0.1:9000` first.

```bash
# terminal 1
npm run server:start

# terminal 2
npm run pip:start
# or: npm --prefix pip-shell start
```

Override widget URL with `SPECTRE_WIDGET_URL`.

Opacity / pin: `window.spectreShell.setOpacity(0.4–1)`, `setPinned(boolean)`, plus localStorage poll fallback.
