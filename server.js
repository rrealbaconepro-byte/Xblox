const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;
const TARGET = 'https://xplay.better16.wtf';

// Proxy everything
app.use('/', createProxyMiddleware({
  target: TARGET,
  changeOrigin: true,
  secure: true,
  ws: true,                    // support WebSockets if the site uses them
  followRedirects: true,
  selfHandleResponse: false,

  on: {
    proxyReq: (proxyReq, req, res) => {
      // Optional: forward useful headers
      proxyReq.setHeader('X-Forwarded-Host', req.headers.host);
      proxyReq.setHeader('X-Forwarded-Proto', req.protocol);
    },
    proxyRes: (proxyRes, req, res) => {
      // Remove headers that can break embedding / cause redirect loops
      delete proxyRes.headers['x-frame-options'];
      delete proxyRes.headers['content-security-policy'];
      delete proxyRes.headers['content-security-policy-report-only'];
    },
    error: (err, req, res) => {
      console.error('Proxy error:', err.message);
      res.status(502).send('Proxy error – the upstream site may be down or blocking the request.');
    }
  }
}));

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
  console.log(`Proxying → ${TARGET}`);
});
