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

// 全角英数字・スペースを半角に直す関数
function toHalfWidth(str) {
    if (!str) return "";
    return str.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function(s) {
        return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
    }).replace(/　/g, ' ').trim();
}

// ★コマンド解析用関数（カッコやスペースを柔軟に処理）
function parseDefaultCommand(text) {
    const normalized = toHalfWidth(text);
    // "default" で始まり、その後に " " か "[" が続く、もしくは "default" だけの場合などを検知
    const match = normalized.match(/^default\s*\[?(.+?)\]?$/i) || normalized.match(/^default\s+(.+)$/i);
    
    if (match) {
        // マッチした場合、中身（URLやキーワード）を返す
        return match[1].trim(); 
    }
    // "default[...]" のようなスペース無しのパターンもカバー
    if (normalized.toLowerCase().startsWith('default[')) {
        return normalized.substring(7).replace(/\]$/, '').trim();
    }
    return null;
}

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

    if (event.type === 'postback') {
        const data = new URLSearchParams(event.postback.data);
        const videoId = data.get('videoId');
        io.emit('add-queue', { videoId, title: 'LINEからのリクエスト', source: 'LINE' });
        return client.replyMessage(event.replyToken, { 
            type: 'text', text: `✅ リクエストを受け付けました！\n(再生まで少しお待ちください)` 
        });
    }

    if (event.type === 'message' && event.message.type === 'text') {
        const rawText = event.message.text;

        // ★ defaultコマンド (判定ロジックを変更)
        const defaultCommandQuery = parseDefaultCommand(rawText);
        
        if (defaultCommandQuery) {
            let newId = extractYouTubeId(defaultCommandQuery);
            
            // URLじゃなければ検索
            if (!newId && YOUTUBE_API_KEY) {
                try {
                    const items = await searchYouTube(defaultCommandQuery);
                    if (items.length > 0) newId = items[0].id.videoId;
                } catch(e) {}
            }

            if (newId) {
                currentDefaultId = newId;
                io.emit('update-default', { videoId: newId });
                io.emit('chat-message', `🔄 LINEからデフォルトBGMが変更されました`);
                return client.replyMessage(event.replyToken, { type: 'text', text: '✅ デフォルトBGMを変更しました！' });
            } else {
                return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 動画が見つかりませんでした。' });
            }
        }

        // 1. コメント
        if (rawText.startsWith('#')) {
            io.emit('flow-comment', rawText);
            return;
        }

        // 2. URL or コマンド
        const normalizedText = toHalfWidth(rawText);
        if (isUrl(normalizedText) || isCommand(normalizedText)) {
            io.emit('chat-message', normalizedText); 
            return client.replyMessage(event.replyToken, { type: 'text', text: '✅ 受け付けました' });
        }

        // 3. キーワード検索
        if (!YOUTUBE_API_KEY) {
            return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ サーバー設定エラー: APIキーがありません' });
        }

        try {
            const items = await searchYouTube(rawText);
            if (!items || items.length === 0) {
                return client.replyMessage(event.replyToken, { type: 'text', text: '😢 見つかりませんでした（または検索上限です）' });
            }

            const bubbles = items.map(item => ({
                type: "bubble", size: "kilo",
                hero: { type: "image", url: item.snippet.thumbnails.high ? item.snippet.thumbnails.high.url : "https://via.placeholder.com/320x180", size: "full", aspectRatio: "16:9", aspectMode: "cover" },
                body: { type: "box", layout: "vertical", contents: [{ type: "text", text: item.snippet.title, wrap: true, weight: "bold", size: "sm" }] },
                footer: {
                    type: "box", layout: "vertical",
                    contents: [{
                        type: "button", style: "primary", color: "#1DB446",
                        action: { type: "postback", label: "予約する", data: `videoId=${item.id.videoId}` }
                    }]
                }
            }));
            return client.replyMessage(event.replyToken, { type: "flex", altText: "検索結果", contents: { type: "carousel", contents: bubbles } });

        } catch (error) {
            console.error("YouTube Search Error:", error);
            return client.replyMessage(event.replyToken, { type: 'text', text: `⚠️ エラーが発生しました。\nURLを直接貼ってお試しください。` });
        }
    }
}

// --- Socket.io (Web版) ---
io.on('connection', (socket) => {
    socket.emit('init-state', { defaultId: currentDefaultId });

    socket.on('client-input', async (rawText) => {
        // ★ defaultコマンド (Web版)
        const defaultCommandQuery = parseDefaultCommand(rawText);

        if (defaultCommandQuery) {
            let newId = extractYouTubeId(defaultCommandQuery);
            if (!newId && YOUTUBE_API_KEY) {
                try {
                    const items = await searchYouTube(defaultCommandQuery);
                    if (items.length > 0) newId = items[0].id.videoId;
                } catch(e) {}
            }
            if (newId) {
                currentDefaultId = newId;
                io.emit('update-default', { videoId: newId });
                io.emit('chat-message', `🔄 PCからデフォルトBGMが変更されました`);
            }
            return;
        }
        
        if (rawText.startsWith('#')) {
            io.emit('flow-comment', rawText); return; 
        }

        const normalizedText = toHalfWidth(rawText);
        if (isUrl(normalizedText) || isCommand(normalizedText)) { 
            io.emit('chat-message', normalizedText); return; 
        }

        if (YOUTUBE_API_KEY) {
            try {
                const items = await searchYouTube(rawText);
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
