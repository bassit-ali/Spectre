(() => {
  if (window.__pelcoPtOverlayInstalled) return;
  window.__pelcoPtOverlayInstalled = true;

  const HOST_ID = 'pelco-pt-overlay-host';
  let root = null;
  let shadow = null;
  let visible = true;
  let opacity = 0.85;

  function ensureUi() {
    if (document.getElementById(HOST_ID)) {
      root = document.getElementById(HOST_ID);
      return;
    }
    root = document.createElement('div');
    root.id = HOST_ID;
    root.style.all = 'initial';
    root.style.position = 'fixed';
    root.style.zIndex = '2147483646';
    root.style.right = '16px';
    root.style.bottom = '16px';
    root.style.width = '240px';
    document.documentElement.appendChild(root);
    shadow = root.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host, * { box-sizing: border-box; font-family: Segoe UI, sans-serif; }
        .shell {
          border-radius: 14px;
          border: 1px solid rgba(255,255,255,.18);
          background: rgba(15,20,25,.78);
          color: #e7eef7;
          backdrop-filter: blur(12px);
          box-shadow: 0 16px 40px rgba(0,0,0,.35);
          overflow: hidden;
        }
        header {
          display:flex; align-items:center; gap:8px;
          padding:8px 10px; background: rgba(0,0,0,.25); cursor: move;
        }
        .body { padding: 10px; }
        .note { font-size: 12px; color:#93a4b8; margin-bottom:8px; line-height:1.35; }
        .grid { display:grid; grid-template-columns: repeat(3,1fr); gap:6px; }
        button {
          border:0; border-radius:8px; padding:10px 0; cursor:pointer;
          background: linear-gradient(180deg,#3d9cf0,#2f6fed); color:#fff; font-weight:700;
        }
        label { display:flex; align-items:center; gap:8px; margin-top:8px; font-size:12px; color:#93a4b8; }
        input[type=range] { flex:1; }
      </style>
      <div class="shell" id="shell">
        <header id="drag"><strong>PelcoPT</strong><span style="margin-left:auto;font-size:12px;opacity:.7">overlay</span></header>
        <div class="body">
          <div class="note">In-page overlay. Full jog/serial lives in the PelcoPT desktop app (always-on-top widget). Preset buttons mirror IDs 1–9 for operator reference.</div>
          <div class="grid" id="presets"></div>
          <label>Opacity <input id="opacity" type="range" min="0.2" max="1" step="0.05" value="0.85" /></label>
        </div>
      </div>`;

    const presets = shadow.getElementById('presets');
    for (let i = 1; i <= 9; i++) {
      const b = document.createElement('button');
      b.textContent = String(i);
      b.title = `Preset ${i} — use desktop app to Call`;
      b.addEventListener('click', () => {
        b.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.92)' }, { transform: 'scale(1)' }], 160);
      });
      presets.appendChild(b);
    }

    const shell = shadow.getElementById('shell');
    const opacityEl = shadow.getElementById('opacity');
    opacityEl.addEventListener('input', () => {
      opacity = Number(opacityEl.value);
      shell.style.opacity = String(opacity);
      chrome.runtime.sendMessage({ type: 'pelco-set-settings', payload: { opacity } });
    });

    let dragging = false;
    let ox = 0;
    let oy = 0;
    const drag = shadow.getElementById('drag');
    drag.addEventListener('pointerdown', (e) => {
      dragging = true;
      ox = e.clientX - root.offsetLeft;
      oy = e.clientY - root.offsetTop;
      drag.setPointerCapture(e.pointerId);
    });
    drag.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      root.style.left = `${e.clientX - ox}px`;
      root.style.top = `${e.clientY - oy}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    });
    drag.addEventListener('pointerup', () => {
      dragging = false;
    });
  }

  function applyVisibility() {
    if (!root) return;
    root.style.display = visible ? 'block' : 'none';
  }

  chrome.runtime.sendMessage({ type: 'pelco-get-settings' }, (data) => {
    ensureUi();
    opacity = data?.opacity ?? 0.85;
    visible = data?.visible !== false;
    const shell = shadow.getElementById('shell');
    const opacityEl = shadow.getElementById('opacity');
    shell.style.opacity = String(opacity);
    opacityEl.value = String(opacity);
    applyVisibility();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'pelco-toggle') {
      ensureUi();
      visible = !visible;
      applyVisibility();
      chrome.runtime.sendMessage({ type: 'pelco-set-settings', payload: { visible } });
    }
  });
})();
