const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const twilio = require('twilio');
const dotenv = require('dotenv');
const fetch = require('node-fetch').default;

dotenv.config();

const app = express();
const server = http.createServer(app);

// Configuration
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const NGROK_URL = process.env.NGROK_URL || 'http://localhost:5050';
const PORT = process.env.PORT || 5050;

const DEFAULT_INITIAL_SCRIPT = "Hello! Welcome to the AI assistant. How can I help you today?";
const DEFAULT_PROMPT = "You are a friendly AI assistant designed to answer questions and assist users over the phone. you name is aimee";

if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    throw new Error('Missing required environment variables');
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ message: 'Twilio Media Stream Server with ElevenLabs is running!' });
});

// Initiate outbound call with just a phone number
app.post('/make-call', async (req, res) => {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'Phone number ("to") is required' });

    try {
        const call = await twilioClient.calls.create({
            url: `${NGROK_URL}/connect`,
            to,
            from: TWILIO_PHONE_NUMBER
        });
        console.log(`Call initiated: ${call.sid}`);
        res.json({ call_sid: call.sid, message: 'Call initiated successfully' });
    } catch (error) {
        console.error(`Call initiation failed: ${error.message}`);
        res.status(500).json({ error: `Failed to initiate call: ${error.message}` });
    }
});

// TwiML for connecting the call
app.all('/connect', (req, res) => {
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    response.say('Connecting to AI assistant...');
    const connect = response.connect();
    connect.stream({ url: `wss://${req.hostname}/media-stream` });
    res.type('text/xml');
    res.send(response.toString());
});

// Fetch signed URL from ElevenLabs
async function getSignedUrl() {
    try {
        const response = await fetch(
            `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
            {
                method: 'GET',
                headers: { 'xi-api-key': ELEVENLABS_API_KEY }
            }
        );
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        const data = await response.json();
        console.log('Signed URL obtained');
        return data.signed_url;
    } catch (error) {
        console.error('Error fetching signed URL:', error);
        throw error;
    }
}

// WebSocket server for media streaming
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    console.log('[Twilio] Client connected');
    let streamSid;
    let elevenLabsWs;

    const setupElevenLabs = async () => {
        try {
            const signedUrl = await getSignedUrl();
            elevenLabsWs = new WebSocket(signedUrl);

            elevenLabsWs.on('open', () => {
                console.log('[ElevenLabs] Connected');
                const initialConfig = {
                    type: 'conversation_initiation_client_data',
                    conversation_config_override: {
                        agent: {
                            prompt: { prompt: DEFAULT_PROMPT },
                            first_message: DEFAULT_INITIAL_SCRIPT
                        }
                    }
                };
                console.log('[ElevenLabs] Sending initial config');
                elevenLabsWs.send(JSON.stringify(initialConfig));
            });

            elevenLabsWs.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    console.log('[ElevenLabs] Received message type:', message.type);

                    if (message.type === 'audio' && streamSid) {
                        const audioPayload = message.audio?.chunk || message.audio_event?.audio_base_64;
                        if (audioPayload) {
                            console.log('[ElevenLabs] Sending audio to Twilio, length:', audioPayload.length);
                            ws.send(JSON.stringify({
                                event: 'media',
                                streamSid,
                                media: { payload: audioPayload }
                            }));
                        }
                    } else if (message.type === 'ping' && message.ping_event?.event_id) {
                        elevenLabsWs.send(JSON.stringify({
                            type: 'pong',
                            event_id: message.ping_event.event_id
                        }));
                    }
                } catch (error) {
                    console.error('[ElevenLabs] Error parsing message:', error);
                }
            });

            elevenLabsWs.on('error', (error) => console.error('[ElevenLabs] WebSocket error:', error));
            elevenLabsWs.on('close', (code, reason) => console.log('[ElevenLabs] Disconnected:', code, reason));
        } catch (error) {
            console.error('[ElevenLabs] Setup failed:', error);
        }
    };

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('[Twilio] Event:', data.event);

            if (data.event === 'start') {
                streamSid = data.start.streamSid;
                console.log('[Twilio] Stream started, StreamSid:', streamSid);
                setupElevenLabs();
            } else if (data.event === 'media' && elevenLabsWs?.readyState === WebSocket.OPEN) {
                console.log('[Twilio] Sending audio to ElevenLabs, length:', data.media.payload.length);
                elevenLabsWs.send(JSON.stringify({
                    user_audio_chunk: data.media.payload
                }));
            } else if (data.event === 'stop') {
                console.log('[Twilio] Stream stopped, StreamSid:', streamSid);
                if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
            }
        } catch (error) {
            console.error('[Twilio] Error processing message:', error);
        }
    });

    ws.on('close', () => {
        console.log('[Twilio] Client disconnected');
        if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
    });

    ws.on('error', (error) => console.error('[Twilio] WebSocket error:', error));
});

// Start the server
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Ensure ngrok is running: ./ngrok http ${PORT}`);
    console.log(`Set NGROK_URL in .env to your ngrok URL`);
});