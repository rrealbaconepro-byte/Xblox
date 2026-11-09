const express = require("express");
const path = require("path");
const fs = require("fs");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const TARGET = (process.env.XPLAY_TARGET || "https://xplay.better16.wtf").replace(/\/+$/, "");
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");

app.disable("x-powered-by");

// Avoid forcing COEP/CORP on every response. Those headers can block
// cross-origin game assets and embedded player content.
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, target: TARGET, proxy: "ready" });
});

const proxy = createProxyMiddleware({
  target: TARGET,
  changeOrigin: true,
  secure: true,
  ws: true,
  xfwd: true,
  logger: console,
  on: {
    proxyReq(proxyReq, req) {
      console.log(`[proxy] ${req.method} ${req.originalUrl}`);
      // Keep the host header aligned with the upstream host.
      proxyReq.setHeader("Host", new URL(TARGET).host);
    },
    proxyRes(proxyRes, req) {
      console.log(`[proxy response] ${proxyRes.statusCode} ${req.method} ${req.originalUrl}`);
    },
    error(err, req, res) {
      console.error(`[proxy error] ${req?.method} ${req?.originalUrl}:`, err.message);
      if (res && !res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      if (res && !res.writableEnded) res.end("Upstream proxy error: " + err.message);
    }
  }
});

// Explicit proxy URL for loading the upstream player page.
app.use("/proxy", createProxyMiddleware({
  target: TARGET,
  changeOrigin: true,
  secure: true,
  ws: true,
  xfwd: true,
  pathRewrite: { "^/proxy": "" },
  logger: console,
  on: {
    proxyReq(proxyReq, req) {
      console.log(`[proxy page] ${req.method} ${req.originalUrl}`);
      proxyReq.setHeader("Host", new URL(TARGET).host);
    },
    proxyRes(proxyRes, req) {
      console.log(`[proxy page response] ${proxyRes.statusCode} ${req.originalUrl}`);
    },
    error(err, req, res) {
      console.error(`[proxy page error] ${req?.originalUrl}:`, err.message);
      if (res && !res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      if (res && !res.writableEnded) res.end("Upstream proxy error: " + err.message);
    }
  }
}));

// These paths are commonly requested by the web player for its relay and assets.
// Forward them without stripping their original URL paths.
app.use((req, res, next) => {
  if (
    req.path === "/relay" || req.path.startsWith("/relay/") ||
    req.path === "/content" || req.path.startsWith("/content/") ||
    req.path === "/assets" || req.path.startsWith("/assets/")
  ) {
    return proxy(req, res, next);
  }
  next();
});

// Serve local website files from public/.
app.use(express.static(PUBLIC, { index: "index.html", fallthrough: true }));

app.get("/", (_req, res) => {
  const indexPath = path.join(PUBLIC, "index.html");
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.status(404).send("public/index.html is missing.");
});

app.use((req, res) => {
  console.warn(`[404] ${req.method} ${req.originalUrl}`);
  res.status(404).type("text").send("Not found: " + req.originalUrl);
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Web player host listening on port ${PORT}`);
  console.log(`Upstream target: ${TARGET}`);
});

// Explicit WebSocket forwarding for relay connections.
server.on("upgrade", (req, socket, head) => {
  const url = req.url || "/";
  if (url.startsWith("/relay/") || url === "/relay" || url.startsWith("/proxy/")) {
    console.log(`[websocket] ${url}`);
    if (url.startsWith("/proxy/")) {
      // The /proxy middleware handles ordinary HTTP requests; forward WS with path stripped.
      req.url = url.replace(/^\/proxy/, "") || "/";
    }
    proxy.upgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});
