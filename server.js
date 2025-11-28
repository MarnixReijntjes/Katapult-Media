import WebSocket, { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import http from 'http';
import { EventEmitter } from 'events';

dotenv.config();

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VOICE = process.env.VOICE || 'alloy';
const INSTRUCTIONS = process.env.INSTRUCTIONS || 'You are Tessa, a helpful and friendly multilingual voice assistant. You can speak both English and Dutch fluently. Automatically detect the language the caller is using and respond in the same language. Speak naturally and conversationally. Help the caller with their questions in a professional and courteous manner. Als de beller Nederlands spreekt, antwoord dan in het Nederlands. If the caller speaks English, respond in English.';

if (!OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY is not set in environment variables');
  process.exit(1);
}

// Track active connections and server stats
const serverStats = {
  startTime: new Date(),
  totalConnections: 0,
  activeConnections: 0,
  totalErrors: 0
};

// Create HTTP server for health checks
const httpServer = http.createServer((req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
});

// Create WebSocket server attached to HTTP server
const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Server started on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] Twilio Media Stream endpoint: wss://localhost:${PORT}`);
  console.log(`[${new Date().toISOString()}] Health check: http://localhost:${PORT}/health`);
});

// Handle Twilio-specific WebSocket connections
function handleTwilioConnection(twilioWs, clientId) {
  console.log(`[${new Date().toISOString()}] Setting up Twilio media stream for: ${clientId}`);
  
  let streamSid = null;
  let callSid = null;
  let lastAssistantItem = null;
  let responseStartTimestamp = null;
  let audioChunkCount = 0;
  let isResponseActive = false;
  
  // Connect to OpenAI Realtime API
  const openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  let isOpenAIConnected = false;

  // Handle OpenAI connection open
  openaiWs.on('open', () => {
    console.log(`[${new Date().toISOString()}] Connected to OpenAI Realtime API for Twilio call: ${clientId}`);
    isOpenAIConnected = true;

    // Configure session for Twilio (mulaw audio)
    const sessionConfig = {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
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
          silence_duration_ms: 500
        },
        temperature: 0.8,
        max_response_output_tokens: 4096
      }
    };

    openaiWs.send(JSON.stringify(sessionConfig));
    console.log(`[${new Date().toISOString()}] Session config sent:`, JSON.stringify(sessionConfig));
    
    // Send an initial greeting to start the conversation
    setTimeout(() => {
      if (openaiWs.readyState === WebSocket.OPEN) {
        const greetingMessage = {
          type: 'response.create',
          response: {
            modalities: ['text', 'audio'],
            instructions: 'Groet de beller warm in het Nederlands en vraag hoe je hen vandaag kunt helpen.'
          }
        };
        openaiWs.send(JSON.stringify(greetingMessage));
        console.log(`[${new Date().toISOString()}] Initial greeting triggered for: ${clientId}`);
      }
    }, 250);
  });

  // Handle messages from Twilio
  twilioWs.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      switch (msg.event) {
        case 'start':
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          console.log(`[${new Date().toISOString()}] Twilio stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
          break;

        case 'media':
          // Forward audio from Twilio to OpenAI
          if (isOpenAIConnected && openaiWs.readyState === WebSocket.OPEN) {
            const audioData = {
              type: 'input_audio_buffer.append',
              audio: msg.media.payload
            };
            openaiWs.send(JSON.stringify(audioData));
          }
          break;

        case 'stop':
          console.log(`[${new Date().toISOString()}] Twilio stream stopped: ${streamSid}`);
          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
          }
          break;

        default:
          console.log(`[${new Date().toISOString()}] Twilio event: ${msg.event}`);
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error processing Twilio message:`, error.message);
    }
  });

  // Handle messages from OpenAI
  openaiWs.on('message', (data) => {
    try {
      const event = JSON.parse(data);

      // Log all events for debugging
      console.log(`[${new Date().toISOString()}] OpenAI event: ${event.type}`);

      // Handle user interruption - cancel ongoing response
      if (event.type === 'input_audio_buffer.speech_started') {
        console.log(`[${new Date().toISOString()}] User interruption detected`);
        
        // Only cancel if there's an active response
        if (isResponseActive && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
          console.log(`[${new Date().toISOString()}] Sent response.cancel`);
        }
        
        // Clear Twilio's audio queue
        if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
          twilioWs.send(JSON.stringify({
            event: 'clear',
            streamSid: streamSid
          }));
        }
      }

      // Track assistant items for potential truncation
      if (event.type === 'response.output_item.added') {
        lastAssistantItem = event.item;
        responseStartTimestamp = Date.now();
        audioChunkCount = 0;
        isResponseActive = true;
      }

      // Handle response cancellation
      if (event.type === 'response.cancelled') {
        console.log(`[${new Date().toISOString()}] Response cancelled - truncating assistant message`);
        isResponseActive = false;
        
        // Truncate the assistant's last message at the interruption point
        if (lastAssistantItem && lastAssistantItem.id && responseStartTimestamp) {
          // Calculate how much audio was actually played
          // G.711 µ-law is 8kHz, 8-bit, so ~20ms per chunk typically
          // More accurate: use elapsed time since response started
          const elapsedMs = Date.now() - responseStartTimestamp;
          
          // Add a small buffer to account for network/processing delays
          const audioEndMs = Math.max(0, elapsedMs - 200);
          
          const truncateEvent = {
            type: 'conversation.item.truncate',
            item_id: lastAssistantItem.id,
            content_index: 0,
            audio_end_ms: audioEndMs
          };
          
          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify(truncateEvent));
            console.log(`[${new Date().toISOString()}] Truncated assistant message at ${audioEndMs}ms: ${lastAssistantItem.id}`);
          }
        }
      }

      // Forward audio responses back to Twilio
      if (event.type === 'response.audio.delta' && event.delta) {
        const audioPayload = {
          event: 'media',
          streamSid: streamSid,
          media: {
            payload: event.delta
          }
        };
        
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify(audioPayload));
          audioChunkCount++;
        }
      }

      // Log conversation items for debugging
      if (event.type === 'conversation.item.created') {
        console.log(`[${new Date().toISOString()}] Conversation item: ${event.item.type}`);
      }

      if (event.type === 'response.done') {
        console.log(`[${new Date().toISOString()}] Response completed for call: ${callSid}`);
        isResponseActive = false;
      }

      if (event.type === 'error') {
        console.error(`[${new Date().toISOString()}] OpenAI error event:`, JSON.stringify(event.error));
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error processing OpenAI message:`, error.message);
    }
  });

  // Handle Twilio disconnection
  twilioWs.on('close', () => {
    serverStats.activeConnections--;
    console.log(`[${new Date().toISOString()}] Twilio disconnected: ${clientId}`);
    console.log(`[${new Date().toISOString()}] Active connections: ${serverStats.activeConnections}`);
    
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  // Handle Twilio errors
  twilioWs.on('error', (error) => {
    serverStats.totalErrors++;
    console.error(`[${new Date().toISOString()}] Twilio WebSocket error (${clientId}):`, error.message);
    
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  // Handle OpenAI disconnection
  openaiWs.on('close', (code) => {
    console.log(`[${new Date().toISOString()}] OpenAI closed for Twilio call ${callSid} (code: ${code})`);
    isOpenAIConnected = false;
    
    if (twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.close();
    }
  });

  // Handle OpenAI errors
  openaiWs.on('error', (error) => {
    serverStats.totalErrors++;
    console.error(`[${new Date().toISOString()}] OpenAI error for Twilio call (${clientId}):`, error.message);
    isOpenAIConnected = false;
    
    if (twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.close();
    }
  });
}

wss.on('connection', (clientWs, request) => {
  const clientId = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
  
  serverStats.totalConnections++;
  serverStats.activeConnections++;
  
  console.log(`[${new Date().toISOString()}] New Twilio connection: ${clientId}`);
  console.log(`[${new Date().toISOString()}] Active connections: ${serverStats.activeConnections}`);
  
  // Handle Twilio connection
  handleTwilioConnection(clientWs, clientId);
});

// Handle server errors
wss.on('error', (error) => {
  serverStats.totalErrors++;
  console.error(`[${new Date().toISOString()}] WebSocket server error:`, error.message);
});

httpServer.on('error', (error) => {
  console.error(`[${new Date().toISOString()}] HTTP server error:`, error.message);
  process.exit(1);
});

// Graceful shutdown
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

  // Force close after 10 seconds
  setTimeout(() => {
    console.error(`[${new Date().toISOString()}] Forced shutdown after timeout`);
    process.exit(1);
  }, 10000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Log unhandled errors
process.on('uncaughtException', (error) => {
  console.error(`[${new Date().toISOString()}] Uncaught exception:`, error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`[${new Date().toISOString()}] Unhandled rejection at:`, promise, 'reason:', reason);
});
