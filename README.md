# Discord Voice Recorder Bot

Discord のボイスチャンネルに参加して、発話をユーザーごとに MP3 保存し、`/stop` 実行後に `nodejs-whisper` で文字起こしして bot を起動しているターミナルへ出力するボットです。

## 機能

- `/record`: 実行者がいるボイスチャンネルに参加して録音開始
- `/stop`: 録音停止、MP3 保存、Whisper 文字起こし
- 保存先: `recordings/<timestamp>_<guildId>/<username>_<userId>.mp3`
- 文字起こし結果: 標準出力に `[transcript][username] ...` 形式で表示

## 前提

- Node.js 20 以上
- `npm install`
- `nodejs-whisper` を動かすためのビルド環境
- Whisper モデル

Windows では `nodejs-whisper` の README にある通り、`make` 相当のビルドツールが必要です。  
モデル未取得なら、必要に応じて次を実行してください。

```bash
npx nodejs-whisper download
```

## セットアップ

1. `.env.example` を `.env` にコピー
2. `DISCORD_TOKEN` と `CLIENT_ID` を設定
3. 必要なら `GUILD_ID` を設定
4. 必要なら Whisper 設定を変更
5. `npm install`
6. `npm run deploy`
7. `npm start`

`.env` 例:

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_client_id_here
GUILD_ID=your_guild_id_here
WHISPER_MODEL=base
WHISPER_AUTO_DOWNLOAD=true
WHISPER_TRANSLATE_TO_ENGLISH=false
WHISPER_WITH_CUDA=false
REALTIME_TRANSCRIBE=true
REALTIME_SEGMENT_SILENCE_MS=2500
```

## 使い方

1. 録音したいボイスチャンネルに入る
2. `/record`
3. 会話する
4. `/stop`
5. ターミナルで文字起こし結果を確認する

## 補足

- 文字起こしは MP3 の保存完了後に実行されます。
- 発話がなかったユーザーは空ファイル扱いで文字起こしをスキップします。
- Whisper の出力テキストファイルが生成される場合があります。
