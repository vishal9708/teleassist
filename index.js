import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import inboundRoutes from "./inboundRoutes.js";
import outboundRoutes from "./outboundRoutes.js";

const fastify = Fastify({
    logger: true 
});

// Register plugins
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Register routes without prefixes
fastify.register(inboundRoutes);
fastify.register(outboundRoutes);

// Root route for health check
fastify.get("/", async (_, reply) => {
    reply.send({ message: "Unified Server is running" });
});

// Log all registered routes before starting
fastify.ready(() => {
    console.log("Registered Routes:");
    console.log(fastify.printRoutes());
});

// Start the server
const PORT = process.env.PORT || 8080;
fastify.listen({ port: PORT }, (err) => {
    if (err) {
        console.error("Error starting server:", err);
        process.exit(1);
    }
    console.log(`[Server] Listening on port ${PORT}`);
});