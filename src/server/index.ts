import { createServer } from './app.js';
import { configuredStore } from '../collector/store.js';

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
const app = await createServer(configuredStore());
await app.listen({ host: '0.0.0.0', port });
console.log(JSON.stringify({ event: 'server_started', port }));
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
