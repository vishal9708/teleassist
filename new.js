import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import awsLambdaFastify from "aws-serverless-fastify";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import axios from "axios";

// Load environment variables from .env file
dotenv.config();

// Retrieve environment variables
const {
  OPENAI_API_KEY,
  ELEVENLABS_API_KEY,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_REGION,
  S3_BUCKET_NAME,
  ELEVENLABS_VOICE_ID
} = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}

if (!ELEVENLABS_API_KEY) {
  console.error("Missing ElevenLabs API key. Please set it in the .env file.");
  process.exit(1);
}

if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !S3_BUCKET_NAME) {
  console.error("Missing AWS credentials or bucket name. Please set them in the .env file.");
  process.exit(1);
}

// Initialize S3 Client
const s3Client = new S3Client({
  region: AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const PORT = process.env.PORT || 8080;
const BUCKET_NAME = S3_BUCKET_NAME;
const RECORDINGS_FOLDER = "recordings";
let VOICE; // ElevenLabs voice ID will be set dynamically
let introScript;
let promptData;

// Function to create a WAV header for μ-law audio
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
  header.writeUInt16LE(8, 34); // 8-bit
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);

  return header;
}

// ElevenLabs TTS Function
async function textToSpeech(text) {
  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      text,
      model_id: "eleven_monolingual_v1",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.5,
      },
    },
    {
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      responseType: "arraybuffer", // Get raw audio data
    }
  );
  return Buffer.from(response.data);
}

// ElevenLabs STT Function (assuming audio is in WAV format)
async function speechToText(audioBuffer) {
  const response = await axios.post(
    "https://api.elevenlabs.io/v1/speech-to-text",
    audioBuffer,
    {
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "audio/wav",
      },
    }
  );
  return response.data.text;
}

// OpenAI Completion Function
async function getOpenAIResponse(prompt) {
  const response = await axios.post(
    "https://api.openai.com/v1/completions",
    {
      model: "text-davinci-003", // Use a suitable model
      prompt: `You are an expert sales. Your task is to generate engaging and persuasive product descriptions for selling laptops, desktops, and accessories.`,
      max_tokens: 150,
      temperature: 0.8,
    },
    {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );
  return response.data.choices[0].text.trim();
}

// Root Route
fastify.get("/", async (request, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" });
});

let callerNumber;
let calledNumber;

// Route for Twilio to handle incoming calls
fastify.all("/incoming-call", async (request, reply) => {
  try {
    console.log("Incoming call request body:", request.body);
    callerNumber = request.body?.From || "Unknown Caller";
    calledNumber = request.body?.To || "Unknown Destination";
    const callSid = request.body?.CallSid || "Unknown CallSid";
    // const response = await axios.get(
    //   `https://j7grsrn6sc.execute-api.ap-south-1.amazonaws.com/dev/api/agent/by-phone/${calledNumber.replaceAll("+", "")}`
    // );
    // console.log("response Data", response.data.agents);
    introScript = "Hey there! My name is Aimee. I am here to assist you with finding the perfect laptop, desktop, or accessories. Let me know your requirements, such as budget, usage type (gaming, office, editing, or general use), and any specific features you need. Based on that, I’ll suggest the best options for you. Feel free to ask me anything!";
    // promptData = response.data.agents.pdfFile;
    // VOICE = response.data.agents.voice; // Assuming this is an ElevenLabs voice ID

    console.log(`Call from: ${callerNumber} to: ${calledNumber}, CallSid: ${callSid}`);
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

    reply.type("text/xml").send(twimlResponse);
  } catch (error) {
    console.error(error);
  }
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, async (connection, req) => {
    console.log("Client connected");

    let streamSid = null;
    let callerAudioBuffer = [];
    let aiAudioBuffer = [];
    const sessionId = Date.now();
    let isAudioSaved = false;

    // Send initial greeting
    const initialAudio = await textToSpeech(introScript);
    connection.send(JSON.stringify({
      event: "media",
      streamSid: streamSid,
      media: { payload: initialAudio.toString("base64") },
    }));
    aiAudioBuffer.push(initialAudio);

    const saveAudioFiles = async () => {
      if (isAudioSaved) {
        console.log("Audio already saved for this session, skipping.");
        return;
      }

      const sanitizedCallerNumber = callerNumber.replace(/[^0-9]/g, "");
      const callerFileKey = `${RECORDINGS_FOLDER}/${calledNumber}/${sanitizedCallerNumber}/${sessionId}_caller.wav`;
      const aiFileKey = `${RECORDINGS_FOLDER}/${calledNumber}/${sanitizedCallerNumber}/${sessionId}_ai.wav`;

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
        } else {
          console.log("No caller audio to save.");
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
        } else {
          console.log("No AI audio to save.");
        }

        isAudioSaved = true;
        callerAudioBuffer = [];
        aiAudioBuffer = [];
      } catch (error) {
        console.error("Error uploading audio files to S3:", error);
      }
    };

    connection.on("message", async (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case "media":
            if (!isAudioSaved) {
              const audioPayload = Buffer.from(data.media.payload, "base64");
              callerAudioBuffer.push(audioPayload);

              // Convert speech to text using ElevenLabs STT
              const callerText = await speechToText(Buffer.concat([createWavHeader(audioPayload.length), audioPayload]));
              console.log("Caller said:", callerText);

              // Get response from OpenAI
              const aiResponseText = await getOpenAIResponse(callerText);

              // Convert AI response to speech using ElevenLabs TTS
              const aiAudio = await textToSpeech(aiResponseText);
              connection.send(JSON.stringify({
                event: "media",
                streamSid: streamSid,
                media: { payload: aiAudio.toString("base64") },
              }));
              aiAudioBuffer.push(aiAudio);
            }
            break;
          case "start":
            streamSid = data.start.streamSid;
            console.log("Incoming stream has started", streamSid);
            callerAudioBuffer = [];
            aiAudioBuffer = [];
            isAudioSaved = false;
            break;
          case "stop":
            console.log("Stream stopped", streamSid);
            await saveAudioFiles();
            break;
          default:
            console.log("Received non-media event:", data.event);
            break;
        }
      } catch (error) {
        console.error("Error processing message:", error);
      }
    });

    connection.on("close", async () => {
      console.log("Client disconnected.");
      await saveAudioFiles();
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