import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import awsLambdaFastify from 'aws-serverless-fastify';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Load environment variables from .env file
dotenv.config();

// Retrieve environment variables
const { OPENAI_API_KEY, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET_NAME } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !S3_BUCKET_NAME) {
    console.error('Missing AWS credentials or bucket name. Please set them in the .env file.');
    process.exit(1);
}

// Initialize S3 Client
const s3Client = new S3Client({
    region: AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY
    }
});

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE = "You are an expert sales. Your task is to generate engaging and persuasive product descriptions for selling laptops, desktops, and accessories.";
const VOICE = 'shimmer';
const PORT = process.env.PORT || 8080;
const BUCKET_NAME = S3_BUCKET_NAME;
const RECORDINGS_FOLDER = 'recordings/';
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
    const header = Buffer.alloc(44);
    const sampleRate = 8000;
    const byteRate = sampleRate * 1 * 1;
    const blockAlign = 1 * 1;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(7, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(8, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataLength, 40);

    return header;
}

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});
let callerNumber
// Route for Twilio to handle incoming calls
fastify.all('/incoming-call', async (request, reply) => {
    console.log('Incoming call request body:', request.body);
     callerNumber = request.body?.From || 'Unknown Caller';
    const calledNumber = request.body?.To || 'Unknown Destination';
    const callSid = request.body?.CallSid || 'Unknown CallSid';

    console.log(`Call from: ${callerNumber} to: ${calledNumber}, CallSid: ${callSid}`);
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
        let callerAudioBuffer = [];
        let aiAudioBuffer = [];
        const sessionId = Date.now();
        let isAudioSaved = false;

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

        const saveAudioFiles = async () => {
            if (isAudioSaved) {
                console.log('Audio already saved for this session, skipping.');
                return;
            }

            const sanitizedCallerNumber = callerNumber;
            // Updated file keys to include caller number as a folder
            const callerFileKey = `${RECORDINGS_FOLDER}${sanitizedCallerNumber}/${sessionId}_caller.wav`;
            const aiFileKey = `${RECORDINGS_FOLDER}${sanitizedCallerNumber}/${sessionId}_ai.wav`;

            try {
                if (callerAudioBuffer.length > 0) {
                    const callerAudioData = Buffer.concat(callerAudioBuffer);
                    const callerWavHeader = createWavHeader(callerAudioData.length);
                    const callerWavData = Buffer.concat([callerWavHeader, callerAudioData]);

                    const callerParams = {
                        Bucket: BUCKET_NAME,
                        Key: callerFileKey,
                        Body: callerWavData,
                        ContentType: 'audio/wav'
                    };

                    await s3Client.send(new PutObjectCommand(callerParams));
                    console.log(`Uploaded caller's audio to s3://${BUCKET_NAME}/${callerFileKey}`);
                } else {
                    console.log('No caller audio to save.');
                }

                if (aiAudioBuffer.length > 0) {
                    const aiAudioData = Buffer.concat(aiAudioBuffer);
                    const aiWavHeader = createWavHeader(aiAudioData.length);
                    const aiWavData = Buffer.concat([aiWavHeader, aiAudioData]);

                    const aiParams = {
                        Bucket: BUCKET_NAME,
                        Key: aiFileKey,
                        Body: aiWavData,
                        ContentType: 'audio/wav'
                    };

                    await s3Client.send(new PutObjectCommand(aiParams));
                    console.log(`Uploaded AI's audio to s3://${BUCKET_NAME}/${aiFileKey}`);
                } else {
                    console.log('No AI audio to save.');
                }

                isAudioSaved = true;
                callerAudioBuffer = [];
                aiAudioBuffer = [];
            } catch (error) {
                console.error('Error uploading audio files to S3:', error);
            }
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
                            callerAudioBuffer.push(Buffer.from(data.media.payload, 'base64'));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', streamSid);
                        callerAudioBuffer = [];
                        aiAudioBuffer = [];
                        responseStartTimestampTwilio = null;
                        latestMediaTimestamp = 0;
                        markQueue = [];
                        lastAssistantItem = null;
                        isAudioSaved = false;
                        break;
                    case 'stop':
                        console.log('Stream stopped', streamSid);
                        saveAudioFiles(callerNumber);
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
            console.log('Client disconnected.');
        });

        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
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