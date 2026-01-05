const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const line = require('@line/bot-sdk');

// 環境変数からLINEの設定を読み込む (Renderで設定します)
const config = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- LINE Bot用の設定 (Webhook) ---
// LINEからの通信は /callback というURLで受け取ります
app.post('/callback', line.middleware(config), (req, res) => {
    Promise.all(req.body.events.map(handleLineEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error(err);
            res.status(500).end();
        });
});

// LINEイベントを処理する関数
async function handleLineEvent(event) {
    // テキストメッセージ以外は無視
    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }

    const userText = event.message.text;

    // 1. ブラウザ(Socket.io)にメッセージを送信（これで曲が予約されます）
    io.emit('chat-message', userText);

    // 2. LINEユーザーに「受け付けました」と返信するためのクライアント作成
    const client = new line.Client(config);

    // YouTubeのURLかどうかの簡易判定（返信メッセージを変えるため）
    const isUrl = userText.includes('youtube.com') || userText.includes('youtu.be');
    const replyText = isUrl 
        ? `🎵 リクエストを受け付けました！\nPC画面を確認してください。` 
        : `💬 メッセージを送信しました: ${userText}`;

    return client.replyMessage(event.replyToken, {
        type: 'text',
        text: replyText
    });
}

// --- Webサイトの公開設定 ---
// LINEの処理より後に書くのがポイントですが、staticは干渉しないのでここでもOK
app.use(express.static('public'));

// --- Socket.io (ブラウザ間の通信) ---
io.on('connection', (socket) => {
    console.log('Webユーザーが接続しました');

    // Web画面からの入力も同様に全員へ転送
    socket.on('chat-message', (msg) => {
        io.emit('chat-message', msg);
    });
});

// サーバー起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
