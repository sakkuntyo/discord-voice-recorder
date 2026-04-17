// スラッシュコマンドを Discord に登録するスクリプト
// 実行: node deploy-commands.js
require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('record')
    .setDescription('あなたが参加しているボイスチャンネルの録音を開始します'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('録音を停止してボイスチャンネルから退出します'),
].map((c) => c.toJSON());

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('❌ .env に DISCORD_TOKEN と CLIENT_ID を設定してください。');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    if (GUILD_ID) {
      // 指定サーバーだけに登録 (反映が即時。開発向け)
      console.log(`⏳ ギルド ${GUILD_ID} にコマンドを登録中...`);
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
        body: commands,
      });
      console.log('✅ ギルドコマンドを登録しました。');
    } else {
      // 全サーバーに登録 (反映に最大1時間かかる)
      console.log('⏳ グローバルコマンドを登録中...');
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('✅ グローバルコマンドを登録しました。');
    }
  } catch (error) {
    console.error('❌ コマンド登録に失敗しました:', error);
    process.exit(1);
  }
})();
