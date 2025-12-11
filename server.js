import dotenv from "dotenv";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

dotenv.config();

// ------------------------------------------------------------
// ENV
// ------------------------------------------------------------
const PORT = process.env.PORT || 8080;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;

const TRELLO_KEY = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const TRELLO_LIST_ID = process.env.TRELLO_LIST_ID;

// ------------------------------------------------------------
// Instructions for Tessa
// ------------------------------------------------------------
const INSTRUCTIONS =
  process.env.INSTRUCTIONS ||
  `
Je bent Tessa, een natuurlijke vrouwelijke telefonische AI-assistent.
Spreek warm, menselijk, vloeiend Nederlands.
Geen functies, geen camera, geen JSON, geen Engels tenzij de beller dat doet.
Hou zinnen kort, praat natuurlijk, reageer snel.
`;

// ------------------------------------------------------------
// Twilio client
// ------------------------------------------------------------
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ------------------------------------------------------------
// Phone normalizer
// ------------------------------------------------------------
function normalizePhone(raw) {
  if (!raw) return null;
  let cleaned = raw.trim();

  if (cleaned.startsWith("+")) {
    return "+" + cleaned.slice(1).replace(/\D/g, "");
  }

  cleaned = cleaned.replace(/\D/g, "");

  if (cleaned.length === 10 && cleaned.startsWith("06")) {
    return "+31" + cleaned.slice(1);
  }

  if (cleaned.length === 11 && cleaned.startsWith("31")) {
    return "+" + cleaned;
  }

  if (cleaned.length === 9 && cleaned.startsWith("6")) {
    return "+316" + cleaned.slice(1);
  }

  return null;
}

// ------------------------------------------------------------
// Outbound call
// ------------------------------------------------------------
async function startOutboundCall(phone) {
  console.log("📞 Outbound:", phone);

  const call = await twilioClient.calls.create({
    to: phone,
    from: TWILIO_FROM,
    url: `${PUBLIC_BASE_URL}/twiml`
  });

  return call.sid;
}

// ------------------------------------------------------------
// HTTP server (TwiML, health, test)
// ------------------------------------------------------------
const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.url === "/twiml" && req.method === "POST") {
    const xml = `
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}" />
  </Connect>
</Response>`;
    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(xml);
  }

  if (req.url.startsWith("/call-test")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const phone = normalizePhone(url.searchParams.get("phone"));

    if (!phone) {
      res.writeHead(400);
      return res.end("Invalid phone");
    }

    startOutboundCall(phone)
      .then(() => {
        res.writeHead(200).end("ok");
      })
      .catch((err) => {
        res.writeHead(500).end(err.message);
      });

    return;
  }

  res.writeHead(404).end();
});

// ------------------------------------------------------------
// WebSocket server (Twilio Media Streams)
// ------------------------------------------------------------
const wss = new WebSocketServer({ server: httpServer });

httpServer.listen(PORT, () => {
  console.log(`[SERVER] Listening on ${PORT}`);
});

// ------------------------------------------------------------
// REALTIME AI (AUDIO-IN / AUDIO-OUT) — THE GOOD VERSION
// ------------------------------------------------------------
function handleCall(twilioWs, id) {
  console.log("📞 Twilio connected:", id);

  let streamSid = null;
  let aiReady = false;

  // CONNECT TO OPENAI REALTIME
  const ai = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  // OPENAI READY
  ai.on("open", () => {
    console.log("✅ OpenAI connected");
    aiReady = true;

    ai.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: INSTRUCTIONS,
          modalities: ["audio", "text"],
          voice: "alloy", // REALTIME ALLOY VOICE
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 250,
            silence_duration_ms: 600,
            create_response: true
          }
        }
      })
    );
  });

  // TWILIO → OPENAI (incoming audio)
  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw);

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      console.log("🔗 Twilio stream:", streamSid);
    }

    if (msg.event === "media") {
      if (!aiReady) return;
      ai.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload
        })
      );
    }

    if (msg.event === "stop") {
      ai.close();
    }
  });

  // OPENAI → TWILIO (audio response)
  ai.on("message", (raw) => {
    const ev = JSON.parse(raw);

    // streaming audio chunks
    if (ev.type === "response.audio.delta" && ev.delta) {
      if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: ev.delta }
          })
        );
      }
    }
  });

  ai.on("close", () => {
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });

  twilioWs.on("close", () => {
    if (ai.readyState === WebSocket.OPEN) ai.close();
  });
}

wss.on("connection", (ws, req) => {
  const id = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  handleCall(ws, id);
});

// ------------------------------------------------------------
// Trello poller
// ------------------------------------------------------------
async function pollTrello() {
  if (!TRELLO_KEY || !TRELLO_TOKEN || !TRELLO_LIST_ID) return;

  try {
    const url = `https://api.trello.com/1/lists/${TRELLO_LIST_ID}/cards?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
    const res = await fetch(url);
    if (!res.ok) return;

    const cards = await res.json();

    for (const card of cards) {
      const labeled = (card.labels || []).some((l) => l.name === "GEBELD");
      if (labeled) continue;

      const m = (card.desc || "").match(/(\+?[0-9][0-9()\-\s]{7,20})/);
      if (!m) continue;

      const phone = normalizePhone(m[0]);
      if (!phone) continue;

      console.log("📞 Trello:", phone);

      try {
        await startOutboundCall(phone);

        await fetch(
          `https://api.trello.com/1/cards/${card.id}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "GEBELD", color: "green" })
          }
        );
      } catch (err) {
        console.error("Trello outbound error:", err.message);
      }
    }
  } catch (e) {
    console.error("Trello poll error:", e.message);
  }
}

setInterval(pollTrello, 15000);
