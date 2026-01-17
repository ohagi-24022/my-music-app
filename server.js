const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const line = require('@line/bot-sdk');
const axios = require('axios');

const config = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ★変更: デフォルト設定をオブジェクトで管理
let currentDefault = { 
    id: "7Q3BGAPAGQY", 
    type: "video", // "video" か "playlist"
    title: "休日のひとり勉強会"
};

function toHalfWidth(str) {
    if (!str) return "";
    return str.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function(s) {
        return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
    }).replace(/　/g, ' ').trim();
}

function parseDefaultCommand(text) {
    const normalized = toHalfWidth(text);
    const match = normalized.match(/^default\s*\[?(.+?)\]?$/i) || normalized.match(/^default\s+(.+)$/i);
    if (match) return match[1].trim();
    if (normalized.toLowerCase().startsWith('default[')) {
        return normalized.substring(7).replace(/\]$/, '').trim();
    }
    return null;
}

function extractPlaylistId(url) {
    const match = url.match(/[?&]list=([^#\&\?]+)/);
    return match ? match[1] : null;
}

function extractYouTubeId(url) {
    const match = url.match(/^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/);
    return (match && match[2].length === 11) ? match[2] : null;
}

async function getPlaylistItems(playlistId) {
    if (!YOUTUBE_API_KEY) return [];
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=20&key=${YOUTUBE_API_KEY}`;
    const res = await axios.get(url);
    return res.data.items;
}

// --- LINE Webhook ---
app.post('/callback', line.middleware(config), (req, res) => {
    Promise.all(req.body.events.map(handleLineEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error("LINE Error:", err.originalError?.response?.data || err);
            res.status(500).end();
        });
});

async function handleLineEvent(event) {
    const client = new line.Client(config);

    if (event.type === 'postback') {
        const data = new URLSearchParams(event.postback.data);
        const videoId = data.get('videoId');
        const mode = data.get('mode');

        // ★デフォルト変更（検索結果ボタンから）は単曲扱い
        if (mode === 'default') {
            currentDefault = { id: videoId, type: 'video', title: 'LINE変更' };
            io.emit('update-default', currentDefault);
            io.emit('chat-message', `🔄 LINEからデフォルトBGMが変更されました`);
            return client.replyMessage(event.replyToken, { type: 'text', text: `✅ デフォルトBGMを変更しました！` });
        }

        io.emit('add-queue', { videoId, title: 'LINEからのリクエスト', source: 'LINE' });
        return client.replyMessage(event.replyToken, { type: 'text', text: `✅ リクエストを受け付けました！` });
    }

    if (event.type === 'message' && event.message.type === 'text') {
        const rawText = event.message.text;

        // ★ defaultコマンド処理
        const defaultCommandQuery = parseDefaultCommand(rawText);
        if (defaultCommandQuery) {
            
            // 1. 再生リストIDがあるかチェック
            const plistId = extractPlaylistId(defaultCommandQuery);
            if (plistId) {
                currentDefault = { id: plistId, type: 'playlist', title: 'Playlist' };
                io.emit('update-default', currentDefault);
                io.emit('chat-message', `🔄 デフォルトBGMをプレイリストに変更しました`);
                return client.replyMessage(event.replyToken, { type: 'text', text: '✅ デフォルトをプレイリストに設定しました！' });
            }

            // 2. なければ単曲動画IDチェック
            let newId = extractYouTubeId(defaultCommandQuery);
            if (newId) {
                currentDefault = { id: newId, type: 'video', title: 'Video' };
                io.emit('update-default', currentDefault);
                io.emit('chat-message', `🔄 LINEからデフォルトBGMが変更されました`);
                return client.replyMessage(event.replyToken, { type: 'text', text: '✅ デフォルトBGMを変更しました！' });
            }

            // 3. どちらでもなければキーワード検索（単曲選択肢を返す）
            if (YOUTUBE_API_KEY) {
                try {
                    const items = await searchYouTube(defaultCommandQuery);
                    if (!items || items.length === 0) return client.replyMessage(event.replyToken, { type: 'text', text: '😢 見つかりませんでした' });
                    const bubbles = createCarousel(items, "設定する", "default");
                    return client.replyMessage(event.replyToken, { type: "flex", altText: "デフォルト変更", contents: { type: "carousel", contents: bubbles } });
                } catch (e) {
                    return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ エラーが発生しました' });
                }
            }
            return;
        }

        if (rawText.startsWith('#')) { io.emit('flow-comment', rawText); return; }

        const normalizedText = toHalfWidth(rawText);

        // 再生リストからの一括予約（通常機能）
        const playlistId = extractPlaylistId(normalizedText);
        if (playlistId) {
            try {
                const items = await getPlaylistItems(playlistId);
                if (items.length > 0) {
                    items.forEach(item => {
                        const vid = item.snippet.resourceId.videoId;
                        if (vid) io.emit('add-queue', { videoId: vid, title: item.snippet.title, source: 'LINE(Playlist)' });
                    });
                    return client.replyMessage(event.replyToken, { type: 'text', text: `✅ 再生リストから${items.length}曲を予約しました！` });
                }
            } catch (e) {}
        }

        if (isUrl(normalizedText) || isCommand(normalizedText)) { 
            io.emit('chat-message', normalizedText); 
            return client.replyMessage(event.replyToken, { type: 'text', text: '✅ 受け付けました' });
        }

        if (YOUTUBE_API_KEY) {
            try {
                const items = await searchYouTube(rawText);
                if (!items || items.length === 0) return client.replyMessage(event.replyToken, { type: 'text', text: '😢 なし' });
                const bubbles = createCarousel(items, "予約する", "queue");
                return client.replyMessage(event.replyToken, { type: "flex", altText: "検索結果", contents: { type: "carousel", contents: bubbles } });
            } catch (error) { return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ エラー' }); }
        }
    }
}

// --- Socket.io (Web版) ---
io.on('connection', (socket) => {
    // 初期状態としてオブジェクトを送る
    socket.emit('init-state', { defaultData: currentDefault });

    socket.on('client-input', async (rawText) => {
        const defaultCommandQuery = parseDefaultCommand(rawText);
        if (defaultCommandQuery) {
            
            // 1. プレイリストチェック
            const plistId = extractPlaylistId(defaultCommandQuery);
            if (plistId) {
                currentDefault = { id: plistId, type: 'playlist', title: 'Playlist' };
                io.emit('update-default', currentDefault);
                io.emit('chat-message', `🔄 デフォルトBGMをプレイリストに変更しました`);
                return;
            }

            // 2. 単曲動画チェック
            let newId = extractYouTubeId(defaultCommandQuery);
            if (newId) {
                currentDefault = { id: newId, type: 'video', title: 'Video' };
                io.emit('update-default', currentDefault);
                io.emit('chat-message', `🔄 PCからデフォルトBGMが変更されました`);
                return;
            }

            // 3. キーワード検索
            if (YOUTUBE_API_KEY) {
                try {
                    const items = await searchYouTube(defaultCommandQuery);
                    socket.emit('search-results-for-default', items);
                } catch(e) {}
            }
            return;
        }
        
        if (rawText.startsWith('#')) { io.emit('flow-comment', rawText); return; }

        const normalizedText = toHalfWidth(rawText);
        const playlistId = extractPlaylistId(normalizedText);
        if (playlistId) {
            try {
                const items = await getPlaylistItems(playlistId);
                if (items.length > 0) {
                    items.forEach(item => {
                        const vid = item.snippet.resourceId.videoId;
                        if (vid) io.emit('add-queue', { videoId: vid, title: item.snippet.title, source: 'PC(Playlist)' });
                    });
                    io.emit('chat-message', `📂 再生リストから${items.length}曲を追加しました`);
                }
            } catch(e) {}
            return;
        }

        if (isUrl(normalizedText) || isCommand(normalizedText)) { io.emit('chat-message', normalizedText); return; }

        if (YOUTUBE_API_KEY) {
            try {
                const items = await searchYouTube(rawText);
                socket.emit('search-results', items);
            } catch(e) {}
        }
    });

    socket.on('select-video', async (data) => {
        // ★変更: プレイリスト(type: 'playlist')なら中身を展開して予約
        if (data.type === 'playlist') {
            try {
                const items = await getPlaylistItems(data.videoId);
                if (items.length > 0) {
                    items.forEach(item => {
                        const vid = item.snippet.resourceId.videoId;
                        if (vid) {
                            io.emit('add-queue', { 
                                videoId: vid, 
                                title: item.snippet.title, 
                                source: 'Favorite(List)' 
                            });
                        }
                    });
                    io.emit('chat-message', `📂 お気に入りからプレイリストを予約しました (${items.length}曲)`);
                }
            } catch (e) {
                console.error("Fav Playlist Error", e);
            }
        } else {
            // 通常の動画(video)ならそのまま予約
            io.emit('add-queue', { videoId: data.videoId, title: data.title, source: 'Favorite' });
        }
    });

    socket.on('select-default', (data) => {
        currentDefault = { id: data.videoId, type: 'video', title: data.title };
        io.emit('update-default', currentDefault);
        io.emit('chat-message', `🔄 PCからデフォルトBGMが変更されました: ${data.title}`);
    });
});

app.use(express.static('public'));

function createCarousel(items, buttonLabel, mode) {
    return items.map(item => ({
        type: "bubble", size: "kilo",
        hero: { type: "image", url: item.snippet.thumbnails.high ? item.snippet.thumbnails.high.url : "https://via.placeholder.com/320", size: "full", aspectRatio: "16:9", aspectMode: "cover" },
        body: { type: "box", layout: "vertical", contents: [{ type: "text", text: item.snippet.title, wrap: true, weight: "bold", size: "sm" }] },
        footer: {
            type: "box", layout: "vertical", contents: [{
                type: "button", style: "primary", color: mode === 'default' ? "#E04F5F" : "#1DB446",
                action: { type: "postback", label: buttonLabel, data: `videoId=${item.id.videoId}&mode=${mode}` }
            }]
        }
    }));
}
function isUrl(text) { return text.includes('youtube.com') || text.includes('youtu.be'); }
function isCommand(text) { 
    const t = text.toLowerCase();
    return t === 'スキップ' || t === 'skip' || 
           t === 'ネクスト' || t === 'next' || 
           t === 'バック' || t === 'back';
}
async function searchYouTube(query) {
    if (!YOUTUBE_API_KEY) throw new Error("No API Key");
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}&type=video&maxResults=3`;
    const res = await axios.get(url);
    return res.data.items;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
