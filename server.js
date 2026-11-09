
const express = require("express");
const fs = require("fs");
const path = require("path");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const ROOT = __dirname;
const TARGET = (
  process.env.XPLAY_TARGET || "https://xplay.better16.wtf"
).replace(/\/+$/, "");

app.disable("x-powered-by");

// Cross-origin isolation for threaded game support.
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

// Only serve files directly from the repository root.
function rootFile(name) {
  const fullPath = path.join(ROOT, name);
  try {
    return fs.statSync(fullPath).isFile() ? fullPath : null;
  } catch {
    return null;
  }
}

function applyIsolationHeaders(proxyRes) {
  proxyRes.headers["cross-origin-opener-policy"] = "same-origin";
  proxyRes.headers["cross-origin-embedder-policy"] = "require-corp";
}

function proxyOptions(label) {
  return {
    target: TARGET,
    changeOrigin: true,
    secure: true,
    ws: true,
    xfwd: true,
    logger: console,
    on: {
      proxyReq(proxyReq, req) {
        console.log(`[${label}] ${req.method} ${req.originalUrl}`);
        proxyReq.setHeader("Host", new URL(TARGET).host);
      },
      proxyRes(proxyRes, req) {
        applyIsolationHeaders(proxyRes);
        console.log(
          `[${label} response] ${proxyRes.statusCode} ${req.originalUrl}`
        );
      },
      error(err, req, res) {
        console.error(
          `[${label} error] ${req?.originalUrl}: ${err.message}`
        );

        if (res && !res.headersSent) {
          res.writeHead(502, {
            "content-type": "text/plain; charset=utf-8"
          });
        }

        if (res && !res.writableEnded) {
          res.end("Upstream proxy error: " + err.message);
        }
      }
    }
  };
}

// Main upstream proxy.
const upstreamProxy = createProxyMiddleware(proxyOptions("upstream"));

// Upstream player page proxy.
const pageProxy = createProxyMiddleware({
  ...proxyOptions("player page"),
  pathRewrite: { "^/proxy": "" }
});

// Health check.
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "xblox-webplayer",
    crossOriginIsolatedHeaders: true,
    indexFound: Boolean(rootFile("index.html")),
    styleFound: Boolean(rootFile("style.css")),
    consoleDataFound: Boolean(rootFile("RobloxConsole.data.js")),
    filesServedFrom: "repository root",
    upstream: TARGET
  });
});

// Homepage.
app.get("/", (_req, res) => {
  const index = rootFile("index.html");

  if (!index) {
    return res.status(404).type("text").send(
      "index.html was not found in the repository root."
    );
  }

  res.sendFile(index);
});

// Stylesheet.
app.get("/style.css", (_req, res) => {
  const css = rootFile("style.css");

  if (!css) {
    return res.status(404).type("text").send(
      "style.css was not found in the repository root."
    );
  }

  res.type("text/css").sendFile(css);
});

// Explicitly handle RobloxConsole.data.js.
// Serve a real local copy if present; otherwise request it upstream.
app.get("/RobloxConsole.data.js", (req, res, next) => {
  const localFile = rootFile("RobloxConsole.data.js");

  if (localFile) {
    console.log("[console data] Serving local RobloxConsole.data.js");
    return res.type("application/javascript").sendFile(localFile);
  }

  console.log("[console data] Local file missing; requesting upstream");
  upstreamProxy(req, res, next);
});

// Player page.
app.use("/proxy", pageProxy);

// Relay, content, and asset endpoints.
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

// Serve other files from repository root.
app.use((req, res, next) => {
  let requested;

  try {
    requested = decodeURIComponent(req.path).replace(/^\/+/, "");
  } catch {
    return res.status(400).send("Invalid URL path.");
  }

  if (!requested || requested.includes("\0")) {
    return next();
  }

  const filePath = path.resolve(ROOT, requested);
  const relative = path.relative(ROOT, filePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return res.sendStatus(403);
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return next();
    }

    res.sendFile(filePath);
  });
});

// Not found.
app.use((_req, res) => {
  res.status(404).type("text").send(
    "File not found in repository root or upstream routes."
  );
});

// Start server.
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Xblox listening on port ${PORT}`);
  console.log(`Repository root: ${ROOT}`);
  console.log(`index.html: ${rootFile("index.html") ? "FOUND" : "MISSING"}`);
  console.log(`style.css: ${rootFile("style.css") ? "FOUND" : "MISSING"}`);
  console.log(
    `RobloxConsole.data.js: ${
      rootFile("RobloxConsole.data.js") ? "FOUND LOCALLY" : "NOT LOCAL - UPSTREAM"
    }`
  );
  console.log(`Upstream: ${TARGET}`);
});

// WebSocket forwarding.
server.on("upgrade", (req, socket, head) => {
  const url = req.url || "/";

  if (
    url.startsWith("/relay") ||
    url.startsWith("/content") ||
    url.startsWith("/assets")
  ) {
    console.log(`[websocket] ${url}`);
    upstreamProxy.upgrade(req, socket, head);
    return;
  }

  if (url.startsWith("/proxy/")) {
    req.url = url.replace(/^\/proxy/, "") || "/";
    console.log(`[websocket player page] ${req.url}`);
    pageProxy.upgrade(req, socket, head);
    return;
  }

  socket.destroy();
});
