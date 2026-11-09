const express = require('express');
const path = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET = 'https://xplay.better16.wtf';

// Serve local static files (index.html, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Optional reverse proxy under /proxy (useful if you want to load assets through your domain)
app.use('/proxy', createProxyMiddleware({
  target: TARGET,
  changeOrigin: true,
  secure: true,
  ws: true,
  pathRewrite: {
    '^/proxy': '',          // remove /proxy prefix
  },
  on: {
    proxyRes: (proxyRes) => {
      // Allow embedding
      delete proxyRes.headers['x-frame-options'];
      delete proxyRes.headers['content-security-policy'];
      delete proxyRes.headers['content-security-policy-report-only'];
    },
    error: (err, req, res) => {
      console.error('Proxy error:', err.message);
      res.status(502).send('Proxy error');
    }
  }
}));

// Fallback: always serve index.html for any unknown route (SPA-style)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
