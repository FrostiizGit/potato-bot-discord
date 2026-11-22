import { createServer, type Server } from 'node:http';
import { createLogger } from './logger.js';

const log = createLogger('health');

/**
 * Tiny HTTP server for the deploy health check (Stalagmite polls it before switching to a new release).
 * `GET /health` answers 503 until `isReady()` is true (logged in to Discord), then 200. No database calls.
 */
export function startHealthServer(port: number, isReady: () => boolean): Server {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const ready = isReady();
      res.writeHead(ready ? 200 : 503, { 'content-type': 'text/plain' });
      res.end(ready ? 'ok' : 'starting');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  server.listen(port, '0.0.0.0', () => log.info(`Health check on http://0.0.0.0:${port}/health`));
  return server;
}
