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

// Supported Realtime API voices: alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar
const VOICE = process.env.VOICE || 'alloy';
const SPEED = parseFloat(process.env.SPEED || '1.0'); // 0.25 to 4.0
const INSTRUCTIONS =
  process.env.INSTRUCTIONS ||
  'You are Tessa, a helpful and friendly multilingual voice assistant. You can speak both English and Dutch fluently. Automatically detect the language the caller is using and respond in the same language. Speak naturally and conversationally. Help the caller with their questions in a professional and courteous manner. Als de beller Nederlands spreekt, antwoord dan in het Nederlands. If the caller speaks English, respond in English.';

if (!OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY is not set in environment variables');
  process.exit(1);
}

// ---------- Twilio config ----------

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM; // bijv. +18046703805
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''); // bijv. https://test-cb9s.onrender.com

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
  console.warn(
    '⚠️  TWILIO_ACCOUNT_SID of TWILIO_AUTH_TOKEN ontbreekt. Outbound calls zullen niet werken tot je deze env vars hebt gezet.'
  );
}

// ---------- ElevenLabs config (optioneel, laten staan) ----------

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
  console.warn('⚠️ ElevenLabs TTS disabled: missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID');
} else {
  console.log('✅ ElevenLabs ENV loaded');
}

/**
 * Genereert TTS via ElevenLabs en geeft een Buffer met audio (mp3) terug.
 */
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
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8
      }
    })
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => '');
    throw new Error(`ELEVENLABS_TTS_FAILED ${resp.status}: ${errTxt}`);
  }

  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// ---------- OpenAI TTS + DSP voor telefoon (offline demo) ----------

async function generateOpenAITTS(text) {
  const resp = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: text
    })
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`OPENAI_TTS_FAILED: ${err}`);
  }

  return Buffer.from(await resp.arrayBuffer());
}

function applyPhoneDSP(inputBuf, outPath) {
  return new Promise((resolve, reject) => {
    const tempIn = path.join('/tmp', `tts_in_${Date.now()}.mp3`);
    fs.writeFileSync(tempIn, inputBuf);

    const args = [
      '-y',
      '-i',
      tempIn,
      '-af',
      'highpass=f=300, lowpass=f=3400, equalizer=f=2700:t=q:w=2:g=6, compand=attacks=0:decays=0:points=-80/-80|-12/-3|0/-3, dynaudnorm',
      '-ar',
      '8000',
      '-ac',
      '1',
      '-c:a',
      'pcm_mulaw',
      outPath
    ];

    execFile('ffmpeg', args, err => {
      try {
        fs.unlinkSync(tempIn);
      } catch (_) {}

      if (err) {
        console.error('❌ ffmpeg error in applyPhoneDSP:', err.message);
        return reject(err);
      }

      resolve(outPath);
    });
  });
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

// ---------- Telefoonnummer normalisatie (NL + varianten) ----------

function normalizePhone(raw) {
  if (!raw) return null;

  let cleaned = raw.toString().trim();

  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1).replace(/\D/g, '');
    if (!digits) {
      console.warn(`⚠️ Could not normalize intl number: ${raw}`);
      return null;
    }
    const e164 = `+${digits}`;
    console.log(`🔄 Normalized intl ${raw} -> ${e164}`);
    return e164;
  }

  const digitsOnly = cleaned.replace(/\D/g, '');
  if (!digitsOnly) {
    console.warn(`⚠️ Could not normalize (no digits): ${raw}`);
    return null;
  }

  if (digitsOnly.length === 10 && digitsOnly.startsWith('06')) {
    const withoutZero = digitsOnly.slice(1);
    const e164 = `+31${withoutZero}`;
    console.log(`🔄 Normalized NL mobile ${raw} -> ${e164}`);
    return e164;
  }

  if (digitsOnly.length === 11 && digitsOnly.startsWith('31')) {
    const e164 = `+${digitsOnly}`;
    console.log(`🔄 Normalized NL intl ${raw} -> ${e164}`);
    return e164;
  }

  if (digitsOnly.length === 9 && digitsOnly.startsWith('6')) {
    const subscriber = digitsOnly.slice(1);
    const e164 = `+316${subscriber}`;
    console.log(`🔄 Normalized NL short mobile ${raw} -> ${e164}`);
    return e164;
  }

  console.warn(`⚠️ Could not normalize phone number (unsupported pattern): ${raw}`);
  return null;
}

// ---------- Outbound call helper ----------

async function makeOutboundCall(phone) {
  if (!twilioClient) {
    throw new Error('Twilio client not configured (missing SID or AUTH TOKEN)');
  }
  if (!TWILIO_FROM) {
    throw new Error('TWILIO_FROM is not set in environment variables');
  }
  if (!PUBLIC_BASE_URL) {
    throw new Error('PUBLIC_BASE_URL is not set in environment variables');
  }

  const twimlUrl = `${PUBLIC_BASE_URL}/twiml`;

  console.log(`[${new Date().toISOString()}] Creating outbound call to ${phone} from ${TWILIO_FROM}`);
  const call = await twilioClient.calls.create({
    to: phone,
    from: TWILIO_FROM,
    url: twimlUrl
  });

  console.log(
    `[${new Date().toISOString()}] Outbound call created: CallSid=${call.sid}, To=${phone}, TwiML=${twimlUrl}`
  );
  return call;
}

async function triggerCall(phoneRaw) {
  try {
    const normalized = normalizePhone(phoneRaw);
    if (!normalized) {
      throw new Error(`Cannot normalize phone number: ${phoneRaw}`);
    }

    console.log(`📞 Triggering Tessa to call ${normalized} (raw: ${phoneRaw})`);
    await makeOutboundCall(normalized);
  } catch (e) {
    console.error('❌ Error triggering outbound call:', e.message);
    throw e;
  }
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
      const txt = await res.text();
      console.error('❌ Trello error response:', txt);
      return;
    }

    const cards = await res.json();
    console.log(`📋 ${cards.length} cards found in Trello list`);

    for (const card of cards) {
      const hasCalled = (card.labels || []).some(l => l.name === 'GEBELD');
      if (hasCalled) continue;

      const desc = card.desc || '';
      const match = desc.match(/(\+?[0-9][0-9()\-\s]{7,20})/);

      if (!match) {
        console.log(`⏭️  Card ${card.id} skipped (no recognizable phone in desc)`);
        continue;
      }

      const phoneRaw = match[0].trim();
      console.log(`📞 Trello trigger for card ${card.id}: raw="${phoneRaw}"`);

      try {
        await triggerCall(phoneRaw);
      } catch (err) {
        console.error(`❌ Call failed for card ${card.id}:`, err.message);
        continue;
      }

      const labelUrl = `https://api.trello.com/1/cards/${card.id}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
      const labelRes = await fetch(labelUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'GEBELD', color: 'green' })
      });

      if (!labelRes.ok) {
        const txt = await labelRes.text();
        console.error(`❌ Failed to set GEBELD label on ${card.id}:`, txt);
      } else {
        console.log(`✅ Label GEBELD set on card ${card.id}`);
      }
    }
  } catch (e) {
    console.error('❌ Trello poll error:', e.message);
  }
}

setInterval(pollTrelloLeads, 15000);

// ---------- HTTP server (health, TwiML, tests, TTS-demo) ----------

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
    const healthStatus = {
      status: 'healthy',
      uptime: `${uptime}s`,
      timestamp: new Date().toISOString(),
      connections: {
        active: serverStats.activeConnections,
        total: serverStats.totalConnections
      },
      errors: serverStats.totalErrors,
      openai_configured: !!OPENAI_API_KEY
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(healthStatus, null, 2));
    console.log(`[${new Date().toISOString()}] Health check requested`);
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
      res.end(JSON.stringify({ error: 'Missing phone parameter. Use /call-test?phone=0612345678' }));
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
    const text =
      urlObj.searchParams.get('text') ||
      'Hallo, ik ben Tessa, de AI-salesmachine. Dit is een test van ElevenLabs.';

    console.log(`🔊 /test-eleven triggered with text: "${text}"`);

    try {
      const audioBuf = await synthesizeWithElevenLabs(text);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(audioBuf);
    } catch (e) {
      console.error('❌ ElevenLabs test error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

    return;
  }

  if (req.url.startsWith('/tts-preview') && req.method === 'GET') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const text = urlObj.searchParams.get('text') || 'Dit is een test van Tessa.';

    console.log(`🔊 /tts-preview triggered with text: "${text}"`);

    try {
      const raw = await generateOpenAITTS(text);
      const outFile = path.join('/tmp', `tts_phone_${Date.now()}.wav`);
      await applyPhoneDSP(raw, outFile);

      const audio = fs.readFileSync(outFile);
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(audio);

      try {
        fs.unlinkSync(outFile);
      } catch (_) {}
    } catch (e) {
      console.error('❌ TTS preview error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

// ---------- WebSocket server voor Twilio Media Streams ----------

const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Server started on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] Health check: http://localhost:${PORT}/health`);
});

// ---------- Twilio connection handler (OpenAI ulaw -> Twilio direct) ----------

function handleTwilioConnection(twilioWs, clientId) {
  console.log(`[${new Date().toISOString()}] Setting up Twilio media stream for: ${clientId}`);

  let streamSid = null;
  let callSid = null;

  // Outbound buffer: g711_ulaw bytes, chunked naar 160-byte frames
  let outboundUlaw = Buffer.alloc(0);

  function sendUlawFrame(frame) {
    if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
    const payload = frame.toString('base64');
    twilioWs.send(
      JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload }
      })
    );
  }

  // Connect to OpenAI Realtime API
  const openaiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  let isOpenAIConnected = false;
  let isResponseActive = false;

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
        // ENIGE LOGISCHE WIJZIGING: laat OpenAI direct g711_ulaw teruggeven (geen ffmpeg)
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

    // Eerste begroeting
    setTimeout(() => {
      if (openaiWs.readyState === WebSocket.OPEN) {
        const greetingMessage = {
          type: 'response.create',
          response: {
            modalities: ['audio', 'text'],
            instructions: 'Zeg exact je opening in het Nederlands. Spreek duidelijk en kort.',
            voice: VOICE
          }
        };
        openaiWs.send(JSON.stringify(greetingMessage));
        console.log(`[${new Date().toISOString()}] Initial greeting triggered for: ${clientId}`);
      }
    }, 250);
  });

  // Twilio → OpenAI audio
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

  // OpenAI → Twilio (direct ulaw)
  openaiWs.on('message', data => {
    try {
      const event = JSON.parse(data);
      console.log(`[${new Date().toISOString()}] OpenAI event: ${event.type}`);

      if (event.type === 'input_audio_buffer.speech_started') {
        console.log(`[${new Date().toISOString()}] User interruption detected`);

        // flush outbound buffer (stop talking)
        outboundUlaw = Buffer.alloc(0);

        if (isResponseActive && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
          console.log(`[${new Date().toISOString()}] Sent response.cancel`);
        }

        if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
          twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
        }
      }

      if (event.type === 'response.output_item.added') {
        isResponseActive = true;
        outboundUlaw = Buffer.alloc(0);
      }

      // OpenAI levert nu g711_ulaw base64
      if (event.type === 'response.audio.delta' && event.delta) {
        const ulawChunk = Buffer.from(event.delta, 'base64');
        outboundUlaw = Buffer.concat([outboundUlaw, ulawChunk]);

        // Twilio: 20ms frames = 160 bytes @ 8k ulaw
        const frameSize = 160;
        while (outboundUlaw.length >= frameSize) {
          const frame = outboundUlaw.subarray(0, frameSize);
          outboundUlaw = outboundUlaw.subarray(frameSize);
          sendUlawFrame(frame);
        }
      }

      if (event.type === 'response.done') {
        isResponseActive = false;
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
    console.log(`[${new Date().toISOString()}] Twilio disconnected: ${clientId}`);
    console.log(`[${new Date().toISOString()}] Active connections: ${serverStats.activeConnections}`);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  twilioWs.on('error', error => {
    serverStats.totalErrors++;
    console.error(`[${new Date().toISOString()}] Twilio WebSocket error (${clientId}):`, error.message);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  openaiWs.on('close', code => {
    console.log(`[${new Date().toISOString()}] OpenAI closed for Twilio call ${callSid} (code: ${code})`);
    isOpenAIConnected = false;
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
  console.log(`[${new Date().toISOString()}] Active connections: ${serverStats.activeConnections}`);

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
  console.log(`[${new Date().toISOString()}] Total connections served: ${serverStats.totalConnections}`);
  console.log(`[${new Date().toISOString()}] Total errors: ${serverStats.totalErrors}`);

  wss.close(() => {
    httpServer.close(() => {
      console.log(`[${new Date().toISOString()}] Server closed gracefully`);
      process.exit(0);
    });
  });

  setTimeout(() => {
    console.error(`[${new Date().toISOString()}] Forced shutdown after timeout`);
    process.exit(1);
  }, 10000);
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
