const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

// Ensure /data directory exists (in case disk not mounted yet)
const dataDir = '/data';
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const authPath = path.join(dataDir, 'auth_info_meta_md');

app.use(express.static(path.join(__dirname, 'public')));

let sock;
let connected = false;

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['META MD', 'Chrome', '110.0.0'],
    syncFullHistory: false,
    generateHighQualityLinkPreview: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // QR would only appear if using QR pairing (not used here)
      io.emit('message', 'QR received (not used in pairing mode)');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      connected = false;
      io.emit('connected', false);
      io.emit('message', `Connection closed (${statusCode || 'unknown'}). ${shouldReconnect ? 'Reconnecting...' : 'Logged out - please pair again.'}`);

      if (shouldReconnect) {
        startSock();
      } else {
        // Optional: clear auth folder if logged out (uncomment if desired)
        // fs.rmSync(authPath, { recursive: true, force: true });
      }
    } else if (connection === 'open') {
      connected = true;
      io.emit('connected', true);
      io.emit('message', 'Connected successfully! META MD is online.');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase().trim();
    const from = msg.key.remoteJid;

    if (text === '.ping') {
      await sock.sendMessage(from, { text: 'Pong! 🏓 META MD is alive.' });
    }
    // Add more commands here in the future
  });
}

startSock();

io.on('connection', (socket) => {
  socket.emit('connected', connected);
  socket.emit('message', connected ? 'Already connected.' : 'Enter phone number to start pairing.');

  socket.on('pair', async (phoneNumber) => {
    if (connected) {
      socket.emit('message', 'Already connected.');
      return;
    }

    try {
      const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
      if (cleanPhone.length < 10) {
        socket.emit('message', 'Invalid phone number.');
        return;
      }

      socket.emit('message', 'Requesting pairing code...');
      const code = await sock.requestPairingCode(cleanPhone);

      socket.emit('code', code);
      socket.emit('message', `Pairing code: ${code}\n\nOpen WhatsApp → Settings → Linked Devices → Link with phone number → Enter this code.`);
    } catch (err) {
      socket.emit('message', `Error: ${err.message}`);
      console.error(err);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`META MD server running on port ${PORT}`);
});
