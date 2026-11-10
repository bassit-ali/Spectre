# SPECTRE web UI (PAN-TILT PEDESTAL CONTROLLER)

Vite multi-page app - **UI only**, the Node/WebSocket server is not included.

```bash
cd web
npm install
npm run dev        # http://127.0.0.1:5174/  and  /widget.html
npm run build      # -> web/dist (index.html + widget.html, fonts bundled offline)
```

- `index.html` -> `src/console.ts` (console)
- `widget.html` -> `src/widget.ts` (floating widget; add `?bg=transparent` for a transparent host window)
- Both connect to `ws://127.0.0.1:9000/ws` (override HTTP base with `VITE_SPECTRE_HTTP`).
- Wire contract draft: `src/shared/protocol.ts`. Wiring hooks: `data-action`, `data-jog`, `data-preset`, `data-setting`, `data-bind`.
