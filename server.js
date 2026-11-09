
const express = require("express");
const fs = require("fs");
const path = require("path");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const ROOT = __dirname;
const TARGET = (process.env.XPLAY_TARGET || "https://xplay.better16.wtf").replace(/\/+$/, "");

app.disable("x-powered-by");

// Enable cross-origin isolation for SharedArrayBuffer and threaded WASM.
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

// All website files are expected directly in the repository root.
function rootFile(name) {
  const fullPath = path.join(ROOT, name);
  try {
    return fs.statSync(fullPath).isFile() ? fullPath : null;
  } catch {
    return null;
  }
}

// Apply isolation headers to upstream responses too.
function applyIsolationHeaders(proxyRes) {
  proxyRes.headers["cross-origin-opener-policy"] = "same-origin";
  proxyRes.headers["cross-origin-embedder-policy"] = "require-corp";
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "xblox-webplayer",
    crossOriginIsolatedHeaders: true,
    indexFound: Boolean(rootFile("index.html")),
    styleFound: Boolean(rootFile("style.css")),
    filesServedFrom: "repository root"
  });
});

// Serve root index.html.
app.get("/", (_req, res) => {
  const index = rootFile("index.html");
  if (!index) {
    return res.status(404).type("text").send(
      "index.html was not found in the repository root. Put index.html beside server.js."
    );
  }
  res.sendFile(index);
});

// Serve root style.css.
app.get("/style.css", (_req, res) => {
  const css = rootFile("style.css");
  if (!css) {
    return res.status(404).type("text").send(
      "style.css was not found in the repository root. Put style.css beside server.js."
    );
  }
  res.type("text/css").sendFile(css);
});

// Shared upstream proxy for relay, content and assets.
const upstreamProxy = createProxyMiddleware({
  target: TARGET,
  changeOrigin: true,
  secure: true,
  ws: true,
  xfwd: true,
  logger: console,
  on: {
    proxyReq(proxyReq, req) {
      console.log(`[proxy] ${req.method} ${req.originalUrl}`);
      proxyReq.setHeader("Host", new URL(TARGET).host);
    },
    proxyRes(proxyRes, req) {
      applyIsolationHeaders(proxyRes);
      console.log(`[proxy response] ${proxyRes.statusCode} ${req.method} ${req.originalUrl}`);
    },
    error(err, req, res) {
      console.error(`[proxy error] ${req?.method} ${req?.originalUrl}: ${err.message}`);
      if (res && !res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      if (res && !res.writableEnded) {
        res.end("Upstream proxy error: " + err.message);
      }
    }
  }
});

// Proxy upstream player page under /proxy.
const pageProxy = createProxyMiddleware({
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
      applyIsolationHeaders(proxyRes);
      console.log(`[proxy page response] ${proxyRes.statusCode} ${req.originalUrl}`);
    },
    error(err, req, res) {
      console.error(`[proxy page error] ${req?.originalUrl}: ${err.message}`);
      if (res && !res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      if (res && !res.writableEnded) {
        res.end("Upstream proxy error: " + err.message);
      }
    }
  }
});

app.use("/proxy", pageProxy);

// Forward local-root assets and upstream relay/content endpoints.
app.use((req, res, next) => {
  const p = req.path;
  if (
    p === "/relay" || p.startsWith("/relay/") ||
    p === "/content" || p.startsWith("/content/") ||
    p === "/assets" || p.startsWith("/assets/")
  ) {
    return upstreamProxy(req, res, next);
  }
  next();
});

// Serve other files directly from repository root.
app.use((req, res, next) => {
  let requested;
  try {
    requested = decodeURIComponent(req.path).replace(/^\/+/, "");
  } catch {
    return res.status(400).send("Invalid URL path.");
  }

  if (!requested || requested.includes("\0")) return next();

  const filePath = path.resolve(ROOT, requested);
  const relative = path.relative(ROOT, filePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return res.sendStatus(403);
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return next();
    res.sendFile(filePath);
  });
});

app.use((_req, res) => {
  res.status(404).type("text").send("File not found in repository root.");
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Xblox server listening on port ${PORT}`);
  console.log(`Serving files from: ${ROOT}`);
  console.log(`index.html: ${rootFile("index.html") ? "FOUND" : "MISSING"}`);
  console.log(`style.css: ${rootFile("style.css") ? "FOUND" : "MISSING"}`);
  console.log(`Upstream: ${TARGET}`);
});

// Forward WebSocket connections.
server.on("upgrade", (req, socket, head) => {
  const url = req.url || "/";

  if (
    url.startsWith("/relay") ||
    url.startsWith("/content") ||
    url.startsWith("/assets")
  ) {
    console.log(`[websocket upgrade] ${url}`);
    upstreamProxy.upgrade(req, socket, head);
  } else if (url.startsWith("/proxy/")) {
    req.url = url.replace(/^\/proxy/, "") || "/";
    console.log(`[websocket proxy upgrade] ${req.url}`);
    pageProxy.upgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});
