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

// ★現在のデフォルト曲IDをサーバーで記憶しておく
let currentDefaultId = "jfKfPfyJRdk"; // 初期値: Lofi Girl

// --- LINE Webhook ---
app.post('/callback', line.middleware(config), (req, res) => {
    Promise.all(req.body.events.map(handleLineEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error(err);
            res.status(500).end();
        });
});

async function handleLineEvent(event) {
    const client = new line.Client(config);

    if (event.type === 'postback') {
        const data = new URLSearchParams(event.postback.data);
        const videoId = data.get('videoId');
        const title = data.get('title');
        
        // Postbackは常に再生予約とする
        io.emit('add-queue', { videoId, title, source: 'LINE' });
        return client.replyMessage(event.replyToken, { type: 'text', text: `🎵 リクエスト予約: ${title}` });
    }

    if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text;

        // 1. コメント機能 (#で始まる場合)
        if (text.startsWith('#')) {
            io.emit('flow-comment', text); // 弾幕として送信
            return client.replyMessage(event.replyToken, { type: 'text', text: '💬 動画にコメントを流しました' });
        }

        // 2. URL or コマンド
        if (isUrl(text) || isCommand(text)) {
            io.emit('chat-message', text);
            return client.replyMessage(event.replyToken, { type: 'text', text: '✅ 受け付けました' });
        }

        // 3. 検索処理
        const items = await searchYouTube(text);
        if (!items || items.length === 0) {
            return client.replyMessage(event.replyToken, { type: 'text', text: '😢 見つかりませんでした' });
        }

        const bubbles = items.map(item => ({
            type: "bubble",
            hero: { type: "image", url: item.snippet.thumbnails.high.url, size: "full", aspectRatio: "16:9", aspectMode: "cover" },
            body: { type: "box", layout: "vertical", contents: [{ type: "text", text: item.snippet.title, wrap: true }] },
            footer: {
                type: "box", layout: "vertical",
                contents: [{
                    type: "button", style: "primary", color: "#1DB446", label: "これにする",
                    action: { type: "postback", data: `videoId=${item.id.videoId}&title=${item.snippet.title}` }
                }]
            }
        }));
        return client.replyMessage(event.replyToken, { type: "flex", altText: "検索結果", contents: { type: "carousel", contents: bubbles } });
    }
}

// --- Socket.io (ブラウザ通信) ---
io.on('connection', (socket) => {
    // 接続時に、現在のデフォルト曲を教える
    socket.emit('init-state', { defaultId: currentDefaultId });

    socket.on('client-input', async (text) => {
        // A. デフォルト曲変更コマンド (default [URL/Word])
        if (text.startsWith('default ')) {
            const query = text.replace('default ', '').trim();
            let newId = extractYouTubeId(query);
            
            // URLじゃなければ検索してトップの結果を使う
            if (!newId && YOUTUBE_API_KEY) {
                const items = await searchYouTube(query);
                if (items.length > 0) newId = items[0].id.videoId;
            }

            if (newId) {
                currentDefaultId = newId; // サーバー側更新
                io.emit('update-default', { videoId: newId }); // 全員に通知
                io.emit('chat-message', `🔄 デフォルトBGMが変更されました`);
            }
            return;
        }

        // B. 弾幕コメント (#)
        if (text.startsWith('#')) {
            io.emit('flow-comment', text);
            return;
        }

        // C. URL, コマンド, 通常チャット
        if (isUrl(text) || isCommand(text)) {
            io.emit('chat-message', text);
            return;
        }

        // D. 検索 (自分だけ)
        if (YOUTUBE_API_KEY) {
            const items = await searchYouTube(text);
            socket.emit('search-results', items);
        }
    });

    socket.on('select-video', (data) => {
        io.emit('add-queue', { videoId: data.videoId, title: data.title, source: 'PC' });
    });
});

app.use(express.static('public'));

// --- ヘルパー ---
function isUrl(text) { return text.includes('youtube.com') || text.includes('youtu.be'); }
function isCommand(text) { return text === 'スキップ' || text.toLowerCase() === 'skip'; }
function extractYouTubeId(url) {
    const match = url.match(/^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/);
    return (match && match[2].length === 11) ? match[2] : null;
}
async function searchYouTube(query) {
    if (!YOUTUBE_API_KEY) return [];
    try {
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}&type=video&maxResults=3`;
        const res = await axios.get(url);
        return res.data.items;
    } catch (e) { return []; }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
