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

let currentDefaultId = "jfKfPfyJRdk"; // 初期値

// --- LINE Webhook ---
app.post('/callback', line.middleware(config), (req, res) => {
    Promise.all(req.body.events.map(handleLineEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error("LINE Webhook Error:", err);
            res.status(500).end();
        });
});

async function handleLineEvent(event) {
    const client = new line.Client(config);

    // ポストバック（ボタンを押した時）
    if (event.type === 'postback') {
        const data = new URLSearchParams(event.postback.data);
        const videoId = data.get('videoId');
        const title = data.get('title');
        io.emit('add-queue', { videoId, title, source: 'LINE' });
        return client.replyMessage(event.replyToken, { type: 'text', text: `🎵 リクエスト予約: ${title}` });
    }

    // テキストメッセージ
    if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text;

        // 1. コメント (#)
        if (text.startsWith('#')) {
            io.emit('flow-comment', text);
            return; // コメントは返信なし（うるさくなるので）
        }

        // 2. URL or コマンド (APIキー不要なので必ず動く)
        if (isUrl(text) || isCommand(text)) {
            io.emit('chat-message', text);
            return client.replyMessage(event.replyToken, { type: 'text', text: '✅ 受け付けました' });
        }

        // 3. キーワード検索
        if (!YOUTUBE_API_KEY) {
            return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ サーバー設定エラー: APIキーがありません' });
        }

        // 検索を実行
        try {
            const items = await searchYouTube(text);
            
            if (!items || items.length === 0) {
                return client.replyMessage(event.replyToken, { type: 'text', text: '😢 見つかりませんでした（または検索上限を超えました）' });
            }

            // 検索結果のボタンを作成
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
                        type: "button", style: "primary", color: "#1DB446", label: "予約する",
                        action: { type: "postback", data: `videoId=${item.id.videoId}&title=${item.snippet.title.substring(0, 20)}...` }
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
            // エラーの内容をユーザーに教える
            return client.replyMessage(event.replyToken, { 
                type: 'text', 
                text: `⚠️ エラーが発生しました。\n1日の検索上限(100回)を超えた可能性があります。\n\n💡URLを直接貼れば制限なく再生できます！` 
            });
        }
    }
}

// --- Socket.io ---
io.on('connection', (socket) => {
    socket.emit('init-state', { defaultId: currentDefaultId });

    socket.on('client-input', async (text) => {
        // default コマンド
        if (text.startsWith('default ')) {
            const query = text.replace('default ', '').trim();
            let newId = extractYouTubeId(query);
            if (!newId && YOUTUBE_API_KEY) {
                try {
                    const items = await searchYouTube(query);
                    if (items.length > 0) newId = items[0].id.videoId;
                } catch(e) { console.log("Default Search Error"); }
            }
            if (newId) {
                currentDefaultId = newId;
                io.emit('update-default', { videoId: newId });
                io.emit('chat-message', `🔄 デフォルトBGMを変更しました`);
            }
            return;
        }
        
        // 弾幕
        if (text.startsWith('#')) {
            io.emit('flow-comment', text);
            return;
        }

        // URL / コマンド
        if (isUrl(text) || isCommand(text)) {
            io.emit('chat-message', text);
            return;
        }

        // PCからの検索
        if (YOUTUBE_API_KEY) {
            try {
                const items = await searchYouTube(text);
                socket.emit('search-results', items);
            } catch(e) { console.log("PC Search Error"); }
        }
    });

    socket.on('select-video', (data) => {
        io.emit('add-queue', { videoId: data.videoId, title: data.title, source: 'PC' });
    });
});

app.use(express.static('public'));

// --- ヘルパー関数 ---
function isUrl(text) { return text.includes('youtube.com') || text.includes('youtu.be'); }
function isCommand(text) { return text === 'スキップ' || text.toLowerCase() === 'skip'; }
function extractYouTubeId(url) {
    const match = url.match(/^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/);
    return (match && match[2].length === 11) ? match[2] : null;
}

// 検索関数（エラーをキャッチせずそのまま上に投げるように変更）
async function searchYouTube(query) {
    if (!YOUTUBE_API_KEY) throw new Error("No API Key");
    
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}&type=video&maxResults=3`;
    const res = await axios.get(url);
    return res.data.items;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
