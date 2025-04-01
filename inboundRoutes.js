import WebSocket from "ws";
import dotenv from "dotenv";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
dotenv.config();
const { 
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    AWS_REGION,
    S3_BUCKET_NAME 
} = process.env;

// if (!ELEVENLABS_AGENT_ID) {
//     console.error("Missing ELEVENLABS_AGENT_ID in environment variables");
//     process.exit(1);
// }

if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !S3_BUCKET_NAME) {
    console.error("Missing AWS credentials or bucket name");
    process.exit(1);
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

let calledNumber;
let callerNumber;
let transcript_call = [];
let introScript;
let promptData;
let voiceID;
export default async function inboundRoutes(fastify, options) {
    const BUCKET_NAME = S3_BUCKET_NAME;
    const RECORDINGS_FOLDER = "recordings";
    const TRANSCRIPTION_FOLDER = "transcription";
    const INBOUND = "INBOUND";

  
    fastify.all("/twilio/inbound_call", async (request, reply) => {
        callerNumber = request.body?.From || "Unknown Caller";
        calledNumber = request.body?.To || "Unknown Destination";
        const callSid = request.body?.CallSid || "Unknown CallSid";
        console.log(`Call from: ${callerNumber} to: ${calledNumber}, CallSid: ${callSid}`);
        const response = await axios.get(
            `https://j7grsrn6sc.execute-api.ap-south-1.amazonaws.com/dev/api/agent/by-phone/${calledNumber.replaceAll(
              "+",
              ""
            )}`
          );
          console.log("response Data", response.data.agents);
          introScript = response.data.agents.welcomeMessage;
          promptData = response.data.agents.pdfFile;
          voiceID = response.data.agents.agentId
        const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
            <Response>
            <Connect>
                <Stream url="wss://${request.headers.host}/media-stream" />
            </Connect>
            </Response>`;
        reply.type("text/xml").send(twimlResponse);
    });

    fastify.get("/media-stream", { websocket: true }, (connection, req) => {
        console.info("[Server] Twilio connected to media stream.");

        let streamSid = null;
        let callerAudioBuffer = [];
        let aiAudioBuffer = [];
        const sessionId = Date.now();
        let isAudioSaved = false;

        const elevenLabsWs = new WebSocket(
            `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${voiceID}`
        );

        const saveAudioFiles = async () => {
            if (isAudioSaved) {
                console.log("Audio already saved for this session");
                return;
            }

            const sanitizedCallerNumber = callerNumber;
            const callerFileKey = `${RECORDINGS_FOLDER}/${INBOUND}/${calledNumber}/${sanitizedCallerNumber}/${sessionId}_caller.wav`;
            const aiFileKey = `${RECORDINGS_FOLDER}/${INBOUND}/${calledNumber}/${sanitizedCallerNumber}/${sessionId}_ai.wav`;

            try {
                if (callerAudioBuffer.length > 0) {
                    const callerAudioData = Buffer.concat(callerAudioBuffer);
                    const callerWavHeader = createWavHeader(callerAudioData.length);
                    const callerWavData = Buffer.concat([callerWavHeader, callerAudioData]);

                    const callerParams = {
                        Bucket: BUCKET_NAME,
                        Key: callerFileKey,
                        Body: callerWavData,
                        ContentType: "audio/wav",
                    };

                    await s3Client.send(new PutObjectCommand(callerParams));
                    console.log(`Uploaded caller's audio to s3://${BUCKET_NAME}/${callerFileKey}`);
                }

                if (aiAudioBuffer.length > 0) {
                    const aiAudioData = Buffer.concat(aiAudioBuffer);
                    const aiWavHeader = createWavHeader(aiAudioData.length);
                    const aiWavData = Buffer.concat([aiWavHeader, aiAudioData]);

                    const aiParams = {
                        Bucket: BUCKET_NAME,
                        Key: aiFileKey,
                        Body: aiWavData,
                        ContentType: "audio/wav",
                    };

                    await s3Client.send(new PutObjectCommand(aiParams));
                    console.log(`Uploaded AI's audio to s3://${BUCKET_NAME}/${aiFileKey}`);
                }

                isAudioSaved = true;
                callerAudioBuffer = [];
                aiAudioBuffer = [];
            } catch (error) {
                console.error("Error uploading audio files to S3:", error);
            }
        };

        const saveTranscription = async () => {
            if (transcript_call.length === 0) {
                console.log("No transcription data to save.");
                return;
            }

            const sanitizedCallerNumber = callerNumber;
            const transcriptFileKey = `${TRANSCRIPTION_FOLDER}/${INBOUND}/${calledNumber}/${sanitizedCallerNumber}/${sessionId}_transcript.txt`;

            try {
                const transcriptText = transcript_call.join("\n");
                const transcriptParams = {
                    Bucket: BUCKET_NAME,
                    Key: transcriptFileKey,
                    Body: transcriptText,
                    ContentType: "text/plain",
                };

                await s3Client.send(new PutObjectCommand(transcriptParams));
                console.log(`Uploaded transcription to s3://${BUCKET_NAME}/${transcriptFileKey}`);
                transcript_call = [];
            } catch (error) {
                console.error("Error uploading transcription to S3:", error);
            }
        };

        elevenLabsWs.on("open", () => {
            console.log("Connected to Eleven Labs Conversational AI");
            const initialConfig = {
                type: "conversation_initiation_client_data",
                conversation_config_override: {
                    agent: {
                        prompt: { prompt: promptData },
                        first_message: introScript,
                    },
                },
            };
            elevenLabsWs.send(JSON.stringify(initialConfig));
        });

        elevenLabsWs.on("message", (data) => {
            try {
                const message = JSON.parse(data);
                handleElevenLabsMessage(message, connection);
            } catch (error) {
                console.error("[II] Error parsing message:", error);
            }
        });

        const handleElevenLabsMessage = (message, connection) => {
            switch (message.type) {
                case "conversation_initiation_metadata":
                    console.info("[II] Received conversation initiation metadata.");
                    break;
                case "audio":
                    if (message.audio_event?.audio_base_64 && !isAudioSaved) {
                        const audioData = {
                            event: "media",
                            streamSid,
                            media: {
                                payload: message.audio_event.audio_base_64,
                            },
                        };
                        connection.send(JSON.stringify(audioData));
                        aiAudioBuffer.push(Buffer.from(message.audio_event.audio_base_64, "base64"));
                    }
                    break;
                case "interruption":
                    connection.send(JSON.stringify({ event: "clear", streamSid }));
                    break;
                case "ping":
                    if (message.ping_event?.event_id) {
                        const pongResponse = {
                            type: "pong",
                            event_id: message.ping_event.event_id,
                        };
                        elevenLabsWs.send(JSON.stringify(pongResponse));
                    }
                    break;
                case 'agent_response':
                    console.log(`[Twilio] Agent response: ${message.agent_response_event?.agent_response}`);
                    transcript_call.push(`Agent response: ${message.agent_response_event?.agent_response}`);
                    break;
                case 'user_transcript':
                    console.log(`[Twilio] User transcript: ${message.user_transcription_event?.user_transcript}`);
                    transcript_call.push(`User transcript: ${message.user_transcription_event?.user_transcript}`);
                    break;
            }
        };

        connection.on("message", async (message) => {
            try {
                const data = JSON.parse(message);
                switch (data.event) {
                    case "start":
                        streamSid = data.start.streamSid;
                        console.log(`[Twilio] Stream started with ID: ${streamSid}`);
                        callerAudioBuffer = [];
                        aiAudioBuffer = [];
                        isAudioSaved = false;
                        break;
                    case "media":
                        if (elevenLabsWs.readyState === WebSocket.OPEN && !isAudioSaved) {
                            const audioMessage = {
                                user_audio_chunk: Buffer.from(data.media.payload, "base64").toString("base64"),
                            };
                            elevenLabsWs.send(JSON.stringify(audioMessage));
                            callerAudioBuffer.push(Buffer.from(data.media.payload, "base64"));
                        }
                        break;
                    case "stop":
                        console.log(`[Twilio] Stream stopped`);
                        await saveAudioFiles();
                        console.log("ARRAY", transcript_call);
                        elevenLabsWs.close();
                        break;
                }
            } catch (error) {
                console.error("[Twilio] Error processing message:", error);
            }
        });

        connection.on("close", async () => {
            await saveAudioFiles();
            await saveTranscription();
            elevenLabsWs.close();
            console.log("[Twilio] Client disconnected");
        });

        connection.on("error", async (error) => {
            console.error("[Twilio] WebSocket error:", error);
            await saveAudioFiles();
            elevenLabsWs.close();
        });

        elevenLabsWs.on("error", (error) => {
            console.error("[II] WebSocket error:", error);
        });

        elevenLabsWs.on("close", () => {
            console.log("[II] Disconnected.");
        });
    });
}