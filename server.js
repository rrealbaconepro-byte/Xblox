
const { createProxyMiddleware, responseInterceptor } =
    require('http-proxy-middleware');

const TARGET = 'https://roblox.com';

app.use('/proxy', createProxyMiddleware({
    target: TARGET,
    changeOrigin: true,
    secure: true,
    ws: true,
    selfHandleResponse: true,

    // Rewrite upstream redirects and cookies
    autoRewrite: true,
    protocolRewrite: 'https',
    cookiePathRewrite: {
        '/': '/proxy'
    },

    on: {
        proxyReq: (proxyReq) => {
            proxyReq.setHeader('origin', TARGET);
            proxyReq.setHeader('referer', TARGET + '/');
        },

        proxyRes: responseInterceptor(
            async (buffer, proxyRes, req, res) => {
                const contentType =
                    proxyRes.headers['content-type'] || '';

                let content = buffer.toString('utf8');

                // Rewrite upstream URLs
                const rewriteOrigin = (value) => {
                    return value
                        .replace(
                            /https:\/\/xplay\.better16\.wtf/gi,
                            '/proxy'
                        )
                        .replace(
                            /\/\/xplay\.better16\.wtf/gi,
                            '/proxy'
                        );
                };

                content = rewriteOrigin(content);

                // Rewrite root-relative HTML assets
                if (contentType.includes('text/html')) {
                    content = content.replace(
                        /(href|src|action|poster)=(["'])\/(?!\/|proxy\/)/gi,
                        '$1=$2/proxy/'
                    );
                }

                // Rewrite CSS root-relative assets
                if (contentType.includes('text/css')) {
                    content = content.replace(
                        /url\((['"]?)\/(?!\/|proxy\/)/gi,
                        'url($1/proxy/'
                    );
                }

                return content;
            }
        ),

        error: (err, req, res) => {
            console.error('[XPLAY PROXY ERROR]', err.message);

            if (res && !res.headersSent) {
                res.status(502).send('XPlay Proxy Error');
            }
        }
    }
}));
