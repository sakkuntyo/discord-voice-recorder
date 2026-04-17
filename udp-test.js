// UDP が外向きに通るかを直接テストするスクリプト
// 実行: node udp-test.js
const dgram = require('node:dgram');

const socket = dgram.createSocket('udp4');

// DNS クエリ (google.com の A レコード) を 8.8.8.8 に UDP で投げる
const query = Buffer.from([
  0x12, 0x34, // ID
  0x01, 0x00, // flags: standard query
  0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  // google.com
  0x06, 0x67, 0x6f, 0x6f, 0x67, 0x6c, 0x65,
  0x03, 0x63, 0x6f, 0x6d, 0x00,
  0x00, 0x01, 0x00, 0x01,
]);

let received = false;

socket.on('message', (msg, rinfo) => {
  received = true;
  console.log(`✅ UDP 応答を受信: ${rinfo.address}:${rinfo.port} (${msg.length} bytes)`);
  console.log('✅ UDP は正常に通っています。Discord 接続失敗は別の原因の可能性があります。');
  socket.close();
  process.exit(0);
});

socket.on('error', (err) => {
  console.error('❌ UDP エラー:', err);
  process.exit(1);
});

socket.send(query, 53, '8.8.8.8', (err) => {
  if (err) {
    console.error('❌ 送信失敗:', err);
    process.exit(1);
  }
  console.log('⏳ 8.8.8.8:53 に UDP パケットを送信しました。5秒以内に応答を待ちます...');
});

setTimeout(() => {
  if (!received) {
    console.error('❌ 5秒間応答がありませんでした。UDP が外向きにブロックされています。');
    console.error('   → Windows ファイアウォール / VPN / ルーターを疑ってください。');
    socket.close();
    process.exit(2);
  }
}, 5000);
