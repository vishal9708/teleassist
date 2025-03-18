import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import awsLambdaFastify from 'aws-serverless-fastify';
import fs from 'fs';
import path from 'path';

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE = "You are an expert sales. Your task is to generate engaging and persuasive product descriptions for selling laptops, desktops, and accessories.";
const VOICE = 'shimmer';
const PORT = process.env.PORT || 5050;
const AUDIO_DIR = path.join(process.cwd(), 'audio_recordings');

// Ensure audio directory exists
if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR);
}

const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created'
];

const SHOW_TIMING_MATH = false;

// Function to create a WAV header for μ-law audio
function createWavHeader(dataLength) {
    const header = Buffer.alloc(44); // Standard WAV header is 44 bytes
    const sampleRate = 8000; // 8 kHz for G.711 μ-law
    const byteRate = sampleRate * 1 * 1; // sampleRate * channels * bytesPerSample
    const blockAlign = 1 * 1; // channels * bytesPerSample

    header.write('RIFF', 0); // Chunk ID
    header.writeUInt32LE(36 + dataLength, 4); // Chunk Size (total file size - 8)
    header.write('WAVE', 8); // Format
    header.write('fmt ', 12); // Subchunk1 ID
    header.writeUInt32LE(16, 16); // Subchunk1 Size (16 for PCM, also used for μ-law)
    header.writeUInt16LE(7, 20); // Audio Format (7 = μ-law)
    header.writeUInt16LE(1, 22); // Number of Channels (1 = mono)
    header.writeUInt32LE(sampleRate, 24); // Sample Rate
    header.writeUInt32LE(byteRate, 28); // Byte Rate
    header.writeUInt16LE(blockAlign, 32); // Block Align
    header.writeUInt16LE(8, 34); // Bits Per Sample (8-bit for μ-law)
    header.write('data', 36); // Subchunk2 ID
    header.writeUInt32LE(dataLength, 40); // Subchunk2 Size (data length)

    return header;
}

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming calls
fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        // Connection-specific state
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;

        // Audio buffers and session state
        let callerAudioBuffer = [];
        let aiAudioBuffer = [];
        const sessionId = Date.now(); // Unique ID for this session
        let isAudioSaved = false; // Flag to ensure single save

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));
            sendInitialConversationItem();
        };

        const sendInitialConversationItem = () => {
            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: 'Greet the user with "Hey there! My name is Aimee. I am here to assist you with finding the perfect laptop, desktop, or accessories. Let me know your requirements, such as budget, usage type (gaming, office, editing, or general use), and any specific features you need. Based on that, I’ll suggest the best options for you. Feel free to ask me anything!"'
                        }
                    ]
                }
            };

            if (SHOW_TIMING_MATH) console.log('Sending initial conversation item:', JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                if (SHOW_TIMING_MATH) console.log(`Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    if (SHOW_TIMING_MATH) console.log('Sending truncation event:', JSON.stringify(truncateEvent));
                    openAiWs.send(JSON.stringify(truncateEvent));
                }

                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));

                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        const sendMark = (connection, streamSid) => {
            if (streamSid) {
                const markEvent = {
                    event: 'mark',
                    streamSid: streamSid,
                    mark: { name: 'responsePart' }
                };
                connection.send(JSON.stringify(markEvent));
                markQueue.push('responsePart');
            }
        };

        // Save audio buffers as WAV files, called only once
        const saveAudioFiles = () => {
            if (isAudioSaved) {
                console.log('Audio already saved for this session, skipping.');
                return;
            }

            const callerFilePath = path.join(AUDIO_DIR, `${sessionId}_caller.wav`);
            const aiFilePath = path.join(AUDIO_DIR, `${sessionId}_ai.wav`);

            // Save caller's audio as WAV
            if (callerAudioBuffer.length > 0) {
                const callerAudioData = Buffer.concat(callerAudioBuffer);
                const callerWavHeader = createWavHeader(callerAudioData.length);
                const callerWavData = Buffer.concat([callerWavHeader, callerAudioData]);
                fs.writeFileSync(callerFilePath, callerWavData);
                console.log(`Saved caller's audio to ${callerFilePath}`);
            } else {
                console.log('No caller audio to save.');
            }

            // Save AI's audio as WAV
            if (aiAudioBuffer.length > 0) {
                const aiAudioData = Buffer.concat(aiAudioBuffer);
                const aiWavHeader = createWavHeader(aiAudioData.length);
                const aiWavData = Buffer.concat([aiWavHeader, aiAudioData]);
                fs.writeFileSync(aiFilePath, aiWavData);
                console.log(`Saved AI's audio to ${aiFilePath}`);
            } else {
                console.log('No AI audio to save.');
            }

            // Mark as saved and clear buffers
            isAudioSaved = true;
            callerAudioBuffer = [];
            aiAudioBuffer = [];
        };

        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(initializeSession, 100);
        });

        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                if (response.type === 'response.audio.delta' && response.delta && !isAudioSaved) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: response.delta }
                    };
                    connection.send(JSON.stringify(audioDelta));

                    // Store AI audio
                    aiAudioBuffer.push(Buffer.from(response.delta, 'base64'));

                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                        if (SHOW_TIMING_MATH) console.log(`Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`);
                    }

                    if (response.item_id) {
                        lastAssistantItem = response.item_id;
                    }
                    
                    sendMark(connection, streamSid);
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (SHOW_TIMING_MATH) console.log(`Received media message with timestamp: ${latestMediaTimestamp}ms`);
                        if (openAiWs.readyState === WebSocket.OPEN && !isAudioSaved) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                            // Store caller's audio
                            callerAudioBuffer.push(Buffer.from(data.media.payload, 'base64'));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', streamSid);
                        // Reset all state on new stream start
                        callerAudioBuffer = [];
                        aiAudioBuffer = [];
                        responseStartTimestampTwilio = null;
                        latestMediaTimestamp = 0;
                        markQueue = [];
                        lastAssistantItem = null;
                        isAudioSaved = false; // Allow saving for this new stream
                        break;
                    case 'stop':
                        console.log('Stream stopped', streamSid);
                        saveAudioFiles(); // Save audio only when stream stops
                        break;
                    case 'mark':
                        if (markQueue.length > 0) {
                            markQueue.shift();
                        }
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            // Do not call saveAudioFiles here; rely on 'stop' event
            console.log('Client disconnected.');
        });

        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
            // Do not call saveAudioFiles here; rely on 'stop' event
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});