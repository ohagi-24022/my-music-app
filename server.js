const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const line = require('@line/bot-sdk');
const axios = require('axios'); // 通信ライブラリ

// 環境変数
const config = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY; // Google APIキー

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Webhook
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

    // --- A. ボタンが押された時 (Postback) ---
    if (event.type === 'postback') {
        // dataの中に "videoId=xxx&title=yyy" という形式で情報が入っている
        const data = new URLSearchParams(event.postback.data);
        const videoId = data.get('videoId');
        const title = data.get('title');

        // PCブラウザへ送信
        io.emit('chat-message', `https://www.youtube.com/watch?v=${videoId}`);
        
        return client.replyMessage(event.replyToken, {
            type: 'text',
            text: `🎵 リクエスト予約: ${title}`
        });
    }

    // --- B. テキストメッセージの時 ---
    if (event.type === 'message' && event.message.type === 'text') {
        const userText = event.message.text;

        // 1. YouTubeのURLが直接送られた場合
        if (userText.includes('youtube.com') || userText.includes('youtu.be')) {
            io.emit('chat-message', userText); // そのままPCへ
            return client.replyMessage(event.replyToken, {
                type: 'text', text: '✅ 直接URLを受け付けました！'
            });
        }
        
        // 2. 「スキップ」などのコマンドの場合
        if (userText === 'スキップ' || userText === 'skip') {
            io.emit('chat-message', userText);
            return client.replyMessage(event.replyToken, {
                type: 'text', text: '⏭️ スキップ信号を送りました'
            });
        }

        // 3. それ以外 ＝ キーワード検索とみなす
        if (!YOUTUBE_API_KEY) {
            return client.replyMessage(event.replyToken, {
                type: 'text', text: '⚠️ エラー: APIキーが設定されていません'
            });
        }

        try {
            // YouTube検索APIを叩く
            const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(userText)}&key=${YOUTUBE_API_KEY}&type=video&maxResults=3`;
            const response = await axios.get(searchUrl);
            const items = response.data.items;

            if (items.length === 0) {
                return client.replyMessage(event.replyToken, {
                    type: 'text', text: '😢 見つかりませんでした...'
                });
            }

            // 検索結果をカルーセル（横並びボタン）にする
            const bubbles = items.map(item => ({
                type: "bubble",
                hero: {
                    type: "image",
                    url: item.snippet.thumbnails.high.url,
                    size: "full", aspectRatio: "16:9", aspectMode: "cover"
                },
                body: {
                    type: "box", layout: "vertical",
                    contents: [
                        { type: "text", text: item.snippet.title, weight: "bold", size: "sm", wrap: true }
                    ]
                },
                footer: {
                    type: "box", layout: "vertical",
                    contents: [
                        {
                            type: "button", style: "primary", color: "#1DB446",
                            action: {
                                type: "postback",
                                label: "これにする",
                                // ボタンを押した時にサーバーに返ってくるデータ
                                data: `videoId=${item.id.videoId}&title=${item.snippet.title}`
                            }
                        }
                    ]
                }
            }));

            return client.replyMessage(event.replyToken, {
                type: "flex",
                altText: "検索結果",
                contents: { type: "carousel", contents: bubbles }
            });

        } catch (error) {
            console.error('YouTube Search Error:', error);
            return client.replyMessage(event.replyToken, {
                type: 'text', text: '⚠️ 検索中にエラーが発生しました'
            });
        }
    }
}

app.use(express.static('public'));

io.on('connection', (socket) => {
    socket.on('chat-message', (msg) => io.emit('chat-message', msg));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
