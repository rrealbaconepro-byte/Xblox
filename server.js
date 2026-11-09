const express = require("express");
const path = require("path");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const TARGET = (process.env.XPLAY_TARGET || "https://xplay.better16.wtf").replace(/\/$/, "");
const PUBLIC_DIR = path.join(__dirname, "public");

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});

app.get("/health", (_req, res) => res.status(200).json({ ok: true, service: "xblox-webplayer" }));

// This proxy forwards requests; it does not bypass upstream authentication or origin checks.
app.use("/proxy", createProxyMiddleware({
  target: TARGET,
  changeOrigin: true,
  secure: true,
  ws: true,
  xfwd: true,
  pathRewrite: { "^/proxy": "" },
  on: {
    proxyReq(proxyReq) {
      proxyReq.setHeader("X-Forwarded-Host", proxyReq.getHeader("host") || "");
    },
    error(err, _req, res) {
      if (res && !res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      if (res && !res.writableEnded) res.end("Upstream proxy unavailable: " + err.message);
    }
  }
}));

app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));
app.get("*", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Web player server listening on ${PORT}`);
});
server.on("upgrade", (req, socket, head) => {
  // WebSocket upgrades under /proxy are handled by http-proxy-middleware.
});
