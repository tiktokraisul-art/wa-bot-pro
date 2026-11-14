const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const axios = require('axios');
const FormData = require('form-data');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WHATSAPP_PHONE_NUMBER = process.env.WHATSAPP_PHONE_NUMBER;

let activeSock = null;

async function sendTextToTelegram(text) {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: text,
            parse_mode: 'Markdown'
        });
        console.log('✅ টেলিগ্রামে মেসেজ পাঠানো হয়েছে!');
    } catch (error) {
        console.error('❌ টেলিগ্রামে মেসেজ পাঠাতে সমস্যা হয়েছে:', error.response ? error.response.data : error.message);
    }
}

async function sendToTelegram(buffer, fileName, caption) {
    try {
        const form = new FormData();
        form.append('chat_id', TELEGRAM_CHAT_ID);
        form.append('document', buffer, { filename: fileName });
        if (caption) {
            form.append('caption', caption);
        }

        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, form, {
            headers: form.getHeaders()
        });
        console.log(`✅ ফাইল টেলিগ্রামে পাঠানো হয়েছে: ${fileName}`);
    } catch (error) {
        console.error('❌ টেলিগ্রামে ফাইল পাঠাতে সমস্যা হয়েছে:', error.response ? error.response.data : error.message);
    }
}

async function generateAndSendPairingCode(sock) {
    if (!WHATSAPP_PHONE_NUMBER) {
        await sendTextToTelegram('❌ কোনো WhatsApp নম্বর দেওয়া নেই! দয়া করে Render-এর Environment Variable-এ `WHATSAPP_PHONE_NUMBER` যুক্ত করুন।');
        return;
    }

    try {
        const cleanedNumber = WHATSAPP_PHONE_NUMBER.replace(/[^0-9]/g, '');
        console.log(`পেয়ারিং কোড জেনারেট করা হচ্ছে নম্বর: ${cleanedNumber} এর জন্য...`);
        
        let code = await sock.requestPairingCode(cleanedNumber);
        code = code?.match(/.{1,4}/g)?.join('-') || code;

        const pairingMsg = `🔑 **WhatsApp Pairing Code**\n\nনিচের কোডটিতে **একবার ক্লিক করলেই কপি** হয়ে যাবে:\n\n\`\`\`${code}\`\`\`\n\n📱 **যুক্ত করার নিয়ম:**\n১. WhatsApp-এ গিয়ে Linked Devices > Link a Device-এ যান।\n২. **Link with phone number instead**-এ ক্লিক করে কোডটি দিন।`;
        
        await sendTextToTelegram(pairingMsg);
    } catch (err) {
        console.error('পেয়ারিং কোড নিতে সমস্যা হয়েছে:', err);
        await sendTextToTelegram('❌ পেয়ারিং কোড আনতে সমস্যা হয়েছে। সার্ভার রিস্টার্ট করে আবার চেষ্টা করুন।');
    }
}

async function listenTelegramCommands() {
    let offset = 0;
    setInterval(async () => {
        try {
            const res = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`, {
                params: { offset, timeout: 30 }
            });

            for (const update of res.data.result) {
                offset = update.update_id + 1;
                const message = update.message;

                if (message && message.text) {
                    const chatId = message.chat.id.toString();
                    const text = message.text.trim();

                    if (chatId === TELEGRAM_CHAT_ID.toString() && text === '/code') {
                        if (activeSock && !activeSock.authState.creds.registered) {
                            await generateAndSendPairingCode(activeSock);
                        } else {
                            await sendTextToTelegram('ℹ️ WhatsApp ইতিমধ্যে কানেক্টেড রয়েছে অথবা সকেট প্রস্তুত হচ্ছে। নতুন কোড চাইলে সার্ভার রিস্টার্ট করুন।');
                        }
                    }
                }
            }
        } catch (err) {}
    }, 3000);
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    activeSock = sock;
    sock.ev.on('creds.update', saveCreds);

    if (WHATSAPP_PHONE_NUMBER && !sock.authState.creds.registered) {
        setTimeout(async () => {
            await generateAndSendPairingCode(sock);
        }, 5000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('কানেকশন বিচ্ছিন্ন হয়েছে, আবার চেষ্টা করা হচ্ছে...', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('🚀 WhatsApp সফলভাবে কানেক্ট হয়েছে!');
            await sendTextToTelegram('🚀 **সফলভাবে WhatsApp কানেক্ট হয়েছে!** এখন থেকে যেকোনো ফাইল, ডকুমেন্ট বা 1-View মিডিয়া সরাসরি এখানে চলে আসবে।');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (msg.key.fromMe || !msg.message) continue;

            let messageContent = msg.message;

            if (messageContent.ephemeralMessage) messageContent = messageContent.ephemeralMessage.message;
            if (messageContent.viewOnceMessage) messageContent = messageContent.viewOnceMessage.message;
            if (messageContent.viewOnceMessageV2) messageContent.viewOnceMessageV2.message;
            if (messageContent.viewOnceMessageV2Extension) messageContent.viewOnceMessageV2Extension.message;
            if (messageContent.documentWithCaptionMessage) messageContent.documentWithCaptionMessage.message;
            
            if (messageContent.viewOnceMessage?.message) messageContent = messageContent.viewOnceMessage.message;
            if (messageContent.viewOnceMessageV2?.message) messageContent = messageContent.viewOnceMessageV2.message;

            const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];
            const messageType = mediaTypes.find(type => messageContent && messageContent[type]);

            if (mediaType) {
                try {
                    const sender = msg.pushName || msg.key.remoteJid.split('@')[0];
                    const mediaObj = messageContent[mediaType];
                    
                    let fileName = mediaObj.fileName;
                    if (!fileName) {
                        const mime = mediaObj.mimetype || 'application/octet-stream';
                        let ext = 'bin';
                        if (mime.includes('image')) ext = 'jpg';
                        else if (mime.includes('video')) ext = 'mp4';
                        else if (mime.includes('audio')) ext = 'mp3';
                        else if (mime.includes('pdf')) ext = 'pdf';
                        fileName = `WA_Media_${Date.now()}.${ext}`;
                    }

                    const caption = `📩 **নতুন ফাইল বা 1-View মিডিয়া এসেছে**\n👤 প্রেরক: ${sender}\n📝 ক্যাপশন: ${mediaObj.caption || 'নেই'}`;

                    console.log(`📥 ফাইল ডাউনলোড হচ্ছে: ${fileName}...`);

                    const clonedMsg = { 
                        ...msg, 
                        message: { 
                            [mediaType]: mediaObj 
                        } 
                    };

                    const buffer = await downloadMediaMessage(
                        clonedMsg,
                        'buffer',
                        {},
                        { logger: pino({ level: 'silent' }) }
                    );

                    if (buffer) {
                        await sendToTelegram(buffer, fileName, caption);
                    }

                } catch (err) {
                    console.error('ফাইল প্রসেস করতে সমস্যা হয়েছে:', err);
                }
            }
        }
    });
}

connectToWhatsApp();
listenTelegramCommands();
