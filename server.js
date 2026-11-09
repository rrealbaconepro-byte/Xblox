
const express = require("express");
const path = require("path");
const admin = require("firebase-admin");
const mime = require("mime-types");
const {
  createProxyMiddleware,
  responseInterceptor
} = require("http-proxy-middleware");

const app = express();
const PORT = process.env.PORT || 10000;

// =====================================
// CONFIGURATION
// =====================================

const OWNER = "rrealbaconepro-byte";
const REPO = "Xblox";
const TARGET = "https://xplay.better16.wtf";
const GITHUB_API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const CACHE_DURATION = 60 * 1000;

let cachedTree = null;
let lastTreeFetch = 0;
let indexPath = null;
let baseDirectory = "";

const fileCache = new Map();

// =====================================
// CROSS-ORIGIN ISOLATION
// =====================================

function setIsolationHeaders(res) {
  res.setHeader(
    "Cross-Origin-Opener-Policy",
    "same-origin"
  );

  res.setHeader(
    "Cross-Origin-Embedder-Policy",
    "require-corp"
  );
}

// Apply to normal Xblox responses
app.use((req, res, next) => {
  setIsolationHeaders(res);
  next();
});

// =====================================
// FIREBASE
// =====================================

let firebaseConnected = false;
let db = null;
let auth = null;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    );

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }

    db = admin.firestore();
    auth = admin.auth();
    firebaseConnected = true;

    console.log("[FIREBASE] Connected");
  } else {
    console.log("[FIREBASE] No credentials configured");
  }
} catch (error) {
  console.error("[FIREBASE ERROR]", error.message);
}

// =====================================
// GITHUB HEADERS
// =====================================

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Xblox-Server"
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  return headers;
}

// =====================================
// GET GITHUB REPOSITORY TREE
// =====================================

async function getRepositoryTree() {
  if (
    cachedTree &&
    Date.now() - lastTreeFetch < CACHE_DURATION
  ) {
    return cachedTree;
  }

  const headers = githubHeaders();

  const repoResponse = await fetch(GITHUB_API, {
    headers
  });

  if (!repoResponse.ok) {
    const details = await repoResponse.text();

    throw new Error(
      `GitHub repository error ${repoResponse.status}: ${details}`
    );
  }

  const repository = await repoResponse.json();
  const branch = repository.default_branch;

  const treeResponse = await fetch(
    `${GITHUB_API}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { headers }
  );

  if (!treeResponse.ok) {
    throw new Error(
      `GitHub tree error ${treeResponse.status}`
    );
  }

  const tree = await treeResponse.json();

  if (tree.truncated) {
    throw new Error("GitHub repository tree is too large");
  }

  const files = tree.tree.filter(
    file => file.type === "blob"
  );

  const htmlFiles = files
    .filter(file =>
      file.path.toLowerCase().endsWith("index.html")
    )
    .sort((a, b) => {
      if (a.path === "index.html") return -1;
      if (b.path === "index.html") return 1;
      return a.path.length - b.path.length;
    });

  if (!htmlFiles.length) {
    throw new Error("index.html not found");
  }

  indexPath = htmlFiles[0].path;

  baseDirectory = indexPath.includes("/")
    ? indexPath.substring(0, indexPath.lastIndexOf("/"))
    : "";

  cachedTree = {
    branch,
    files: new Map(
      files.map(file => [file.path, file])
    )
  };

  lastTreeFetch = Date.now();

  console.log("[GITHUB] Repository loaded");
  console.log("[GITHUB] Branch:", branch);
  console.log("[GITHUB] Index:", indexPath);
  console.log("[GITHUB] Files:", files.length);

  return cachedTree;
}

// =====================================
// DOWNLOAD GITHUB FILE
// =====================================

async function getGitHubFile(filePath, tree) {
  const file = tree.files.get(filePath);

  if (!file) return null;

  if (fileCache.has(file.sha)) {
    return fileCache.get(file.sha);
  }

  const encodedBranch = tree.branch
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  const encodedPath = filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  const url =
    `https://raw.githubusercontent.com/${OWNER}/${REPO}/${encodedBranch}/${encodedPath}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `GitHub file download error ${response.status}`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  fileCache.set(file.sha, buffer);

  return buffer;
}

// =====================================
// HEALTH CHECK
// =====================================

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    service: "Xblox",
    timestamp: new Date().toISOString()
  });
});

// =====================================
// FIREBASE STATUS
// =====================================

app.get("/api/firebase-status", (req, res) => {
  res.json({
    connected: firebaseConnected,
    firestore: !!db,
    authentication: !!auth
  });
});

app.get("/api/firebase-test", async (req, res) => {
  if (!db) {
    return res.status(503).json({
      success: false,
      error: "Firebase is not configured"
    });
  }

  try {
    await db.collection("xblox_system")
      .doc("connection")
      .set({
        status: "online",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

    res.json({
      success: true,
      message: "Firestore connected"
    });
  } catch (error) {
    console.error("[FIREBASE TEST]", error.message);

    res.status(500).json({
      success: false,
      error: "Firebase connection failed"
    });
  }
});

// =====================================
// GITHUB STATUS
// =====================================

app.get("/api/github-status", async (req, res) => {
  try {
    const tree = await getRepositoryTree();

    res.json({
      connected: true,
      repository: `${OWNER}/${REPO}`,
      branch: tree.branch,
      index: indexPath,
      files: tree.files.size
    });
  } catch (error) {
    console.error("[GITHUB STATUS]", error.message);

    res.status(503).json({
      connected: false,
      error: error.message
    });
  }
});

// =====================================
// XPLAY PROXY
// =====================================

app.use(
  "/proxy",
  createProxyMiddleware({
    target: TARGET,
    changeOrigin: true,
    secure: true,
    ws: true,
    selfHandleResponse: true,

    autoRewrite: true,
    protocolRewrite: "https",

    cookiePathRewrite: {
      "/": "/proxy"
    },

    on: {
      proxyRes: responseInterceptor(
        async (buffer, proxyRes, req, res) => {
          // Add isolation headers to proxied game responses too.
          setIsolationHeaders(res);

          const contentType =
            proxyRes.headers["content-type"] || "";

          const isHTML =
            contentType.includes("text/html");

          const isCSS =
            contentType.includes("text/css");

          const isJavaScript =
            contentType.includes("javascript");

          if (!isHTML && !isCSS && !isJavaScript) {
            return buffer;
          }

          let content = buffer.toString("utf8");

          // Route ordinary XPlay site references through this proxy.
          content = content.replace(
            /https:\/\/xplay\.better16\.wtf/gi,
            "/proxy"
          );

          content = content.replace(
            /\/\/xplay\.better16\.wtf/gi,
            "/proxy"
          );

          if (isHTML) {
            content = content.replace(
              /(href|src|action|poster)=(["'])\/(?!\/|proxy\/)/gi,
              '$1=$2/proxy/'
            );
          }

          if (isCSS) {
            content = content.replace(
              /url\((['"]?)\/(?!\/|proxy\/)/gi,
              "url($1/proxy/"
            );
          }

          return content;
        }
      ),

      error: (error, req, res) => {
        console.error(
          "[XPLAY PROXY ERROR]",
          error.message
        );

        if (res && !res.headersSent) {
          res.status(502).send(
            "XPlay proxy is temporarily unavailable."
          );
        }
      }
    }
  })
);

// =====================================
// GITHUB WEBSITE ROUTER
// =====================================

app.get("*", async (req, res) => {
  try {
    const tree = await getRepositoryTree();

    let requestedPath;

    try {
      requestedPath = decodeURIComponent(req.path);
    } catch {
      return res.status(400).send("Invalid URL");
    }

    requestedPath = requestedPath.replace(/^\/+/, "");

    if (
      requestedPath.includes("\\") ||
      requestedPath.split("/").includes("..")
    ) {
      return res.status(400).send("Invalid path");
    }

    if (
      !requestedPath ||
      requestedPath === "index.html"
    ) {
      requestedPath = indexPath;
    } else if (
      baseDirectory &&
      !requestedPath.startsWith(baseDirectory + "/")
    ) {
      requestedPath = `${baseDirectory}/${requestedPath}`;
    }

    // SPA fallback for client-side routes.
    if (
      !tree.files.has(requestedPath) &&
      !path.posix.extname(requestedPath)
    ) {
      requestedPath = indexPath;
    }

    const file = await getGitHubFile(
      requestedPath,
      tree
    );

    if (!file) {
      return res.status(404).send("404 - File Not Found");
    }

    const contentType =
      mime.lookup(requestedPath) ||
      "application/octet-stream";

    res.setHeader("Content-Type", contentType);

    if (requestedPath === indexPath) {
      res.setHeader(
        "Cache-Control",
        "no-cache, no-store, must-revalidate"
      );
    } else {
      res.setHeader(
        "Cache-Control",
        "public, max-age=60"
      );
    }

    res.send(file);
  } catch (error) {
    console.error("[XBLOX ERROR]", error.message);

    res.status(503).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Xblox - Service Unavailable</title>
      </head>
      <body>
        <h1>503 Service Unavailable</h1>
        <p>Unable to retrieve the Xblox website from GitHub.</p>
        <p>Please try again later.</p>
      </body>
      </html>
    `);
  }
});

// =====================================
// START SERVER
// =====================================

app.listen(PORT, () => {
  console.log("==============================");
  console.log(" XBLOX SERVER");
  console.log("==============================");
  console.log("Port:", PORT);
  console.log("GitHub:", `${OWNER}/${REPO}`);
  console.log(
    "Firebase:",
    firebaseConnected ? "Connected" : "Not configured"
  );
  console.log("XPlay Proxy:", TARGET);
  console.log("Cross-Origin Isolation: Enabled");
  console.log("==============================");
});
