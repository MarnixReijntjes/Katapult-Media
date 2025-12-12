import WebSocket, { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import http from 'http';
import twilio from 'twilio';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

dotenv.config();

// ---------- Basis config ----------

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const VOICE = process.env.VOICE || 'alloy';
const SPEED = parseFloat(process.env.SPEED || '1.0');
const INSTRUCTIONS = process.env.INSTRUCTIONS || 'You are Tessa...';

if (!OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY is not set in environment variables');
  process.exit(1);
}

// ---------- Twilio config ----------

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
  console.warn('⚠️  TWILIO_ACCOUNT_SID of TWILIO_AUTH_TOKEN ontbreekt.');
}

// ---------- ElevenLabs config ----------

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
  console.warn('⚠️ ElevenLabs TTS disabled: missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID');
} else {
  console.log('✅ ElevenLabs ENV loaded');
}

async function synthesizeWithElevenLabs(text) {
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
    throw new Error('ELEVENLABS_NOT_CONFIGURED');
  }

  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVEN_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    body: JSON.stringify({
      model_id: ELEVEN_MODEL,
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.8 }
    })
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => '');
    throw new Error(`ELEVENLABS_TTS_FAILED ${resp.status}: ${errTxt}`);
  }

  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// ---------- Trello config ----------

const TRELLO_KEY = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const TRELLO_LIST_ID = process.env.TRELLO_LIST_ID;

if (!TRELLO_KEY || !TRELLO_TOKEN || !TRELLO_LIST_ID) {
  console.error('❌ Trello ENV vars ontbreken');
} else {
  console.log('✅ Trello ENV loaded');
}

// ---------- Server statistics ----------

const serverStats = {
  startTime: new Date(),
  totalConnections: 0,
  activeConnections: 0,
  totalErrors: 0
};

// ---------- Telefoonnummer normalisatie ----------

function normalizePhone(raw) {
  if (!raw) return null;
  let cleaned = raw.toString().trim();

  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1).replace(/\D/g, '');
    if (!digits) return null;
    return `+${digits}`;
  }

  const digitsOnly = cleaned.replace(/\D/g, '');
  if (!digitsOnly) return null;

  if (digitsOnly.length === 10 && digitsOnly.startsWith('06')) return `+31${digitsOnly.slice(1)}`;
  if (digitsOnly.length === 11 && digitsOnly.startsWith('31')) return `+${digitsOnly}`;
  if (digitsOnly.length === 9 && digitsOnly.startsWith('6')) return `+316${digitsOnly.slice(1)}`;

  return null;
}

// ---------- Outbound call helper ----------

async function makeOutboundCall(phone) {
  if (!twilioClient) throw new Error('Twilio client not configured');
  if (!TWILIO_FROM) throw new Error('TWILIO_FROM is not set');
  if (!PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL is not set');

  const twimlUrl = `${PUBLIC_BASE_URL}/twiml`;

  console.log(`[${new Date().toISOString()}] Creating outbound call to ${phone} from ${TWILIO_FROM}`);
  const call = await twilioClient.calls.create({ to: phone, from: TWILIO_FROM, url: twimlUrl });
  console.log(`[${new Date().toISOString()}] Outbound call created: CallSid=${call.sid}`);
  return call;
}

async function triggerCall(phoneRaw) {
  const normalized = normalizePhone(phoneRaw);
  if (!normalized) throw new Error(`Cannot normalize phone number: ${phoneRaw}`);
  console.log(`📞 Triggering Tessa to call ${normalized} (raw: ${phoneRaw})`);
  await makeOutboundCall(normalized);
}

// ---------- Trello poller ----------

async function pollTrelloLeads() {
  if (!TRELLO_KEY || !TRELLO_TOKEN || !TRELLO_LIST_ID) return;

  console.log('🔁 Polling Trello list for new leads...');

  try {
    const url = `https://api.trello.com/1/lists/${TRELLO_LIST_ID}/cards?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
    const res = await fetch(url);
    console.log('📡 Trello status:', res.status);

    if (!res.ok) {
      console.error('❌ Trello error response:', await res.text());
      return;
    }

    const cards = await res.json();
    console.log(`📋 ${cards.length} cards found in Trello list`);

    for (const card of cards) {
      const hasCalled = (card.labels || []).some(l => l.name === 'GEBELD');
      if (hasCalled) continue;

      const desc = card.desc || '';
      const match = desc.match(/(\+?[0-9][0-9()\-\s]{7,20})/);
      if (!match) continue;

      try {
        await triggerCall(match[0].trim());
      } catch (err) {
        console.error(`❌ Call failed for card ${card.id}:`, err.message);
        continue;
      }

      const labelUrl = `https://api.trello.com/1/cards/${card.id}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
      await fetch(labelUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'GEBELD', color: 'green' })
      });
    }
  } catch (e) {
    console.error('❌ Trello poll error:', e.message);
  }
}

setInterval(pollTrelloLeads, 15000);

// ---------- HTTP server ----------

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/health' && req.method === 'GET') {
    const uptime = Math.floor((Date.now() - serverStats.startTime.getTime()) / 1000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        {
          status: 'healthy',
          uptime: `${uptime}s`,
          timestamp: new Date().toISOString(),
          connections: { active: serverStats.activeConnections, total: serverStats.totalConnections },
          errors: serverStats.totalErrors,
          openai_configured: !!OPENAI_API_KEY
        },
        null,
        2
      )
    );
    return;
  }

  if (req.url === '/twiml' && req.method === 'POST') {
    const websocketUrl = `wss://${req.headers.host}`;
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${websocketUrl}" />
  </Connect>
</Response>`;
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml);
    console.log(`[${new Date().toISOString()}] TwiML requested for host: ${req.headers.host}`);
    return;
  }

  if (req.url.startsWith('/call-test') && req.method === 'GET') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const phone = urlObj.searchParams.get('phone');
    if (!phone) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing phone parameter' }));
      return;
    }

    console.log(`📞 /call-test triggered for: ${phone}`);
    triggerCall(phone)
      .then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', calling: phone }));
      })
      .catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  if (req.url.startsWith('/test-eleven') && req.method === 'GET') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const text = urlObj.searchParams.get('text') || 'Hallo, dit is een ElevenLabs test.';
    try {
      const audioBuf = await synthesizeWithElevenLabs(text);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(audioBuf);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

// ---------- WebSocket server ----------

const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Server started on port ${PORT}`);
});

// ---------- Twilio connection handler (OpenAI ulaw -> Twilio direct) ----------

function handleTwilioConnection(twilioWs, clientId) {
  console.log(`[${new Date().toISOString()}] Setting up Twilio media stream for: ${clientId}`);

  let streamSid = null;
  let callSid = null;

  let outboundUlaw = Buffer.alloc(0);
  let isResponseActive = false;

  // --- ENIGE EXTRA LOGICA IN DEZE STAP: tekst verzamelen + ElevenLabs aanroepen (LOG ONLY) ---
  let assistantText = '';
  let elevenInFlight = false;

  function sendUlawFrame(frame) {
    if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
    twilioWs.send(
      JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: frame.toString('base64') }
      })
    );
  }

  const openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' }
  });

  let isOpenAIConnected = false;

  openaiWs.on('open', () => {
    console.log(`[${new Date().toISOString()}] Connected to OpenAI Realtime API for Twilio call: ${clientId}`);
    isOpenAIConnected = true;

    const sessionConfig = {
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions: INSTRUCTIONS,
        voice: VOICE,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true
        },
        temperature: 0.8,
        max_response_output_tokens: 1024,
        speed: SPEED
      }
    };

    openaiWs.send(JSON.stringify(sessionConfig));
    console.log(`[${new Date().toISOString()}] Session config sent:`, JSON.stringify(sessionConfig));

    setTimeout(() => {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(
          JSON.stringify({
            type: 'response.create',
            response: { modalities: ['audio', 'text'], instructions: 'Zeg exact je opening in het Nederlands. Spreek duidelijk en kort.', voice: VOICE }
          })
        );
        console.log(`[${new Date().toISOString()}] Initial greeting triggered for: ${clientId}`);
      }
    }, 250);
  });

  twilioWs.on('message', message => {
    try {
      const msg = JSON.parse(message);

      switch (msg.event) {
        case 'start':
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          console.log(`[${new Date().toISOString()}] Twilio stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
          break;

        case 'media':
          if (isOpenAIConnected && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }));
          }
          break;

        case 'stop':
          console.log(`[${new Date().toISOString()}] Twilio stream stopped: ${streamSid}`);
          if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
          break;

        default:
          console.log(`[${new Date().toISOString()}] Twilio event: ${msg.event}`);
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error processing Twilio message:`, error.message);
    }
  });

  openaiWs.on('message', data => {
    try {
      const event = JSON.parse(data);
      // console.log(`[${new Date().toISOString()}] OpenAI event: ${event.type}`);

      if (event.type === 'input_audio_buffer.speech_started') {
        // flush outbound
        outboundUlaw = Buffer.alloc(0);
        if (isResponseActive && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
        }
        if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
          twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
        }
      }

      if (event.type === 'response.output_item.added') {
        isResponseActive = true;
        outboundUlaw = Buffer.alloc(0);
        assistantText = '';
      }

      // audio terug naar Twilio
      if (event.type === 'response.audio.delta' && event.delta) {
        const ulawChunk = Buffer.from(event.delta, 'base64');
        outboundUlaw = Buffer.concat([outboundUlaw, ulawChunk]);
        const frameSize = 160;
        while (outboundUlaw.length >= frameSize) {
          const frame = outboundUlaw.subarray(0, frameSize);
          outboundUlaw = outboundUlaw.subarray(frameSize);
          sendUlawFrame(frame);
        }
      }

      // tekst verzamelen (voor ElevenLabs test)
      if (event.type === 'response.audio_transcript.delta' && typeof event.delta === 'string') {
        assistantText += event.delta;
      }

      if (event.type === 'response.done') {
        isResponseActive = false;

        const text = (assistantText || '').trim();
        if (text && ELEVEN_API_KEY && ELEVEN_VOICE_ID && !elevenInFlight) {
          elevenInFlight = true;
          const started = Date.now();
          synthesizeWithElevenLabs(text.slice(0, 400))
            .then(buf => {
              console.log(
                `[${new Date().toISOString()}] ✅ ELEVEN TTS OK bytes=${buf.length} ms=${Date.now() - started} text="${text.slice(0, 80)}"`
              );
            })
            .catch(err => {
              console.error(`[${new Date().toISOString()}] ❌ ELEVEN TTS FAIL: ${err.message}`);
            })
            .finally(() => {
              elevenInFlight = false;
            });
        } else {
          if (!text) console.log(`[${new Date().toISOString()}] (No assistant transcript captured for ElevenLabs test)`);
        }
      }

      if (event.type === 'error') {
        console.error(`[${new Date().toISOString()}] OpenAI error event:`, JSON.stringify(event.error));
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error processing OpenAI message:`, error.message);
    }
  });

  twilioWs.on('close', () => {
    serverStats.activeConnections--;
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  twilioWs.on('error', error => {
    serverStats.totalErrors++;
    console.error(`[${new Date().toISOString()}] Twilio WebSocket error (${clientId}):`, error.message);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  openaiWs.on('close', code => {
    isOpenAIConnected = false;
    console.log(`[${new Date().toISOString()}] OpenAI closed for Twilio call ${callSid} (code: ${code})`);
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });

  openaiWs.on('error', error => {
    serverStats.totalErrors++;
    console.error(`[${new Date().toISOString()}] OpenAI error for Twilio call (${clientId}):`, error.message);
    isOpenAIConnected = false;
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });
}

// ---------- WebSocket events ----------

wss.on('connection', (clientWs, request) => {
  const clientId = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
  serverStats.totalConnections++;
  serverStats.activeConnections++;
  console.log(`[${new Date().toISOString()}] New Twilio connection: ${clientId}`);
  handleTwilioConnection(clientWs, clientId);
});

wss.on('error', error => {
  serverStats.totalErrors++;
  console.error(`[${new Date().toISOString()}] WebSocket server error:`, error.message);
});

httpServer.on('error', error => {
  console.error(`[${new Date().toISOString()}] HTTP server error:`, error.message);
  process.exit(1);
});

// ---------- Graceful shutdown ----------

const shutdown = () => {
  console.log(`\n[${new Date().toISOString()}] Shutting down server...`);
  wss.close(() => {
    httpServer.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', error => {
  console.error(`[${new Date().toISOString()}] Uncaught exception:`, error);
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error(`[${new Date().toISOString()}] Unhandled rejection at:`, promise, 'reason:', reason);
});
