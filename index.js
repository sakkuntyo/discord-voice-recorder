require("node:dns").setDefaultResultOrder("ipv4first");
require("dotenv").config({ override: true });

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { PassThrough } = require("node:stream");
const {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags
} = require("discord.js");
const {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  generateDependencyReport,
  getVoiceConnection,
  joinVoiceChannel
} = require("@discordjs/voice");
const prism = require("prism-media");
const ffmpegPath = require("ffmpeg-static");

if (ffmpegPath) {
  const ffmpegDir = path.dirname(ffmpegPath);
  process.env.PATH = `${ffmpegDir}${path.delimiter}${process.env.PATH || ""}`;
  process.env.FFMPEG_PATH = ffmpegPath;
}

const { nodewhisper } = require("nodejs-whisper");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const RECORDINGS_DIR = path.join(__dirname, "recordings");
const WHISPER_MODEL_RAW = (process.env.WHISPER_MODEL || "base").trim();
const WHISPER_MODEL_ALIASES = {
  "large-v3-boost": "large-v3-turbo"
};
const WHISPER_MODEL = WHISPER_MODEL_ALIASES[WHISPER_MODEL_RAW] || WHISPER_MODEL_RAW;
const WHISPER_AUTO_DOWNLOAD =
  process.env.WHISPER_AUTO_DOWNLOAD !== "false";
const WHISPER_TRANSLATE_TO_ENGLISH =
  process.env.WHISPER_TRANSLATE_TO_ENGLISH === "true";
const WHISPER_WITH_CUDA = process.env.WHISPER_WITH_CUDA === "true";
const WHISPER_VERBOSE = process.env.WHISPER_VERBOSE === "true";
const WHISPER_LANGUAGE = (process.env.WHISPER_LANGUAGE || "").trim();
const WHISPER_LANGUAGE_FROM_CHANNEL =
  process.env.WHISPER_LANGUAGE_FROM_CHANNEL !== "false";
const DEBUG_LOGS = process.env.DEBUG_LOGS === "true";
const REALTIME_TRANSCRIBE = process.env.REALTIME_TRANSCRIBE !== "false";
const MIN_TRANSCRIBE_FILE_SIZE_BYTES = 4096;
const MIN_REALTIME_PCM_BYTES = 48000 * 2 * 2;
const REALTIME_SEGMENT_SILENCE_MS = Number(
  process.env.REALTIME_SEGMENT_SILENCE_MS || 2500
);
const whisperLogger = WHISPER_VERBOSE
  ? console
  : {
      log: () => {},
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: (...args) => debugError(...args)
    };
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
let suppressedOutputDepth = 0;
let processOutputPatched = false;

function patchProcessOutput() {
  if (processOutputPatched) {
    return;
  }

  process.stdout.write = function writeStdout(chunk, encoding, callback) {
    if (suppressedOutputDepth > 0) {
      if (typeof encoding === "function") {
        encoding();
      } else if (typeof callback === "function") {
        callback();
      }
      return true;
    }

    return originalStdoutWrite(chunk, encoding, callback);
  };

  process.stderr.write = function writeStderr(chunk, encoding, callback) {
    if (suppressedOutputDepth > 0) {
      if (typeof encoding === "function") {
        encoding();
      } else if (typeof callback === "function") {
        callback();
      }
      return true;
    }

    return originalStderrWrite(chunk, encoding, callback);
  };

  processOutputPatched = true;
}

async function runQuietly(fn) {
  if (DEBUG_LOGS || WHISPER_VERBOSE) {
    return fn();
  }

  patchProcessOutput();
  suppressedOutputDepth += 1;
  try {
    return await fn();
  } finally {
    suppressedOutputDepth -= 1;
  }
}

function transcriptLog(message) {
  originalStdoutWrite(`${message}\n`);
}

function debugLog(...args) {
  if (DEBUG_LOGS) {
    console.log(...args);
  }
}

function debugWarn(...args) {
  if (DEBUG_LOGS) {
    console.warn(...args);
  }
}

function debugError(...args) {
  if (DEBUG_LOGS) {
    console.error(...args);
  }
}

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

debugLog("--- @discordjs/voice Dependency Report ---");
debugLog(generateDependencyReport());
debugLog("------------------------------------------");
debugLog(`[whisper] model=${WHISPER_MODEL} autoDownload=${WHISPER_AUTO_DOWNLOAD}`);

const activeSessions = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages
  ]
});

function sanitizeFilePart(input) {
  return String(input || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ts() {
  return new Date().toISOString().slice(11, 23);
}

function buildEphemeralReply(content) {
  return {
    content,
    flags: MessageFlags.Ephemeral
  };
}

async function safeReply(interaction, content) {
  const payload = buildEphemeralReply(content);

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload).catch(() => {});
    return;
  }

  await interaction.reply(payload).catch(() => {});
}

function findTranscriptTextPath(audioFilePath) {
  const directory = path.dirname(audioFilePath);
  const basename = path.basename(audioFilePath, path.extname(audioFilePath));
  const exactPath = path.join(directory, `${basename}.txt`);

  if (fs.existsSync(exactPath)) {
    return exactPath;
  }

  const matches = fs
    .readdirSync(directory)
    .filter((name) => name.startsWith(basename) && name.endsWith(".txt"))
    .sort();

  return matches.length > 0 ? path.join(directory, matches[0]) : null;
}

function extractTranscriptText(result) {
  if (!result) {
    return "";
  }

  if (typeof result === "string") {
    return result.trim();
  }

  if (typeof result.text === "string") {
    return result.text.trim();
  }

  if (typeof result.transcript === "string") {
    return result.transcript.trim();
  }

  return "";
}

function isJapaneseChar(char) {
  const code = char.codePointAt(0);
  return (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    code === 0x30fc ||
    code === 0x3005
  );
}

function joinTranscriptParts(parts) {
  return parts.reduce((text, part) => {
    if (!text) {
      return part;
    }

    const last = text[text.length - 1];
    const first = part[0];
    const needsSpace = !isJapaneseChar(last) && !isJapaneseChar(first);
    return `${text}${needsSpace ? " " : ""}${part}`;
  }, "");
}

function formatTranscriptForConsole(transcript) {
  const parts = transcript
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*\[[^\]]+-->\s*[^\]]+\]\s*/, "")
        .trim()
    )
    .filter(Boolean);

  return joinTranscriptParts(parts);
}

function hasJapaneseText(text) {
  return Array.from(String(text || "")).some(isJapaneseChar);
}

function normalizeWhisperLanguage(language) {
  const normalized = String(language || "").trim().toLowerCase();

  if (!normalized || normalized === "auto") {
    return "auto";
  }

  if (normalized.startsWith("ja") || normalized.includes("japan")) {
    return "ja";
  }

  if (normalized.startsWith("en") || normalized.includes("english")) {
    return "en";
  }

  return normalized;
}

function getVoiceEndpointFromConnection(connection) {
  return String(
    connection?.state?.networking?.state?.connectionOptions?.endpoint || ""
  );
}

function getVoiceEndpointRegion(endpoint) {
  const normalized = String(endpoint || "").toLowerCase();
  const match = normalized.match(/(?:^|[-.])([a-z]{3})\d*(?:[-.])/);
  return match?.[1] || "";
}

function detectWhisperLanguageFromVoiceEndpoint(endpoint) {
  const normalized = String(endpoint || "").toLowerCase();
  const region = getVoiceEndpointRegion(normalized);

  if (
    ["jpe", "jpn", "ja", "nrt", "tyo"].includes(region) ||
    normalized.includes("japan") ||
    normalized.includes("tokyo")
  ) {
    return "ja";
  }

  if (["hkg", "hkn"].includes(region) || normalized.includes("hong-kong")) {
    return "zh";
  }

  return "";
}

function detectWhisperLanguageFromVoiceChannel(voiceChannel, guild, connection) {
  if (WHISPER_LANGUAGE) {
    return normalizeWhisperLanguage(WHISPER_LANGUAGE);
  }

  if (!WHISPER_LANGUAGE_FROM_CHANNEL) {
    return "auto";
  }

  const endpointLanguage = detectWhisperLanguageFromVoiceEndpoint(
    getVoiceEndpointFromConnection(connection)
  );
  if (endpointLanguage) {
    return endpointLanguage;
  }

  const rtcRegion = String(voiceChannel?.rtcRegion || "").toLowerCase();
  if (rtcRegion.includes("japan")) {
    return "ja";
  }

  const preferredLocale = normalizeWhisperLanguage(guild?.preferredLocale);
  return preferredLocale || "auto";
}

async function transcribeAudioFile(audioFilePath, speakerLabel, language = "auto") {
  if (!fs.existsSync(audioFilePath)) {
    debugLog(`[whisper] skip missing file: ${audioFilePath}`);
    return;
  }

  const stat = fs.statSync(audioFilePath);
  if (stat.size < MIN_TRANSCRIBE_FILE_SIZE_BYTES) {
    debugLog(`[whisper] skip too-small file: ${audioFilePath}`);
    return;
  }

  debugLog(`[whisper] transcribing ${speakerLabel}: ${audioFilePath}`);

  let result;

  try {
    result = await runQuietly(() =>
      nodewhisper(audioFilePath, {
        modelName: WHISPER_MODEL,
        autoDownloadModelName: WHISPER_AUTO_DOWNLOAD ? WHISPER_MODEL : undefined,
        removeWavFileAfterTranscription: true,
        withCuda: WHISPER_WITH_CUDA,
        logger: whisperLogger,
        whisperOptions: {
          outputInCsv: false,
          outputInJson: false,
          outputInJsonFull: false,
          outputInLrc: false,
          outputInSrt: false,
          outputInText: true,
          outputInVtt: false,
          outputInWords: false,
          translateToEnglish: WHISPER_TRANSLATE_TO_ENGLISH,
          language,
          wordTimestamps: false,
          timestamps_length: 20
        }
      })
    );
  } catch (error) {
    debugError(`[whisper] failed for ${speakerLabel}:`, error);
    if (String(error.message || error).includes("Model file does not exist")) {
      debugError(
        `[whisper] model '${WHISPER_MODEL}' is missing. ` +
          "Run `npx nodejs-whisper download` once, or keep WHISPER_AUTO_DOWNLOAD=true."
      );
    }
    return;
  }

  let transcript = extractTranscriptText(result);

  if (!transcript) {
    const transcriptPath = findTranscriptTextPath(audioFilePath);
    if (transcriptPath && fs.existsSync(transcriptPath)) {
      transcript = fs.readFileSync(transcriptPath, "utf8").trim();
    }
  }

  if (!transcript) {
    debugLog(`[transcript][${speakerLabel}] <empty>`);
    return;
  }

  transcriptLog(`[transcript][${speakerLabel}] ${formatTranscriptForConsole(transcript)}`);
}

function createFfmpegProcess(outputPath) {
  return spawn(
    ffmpegPath,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-i",
      "pipe:0",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "128k",
      outputPath
    ],
    { stdio: ["pipe", "ignore", "pipe"] }
  );
}

function ensureUserStream(session, userId, guild) {
  let info = session.userStreams.get(userId);
  if (info) {
    return info;
  }

  const member = guild.members.cache.get(userId);
  const username = sanitizeFilePart(member?.user?.username || userId);
  const outputPath = path.join(session.sessionDir, `${username}_${userId}.mp3`);
  const ffmpeg = createFfmpegProcess(outputPath);

  ffmpeg.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) {
      debugLog(`[ffmpeg][${username}] ${text}`);
    }
  });

  ffmpeg.on("error", (error) => {
    debugError(`[ffmpeg] process error for ${username}:`, error);
  });
  ffmpeg.stdin.on("error", (error) => {
    debugWarn(`[record] ffmpeg stdin error for ${username}: ${error.message}`);
  });

  const closedPromise = new Promise((resolve) => {
    ffmpeg.once("close", async (code) => {
      debugLog(`[save] ${outputPath} (ffmpeg exit ${code})`);
      if (!REALTIME_TRANSCRIBE) {
        await transcribeAudioFile(outputPath, username, session.whisperLanguage);
      }
      resolve();
    });
  });

  info = {
    username,
    outputPath,
    ffmpeg,
    opusStream: null,
    decoder: null,
    subscribed: false,
    closedPromise,
    realtimePromises: new Set(),
    segmentIndex: 0,
    realtimeChunks: [],
    realtimeBytes: 0,
    realtimeFlushTimer: null,
    realtimeFlushPromise: Promise.resolve()
  };

  session.userStreams.set(userId, info);
  debugLog(`[record] prepare speaker ${username} (${userId}) -> ${outputPath}`);
  return info;
}

function encodePcmToMp3(pcmBuffer, outputPath, speakerLabel) {
  return new Promise((resolve) => {
    const ffmpeg = createFfmpegProcess(outputPath);

    ffmpeg.on("error", (error) => {
      debugError(`[segment] ffmpeg error for ${speakerLabel}:`, error);
    });
    ffmpeg.stdin.on("error", (error) => {
      debugWarn(`[segment] stdin error for ${speakerLabel}: ${error.message}`);
    });
    ffmpeg.once("close", (code) => {
      debugLog(`[segment] ${outputPath} (ffmpeg exit ${code})`);
      resolve(code);
    });

    ffmpeg.stdin.end(pcmBuffer);
  });
}

async function flushRealtimeBuffer(session, info, userId) {
  if (info.realtimeFlushTimer) {
    clearTimeout(info.realtimeFlushTimer);
    info.realtimeFlushTimer = null;
  }

  if (info.realtimeBytes < MIN_REALTIME_PCM_BYTES) {
    if (info.realtimeBytes > 0) {
      debugLog(
        `[realtime] skip short buffer for ${info.username}: ${info.realtimeBytes} bytes`
      );
    }
    info.realtimeChunks = [];
    info.realtimeBytes = 0;
    return;
  }

  const segmentsDir = path.join(session.sessionDir, "segments");
  fs.mkdirSync(segmentsDir, { recursive: true });

  const segmentIndex = ++info.segmentIndex;
  const segmentPath = path.join(
    segmentsDir,
    `${info.username}_${userId}_${String(segmentIndex).padStart(4, "0")}.mp3`
  );
  const pcmBuffer = Buffer.concat(info.realtimeChunks, info.realtimeBytes);
  info.realtimeChunks = [];
  info.realtimeBytes = 0;

  const task = (async () => {
    const code = await encodePcmToMp3(
      pcmBuffer,
      segmentPath,
      `${info.username}#${segmentIndex}`
    );
    if (code === 0) {
      await transcribeAudioFile(
        segmentPath,
        `${info.username}#${segmentIndex}`,
        session.whisperLanguage
      );
    }
  })();

  info.realtimePromises.add(task);
  task.finally(() => info.realtimePromises.delete(task));
  await task;
}

function scheduleRealtimeFlush(session, info, userId) {
  if (!REALTIME_TRANSCRIBE) {
    return;
  }

  if (info.realtimeFlushTimer) {
    clearTimeout(info.realtimeFlushTimer);
  }

  info.realtimeFlushTimer = setTimeout(() => {
    info.realtimeFlushPromise = info.realtimeFlushPromise.then(() =>
      flushRealtimeBuffer(session, info, userId).catch((error) => {
        debugError(`[realtime] flush failed for ${info.username}:`, error);
      })
    );
  }, REALTIME_SEGMENT_SILENCE_MS);
}

function subscribeUserSpeech(session, userId, guild) {
  const info = ensureUserStream(session, userId, guild);
  if (info.subscribed) {
    return;
  }

  const opusStream = session.connection.receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 500
    }
  });

  const decoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960
  });

  info.opusStream = opusStream;
  info.decoder = decoder;
  info.subscribed = true;

  const cleanup = () => {
    info.subscribed = false;
    info.opusStream = null;
    info.decoder = null;
    scheduleRealtimeFlush(session, info, userId);
  };

  const handleStreamError = (source, error) => {
    const message = error?.message || String(error);
    debugWarn(`[record] ${source} error for ${info.username}: ${message}`);
    cleanup();

    try {
      opusStream.destroy();
    } catch {}
    try {
      decoder.destroy();
    } catch {}
    scheduleRealtimeFlush(session, info, userId);
  };

  opusStream.on("error", (error) => handleStreamError("opus", error));
  decoder.on("error", (error) => handleStreamError("decoder", error));

  const pcmTap = new PassThrough();

  pcmTap.on("data", (chunk) => {
    if (!info.ffmpeg.stdin.destroyed && info.ffmpeg.stdin.writable) {
      info.ffmpeg.stdin.write(chunk);
    }

    if (!REALTIME_TRANSCRIBE) {
      return;
    }

    info.realtimeChunks.push(Buffer.from(chunk));
    info.realtimeBytes += chunk.length;
    scheduleRealtimeFlush(session, info, userId);
  });

  pcmTap.on("error", (error) => handleStreamError("pcm", error));
  opusStream.pipe(decoder);
  decoder.pipe(pcmTap);

  opusStream.once("end", cleanup);
  opusStream.once("close", cleanup);
  decoder.once("close", cleanup);
  pcmTap.once("close", cleanup);
}

async function stopSession(guildId) {
  const session = activeSessions.get(guildId);
  if (!session) {
    return;
  }

  activeSessions.delete(guildId);

  for (const info of session.userStreams.values()) {
    if (info.realtimeFlushTimer) {
      clearTimeout(info.realtimeFlushTimer);
      info.realtimeFlushTimer = null;
    }
    info.realtimeFlushPromise = info.realtimeFlushPromise.then(() =>
      flushRealtimeBuffer(session, info, "final").catch((error) => {
        debugError(`[realtime] final flush failed for ${info.username}:`, error);
      })
    );

    try {
      info.opusStream?.destroy();
    } catch {}
    try {
      info.decoder?.destroy();
    } catch {}
  }

  for (const info of session.userStreams.values()) {
    try {
      info.ffmpeg.stdin.end();
    } catch {}
  }

  await Promise.all(
    Array.from(session.userStreams.values()).map((info) =>
      Promise.race([
        info.closedPromise,
        new Promise((resolve) => setTimeout(resolve, 30_000))
      ])
    )
  );

  await Promise.all(
    Array.from(session.userStreams.values()).flatMap((info) =>
      [info.realtimeFlushPromise, ...Array.from(info.realtimePromises || [])]
    )
  );

  const connection = session.connection || getVoiceConnection(guildId);
  if (connection) {
    try {
      connection.destroy();
    } catch {}
  }
}

async function handleRecord(interaction) {
  const { guild, member, guildId } = interaction;

  if (!guild) {
    await interaction.reply(
      buildEphemeralReply("このコマンドはサーバー内でのみ使えます。")
    );
    return;
  }

  const voiceChannel = member.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply(
      buildEphemeralReply("先にボイスチャンネルへ参加してください。")
    );
    return;
  }

  if (activeSessions.has(guildId)) {
    await interaction.reply(
      buildEphemeralReply(
        "このサーバーではすでに録音中です。`/stop` で停止してください。"
      )
    );
    return;
  }

  await interaction.deferReply();

  const sessionDir = path.join(RECORDINGS_DIR, `${timestampLabel()}_${guildId}`);
  fs.mkdirSync(sessionDir, { recursive: true });

  const me = await guild.members.fetchMe();
  const permissions = voiceChannel.permissionsFor(me);
  if (!permissions?.has("Connect") || !permissions?.has("ViewChannel")) {
    await interaction.editReply(
      `Bot にチャンネル参加権限がありません。VC: ${voiceChannel.name}`
    );
    return;
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
    debug: DEBUG_LOGS
  });

  connection.on("stateChange", (oldState, newState) => {
    debugLog(`[${ts()}] voice state: ${oldState.status} -> ${newState.status}`);
  });
  connection.on("error", (error) => {
    debugError(`[${ts()}] voice connection error:`, error);
  });
  connection.on("debug", (message) => {
    debugLog(`[${ts()}] [voice debug] ${message}`);
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch (error) {
    debugError("Voice connection failed:", error);

    try {
      connection.destroy();
    } catch {}

    await interaction.editReply(
      `ボイスチャンネルへの接続に失敗しました: ${error.message}`
    );
    return;
  }

  const session = {
    connection,
    sessionDir,
    channelName: voiceChannel.name,
    voiceEndpoint: getVoiceEndpointFromConnection(connection),
    whisperLanguage: detectWhisperLanguageFromVoiceChannel(
      voiceChannel,
      guild,
      connection
    ),
    userStreams: new Map()
  };
  debugLog(
    `[whisper] language=${session.whisperLanguage} endpoint=${
      session.voiceEndpoint || "unknown"
    } channel=${voiceChannel.name}`
  );

  activeSessions.set(guildId, session);

  connection.receiver.speaking.on("start", (userId) => {
    const info = session.userStreams.get(userId);
    if (info?.subscribed) {
      return;
    }

    subscribeUserSpeech(session, userId, guild);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
      ]);
    } catch {
      await stopSession(guildId).catch(() => {});
    }
  });

  await interaction.editReply(
    `**${voiceChannel.name}** の録音を開始しました。\n` +
      "`/stop` で停止すると MP3 保存後に Whisper で文字起こしし、結果を標準出力へ表示します。"
  );
}

async function handleStop(interaction) {
  const { guildId } = interaction;

  if (!activeSessions.has(guildId)) {
    await interaction.reply(
      buildEphemeralReply("現在このサーバーでは録音していません。")
    );
    return;
  }

  await interaction.deferReply();

  const { sessionDir, channelName } = activeSessions.get(guildId);
  await stopSession(guildId);

  await interaction.editReply(
    `**${channelName}** の録音を停止しました。\n` +
      `保存先: \`${path.relative(__dirname, sessionDir)}\`\n` +
      "文字起こし結果は bot を起動しているターミナルへ出力されます。"
  );
}

client.once(Events.ClientReady, (readyClient) => {
  debugLog(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  try {
    if (interaction.commandName === "record") {
      await handleRecord(interaction);
      return;
    }

    if (interaction.commandName === "stop") {
      await handleStop(interaction);
    }
  } catch (error) {
    debugError("Command handling error:", error);
    await safeReply(interaction, `エラーが発生しました: ${error.message}`);
  }
});

process.on("SIGINT", async () => {
  debugLog("\nStopping active recording sessions...");

  for (const guildId of Array.from(activeSessions.keys())) {
    await stopSession(guildId);
  }

  client.destroy();
  process.exit(0);
});

client.login(DISCORD_TOKEN);
