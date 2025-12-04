import WebSocket, { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import http from 'http';
import twilio from 'twilio';

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

// ---------- Server statistics ----------

const serverStats = {
  startTime: new Date(),
  totalConnections: 0,
  activeConnections: 0,
  totalErrors: 0
};

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

async function triggerCall(phone) {
  try {
    console.log(`📞 Triggering Tessa to call ${phone}`);
    await makeOutboundCall(phone);
  } catch (e) {
    console.error('❌ Error triggering outbound call:', e.message);
    throw e;
  }
}

// ---------- HTTP server (health, TwiML, call-test) ----------

const httpServer = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Healthcheck
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

  // Twilio voice webhook → geeft TwiML met Media Stream
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

  // Test endpoint → /call-test?phone=06...
  if (req.url.startsWith('/call-test') && req.method === 'GET') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const phone = urlObj.searchParams.get('phone');

    if (!phone) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'Missing phone parameter. Use /call-test?phone=0612345678'
        })
      );
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

  // Fallback 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

// ---------- WebSocket server voor Twilio Media Streams ----------

const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Server started on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] Twilio Media Stream endpoint: wss://localhost:${PORT}`);
  console.log(`[${new Date().toISOString()}] Health check: http://localhost:${PORT}/health`);
});

// Twilio connection handler
function handleTwilioConnection(twilioWs, clientId) {
  console.log(`[${new Date().toISOString()}] Setting up Twilio media stream for: ${clientId}`);

  let streamSid = null;
  let callSid = null;
  let lastAssistantItem = null;
  let responseStartTimestamp = null;
  let audioChunkCount = 0;
  let isResponseActive = false;

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

  openaiWs.on('open', () => {
    console.log(
      `[${new Date().toISOString()}] Connected to OpenAI Realtime API for Twilio call: ${clientId}`
    );
    isOpenAIConnected = true;

    const sessionConfig = {
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions: INSTRUCTIONS,
        voice: VOICE,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: {
          model: 'whisper-1'
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true
        },
        temperature: 0.8,
        max_response_output_tokens: 4096,
        speed: SPEED
      }
    };

    openaiWs.send(JSON.stringify(sessionConfig));
    console.log(
      `[${new Date().toISOString()}] Session config sent:`,
      JSON.stringify(sessionConfig)
    );

    // Eerste begroeting
    setTimeout(() => {
      if (openaiWs.readyState === WebSocket.OPEN) {
        const greetingMessage = {
          type: 'response.create',
          response: {
            modalities: ['audio', 'text'],
            instructions:
              'Groet de beller warm in het Nederlands en vraag hoe je hen vandaag kunt helpen.',
            voice: VOICE
          }
        };
        openaiWs.send(JSON.stringify(greetingMessage));
        console.log(
          `[${new Date().toISOString()}] Initial greeting triggered for: ${clientId}`
        );
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
          console.log(
            `[${new Date().toISOString()}] Twilio stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`
          );
          break;

        case 'media':
          if (isOpenAIConnected && openaiWs.readyState === WebSocket.OPEN) {
            const audioData = {
              type: 'input_audio_buffer.append',
              audio: msg.media.payload
            };
            openaiWs.send(JSON.stringify(audioData));
          }
          break;

        case 'stop':
          console.log(
            `[${new Date().toISOString()}] Twilio stream stopped: ${streamSid}`
          );
          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
          }
          break;

        default:
          console.log(`[${new Date().toISOString()}] Twilio event: ${msg.event}`);
      }
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Error processing Twilio message:`,
        error.message
      );
    }
  });

  // OpenAI → Twilio audio + events
  openaiWs.on('message', data => {
    try {
      const event = JSON.parse(data);

      console.log(`[${new Date().toISOString()}] OpenAI event: ${event.type}`);

      if (event.type === 'input_audio_buffer.speech_started') {
        console.log(`[${new Date().toISOString()}] User interruption detected`);

        if (isResponseActive && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
          console.log(`[${new Date().toISOString()}] Sent response.cancel`);
        }

        if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
          twilioWs.send(
            JSON.stringify({
              event: 'clear',
              streamSid: streamSid
            })
          );
        }
      }

      if (event.type === 'response.output_item.added') {
        lastAssistantItem = event.item;
        responseStartTimestamp = Date.now();
        audioChunkCount = 0;
        isResponseActive = true;
        console.log(
          `[${new Date().toISOString()}] 🎤 New response started - waiting for audio chunks...`
        );
      }

      if (event.type === 'response.cancelled') {
        console.log(
          `[${new Date().toISOString()}] Response cancelled - truncating assistant message`
        );
        isResponseActive = false;

        if (lastAssistantItem && lastAssistantItem.id && responseStartTimestamp) {
          const elapsedMs = Date.now() - responseStartTimestamp;
          const audioEndMs = Math.max(0, elapsedMs - 200);

          const truncateEvent = {
            type: 'conversation.item.truncate',
            item_id: lastAssistantItem.id,
            content_index: 0,
            audio_end_ms: audioEndMs
          };

          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify(truncateEvent));
            console.log(
              `[${new Date().toISOString()}] Truncated assistant message at ${audioEndMs}ms: ${lastAssistantItem.id}`
            );
          }
        }
      }

      if (event.type === 'response.audio.delta' && event.delta) {
        audioChunkCount++;
        console.log(
          `[${new Date().toISOString()}] 🔊 Audio chunk #${audioChunkCount} received from OpenAI (${event.delta.length} bytes)`
        );

        const audioPayload = {
          event: 'media',
          streamSid: streamSid,
          media: {
            payload: event.delta
          }
        };

        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify(audioPayload));
          console.log(
            `[${new Date().toISOString()}] ✅ Audio chunk #${audioChunkCount} forwarded to Twilio`
          );
        } else {
          console.error(
            `[${new Date().toISOString()}] ❌ Failed to forward audio chunk #${audioChunkCount} - Twilio WS not open`
          );
        }
      }

      if (event.type === 'conversation.item.created') {
        console.log(
          `[${new Date().toISOString()}] Conversation item: ${event.item.type}`
        );
      }

      if (event.type === 'response.done') {
        console.log(
          `[${new Date().toISOString()}] Response completed for call: ${callSid} - Total audio chunks sent: ${audioChunkCount}`
        );
        isResponseActive = false;

        if (audioChunkCount === 0) {
          console.warn(
            `[${new Date().toISOString()}] ⚠️ WARNING: Response completed but NO audio chunks were received from OpenAI!`
          );
        }
      }

      if (event.type === 'error') {
        console.error(
          `[${new Date().toISOString()}] OpenAI error event:`,
          JSON.stringify(event.error)
        );
      }
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Error processing OpenAI message:`,
        error.message
      );
    }
  });

  twilioWs.on('close', () => {
    serverStats.activeConnections--;
    console.log(`[${new Date().toISOString()}] Twilio disconnected: ${clientId}`);
    console.log(
      `[${new Date().toISOString()}] Active connections: ${serverStats.activeConnections}`
    );

    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  twilioWs.on('error', error => {
    serverStats.totalErrors++;
    console.error(
      `[${new Date().toISOString()}] Twilio WebSocket error (${clientId}):`,
      error.message
    );

    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  openaiWs.on('close', code => {
    console.log(
      `[${new Date().toISOString()}] OpenAI closed for Twilio call ${callSid} (code: ${code})`
    );
    isOpenAIConnected = false;

    if (twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.close();
    }
  });

  openaiWs.on('error', error => {
    serverStats.totalErrors++;
    console.error(
      `[${new Date().toISOString()}] OpenAI error for Twilio call (${clientId}):`,
      error.message
    );
    isOpenAIConnected = false;

    if (twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.close();
    }
  });
}

// ---------- WebSocket events ----------

wss.on('connection', (clientWs, request) => {
  const clientId = `${request.socket.remoteAddress}:${request.socket.remotePort}`;

  serverStats.totalConnections++;
  serverStats.activeConnections++;

  console.log(`[${new Date().toISOString()}] New Twilio connection: ${clientId}`);
  console.log(
    `[${new Date().toISOString()}] Active connections: ${serverStats.activeConnections}`
  );

  handleTwilioConnection(clientWs, clientId);
});

wss.on('error', error => {
  serverStats.totalErrors++;
  console.error(
    `[${new Date().toISOString()}] WebSocket server error:`,
    error.message
  );
});

httpServer.on('error', error => {
  console.error(`[${new Date().toISOString()}] HTTP server error:`, error.message);
  process.exit(1);
});

// ---------- Graceful shutdown ----------

const shutdown = () => {
  console.log(`\n[${new Date().toISOString()}] Shutting down server...`);
  console.log(
    `[${new Date().toISOString()}] Total connections served: ${serverStats.totalConnections}`
  );
  console.log(
    `[${new Date().toISOString()}] Total errors: ${serverStats.totalErrors}`
  );

  wss.close(() => {
    httpServer.close(() => {
      console.log(`[${new Date().toISOString()}] Server closed gracefully`);
      process.exit(0);
    });
  });

  setTimeout(() => {
    console.error(
      `[${new Date().toISOString()}] Forced shutdown after timeout`
    );
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
  console.error(
    `[${new Date().toISOString()}] Unhandled rejection at:`,
    promise,
    'reason:',
    reason
  );
});
