const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const express = require('express');

// Khai báo tên miền API chuẩn xác theo log hệ thống của bạn
const NGUONC_API_BASE = 'https://nguonc.com'; 
const PORT = process.env.PORT || 7860;

// 1. Khởi tạo Manifest cho Addon
const manifest = {
    id: 'org.stremio.nguonc.hfspace',
    version: '3.4.0',
    name: 'NguonC Phim (HF Space)',
    description: 'Xem phim từ NguonC - Chạy trên Hugging Face Spaces 24/7',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['nguonc:'],
    catalogs: [
        { type: 'movie', id: 'nguonc-phim-moi', name: 'NguonC: Mới Cập Nhật', extra: [{ name: 'search', isRequired: false }] },
        { type: 'series', id: 'nguonc-phim-moi', name: 'NguonC: Mới Cập Nhật', extra: [{ name: 'search', isRequired: false }] },
        { type: 'movie', id: 'nguonc-phim-le', name: 'NguonC: Phim Lẻ' },
        { type: 'series', id: 'nguonc-phim-bo', name: 'NguonC: Phim Bộ' }
    ]
};

const builder = new addonBuilder(manifest);

function formatMetaPreview(item) {
    const isSeries = item.type === 'series' || item.current_episode !== 'Full';
    return {
        id: `nguonc:${item.slug}`,
        type: isSeries ? 'series' : 'movie',
        name: item.name,
        poster: item.thumb_url || item.poster_url,
        description: `Tên khác: ${item.original_name || 'N/A'} | Năm: ${item.year || 'N/A'}`
    };
}

// 2. Định nghĩa các Handlers dữ liệu

// Catalog Handler
builder.defineCatalogHandler(async (args) => {
    try {
        let endpoint = `${NGUONC_API_BASE}/api/films/phim-moi-cap-nhat?page=1`;

        if (args.extra && args.extra.search) {
            const query = encodeURIComponent(args.extra.search);
            endpoint = `${NGUONC_API_BASE}/api/films/search?keyword=${query}`;
        } else if (args.id === 'nguonc-phim-le') {
            endpoint = `${NGUONC_API_BASE}/api/films/danh-sach/phim-le?page=1`;
        } else if (args.id === 'nguonc-phim-bo') {
            endpoint = `${NGUONC_API_BASE}/api/films/danh-sach/phim-bo?page=1`;
        }

        console.log(`📡 Đang gọi Catalog API: ${endpoint}`);
        const response = await axios.get(endpoint, { timeout: 8000 });
        const items = response.data?.items || [];
        return { metas: items.map(formatMetaPreview) };
    } catch (err) {
        console.error('❌ Lỗi Catalog:', err.message);
        return { metas: [] };
    }
});

// Meta Handler
builder.defineMetaHandler(async (args) => {
    const slug = (args.id || '').replace('nguonc:', '');

    try {
        const endpoint = `${NGUONC_API_BASE}/api/film/${slug}`;
        console.log(`📡 Đang gọi Meta API: ${endpoint}`);
        
        const response = await axios.get(endpoint, { timeout: 8000 });
        const movie = response.data?.movie;

        if (!movie) return { meta: null };

        const isSeries = movie.type === 'series' || (Array.isArray(movie.episodes) && movie.episodes.some((server) => Array.isArray(server?.items) && server.items.length > 1));

        const meta = {
            id: args.id,
            type: isSeries ? 'series' : 'movie',
            name: movie.name,
            poster: movie.thumb_url || movie.poster_url,
            background: movie.poster_url,
            description: (movie.description || '').replace(/<[^>]*>?/gm, ''),
            genres: movie.category ? Object.values(movie.category).map((c) => c?.group?.name).filter(Boolean) : [],
            releaseInfo: String(movie.year || '')
        };

        if (isSeries && Array.isArray(movie.episodes)) {
            const videos = [];
            movie.episodes.forEach((server) => {
                if (!Array.isArray(server?.items)) return;
                server.items.forEach((ep) => {
                    videos.push({
                        id: `nguonc:${slug}:${server.server_name}:${ep.slug}`,
                        title: `${ep.name} (${server.server_name})`,
                        released: new Date().toISOString()
                    });
                });
            });
            meta.videos = videos;
        }

        return { meta };
    } catch (err) {
        console.error('❌ Lỗi Meta:', err.message);
        return { meta: null };
    }
});

// Stream Handler - Đã tối ưu hóa mở Web-view trực diện thay vì bung trình duyệt ngoài
builder.defineStreamHandler(async (args) => {
    const parts = String(args.id || '').split(':');
    
    // Rút gọn biến trích xuất mảng để tránh lỗi log nối chuỗi sai địa chỉ
    const slug = parts[1];
    const targetServer = parts[2];
    const targetEpSlug = parts[3];

    try {
        const endpoint = `${NGUONC_API_BASE}/api/film/${slug}`;
        console.log(`📡 Đang gọi Stream API: ${endpoint}`);

        const response = await axios.get(endpoint, { timeout: 8000 });
        const movie = response.data?.movie;

        if (!movie || !movie.episodes) return { streams: [] };

        const streams = [];
        // Lấy giá trị host từ biến môi trường APP_URL thiết lập trên Hugging Face
        const hostUrl = process.env.APP_URL || `http://localhost:${PORT}`;

        for (const server of movie.episodes) {
            if (!Array.isArray(server?.items)) continue;
            for (const ep of server.items) {
                const isMatch = targetEpSlug ?
                    (server.server_name === targetServer && ep.slug === targetEpSlug) :
                    true;

                if (isMatch && ep.embed) {
                    const playerEndpoint = `${hostUrl}/player?url=${encodeURIComponent(ep.embed)}`;
                    
                    streams.push({
                        name: 'NguonC Player',
                        title: `▶ Xem phim [${server.server_name} - ${ep.name}]`,
                        // Trả lại externalUrl kết hợp cấu hình behaviorHints để kích hoạt WebView gọn gàng
                        externalUrl: playerEndpoint, 
                        behaviorHints: {
                            notSupported: false,
                            // Gợi ý cho ứng dụng Stremio kích hoạt trình duyệt nhúng nội bộ nếu thiết bị hỗ trợ
                            isLive: false 
                        }
                    });
                }
            }
        }

        return { streams };
    } catch (err) {
        console.error('❌ Lỗi Stream:', err.message);
        return { streams: [] };
    }
});

// 3. Cấu hình Express Server
const app = express();

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    next();
});

// Route /player xuất giao diện xem phim toàn màn hình, chống tràn
app.get('/player', (req, res) => {
    const embedUrl = req.query.url;
    if (!embedUrl) {
        return res.status(400).setHeader('Content-Type', 'text/plain; charset=utf-8').send('Thiếu tham số URL phim!');
    }

    const html = `
        <!DOCTYPE html>
        <html lang="vi">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
            <title>Đang tải phim...</title>
            <style>
                body, html { margin: 0; padding: 0; width: 100%; height: 100%; background-color: #000; overflow: hidden; }
                iframe { width: 100%; height: 100%; border: none; }
            </style>
        </head>
        <body>
            <iframe src="${embedUrl}" allowfullscreen="true" webkitallowfullscreen="true" mozallowfullscreen="true"></iframe>
        </body>
        </html>
    `;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

// Nạp các Router chuẩn của Stremio Addon SDK vào Express
const addonInterface = builder.getInterface();
const addonRouter = getRouter(addonInterface);
app.use('/', addonRouter);

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Addon NguonC đang chạy mượt mà tại cổng: ${PORT}`);
});
