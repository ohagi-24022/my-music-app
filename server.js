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

let currentDefaultId = "QngwLXMRTSc"; // 初期値

// --- LINE Webhook ---
app.post('/callback', line.middleware(config), (req, res) => {
    Promise.all(req.body.events.map(handleLineEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error("LINE Webhook Error:", err.originalError?.response?.data || err);
            res.status(500).end();
        });
});

async function handleLineEvent(event) {
    const client = new line.Client(config);

    // ★ボタンが押された時の処理
    if (event.type === 'postback') {
        const data = new URLSearchParams(event.postback.data);
        const videoId = data.get('videoId');

        // PCへ送信
        io.emit('add-queue', { videoId, title: 'LINEからのリクエスト', source: 'LINE' });
        
        return client.replyMessage(event.replyToken, { 
            type: 'text', 
            text: `✅ リクエストを受け付けました！\n(再生まで少しお待ちください)` 
        });
    }

    // テキストメッセージ
    if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text;

        // 1. コメント (#)
        if (text.startsWith('#')) {
            io.emit('flow-comment', text);
            return;
        }

        // 2. URL or コマンド
        if (isUrl(text) || isCommand(text)) {
            io.emit('chat-message', text);
            return client.replyMessage(event.replyToken, { type: 'text', text: '✅ 受け付けました' });
        }

        // 3. キーワード検索
        if (!YOUTUBE_API_KEY) {
            return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ サーバー設定エラー: APIキーがありません' });
        }

        try {
            const items = await searchYouTube(text);
            
            if (!items || items.length === 0) {
                return client.replyMessage(event.replyToken, { type: 'text', text: '😢 見つかりませんでした（または検索上限です）' });
            }

            // ★修正ポイント: labelをactionの中に入れました
            const bubbles = items.map(item => ({
                type: "bubble",
                size: "kilo",
                hero: { 
                    type: "image", 
                    url: item.snippet.thumbnails.high ? item.snippet.thumbnails.high.url : "https://via.placeholder.com/320x180?text=No+Image",
                    size: "full", aspectRatio: "16:9", aspectMode: "cover" 
                },
                body: { 
                    type: "box", layout: "vertical", 
                    contents: [{ type: "text", text: item.snippet.title, wrap: true, weight: "bold", size: "sm" }] 
                },
                footer: {
                    type: "box", layout: "vertical",
                    contents: [{
                        type: "button", 
                        style: "primary", 
                        color: "#1DB446", 
                        // labelプロパティを削除し、actionの中に移動
                        action: { 
                            type: "postback", 
                            label: "予約する", // ←ここに移動しました！
                            data: `videoId=${item.id.videoId}` 
                        }
                    }]
                }
            }));

            return client.replyMessage(event.replyToken, { 
                type: "flex", 
                altText: "検索結果", 
                contents: { type: "carousel", contents: bubbles } 
            });

        } catch (error) {
            console.error("YouTube Search Error:", error);
            return client.replyMessage(event.replyToken, { 
                type: 'text', 
                text: `⚠️ エラーが発生しました。\nURLを直接貼ってお試しください。` 
            });
        }
    }
}

// --- Socket.io ---
io.on('connection', (socket) => {
    socket.emit('init-state', { defaultId: currentDefaultId });

    socket.on('client-input', async (text) => {
        if (text.startsWith('default ')) {
            const query = text.replace('default ', '').trim();
            let newId = extractYouTubeId(query);
            if (!newId && YOUTUBE_API_KEY) {
                try {
                    const items = await searchYouTube(query);
                    if (items.length > 0) newId = items[0].id.videoId;
                } catch(e) {}
            }
            if (newId) {
                currentDefaultId = newId;
                io.emit('update-default', { videoId: newId });
                io.emit('chat-message', `🔄 デフォルトBGMを変更しました`);
            }
            return;
        }
        
        if (text.startsWith('#')) {
            io.emit('flow-comment', text);
            return;
        }

        if (isUrl(text) || isCommand(text)) {
            io.emit('chat-message', text);
            return;
        }

        if (YOUTUBE_API_KEY) {
            try {
                const items = await searchYouTube(text);
                socket.emit('search-results', items);
            } catch(e) {}
        }
    });

    socket.on('select-video', (data) => {
        io.emit('add-queue', { videoId: data.videoId, title: data.title, source: 'PC' });
    });
});

app.use(express.static('public'));

function isUrl(text) { return text.includes('youtube.com') || text.includes('youtu.be'); }
function isCommand(text) { return text === 'スキップ' || text.toLowerCase() === 'skip'; }
function extractYouTubeId(url) {
    const match = url.match(/^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/);
    return (match && match[2].length === 11) ? match[2] : null;
}

async function searchYouTube(query) {
    if (!YOUTUBE_API_KEY) throw new Error("No API Key");
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}&type=video&maxResults=3`;
    const res = await axios.get(url);
    return res.data.items;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
