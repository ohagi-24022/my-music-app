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
        io.emit('add-queue', { videoId, title, source: 'LINE' }); // 統一イベント名に変更
        return client.replyMessage(event.replyToken, { type: 'text', text: `🎵 リクエスト予約: ${title}` });
    }

    if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text;
        
        // URLまたはコマンド
        if (isUrl(text) || isCommand(text)) {
            io.emit('chat-message', text);
            return client.replyMessage(event.replyToken, { type: 'text', text: '✅ 受け付けました' });
        }

        // 検索処理
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

// --- PC(Socket.io) 通信処理 ---
io.on('connection', (socket) => {
    // クライアントからメッセージ受信
    socket.on('client-input', async (text) => {
        
        // 1. URL または コマンドの場合 -> 全員に送信して再生/スキップ
        if (isUrl(text) || isCommand(text)) {
            io.emit('chat-message', text); 
            return;
        }

        // 2. それ以外は「検索」とみなす (APIキーがある場合)
        if (YOUTUBE_API_KEY) {
            const items = await searchYouTube(text);
            // 検索結果は「送信者だけ」に返す (emit to socket only)
            socket.emit('search-results', items);
        }
    });

    // PC側で「検索結果」や「お気に入り」がクリックされた時
    socket.on('select-video', (data) => {
        // 全員に再生命令を送る
        io.emit('add-queue', { videoId: data.videoId, title: data.title, source: 'PC' });
    });
});

app.use(express.static('public'));

// --- ヘルパー関数 ---
function isUrl(text) {
    return text.includes('youtube.com') || text.includes('youtu.be');
}
function isCommand(text) {
    return text === 'スキップ' || text.toLowerCase() === 'skip';
}
async function searchYouTube(query) {
    if (!YOUTUBE_API_KEY) return [];
    try {
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}&type=video&maxResults=3`;
        const res = await axios.get(url);
        return res.data.items;
    } catch (e) {
        console.error("Search Error", e);
        return [];
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
