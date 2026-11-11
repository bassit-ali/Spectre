import fs from 'fs';
import path from 'path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { ConfigStore, DEFAULT_HTTP_PORT, clampHttpPort } from './config';
import { SpectreService } from './service';
import { attachWebSocket, Endpoint } from './ws';

const HOST = '127.0.0.1';

/** Locate <project>/server regardless of tsx (server/src) or compiled (server/dist/src). */
function findServerRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i += 1) {
    if (path.basename(dir) === 'server') return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(__dirname, '..');
}

function resolveWebDir(): string | null {
  const override = process.env.SPECTRE_WEB_DIR;
  if (override && fs.existsSync(override)) return path.resolve(override);
  const root = path.resolve(findServerRoot(), '..', 'web');
  const dist = path.join(root, 'dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) return dist;
  if (fs.existsSync(root) && fs.statSync(root).isDirectory()) return root;
  return null;
}

async function main(): Promise<void> {
  const config = new ConfigStore();
  const envPort = Number(process.env.SPECTRE_PORT);
  const PORT = Number.isFinite(envPort) && envPort > 0
    ? clampHttpPort(envPort)
    : clampHttpPort(config.value.httpPort ?? DEFAULT_HTTP_PORT);
  const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>Spectre</title>
<body style="font-family:system-ui;background:#0f1419;color:#d8dee9;padding:2rem">
<h1>Spectre server is running</h1>
<p>No web UI found (<code>web/dist</code> or <code>web</code>). Available on port ${PORT} (WebSocket /ws) &middot;
<a style="color:#88c0d0" href="/health">/health</a></p></body>`;

  const svc = new SpectreService(config);
  const webDir = resolveWebDir();
  const projectRoot = path.resolve(findServerRoot(), '..');
  svc.setWebDir(webDir);
  if (config.lastError) svc.log('warn', `config: ${config.lastError}`);
  svc.log('info', `config: ${config.path}`);
  svc.log('info', webDir ? `serving static UI from ${webDir}` : 'no web UI directory found; serving placeholder');

  const app = Fastify({ logger: false });

  app.get('/health', async (_req, reply) => {
    const h = svc.health();
    return reply.code(h.status === 'down' ? 503 : 200).header('Cache-Control', 'no-store').send(h);
  });

  // GET works from browser / curl with no body; POST kept for clients.
  app.get('/api/widget/open', async (_req, reply) => {
    const result = await svc.openDesktopWidget();
    return reply.code(result.ok ? 200 : 500).send(result);
  });
  app.post('/api/widget/open', async (_req, reply) => {
    const result = await svc.openDesktopWidget();
    return reply.code(result.ok ? 200 : 500).send(result);
  });
  app.get('/api/widget/close', async (_req, reply) => {
    await svc.closeDesktopWidget();
    return reply.send({ ok: true });
  });
  app.post('/api/widget/close', async (_req, reply) => {
    await svc.closeDesktopWidget();
    return reply.send({ ok: true });
  });

  if (webDir) {
    await app.register(fastifyStatic, { root: webDir, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      const wantsHtml = req.method === 'GET' && (req.headers.accept ?? '').includes('text/html');
      if (wantsHtml && fs.existsSync(path.join(webDir, 'index.html'))) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send(PLACEHOLDER));
  }

  const endpoint: Endpoint = {
    host: HOST,
    port: PORT,
    url: `http://${HOST}:${PORT}/`,
    wsUrl: `ws://${HOST}:${PORT}/ws`,
  };
  svc.setPublicUrl(endpoint.url);
  attachWebSocket(app.server, svc, endpoint);

  await app.listen({ host: HOST, port: PORT });
  svc.log('info', `Spectre listening on port ${PORT}`);

  svc.initPipShell(projectRoot, `${endpoint.url}widget.html`);
  svc.startWatchdog();
  // Boot BIT runs in the background so /health and WS are available immediately.
  void svc.runBit('boot');

  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return;
    closing = true;
    svc.log('info', `${sig}: shutting down`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    try {
      await svc.shutdown();
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => svc.log('error', `uncaughtException: ${err.stack ?? err}`));
  process.on('unhandledRejection', (err) => svc.log('error', `unhandledRejection: ${String(err)}`));
}

main().catch((err) => {
  console.error('[spectre] fatal:', err);
  process.exit(1);
});
