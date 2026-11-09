const express = require("express");
const fs = require("fs");
const path = require("path");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const PROJECT_ROOT = __dirname;
const TARGET = (process.env.XPLAY_TARGET || "https://xplay.better16.wtf").replace(/\/+$/, "");

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".render", ".cache", "coverage",
  ".next", ".nuxt", "vendor", "tmp", "temp"
]);

const isInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

// Recursively search the project for a filename. Ignore dependency/build folders.
// Prefer common website folders and shallower paths, but keep searching the whole project.
function findFilesByName(root, wantedName) {
  const matches = [];
  const wanted = wantedName.toLowerCase();

  function walk(current, depth) {
    if (depth > 14) return;

    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        walk(path.join(current, entry.name), depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase() === wanted) {
        matches.push(path.join(current, entry.name));
      }
    }
  }

  walk(root, 0);

  const preferredFolders = [
    path.join(root, "public"),
    path.join(root, "public", "html"),
    path.join(root, "www"),
    path.join(root, "site"),
    path.join(root, "dist"),
    path.join(root, "build")
  ];

  const score = (file) => {
    const relative = path.relative(root, file);
    const parent = path.dirname(file);
    const preferredIndex = preferredFolders.findIndex(folder => isInside(folder, parent));
    const depth = relative.split(path.sep).length - 1;
    return (preferredIndex === -1 ? 100 : preferredIndex * 10) + depth;
  };

  return matches.sort((a, b) => score(a) - score(b));
}

function locateWebsiteFiles() {
  const indexes = findFilesByName(PROJECT_ROOT, "index.html");
  const styles = findFilesByName(PROJECT_ROOT, "style.css");

  const indexFile = indexes[0] || null;
  let styleFile = null;

  if (indexFile && styles.length) {
    const indexDir = path.dirname(indexFile);
    styleFile = styles.find(file => path.dirname(file) === indexDir)
      || styles.find(file => isInside(indexDir, file))
      || styles[0];
  } else {
    styleFile = styles[0] || null;
  }

  console.log("[file search] index.html matches:", indexes.length);
  indexes.forEach(file => console.log("  index:", path.relative(PROJECT_ROOT, file)));
  console.log("[file search] style.css matches:", styles.length);
  styles.forEach(file => console.log("  style:", path.relative(PROJECT_ROOT, file)));
  console.log("[file search] selected index:", indexFile ? path.relative(PROJECT_ROOT, indexFile) : "NOT FOUND");
  console.log("[file search] selected style:", styleFile ? path.relative(PROJECT_ROOT, styleFile) : "NOT FOUND");

  return { indexFile, styleFile };
}

let websiteFiles = locateWebsiteFiles();

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "xblox-webplayer",
    indexFound: Boolean(websiteFiles.indexFile),
    styleFound: Boolean(websiteFiles.styleFile),
    indexPath: websiteFiles.indexFile
      ? path.relative(PROJECT_ROOT, websiteFiles.indexFile)
      : null,
    stylePath: websiteFiles.styleFile
      ? path.relative(PROJECT_ROOT, websiteFiles.styleFile)
      : null
  });
});

// Re-scan on demand so files added during a running instance can be discovered.
app.get("/api/file-search", (_req, res) => {
  websiteFiles = locateWebsiteFiles();
  res.json({
    indexMatches: findFilesByName(PROJECT_ROOT, "index.html").map(file => path.relative(PROJECT_ROOT, file)),
    styleMatches: findFilesByName(PROJECT_ROOT, "style.css").map(file => path.relative(PROJECT_ROOT, file)),
    selectedIndex: websiteFiles.indexFile ? path.relative(PROJECT_ROOT, websiteFiles.indexFile) : null,
    selectedStyle: websiteFiles.styleFile ? path.relative(PROJECT_ROOT, websiteFiles.styleFile) : null
  });
});

// Forward requests to the configured upstream. This does not bypass upstream auth.
app.use("/proxy", createProxyMiddleware({
  target: TARGET,
  changeOrigin: true,
  secure: true,
  ws: true,
  xfwd: true,
  pathRewrite: { "^/proxy": "" },
  on: {
    error(err, _req, res) {
      if (res && !res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      if (res && !res.writableEnded) {
        res.end("Upstream proxy unavailable: " + err.message);
      }
    }
  }
}));

// Serve the selected stylesheet even when it is stored in a different folder.
app.get("/style.css", (_req, res) => {
  websiteFiles = websiteFiles.styleFile ? websiteFiles : locateWebsiteFiles();
  if (!websiteFiles.styleFile) {
    return res.status(404).type("text").send("style.css was not found anywhere in the project.");
  }
  res.type("text/css").sendFile(websiteFiles.styleFile);
});

// Serve the discovered index.html at the website root.
app.get("/", (_req, res) => {
  websiteFiles = websiteFiles.indexFile ? websiteFiles : locateWebsiteFiles();
  if (!websiteFiles.indexFile) {
    return res.status(404).type("text").send(
      "index.html was not found. Check the Render logs for the recursive file-search results."
    );
  }
  res.sendFile(websiteFiles.indexFile);
});

// Serve other files relative to the folder containing the selected index.html.
// This keeps relative images, scripts, fonts, and other local assets working.
app.use((req, res, next) => {
  if (!websiteFiles.indexFile) websiteFiles = locateWebsiteFiles();
  if (!websiteFiles.indexFile) return next();

  const requested = decodeURIComponent(req.path).replace(/^\/+/, "");
  if (!requested || requested.includes("\0")) return next();

  const baseDir = path.dirname(websiteFiles.indexFile);
  const candidate = path.resolve(baseDir, requested);

  if (!isInside(baseDir, candidate)) return res.sendStatus(403);

  fs.stat(candidate, (err, stat) => {
    if (err || !stat.isFile()) return next();
    res.sendFile(candidate);
  });
});

app.use((_req, res) => {
  res.status(404).type("text").send("File not found.");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Xblox server listening on port ${PORT}`);
});
