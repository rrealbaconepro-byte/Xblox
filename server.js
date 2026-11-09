
const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

const PORT = process.env.PORT || 3000;

// GitHub repository
const GITHUB_OWNER = 'rrealbaconepro-byte';
const GITHUB_REPO = 'Xblox';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

// Reverse proxy
const TARGET = 'https://xplay.better16.wtf';

// Cache
let cachedHTML = null;
let lastFetch = 0;
const CACHE_DURATION = 60 * 1000;

// Firebase initialization
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

        console.log('[FIREBASE] Connected successfully');
    } else {
        console.log('[FIREBASE] No service account configured');
    }
} catch (error) {
    console.error('[FIREBASE] Initialization failed:', error.message);
}

// Firebase references
const db = firebaseConnected
    ? admin.firestore()
    : null;

const auth = firebaseConnected
    ? admin.auth()
    : null;

// Find index.html anywhere in the repository
async function getGitHubHTML() {
    const now = Date.now();

    if (cachedHTML && now - lastFetch < CACHE_DURATION) {
        return cachedHTML;
    }

    const headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Xblox-Server'
    };

    if (process.env.GITHUB_TOKEN) {
        headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    // Get repository information
    const repoResponse = await fetch(GITHUB_API, { headers });

    if (!repoResponse.ok) {
        throw new Error(`GitHub repository error: ${repoResponse.status}`);
    }

    const repo = await repoResponse.json();
    const branch = repo.default_branch;

    // Search repository files
    const treeResponse = await fetch(
        `${GITHUB_API}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        { headers }
    );

    if (!treeResponse.ok) {
        throw new Error(`GitHub tree error: ${treeResponse.status}`);
    }

    const tree = await treeResponse.json();

    if (tree.truncated) {
        throw new Error('GitHub repository tree is too large');
    }

    // Find index.html, preferring the repository root
    const files = tree.tree.filter(file =>
        file.type === 'blob' &&
        file.path.toLowerCase().endsWith('index.html')
    );

    files.sort((a, b) => {
        if (a.path === 'index.html') return -1;
        if (b.path === 'index.html') return 1;
        return a.path.length - b.path.length;
    });

    if (!files.length) {
        throw new Error('index.html was not found in Xblox');
    }

    const selectedFile = files[0];

    console.log(`[GITHUB] Found ${selectedFile.path}`);

    // Download HTML
    const rawURL =
        `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${encodeURIComponent(branch)}/${selectedFile.path.split('/').map(encodeURIComponent).join('/')}`;

    const htmlResponse = await fetch(rawURL);

    if (!htmlResponse.ok) {
        throw new Error(`HTML download failed: ${htmlResponse.status}`);
    }

    cachedHTML = await htmlResponse.text();
    lastFetch = now;

    console.log('[GITHUB] index.html downloaded successfully');

    return cachedHTML;
}

// Local static files
app.use(express.static(path.join(__dirname, 'public')));

// Firebase status
app.get('/api/firebase-status', (req, res) => {
    res.json({
        service: 'Xblox Firebase',
        connected: firebaseConnected,
        firestore: !!db,
        authentication: !!auth
    });
});

// Firebase test endpoint
app.get('/api/firebase-test', async (req, res) => {
    if (!db) {
        return res.status(503).json({
            error: 'Firebase is not configured'
        });
    }

    try {
        await db.collection('xblox_system').doc('connection').set({
            status: 'online',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({
            success: true,
            message: 'Firebase Firestore connection successful'
        });
    } catch (error) {
        console.error('[FIREBASE]', error.message);

        res.status(500).json({
            error: 'Firebase connection failed'
        });
    }
});

// XPlay reverse proxy
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
            console.error('[PROXY]', err.message);

            if (res && !res.headersSent) {
                res.status(502).send('Xblox Proxy Error');
            }
        }
    }
}));

// Serve GitHub index.html
app.get('*', async (req, res) => {
    try {
        const html = await getGitHubHTML();

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');

        res.send(html);

    } catch (error) {
        console.error('[GITHUB ERROR]', error.message);

        res.status(503).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Xblox - Service Unavailable</title>
            </head>
            <body>
                <h1>503 Service Unavailable</h1>
                <p>Xblox could not retrieve index.html from GitHub.</p>
                <p>Please try again later.</p>
            </body>
            </html>
        `);
    }
});

app.listen(PORT, () => {
    console.log('================================');
    console.log('       XBLOX SERVER');
    console.log('================================');
    console.log(`Port: ${PORT}`);
    console.log(`GitHub: ${GITHUB_OWNER}/${GITHUB_REPO}`);
    console.log(`Firebase: ${firebaseConnected ? 'Connected' : 'Not configured'}`);
    console.log('================================');
});
