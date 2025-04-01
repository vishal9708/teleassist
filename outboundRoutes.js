import dotenv from 'dotenv';
import Twilio from 'twilio';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

dotenv.config();

const {
    ELEVENLABS_API_KEY,
    ELEVENLABS_AGENT_ID,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER,
    S3_BUCKET_NAME,
    AWS_REGION,
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY
} = process.env;

if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !TWILIO_ACCOUNT_SID || 
    !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !S3_BUCKET_NAME) {
    console.error('Missing required environment variables');
    throw new Error('Missing required environment variables');
}

const s3Client = new S3Client({
    region: AWS_REGION || "us-east-1",
    credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
});

function createWavHeader(dataLength) {
    const header = Buffer.alloc(44);
    const sampleRate = 8000;
    const byteRate = sampleRate * 1 * 1;
    const blockAlign = 1 * 1;

    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(7, 20); // μ-law format
    header.writeUInt16LE(1, 22); // Mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(8, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataLength, 40);
    return header;
}

let callerNumber ;
let calledNumber ;
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

async function getSignedUrl() {
    try {
        const response = await fetch(
            `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
            {
                method: 'GET',
                headers: {
                    'xi-api-key': ELEVENLABS_API_KEY,
                },
            }
        );
        if (!response.ok) throw new Error(`Failed to get signed URL: ${response.statusText}`);
        const data = await response.json();
        return data.signed_url;
    } catch (error) {
        console.error('Error getting signed URL:', error);
        throw error;
    }
}

export default async function outboundRoutes(fastify, options) {
    const RECORDINGS_FOLDER = "recordings";
    const TRANSCRIPTION_FOLDER = "transcription";
    const OUTBOUND = "OUTBOUND";

   

    fastify.post('/outbound-call', async (request, reply) => {
        const { number, prompt, first_message } = request.body;
        if (!number) {
            return reply.code(400).send({ error: 'Phone number is required' });
        }

        try {
            const call = await twilioClient.calls.create({
                from: TWILIO_PHONE_NUMBER,
                to: number,
                url: `https://${request.headers.host}/outbound-call-twiml?prompt=${encodeURIComponent(prompt)}&first_message=${encodeURIComponent(first_message)}`,
            });

            reply.send({
                success: true,
                message: 'Call initiated',
                callSid: call.sid,
            });
        } catch (error) {
            console.error('Error initiating outbound call:', error);
            reply.code(500).send({ error: 'Failed to initiate call' });
        }
    });

    fastify.all('/outbound-call-twiml', async (request, reply) => {
        const prompt = request.query.prompt || '';
        const first_message = request.query.first_message || '';
        callerNumber = request.body?.From || "Unknown Caller";
        calledNumber = request.body?.To || "Unknown Destination";
        console.log("REQUEST", prompt, calledNumber, callerNumber);
        const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
            <Response>
                <Connect>
                <Stream url="wss://${request.headers.host}/outbound-media-stream">
                    <Parameter name="prompt" value="${prompt}" />
                    <Parameter name="first_message" value="${first_message}" />
                </Stream>
                </Connect>
            </Response>`;
        reply.type('text/xml').send(twimlResponse);
    });

    fastify.get('/outbound-media-stream', { websocket: true }, (ws, req) => {
        console.info('[Server] Twilio connected to outbound media stream');

        const sessionId = uuidv4();
        let streamSid = null;
        let callSid = null;
        let elevenLabsWs = null;
        let customParameters = null;

        let transcriptCall = [];
        let callerAudioBuffer = [];
        let aiAudioBuffer = [];
        let isAudioSaved = false;

        const saveAudioFiles = async () => {
            if (isAudioSaved || (!callerAudioBuffer.length && !aiAudioBuffer.length)) {
                console.log("No audio to save or already saved for session:", sessionId);
                return;
            }

            const sanitizedCallerNumber = callerNumber;
            const callerFileKey = `${RECORDINGS_FOLDER}/${OUTBOUND}/${sanitizedCallerNumber}/${calledNumber}/${calledNumber}_${sessionId}_caller.wav`;
            const aiFileKey = `${RECORDINGS_FOLDER}/${OUTBOUND}/${sanitizedCallerNumber}/${calledNumber}/${calledNumber}_${sessionId}_ai.wav`;

            try {
                if (callerAudioBuffer.length > 0) {
                    const callerAudioData = Buffer.concat(callerAudioBuffer);
                    const callerWavHeader = createWavHeader(callerAudioData.length);
                    const callerWavData = Buffer.concat([callerWavHeader, callerAudioData]);

                    const callerParams = {
                        Bucket: S3_BUCKET_NAME,
                        Key: callerFileKey,
                        Body: callerWavData,
                        ContentType: "audio/wav",
                    };

                    await s3Client.send(new PutObjectCommand(callerParams));
                    console.log(`Uploaded caller's audio to s3://${S3_BUCKET_NAME}/${callerFileKey}`);
                }

                if (aiAudioBuffer.length > 0) {
                    const aiAudioData = Buffer.concat(aiAudioBuffer);
                    const aiWavHeader = createWavHeader(aiAudioData.length);
                    const aiWavData = Buffer.concat([aiWavHeader, aiAudioData]);

                    const aiParams = {
                        Bucket: S3_BUCKET_NAME,
                        Key: aiFileKey,
                        Body: aiWavData,
                        ContentType: "audio/wav",
                    };

                    await s3Client.send(new PutObjectCommand(aiParams));
                    console.log(`Uploaded AI's audio to s3://${S3_BUCKET_NAME}/${aiFileKey}`);
                }

                isAudioSaved = true;
                callerAudioBuffer = [];
                aiAudioBuffer = [];
            } catch (error) {
                console.error("Error uploading audio files to S3 for session", sessionId, error);
            }
        };

        const saveTranscription = async () => {
            if (!transcriptCall.length) {
                console.log("No transcription data to save for session:", sessionId);
                return;
            }

            const sanitizedCallerNumber = callerNumber;
            const transcriptFileKey = `${TRANSCRIPTION_FOLDER}/${OUTBOUND}/${sanitizedCallerNumber}/${calledNumber}/${calledNumber}_${sessionId}_transcript.txt`;

            try {
                const transcriptText = transcriptCall.join("\n");
                const transcriptParams = {
                    Bucket: S3_BUCKET_NAME,
                    Key: transcriptFileKey,
                    Body: transcriptText,
                    ContentType: "text/plain",
                };

                await s3Client.send(new PutObjectCommand(transcriptParams));
                console.log(`Uploaded transcription to s3://${S3_BUCKET_NAME}/${transcriptFileKey}`);
                transcriptCall = [];
            } catch (error) {
                console.error("Error uploading transcription to S3 for session", sessionId, error);
            }
        };

        const setupElevenLabs = async () => {
            try {
                const signedUrl = await getSignedUrl();
                elevenLabsWs = new WebSocket(signedUrl);

                elevenLabsWs.on('open', () => {
                    console.log('[ElevenLabs] Connected to Conversational AI for session:', sessionId);

                    const initialConfig = {
                        type: 'conversation_initiation_client_data',
                        dynamic_variables: { user_name: 'Angelo', user_id: 1234 },
                        conversation_config_override: {
                            agent: {
                                prompt: { prompt: customParameters?.prompt || 'you are gary from the phone store' },
                                first_message: customParameters?.first_message || 'hey there! how can I help you today?',
                            },
                        },
                    };

                    elevenLabsWs.send(JSON.stringify(initialConfig));
                });

                elevenLabsWs.on('message', (data) => {
                    try {
                        const message = JSON.parse(data);
                        switch (message.type) {
                            case 'conversation_initiation_metadata':
                                console.log('[ElevenLabs] Received initiation metadata for session:', sessionId);
                                break;

                            case 'audio':
                                if (streamSid) {
                                    const audioPayload = message.audio?.chunk || message.audio_event?.audio_base_64;
                                    if (audioPayload) {
                                        aiAudioBuffer.push(Buffer.from(audioPayload, 'base64'));
                                        ws.send(JSON.stringify({
                                            event: 'media',
                                            streamSid,
                                            media: { payload: audioPayload },
                                        }));
                                    }
                                }
                                break;

                            case 'interruption':
                                if (streamSid) ws.send(JSON.stringify({ event: 'clear', streamSid }));
                                break;

                            case 'ping':
                                if (message.ping_event?.event_id) {
                                    elevenLabsWs.send(JSON.stringify({ type: 'pong', event_id: message.ping_event.event_id }));
                                }
                                break;

                            case 'agent_response':
                                transcriptCall.push(`Agent: ${message.agent_response_event?.agent_response}`);
                                break;

                            case 'user_transcript':
                                transcriptCall.push(`User: ${message.user_transcription_event?.user_transcript}`);
                                break;
                        }
                    } catch (error) {
                        console.error('[ElevenLabs] Error processing message for session', sessionId, error);
                    }
                });

                elevenLabsWs.on('error', (error) => console.error('[ElevenLabs] WebSocket error for session', sessionId, error));
                elevenLabsWs.on('close', () => console.log('[ElevenLabs] Disconnected for session:', sessionId));
            } catch (error) {
                console.error('[ElevenLabs] Setup error for session', sessionId, error);
            }
        };

        ws.on('message', (message) => {
            try {
                const msg = JSON.parse(message);
                switch (msg.event) {
                    case 'start':
                        streamSid = msg.start.streamSid;
                        callSid = msg.start.callSid;
                        customParameters = msg.start.customParameters;
                        console.log(`[Twilio] Stream started - Session: ${sessionId}, StreamSid: ${streamSid}`);
                        setupElevenLabs();
                        break;

                    case 'media':
                        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                            callerAudioBuffer.push(Buffer.from(msg.media.payload, 'base64'));
                            elevenLabsWs.send(JSON.stringify({
                                user_audio_chunk: msg.media.payload,
                            }));
                        }
                        break;

                    case 'stop':
                        console.log(`[Twilio] Stream ${streamSid} ended for session: ${sessionId}`);
                        Promise.all([saveAudioFiles(), saveTranscription()])
                            .then(() => elevenLabsWs?.close());
                        break;
                }
            } catch (error) {
                console.error('[Twilio] Error processing message for session', sessionId, error);
            }
        });

        ws.on('close', async () => {
            console.log('[Twilio] Client disconnected for session:', sessionId);
            await Promise.all([saveAudioFiles(), saveTranscription()]);
            if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
        });

        ws.on('error', console.error);
    });
}