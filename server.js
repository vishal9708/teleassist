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
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_REGION,
  S3_BUCKET_NAME,
} = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}

if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !S3_BUCKET_NAME) {
  console.error(
    "Missing AWS credentials or bucket name. Please set them in the .env file."
  );
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
// const SYSTEM_MESSAGE = "You are an expert sales. Your task is to generate engaging and persuasive product descriptions for selling laptops, desktops, and accessories.";
const SYSTEM_MESSAGE = `
WHAT IS A VEHICLE SERVICE AGREEMENT (VSA)?  A VSA helps protect you from covered repair costs due to mechanical breakdown after your vehicle’s warranty expires. We offer variable options to provide you the right level of protection, based on the mileage you drive and how long you plan to keep your vehicle. 1  V S A VEHICLE SERVICE AGREEMENT  Backed by the strength and stability of Toyota  PLATINUM VEHICLE ELIGIBILITY NEW VEHICLE PLANS  Toyota vehicles are eligible if less than three (3) years old from date vehicle was first put into service and up to 36,000 total vehicle miles.   2  USED VEHICLE PLANS  Toyota vehicles are eligible within current model year plus nine (9) prior model years and up to 150,000 total vehicle miles. See your dealer for eligibility requirements. Used vehicle plans are available through your dealer  only   at the time of used vehicle purchase or lease.   3  VSA PLATINUM WILL HELP YOU  •   Be prepared and protected after your vehicle’s warranty expires •   Be protected against rising costs of labor and covered parts •   Ensure repairs are handled by a factory-trained service technician using only Toyota-approved parts •   Enjoy 24/7 Roadside Assistance •   Access a network of Toyota dealers throughout the U.S. and Canada •   Be able to transfer your agreement one time at no additional cost, potentially increasing the resale value of your Toyota  Exclusions  1.   Time and mileage coverage periods for new vehicle plans are measured from date vehicle was first put into service as a new vehicle and zero miles. Time and mileage coverage periods for used vehicle plans are measured from the agreement application date and agreement application mileage. Coverage expires upon reaching the maximum time or mileage of the coverage period selected, whichever occurs first. Deductible applies to each eligible repair visit. See your agreement for complete terms, conditions, and restrictions 2.   Any repairs/replacements made without prior authorization are excluded. Additional exclusions may apply. Please consult your customer product agreement for specific coverage details, including limitations and exclusions. 3.   Certain Toyota vehicles may already include a 24/7 Roadside Assistance program depending on your vehicle’s Safety Connect features. If a vehicle already has 24/7 Roadside Assistance, no additional Roadside Assistance benefit will be provided with the purchase of a Vehicle Service Agreement. Emergency fuel delivery includes up to three (3) gallons of gasoline twice per calendar month at no charge. Excludes Fuel Cell and Electric vehicles, which may be towed to the nearest authorized servicing Toyota dealer or authorized fueling station; fuel delivery will not apply. Roadside Assistance services provided by and through AAA with coverage available anywhere in the continental U.S. and Canada. In California, Roadside Assistance is provided if vehicle is inoperable due to mechanical failure of a covered component.  Up to 1,100 vehicle parts covered 24/7 Roadside Assistance   3 Substitute transportation Travel protection Transferable   Deductible options  GENERAL BENEFITS
VSA PLATINUM  VSA Platinum covers the cost of mechanical breakdown of the parts listed in GRAY and RED text after your vehicle’s basic warranty expires. Your vehicle’s Limited Powertrain Warranty covers those parts listed in GRAY text only. 4  ENGINE  All internally lubricated components and: Balance Shaft; Camshaft; Crankshaft; Crankshaft Pulley; Cylinder Heads; Engine Block; Engine Mounts; Engine Oil Reservoir; Engine Oil Reservoir Pump; Equipment Drive Shaft; Exhaust Manifolds; Flexplate; Flywheel; Idler Pulley; Intake Manifold; Oil Pan; Oil Pressure Switch; Oil Pump; Oil Sending Unit; Pistons; Seals and Gaskets; Supercharger; Supercharger Intercooler; Tensioners; Timing Belt; Timing Chain; Timing Cover; Timing Gears; Turbo Intercooler; Turbo Wastegate; Turbocharger; Valve Covers; Water Pump; Air Control Valve (ACV); Air Pump; Catalytic Converter; Crankcase Ventilation Valve; Exhaust Gas Recirculation Valve; Exhaust Manifold Heat Insulator; Exhaust Pipe Gasket; Mixture Control Valve; Oil Cooler; Oil Filter Bracket Subassembly; Pair Valve (Reed Valve); Supercharger Bypass Valve; Supercharger Relay; Thermal Vacuum Valve; Thermostatic Valve; Vacuum Switch; Vacuum Switching Valve; Vacuum Transmitting Valve  MANUAL TRANSMISSION  Transfer Case Components (All internally lubricated components) and: Clutch Master Cylinder; Clutch Release Cylinder; Gears and Shafts; Hoses, Lines, and Tubes; Seals and Gaskets; Shift Linkage and Cables; Transfer/ Transmission Case; Transmission Mounts; Clutch Pedal Subassembly; Control Position Indicator Subassembly; Master Cylinder Reservoir; Radial Ball Bearing (for Clutch Release) and/or Clutch Fork; Shift Lever Boot and/or Retainer; Shift Lever Knob  AUTOMATIC TRANSMISSION  Transfer Case Components (All internally lubricated components) and: Hoses, Lines, and Tubes; Seals and Gaskets; Shift Linkage and Cables; Solenoids; Torque Converter; Transfer/Transmission Case; Transmission Mounts; Vacuum Modulator; Shift Lever Knob  AXLE ASSEMBLY  Front, Rear, 4WD and AWD: (All internally lubricated components) and: 4x4 Actuators; Axles and Bearings; Center Support Bearing; Constant Velocity Boot Band; Constant Velocity Joints and Boots; Differential Carrier Assembly; Drive Axle Housing; Drive Shaft; Hubs; Locking Hubs; Seals and Gaskets; Thrust Washers; Universal Joints; Viscous Coupling  SUSPENSION  (Front and Rear): Bushings/Bearings; Control Arm Shafts; Electronic Suspension Actuator/Motor and Compressor; Front and Rear Coil Springs; Front and Rear Stabilizer Bar; Front Leading Arm; Front Spring Assembly; Radius Arm; Spindle; Spindle Support; Steering Knuckle; Strut Rod; Suspension Spring Shackles; Sway Bar Link; Torsion Bar Spring; Upper and Lower Ball Joints; Upper and Lower Control Arms; Upper Arm Shaft  STEERING  Gear Box internal components and: Bushings/Bearings; Center Link; Horn Contact Ring; Hoses, Lines, and Tubes; Idler Arm; Knuckle Stopper Cover; Pitman Arm; Power Steering Pump; Power Steering Pump Pulley; Rack and Pinion; Seals and Gaskets; Steering Column; Steering Column Coupling; Steering Column Shaft; Steering Dampener; Steering Gear Box and Pump Housings; Tie Rod End  FUEL SYSTEM  Air Flow Meter; Carburetor; Charcoal Canister; Diesel Fuel Injection Pump; Electric Fuel Pump; Electronic Fuel Injection System; Fuel Filler Opening Lid Hinge Spring; Fuel Injectors; Fuel Pressure Regulator; Fuel Pump; Fuel Sending Unit; Fuel Sensors; Fuel Tank; Throttle Body  COOLING SYSTEM  Coolant Level Sensor/Tank; Cooling Fan Relay; Cooling Fan Sensor; Engine Coolant Temperature Switch or Sensor (at radiator); Engine Cooling Fan Motor; Engine Fan; Engine Fan Clutch; Engine Fan Motor; Engine Fan Shroud; Equipment Drive Pulley; Fan Bracket Subassembly; Radiator; Seals and Gaskets; Thermostat  AIR CONDITIONING/HEATING  Air Conditioning Heater Box Assembly; Air Conditioning Lines, and Tubes; Air Conditioning Pressure Switches; Air Temperature Control Programmer; Blower Motor; Blower Motor Resistor; Compressor; Compressor Clutch Assembly; Compressor Pulley; Condenser; Condenser Fan and Motor; Cooler Control Switch; Damper Servo; Defroster Control Cable; Evaporator; Evaporator Temperature Sensor; Expansion Valve; Heater Control Head; Heater Control Valve; Heater Core; Idler Pulley; Pressure Regulator Assembly; Receiver/Dryer; Schrader Valve; Seals and Gaskets  BRAKES  Anti-Lock Braking/Traction Control Actuator, Pump and Motor; Brake Booster; Brake Hoses, Lines, and Tubes; Brake Pedal Subassembly; Disc Brake Calipers; Load-Sensing Proportioning Valve; Master Cylinder; Parking Brake Cable; Parking Brake Control Handle Assembly; Parking Brake Lever Subassembly; Parking Brake Pedal Subassembly; Proportioning Valve; Rear Brake Backing Plate; Seals and Gaskets; Wheel Cylinders  Exclusions  4.   Covered components are subject to change. See your agreement for complete details.
HYBRID/ALTERNATIVE FUEL  Actuator Assembly Shift Control; Hybrid Vehicle Generator Assembly; Hybrid Vehicle Motor Assembly; Hybrid Vehicle Transaxle Assembly; Transmission Input Damper Assembly; Battery Computer Assembly; Battery Current Sensor; Boost Charging Inlet and Plug-in Electronic Control Unit; Circuit Breaker Sensor; Combination Meter Assembly; Combination Meter Computer; Fuel Cell Water Pump; Fueling Receptacle; Hybrid Vehicle Battery Blower Assembly; Hybrid Vehicle Battery Blower Motor Control; Hybrid Vehicle Battery Thermistor; Hybrid Vehicle Control Computer; Hydrogen Pipes and Manifolds; Inverter Assembly with Converter; Main Switch Assembly; Power Source Control Computer Assembly; Power Steering Electronic Control Unit Assembly; Power Steering Gear Assembly; Pressure Sensors; Reducing Valve; Shift Lever Position Sensor; Skid Control Computer Assembly; Steering Column Assembly; Transmission Control Module  ELECTRICAL  Alternator; Automatic-Off Headlamp Sensor, Timer and Switches; Automatic Shoulder Belt Motor and Switches; Automatic Temperature Control Unit; Battery to Ground Cable; Battery to Starter Cable; Blower Motor; Blower Motor Resistor; Charge Warning Relay; Clutch Starter Interlock Switch; Convertible Top Motor; Cruise Control Actuator/Servo; Cruise Control Sensors and Switches; Cruise Control Vacuum Motor; Defogger Relay; Distributor; Door Control Relay; Engine Coolant Temperature Gauge and Sending Unit; Engine Coolant Temperature Receiver Gauge and Sending Unit; Engine Cooling Fan Motor; Engine Tachometer; Fuel Gauge and Sending Unit; Fuel Receiver Gauge and Sending Unit; Guide Rail Limit Switch; Headlamp Washer; Headlight Control Relay; Horn; Horn (for theft deterrent); Ignition Coil; Ignition Switch Lock Cylinder and Key Set; Integration Relay; Lamp Failure Indicator Sensor; Lock Cylinder Set; Main Relay; Manually Operated Switches; Oil Pressure Receiver Gauge and Sending Unit; Power Antenna Motor and Cable; Power Door Lock Actuator; Power Mirror Defogger; Power Mirror Motor; Power Seat Motors; Power Sliding Door Motor; Power Window Motor/Regulator; Rear Shock Absorber Control Actuator; Retractable Headlamp Motor; Shoulder Belt Drive Motor; Smart Entry and Start System Switch, Sensor and Electronic Control Unit; Spark Plug Resistive Cord; Speedometer; Starter Motor; Starter Solenoid; Stop Light Switch; Sunroof Cables; Sunroof Motor; Taillight Control Relay; Turn Signal Flasher; Unlock Warning Buzzer; Windshield Washer Pump; Windshield Wiper Link Assembly; Wiper Control Relay; Wiper Motor; Wiring Harnesses  COMPUTERS AND ELECTRONICS  Airbags; Airbag Sensors; Antenna Cord; Anti-Lock Braking/Traction Control Computer and Sensors; Automatic Shoulder Belt Computer; Body Control Module; Circuit Opening Relay; Compact Disc (CD) Player; Cruise Control Computer; Electronic Ignition Unit; Electronically Controlled Transmission/Transfer Case Computer and Sensors; Electronically Modulated Suspension Computer; Engine Control Computer; Front Seat Airbag Assembly; Graphic Equalizer; Knock Sensor; Navigation System; Power Mirror Electronic Control Unit; Power Seat Computer; Progressive Power Steering Computer; Radio Tuner; Steering Sensor; Stereo Component Amplifier; Sunroof Control Computer and Relay; Tape Player; Tilt/Telescoping Steering Computer; Traction Control Computer; Trip Computer; Variable Induction System; Vehicle Security Computers and Sensor; Wiper Module  ADDITIONAL COMPONENTS  Accelerator Pedal and/or Bracket Subassembly; Accelerator Pedal Rod Assembly; Back Door Lock Assembly; Convertible Roof Hook; Door Handles; Door Lock Cylinder; Front and Rear Door Lock Assembly; Front Seat Belt; Glove Compartment Door Lock Cylinder; Glove Compartment Door Latch Subassembly; Hinges; Hood Lock Assembly; Hood Lock Control Cable Assembly; Hood Support Assembly; Rear Seat Belt; Reclining Seat Back Adjuster; Removable Roof Lock Handle; Seat Track Assembly; Shoulder Belt Guide Rail Assembly; Sliding Roof Drive Cable; Sliding Roof Guide Rail; Tail Gate Lock Assembly; Tilt Roof Lock Handle Assembly  THESE ARE THE ITEMS NOT COVERED  Accessory Drive Belts; Batteries; Body Panels; Brake Linings, Pads, and Shoes, Rotors and Drums; Bumpers; Carpet; Chrome; Clutch Friction Disc and Pressure Plate; Dash Cover and Pad; Door Fabric; Door Trim; Filters; Fluids; Fuel Cell Air Compressor; Fuel Cell Boost Converter; Fuel Cell Electronic Control Unit; Fuel Cell Hydrogen Tanks; Fuel Cell Power Control Unit; Fuel Cell Stack; Fuel Cell Vehicle Battery Pack; Glass (including Windshields); Headliner; Heating Hoses, Lines, and Tubes; Hoses; Hybrid Vehicle Battery Pack; Hybrid Vehicle Battery Plug Assembly; Hybrid Vehicle Relay Assembly; Hybrid Vehicle Supply Battery Assembly; Hydrogen Fueling Electronic Control Unit; Interior and Exterior Trim and Moldings (including but not limited to: Ashtrays, Covers, Cup Holders, and Vents); Lamps, Light Assemblies/ Housings, and Light Bulbs; Nuts, Bolts, Clips, Retainers, and Fasteners; Paint; Rust and Corrosion Damage; Seat Covers; Sheet Metals; Shiny Metals; Spark Plugs; Structural Framework and Welds; Tires; Vacuum Hoses, Lines, and Tubes; Weather Stripping; Wheels and Rims; Windshield Wiper Blades (rubber component); All interior and exterior cloth, leather, and stitching including convertible tops and/or vinyl tops including but not limited to: any vibration, deterioration, discoloration, disfigurement, warping, fading, staining, stretching, ripping, punctures, tearing, and/or scratches
S A PLATINUM ADDITIONAL BENEFITS 24/7 ROADSIDE ASSISTANCE  For those times when the unexpected might occur, VSA Platinum also provides 24/7 Roadside Assistance.   3 •   Battery jump start •   Lockout protection •   Delivery of up to three (3) gallons of fuel, no more than two (2) times per calendar month   3 •   Tire service — Impaired tire will be replaced with your inflated spare •   Towing to the nearest authorized dealer   3 •   Winching — Extrication from any ditch, mud, sand, or snow. Vehicle must be immediately adjacent to a regularly traveled road and capable of being serviced with standard servicing equipment.  TRAVEL PROTECTION  If you’re unable to drive your vehicle due to the mechanical breakdown of a covered component, substitute transportation and travel protection benefits will provide reimbursements of: •   Up to   $50 per day   for car rentals or other substitute transportation.   5   Maximum of five (5) days per occurrence. •   Up to   $100 per day   for lodging and meals if you’re more than 150 miles from home.   5   Maximum of five (5) days over the life of your agreement.  LEARN MORE ABOUT VSA PLATINUM  Exclusions  5.   Due to a covered mechanical failure. Valid receipts are required for all reimbursements.  VEHICLE SERVICE AGREEMENT  The purchase of a Vehicle Service Agreement Voluntary Protection Product is optional, cancelable (subject to specific agreement terms) and not required to obtain credit.  This brochure is intended as an outline of Vehicle Service Agreement coverage. Coverage is subject to exclusions and limitations set forth in the Vehicle Service Agreement. The actual coverage, exclusions, and limitations of the agreements issued to customers may vary both from state to state and according to the program features chosen by the customer. In certain states, Toyota Motor Services Company administers Vehicle Service Agreements. Vehicle Service Agreements are available through Toyota Financial Services at participating Toyota dealerships only. Not available in select states.  In Florida, the administrator is Toyota Motor Insurance Company, P.O. BOX 661012, Dallas, TX, 75265, Florida License #02871  ©2024 Toyota Motor Insurance Services, Inc. oyota Financial Services is a service mark used by Toyota Motor Insurance Services, Inc. (TMIS) and its subsidiaries. Voluntary Protection Products are administered by TMIS or a third party contracted by TMIS. 00703 · 24-847600 (08/24)
`;
let VOICE;
const PORT = process.env.PORT || 8080;
const BUCKET_NAME = S3_BUCKET_NAME;
const RECORDINGS_FOLDER = "recordings";
const LOG_EVENT_TYPES = [
  "error",
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
];
const SHOW_TIMING_MATH = false;

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
  header.writeUInt16LE(7, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);

  return header;
}

// Root Route
fastify.get("/", async (request, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" });
});
let callerNumber;
let calledNumber;
let introScript;
let promptData;
// Route for Twilio to handle incoming calls
fastify.all("/incoming-call", async (request, reply) => {
  try {
    console.log("Incoming call request body:", request.body);
    callerNumber = request.body?.From || "Unknown Caller";
    calledNumber = request.body?.To || "Unknown Destination";
    const callSid = request.body?.CallSid || "Unknown CallSid";
    const response = await axios.get(
      `https://j7grsrn6sc.execute-api.ap-south-1.amazonaws.com/dev/api/agent/by-phone/${calledNumber.replaceAll(
        "+",
        ""
      )}`
    );
    console.log("response Data", response.data.agents);
    introScript = response.data.agents.welcomeMessage;
    promptData = response.data.agents.pdfFile;
    VOICE = response.data.agents.voice;

    console.log(
      `Call from: ${callerNumber} to: ${calledNumber}, CallSid: ${callSid}`
    );
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                             
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

    reply.type("text/xml").send(twimlResponse);
  } catch (error) {
    console.log(error);
  }
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("Client connected");

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

    const openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    const initializeSession = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: promptData,
          modalities: ["text", "audio"],
          temperature: 0.8,
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 200,
          },
        },
      };
      console.log("Sending session update:", JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));
      sendInitialConversationItem();
    };

    const sendInitialConversationItem = () => {
      const initialConversationItem = {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Greet the user with ${introScript} `,
            },
          ],
        },
      };
      if (SHOW_TIMING_MATH)
        console.log(
          "Sending initial conversation item:",
          JSON.stringify(initialConversationItem)
        );
      openAiWs.send(JSON.stringify(initialConversationItem));
      openAiWs.send(JSON.stringify({ type: "response.create" }));
    };

    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
        if (SHOW_TIMING_MATH)
          console.log(
            `Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`
          );

        if (lastAssistantItem) {
          const truncateEvent = {
            type: "conversation.item.truncate",
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime,
          };
          if (SHOW_TIMING_MATH)
            console.log(
              "Sending truncation event:",
              JSON.stringify(truncateEvent)
            );
          openAiWs.send(JSON.stringify(truncateEvent));
        }

        connection.send(
          JSON.stringify({
            event: "clear",
            streamSid: streamSid,
          })
        );

        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };

    const sendMark = (connection, streamSid) => {
      if (streamSid) {
        const markEvent = {
          event: "mark",
          streamSid: streamSid,
          mark: { name: "responsePart" },
        };
        connection.send(JSON.stringify(markEvent));
        markQueue.push("responsePart");
      }
    };

    const saveAudioFiles = async () => {
      if (isAudioSaved) {
        console.log("Audio already saved for this session, skipping.");
        return;
      }

      const sanitizedCallerNumber = callerNumber;
      // Updated file keys to include caller number as a folder
      const callerFileKey = `${RECORDINGS_FOLDER}/${calledNumber}/${sanitizedCallerNumber}/${sessionId}_caller.wav`;
      const aiFileKey = `${RECORDINGS_FOLDER}/${calledNumber}/${sanitizedCallerNumber}/${sessionId}_ai.wav`;

      try {
        if (callerAudioBuffer.length > 0) {
          const callerAudioData = Buffer.concat(callerAudioBuffer);
          const callerWavHeader = createWavHeader(callerAudioData.length);
          const callerWavData = Buffer.concat([
            callerWavHeader,
            callerAudioData,
          ]);

          const callerParams = {
            Bucket: BUCKET_NAME,
            Key: callerFileKey,
            Body: callerWavData,
            ContentType: "audio/wav",
          };

          await s3Client.send(new PutObjectCommand(callerParams));
          console.log(
            `Uploaded caller's audio to s3://${BUCKET_NAME}/${callerFileKey}`
          );
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
          console.log(
            `Uploaded AI's audio to s3://${BUCKET_NAME}/${aiFileKey}`
          );
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

    openAiWs.on("open", () => {
      console.log("Connected to the OpenAI Realtime API");
      setTimeout(initializeSession, 100);
    });

    openAiWs.on("message", (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }

        if (
          response.type === "response.audio.delta" &&
          response.delta &&
          !isAudioSaved
        ) {
          const audioDelta = {
            event: "media",
            streamSid: streamSid,
            media: { payload: response.delta },
          };
          connection.send(JSON.stringify(audioDelta));
          aiAudioBuffer.push(Buffer.from(response.delta, "base64"));

          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
            if (SHOW_TIMING_MATH)
              console.log(
                `Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`
              );
          }

          if (response.item_id) {
            lastAssistantItem = response.item_id;
          }

          sendMark(connection, streamSid);
        }

        if (response.type === "input_audio_buffer.speech_started") {
          handleSpeechStartedEvent();
        }
      } catch (error) {
        console.error(
          "Error processing OpenAI message:",
          error,
          "Raw message:",
          data
        );
      }
    });

    connection.on("message", (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case "media":
            latestMediaTimestamp = data.media.timestamp;
            if (SHOW_TIMING_MATH)
              console.log(
                `Received media message with timestamp: ${latestMediaTimestamp}ms`
              );
            if (openAiWs.readyState === WebSocket.OPEN && !isAudioSaved) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              };
              openAiWs.send(JSON.stringify(audioAppend));
              callerAudioBuffer.push(Buffer.from(data.media.payload, "base64"));
            }
            break;
          case "start":
            streamSid = data.start.streamSid;
            console.log("Incoming stream has started", streamSid);
            callerAudioBuffer = [];
            aiAudioBuffer = [];
            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;
            markQueue = [];
            lastAssistantItem = null;
            isAudioSaved = false;
            break;
          case "stop":
            console.log("Stream stopped", streamSid);
            saveAudioFiles(callerNumber);
            break;
          case "mark":
            if (markQueue.length > 0) {
              markQueue.shift();
            }
            break;
          default:
            console.log("Received non-media event:", data.event);
            break;
        }
      } catch (error) {
        console.error("Error parsing message:", error, "Message:", message);
      }
    });

    connection.on("close", () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log("Client disconnected.");
    });

    openAiWs.on("close", () => {
      console.log("Disconnected from the OpenAI Realtime API");
    });

    openAiWs.on("error", (error) => {
      console.error("Error in the OpenAI WebSocket:", error);
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
