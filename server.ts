import fastify from "fastify";
import plugin, { Options } from "./src/index";

const app = fastify({ logger: true });

// Add health check endpoint
app.get('/health', async () => {
	return { 
		status: 'ok'
	};
});

app.register(plugin, {} as any);

app.listen("3000", "0.0.0.0", (err: any, address: string) => {
	if (err) {
		console.error(err);
		process.exit(1);
	}
});
