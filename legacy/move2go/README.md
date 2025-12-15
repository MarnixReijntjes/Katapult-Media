# Node.js Twilio Relay Server for OpenAI Realtime Voice API

A WebSocket relay server that connects Twilio phone calls to OpenAI's Realtime Voice API, enabling natural voice conversations with AI over the phone.

## Features

- 📞 **Twilio Media Streams integration** - Route phone calls to OpenAI voice agent
- 🎙️ Real-time voice streaming with G.711 µ-law audio format
- 🔄 Bidirectional audio communication
- 🎯 Simple relay architecture - no audio processing on server
- 🚀 Easy to deploy to any cloud platform
- 🔒 Secure API key management via environment variables
- 📊 Built-in health check endpoint for monitoring
- 📝 Comprehensive logging with ISO timestamps
- ⚡ Connection tracking and server statistics

## Prerequisites

- Node.js 18+ (ES modules support)
- OpenAI API key with Realtime API access
- npm or yarn package manager

## Installation

1. Clone this repository:
```bash
git clone <your-repo-url>
cd nodejs-relay-server-for-inbound-voice-agent
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
# Copy the example env file
cp .env.example .env

# Edit .env and add your OpenAI API key
OPENAI_API_KEY=sk-...
PORT=8080
```

## Usage

### Development Mode (with auto-reload)
```bash
npm run dev
```

### Production Mode
```bash
npm start
```

The server will start on `ws://localhost:8080` (or the port specified in `.env`).

## Twilio Setup

### 1. Configure Your Twilio Phone Number

1. Go to [Twilio Console](https://console.twilio.com/)
2. Navigate to **Phone Numbers** → **Manage** → **Active Numbers**
3. Select your phone number
4. Scroll to **Voice Configuration**
5. Set "A Call Comes In" to **Webhook**
6. Use this TwiML:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://your-deployment-url.com" />
    </Connect>
</Response>
```

**For Render deployment:**
```xml
<Stream url="wss://nodejs-relay-server-for-inbound-voice.onrender.com" />
```

### 2. Test Your Setup

1. Call your Twilio number
2. You should be connected to Tessa (the voice assistant)
3. Have a natural conversation!

### How It Works

```
Caller → Twilio Number → Media Stream → Relay Server → OpenAI Realtime API → Tessa (AI Agent)
```

**Configuration:**
- **Model**: `gpt-4o-realtime-preview-2024-12-17` (latest)
- **Voice**: `alloy` (female voice)
- **Language**: English (automatically detects and responds in caller's language)
- **Audio Format**: G.711 µ-law (Twilio standard)
- **Turn Detection**: Server VAD (Voice Activity Detection)

## API Endpoints

### Health Check Endpoint
**GET** `http://localhost:8080/health`

Returns server status and statistics:

```json
{
  "status": "healthy",
  "uptime": "325s",
  "timestamp": "2025-11-28T10:15:30.123Z",
  "connections": {
    "active": 2,
    "total": 15
  },
  "errors": 0,
  "openai_configured": true
}
```

**Response Fields:**
- `status` - Server health status (always "healthy" if responding)
- `uptime` - Time since server started (in seconds)
- `timestamp` - Current server time (ISO 8601 format)
- `connections.active` - Number of currently connected clients
- `connections.total` - Total connections since server started
- `errors` - Total errors encountered since server started
- `openai_configured` - Whether OpenAI API key is configured

**Use cases:**
- Load balancer health checks
- Monitoring and alerting systems
- Deployment readiness checks
- Debugging connection issues

## Twilio Message Flow

The server handles Twilio Media Stream events:

### Twilio → Server (Input)
- `start` - Stream initialization with StreamSid and CallSid
- `media` - Audio payload (G.711 µ-law base64 encoded)
- `stop` - Stream termination

### Server → Twilio (Output)
- `media` - Audio response from OpenAI (G.711 µ-law base64 encoded)

Audio is automatically converted between Twilio's format and OpenAI's requirements.

## Deployment

### Deploy to Railway
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and deploy
railway login
railway init
railway up
```

### Deploy to Render
1. Create a new Web Service
2. Connect your repository
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Add environment variable: `OPENAI_API_KEY`

### Deploy to Heroku
```bash
# Install Heroku CLI and login
heroku login

# Create app and deploy
heroku create your-app-name
git push heroku main
heroku config:set OPENAI_API_KEY=your_key_here
```

### Deploy to Cloud Run (GCP)
```bash
# Build container
gcloud builds submit --tag gcr.io/PROJECT_ID/voice-relay

# Deploy
gcloud run deploy voice-relay \
  --image gcr.io/PROJECT_ID/voice-relay \
  --platform managed \
  --set-env-vars OPENAI_API_KEY=your_key_here
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | - | Your OpenAI API key |
| `PORT` | No | 8080 | Server port |
| `VOICE` | No | alloy | Voice for assistant (alloy, echo, shimmer) |
| `INSTRUCTIONS` | No | Default greeting | System instructions for the assistant |

## Architecture

```
Client (Browser/App)
       ↕ WebSocket
Relay Server (This)
       ↕ WebSocket
OpenAI Realtime API
```

The relay server:
1. Accepts client WebSocket connections
2. Establishes a connection to OpenAI Realtime API
3. Forwards all messages bidirectionally
4. Manages connection lifecycle and errors

## Customization

### Change Voice Assistant Instructions

Set the `INSTRUCTIONS` environment variable:

```bash
# In .env file
INSTRUCTIONS=You are a customer support agent for Acme Corp. Be professional and helpful.
```

Or in your deployment platform (Render, Railway, etc.):
```
INSTRUCTIONS=You are a Spanish-speaking assistant. Always respond in Spanish.
```

### Change Voice

Set the `VOICE` environment variable:

```bash
# In .env file
VOICE=shimmer
```

Available voices: `alloy` (default), `echo`, `shimmer`

### Adjust Voice Detection Sensitivity

Edit turn detection settings (line ~108):
```javascript
turn_detection: {
  type: 'server_vad',
  threshold: 0.5,        // Lower = more sensitive (0.0 - 1.0)
  prefix_padding_ms: 300, // Audio before speech starts
  silence_duration_ms: 500 // Silence before considering speech done
}
```

### Change Language

The assistant automatically detects and responds in the caller's language, but you can specify it in instructions:

```javascript
instructions: 'You are Tessa. Always respond in Spanish, regardless of the caller\'s language.',
```

## Error Handling

The server includes comprehensive error handling:

- **Client disconnections** → Closes OpenAI connection and updates stats
- **OpenAI errors** → Notifies client with error details and closes connection
- **Missing API key** → Exits with error message on startup
- **Connection failures** → Logs errors with timestamps and client IDs
- **Uncaught exceptions** → Logged and triggers graceful shutdown
- **Unhandled promises** → Logged for debugging
- **Graceful shutdown** → 10-second timeout with connection statistics

All errors are tracked and reported via the `/health` endpoint's error count.

## Monitoring

### Health Endpoint
Use the `/health` endpoint to monitor server status programmatically:

```bash
# Check server health
curl http://localhost:8080/health

# Monitor in a loop
watch -n 5 'curl -s http://localhost:8080/health | jq'

# Use in monitoring tools (Prometheus, Datadog, etc.)
```

### Server Logs
All logs include ISO 8601 timestamps for easy parsing:

```
[2025-11-28T10:15:30.123Z] Server started on port 8080
[2025-11-28T10:15:30.123Z] WebSocket endpoint: ws://localhost:8080
[2025-11-28T10:15:30.123Z] Health check: http://localhost:8080/health
[2025-11-28T10:15:45.456Z] New client connected: 127.0.0.1:54321
[2025-11-28T10:15:45.457Z] Active connections: 1
[2025-11-28T10:15:46.789Z] Connected to OpenAI Realtime API for client: 127.0.0.1:54321
[2025-11-28T10:15:46.790Z] Session configured for client: 127.0.0.1:54321
```

**Log information includes:**
- Server startup and endpoint information
- Client connections/disconnections with unique IDs
- Active connection counts
- OpenAI session lifecycle events
- Error tracking with client context
- Message buffering warnings
- Graceful shutdown statistics

## Security Considerations

⚠️ **Important**: This relay server forwards all messages without validation. For production:

1. Add authentication for client connections
2. Implement rate limiting
3. Add message validation/sanitization
4. Use HTTPS/WSS in production
5. Monitor API usage and costs
6. Add request logging for auditing

## Limitations

- Each client connection creates a new OpenAI session (costs add up)
- No connection pooling or session reuse
- No built-in authentication
- No message buffering or retry logic

## Cost Considerations

**Per Call Costs:**
- Twilio: ~$0.013/min (US inbound)
- OpenAI Realtime API: ~$0.06/min (input) + ~$0.24/min (output)
- **Total**: ~$0.31/min per call

**Tips to reduce costs:**
- Monitor usage via Twilio and OpenAI dashboards
- Consider adding call duration limits in Twilio
- Test thoroughly before production use

## Troubleshooting

### "OPENAI_API_KEY is not set"
Ensure your `.env` file exists and contains a valid API key or set it in your deployment platform's environment variables.

### Call connects but no audio
- Check deployment logs for OpenAI connection errors
- Verify OpenAI API key is correct
- Ensure your OpenAI account has Realtime API access enabled
- Check Twilio debugger: console.twilio.com/monitor/logs/debugger

### Twilio webhook fails
- Verify the Stream URL is correct: `wss://your-domain.com`
- Ensure deployment is running (check health endpoint)
- Check TwiML syntax is valid

### High latency or delays
- Check deployment region vs caller location
- Monitor OpenAI API status
- Consider upgrading deployment resources

### Assistant not understanding caller
- Check Twilio debugger for audio quality issues
- Verify turn detection settings aren't too aggressive
- Adjust `threshold` and `silence_duration_ms` values

### Health check returns errors
If `/health` doesn't respond:
- Ensure server is running
- Check deployment logs
- Verify deployment URL is accessible

## License

MIT

## Contributing

Contributions welcome! Please open an issue or submit a pull request.

## Support

For issues related to:
- **This server**: Open a GitHub issue
- **OpenAI Realtime API**: See [OpenAI documentation](https://platform.openai.com/docs/api-reference/realtime)
