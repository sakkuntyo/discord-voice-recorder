# Discord Voice Recorder Bot

Discord のボイスチャンネルに参加し、ユーザーごとの音声を MP3 で保存しながら、`nodejs-whisper` で文字起こしする Bot です。

## Features

- `/record`: 実行者がいるボイスチャンネルに参加して録音を開始
- `/stop`: 録音を停止し、MP3 保存と Whisper 文字起こしを実行
- 保存先: `recordings/<timestamp>_<guildId>/<username>_<userId>.mp3`
- 文字起こし結果: 標準出力に `[transcript][username#segment] ...` 形式で表示
- CUDA 版 `whisper.cpp` を使った GPU 文字起こしに対応

## Requirements

- Node.js 18 以上
- FFmpeg
- Discord Bot token
- Whisper model
- CUDA を使う場合は NVIDIA GPU、CUDA Toolkit、CUDA 対応ビルド済み `whisper.cpp`

## Setup

```bash
npm install
cp .env.example .env
npm run deploy
npm start
```

Windows PowerShell では `cp` の代わりに次を使えます。

```powershell
Copy-Item .env.example .env
```

`.env` に `DISCORD_TOKEN`、`CLIENT_ID`、必要なら `GUILD_ID` を設定してください。

## Whisper Model

モデルをダウンロードする場合:

```bash
npx nodejs-whisper download
```

推奨設定例:

```env
WHISPER_MODEL=large-v3-turbo
WHISPER_AUTO_DOWNLOAD=true
WHISPER_WITH_CUDA=false
WHISPER_VERBOSE=false
WHISPER_LANGUAGE_FROM_CHANNEL=true
DEBUG_LOGS=false
```

`WHISPER_LANGUAGE` を指定すると、その言語が最優先されます。未指定の場合は Discord voice endpoint などから推測し、判定できない場合は Whisper の自動判定を使います。

## CUDA GPU Build

`ggml-cuda.dll` は `node_modules` 配下のビルド成果物なので、このリポジトリには commit していません。
CUDA 版を使いたい場合は、GitHub Releases から `ggml-cuda.dll` をダウンロードしてください。

https://github.com/sakkuntyo/discord-voice-recorder/releases

`npm install` 後、次の場所に `ggml-cuda.dll` を配置します。

```text
node_modules/nodejs-whisper/cpp/whisper.cpp/build/bin/Release/ggml-cuda.dll
```

その後、`.env` で CUDA を有効にします。

```env
WHISPER_WITH_CUDA=true
```

起動ログに `using CUDA0 backend` が出れば GPU が使われています。通常運用でログを減らしたい場合は `DEBUG_LOGS=false`、`WHISPER_VERBOSE=false` にしてください。

## Usage

1. 録音したい Discord ボイスチャンネルに入る
2. `/record` を実行
3. 会話する
4. `/stop` を実行
5. `recordings/` とターミナルの `[transcript]` 出力を確認

## Notes

- `.env`、`node_modules/`、`recordings/` は `.gitignore` で除外しています。
- Discord token は絶対に GitHub に push しないでください。
- `ggml-cuda.dll` のような環境依存の DLL は、Git commit ではなく Releases で管理します。
