
const express = require('express');
const admin = require('firebase-admin');
const { createProxyMiddleware } = require('http-proxy-middleware');
const mime = require('mime-types');

const app = express();
const PORT = process.env.PORT || 3000;

// GitHub configuration
const OWNER = 'rrealbaconepro-byte';
const REPO = 'Xblox';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

const TARGET = 'https://xplay.better16.wtf';

// Cache settings
const CACHE_TIME = 60 * 1000;
let cachedTree = null;
let lastTreeFetch = 0;
let indexPath = null;
let baseDirectory = '';

const fileCache = new Map();

// GitHub headers
function githubHeaders() {
    const headers = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Xblox-Server'
    };

    if (process.env.GITHUB_TOKEN) {
        headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    return headers;
}

// Firebase
let firebaseConnected = false;

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

        firebaseConnected = true;
        console.log('[FIREBASE] Connected');
    }
} catch (error) {
    console.error('[FIREBASE ERROR]', error.message);
}

const db = firebaseConnected ? admin.firestore() : null;
const auth = firebaseConnected ? admin.auth() : null;

// Retrieve complete GitHub repository tree
async function getRepositoryTree() {
    if (cachedTree && Date.now() - lastTreeFetch < CACHE_TIME) {
        return cachedTree;
    }

    const response = await fetch(API, {
        headers: githubHeaders()
    });

    if (!response.ok) {
        throw new Error(`GitHub repository error: ${response.status}`);
    }

    const repository = await response.json();
    const branch = repository.default_branch;

    const treeResponse = await fetch(
        `${API}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        { headers: githubHeaders() }
    );

    if (!treeResponse.ok) {
        throw new Error(`GitHub tree error: ${treeResponse.status}`);
    }

    const tree = await treeResponse.json();

    if (tree.truncated) {
        throw new Error('GitHub repository is too large');
    }

    const files = tree.tree.filter(file => file.type === 'blob');

    const htmlFiles = files
        .filter(file => file.path.toLowerCase().endsWith('index.html'))
        .sort((a, b) => {
            if (a.path === 'index.html') return -1;
            if (b.path === 'index.html') return 1;
            return a.path.length - b.path.length;
        });

    if (!htmlFiles.length) {
        throw new Error('index.html not found');
    }

    indexPath = htmlFiles[0].path;
    baseDirectory = indexPath.includes('/')
        ? indexPath.substring(0, indexPath.lastIndexOf('/'))
        : '';

    cachedTree = {
        branch,
        files: new Map(files.map(file => [file.path, file]))
    };

    lastTreeFetch = Date.now();

    console.log('[GITHUB] Repository loaded');
    console.log('[GITHUB] Branch:', branch);
    console.log('[GITHUB] Website:', indexPath);
    console.log('[GITHUB] Files:', files.length);

    return cachedTree;
}

// Retrieve any file from GitHub
async function getGitHubFile(filePath, tree) {
    const file = tree.files.get(filePath);

    if (!file) {
        return null;
    }

    if (fileCache.has(file.sha)) {
        return fileCache.get(file.sha);
    }

    const encodedBranch = tree.branch
        .split('/')
        .map(encodeURIComponent)
        .join('/');

    const encodedPath = filePath
        .split('/')
        .map(encodeURIComponent)
        .join('/');

    const url =
        `https://raw.githubusercontent.com/${OWNER}/${REPO}/${encodedBranch}/${encodedPath}`;

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`GitHub file error: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    fileCache.set(file.sha, buffer);

    return buffer;
}

// GitHub status
app.get('/api/github-status', async (req, res) => {
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
        res.status(503).json({
            connected: false,
            error: error.message
        });
    }
});

// Firebase status
app.get('/api/firebase-status', (req, res) => {
    res.json({
        connected: firebaseConnected,
        firestore: !!db,
        authentication: !!auth
    });
});

// XPlay proxy
app.use('/proxy', createProxyMiddleware({
    target: TARGET,
    changeOrigin: true,
    secure: true,
    ws: true,

    pathRewrite: {
        '^/proxy': ''
    },

    on: {
        proxyRes: (proxyRes) => {
            delete proxyRes.headers['x-frame-options'];
            delete proxyRes.headers['content-security-policy'];
            delete proxyRes.headers['content-security-policy-report-only'];
        },

        error: (err, req, res) => {
            console.error('[PROXY ERROR]', err.message);

            if (res && !res.headersSent) {
                res.status(502).send('Xblox Proxy Error');
            }
        }
    }
}));

// Serve the complete GitHub website
app.get('*', async (req, res) => {
    try {
        const tree = await getRepositoryTree();

        let requestedPath;

        try {
            requestedPath = decodeURIComponent(req.path);
        } catch {
            return res.status(400).send('Invalid URL');
        }

        requestedPath = requestedPath.replace(/^\/+/, '');

        if (
            requestedPath.includes('\\') ||
            requestedPath.split('/').includes('..')
        ) {
            return res.status(400).send('Invalid path');
        }

        // Root displays index.html
        if (!requestedPath || requestedPath === 'index.html') {
            requestedPath = indexPath;
        } else {
            requestedPath = baseDirectory
                ? `${baseDirectory}/${requestedPath}`
                : requestedPath;
        }

        // Support SPA routes
        if (
            !tree.files.has(requestedPath) &&
            !require('path').posix.extname(requestedPath)
        ) {
            requestedPath = indexPath;
        }

        const file = await getGitHubFile(requestedPath, tree);

        if (!file) {
            return res.status(404).send('404 - File Not Found');
        }

        const contentType = mime.lookup(requestedPath) ||
            'application/octet-stream';

        res.setHeader('Content-Type', contentType);

        if (requestedPath === indexPath) {
            res.setHeader('Cache-Control', 'no-cache');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=60');
        }

        res.send(file);

    } catch (error) {
        console.error('[XBLOX ERROR]', error.message);

        res.status(503).send(`
            <!DOCTYPE html>
            <html>
            <head>
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

// Start server
app.listen(PORT, () => {
    console.log('================================');
    console.log('          XBLOX SERVER');
    console.log('================================');
    console.log('Port:', PORT);
    console.log('GitHub:', `${OWNER}/${REPO}`);
    console.log('Firebase:', firebaseConnected ? 'Connected' : 'Not configured');
    console.log('================================');
});
