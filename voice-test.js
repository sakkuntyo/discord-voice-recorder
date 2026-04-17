// 最小限の voice 接続テストスクリプト
// ボット自身が指定チャンネルに入って 10 秒待つだけ
// 実行: node voice-test.js <GUILD_ID> <VOICE_CHANNEL_ID>
require('node:dns').setDefaultResultOrder('ipv4first');
require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  generateDependencyReport,
} = require('@discordjs/voice');

const [, , guildId, channelId] = process.argv;
if (!guildId || !channelId) {
  console.error(
    'Usage: node voice-test.js <GUILD_ID> <VOICE_CHANNEL_ID>'
  );
  process.exit(1);
}

console.log(generateDependencyReport());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const ts = () => new Date().toISOString().slice(11, 23);

client.once('ready', async () => {
  console.log(`[${ts()}] ✅ ログイン: ${client.user.tag}`);
  const guild = await client.guilds.fetch(guildId);

  const conn = joinVoiceChannel({
    guildId,
    channelId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
    debug: true,
  });

  conn.on('stateChange', (o, n) => {
    console.log(`[${ts()}] state: ${o.status} -> ${n.status}`);
  });
  conn.on('debug', (m) => console.log(`[${ts()}] dbg: ${m}`));
  conn.on('error', (e) => console.error(`[${ts()}] err:`, e));

  try {
    await entersState(conn, VoiceConnectionStatus.Ready, 30_000);
    console.log(`[${ts()}] 🎉 Ready!`);
    setTimeout(() => {
      conn.destroy();
      client.destroy();
      process.exit(0);
    }, 5000);
  } catch (err) {
    console.error(`[${ts()}] ❌ Ready にならず:`, err.message);
    conn.destroy();
    client.destroy();
    process.exit(2);
  }
});

client.login(process.env.DISCORD_TOKEN);
