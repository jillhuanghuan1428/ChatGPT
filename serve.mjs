import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const migrationDirectory = new URL('./migrations/', import.meta.url);

function sqliteBinding(database) {
  function statement(sql, parameters = []) {
    const prepared = database.prepare(sql);
    return {
      bind(...values) { return statement(sql, values); },
      async first(column) {
        const row = prepared.get(...parameters);
        if (!row) return null;
        if (column === undefined) return row;
        if (!Object.hasOwn(row, column)) throw new Error('Unknown result column');
        return row[column];
      },
      async all() { return { success: true, results: prepared.all(...parameters) }; },
      async run() {
        const { changes, lastInsertRowid } = prepared.run(...parameters);
        return { success: true, results: [], meta: { changes: Number(changes), last_row_id: Number(lastInsertRowid) } };
      },
    };
  }
  return { prepare: sql => statement(sql) };
}

async function migrate(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS _moon_migrations (
    name TEXT PRIMARY KEY NOT NULL,
    sha256 TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const names = (await readdir(migrationDirectory)).filter(name => /^\d{4}_[A-Za-z0-9_-]+\.sql$/.test(name)).sort();
  if (!names.length) throw new Error('No database migrations found');
  for (const name of names) {
    const sql = (await readFile(new URL(name, migrationDirectory), 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const hash = createHash('sha256').update(sql).digest('hex');
    // One lock covers the read and application, including concurrent process startup.
    database.exec('BEGIN IMMEDIATE');
    try {
      const applied = database.prepare('SELECT sha256 FROM _moon_migrations WHERE name = ?').get(name);
      if (applied && applied.sha256 !== hash) throw new Error('An applied migration changed');
      if (!applied) {
        database.exec(sql);
        database.prepare('INSERT INTO _moon_migrations (name, sha256, applied_at) VALUES (?, ?, ?)').run(name, hash, Date.now());
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

function toWorkerRequest(incoming, port) {
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
  const options = { method: incoming.method, headers };
  if (!['GET', 'HEAD'].includes(incoming.method)) {
    options.body = Readable.toWeb(incoming);
    options.duplex = 'half';
  }
  // The Worker routes by path. Avoid deriving the request origin from untrusted proxy headers.
  return new Request(`http://127.0.0.1:${port}${incoming.url}`, options);
}

async function forwardWorkerResponse(response, outgoing, method) {
  for (const [name, value] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader('set-cookie', cookies);
  outgoing.statusCode = response.status;
  if (response.body && method !== 'HEAD') await pipeline(Readable.fromWeb(response.body), outgoing);
  else outgoing.end();
}

export async function startServer({
  host = process.env.HOST || '0.0.0.0',
  port = process.env.PORT === undefined ? 8080 : Number(process.env.PORT),
  databasePath = process.env.DB_PATH || './data/borrowed-moon.sqlite',
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  const { default: worker } = await import('./dist/server/index.js');
  if (typeof worker?.fetch !== 'function') throw new Error('The game build is missing its fetch handler');
  const absolutePath = resolve(databasePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  const database = new DatabaseSync(absolutePath);
  try {
    database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    await migrate(database);
  } catch (error) { database.close(); throw error; }
  const env = { DB: sqliteBinding(database) };
  const backgroundTasks = new Set();
  const context = { waitUntil(task) {
    const tracked = Promise.resolve(task).catch(() => console.error('A background task failed.')).finally(() => backgroundTasks.delete(tracked));
    backgroundTasks.add(tracked);
  } };
  const server = createServer({ requestTimeout: 20000, headersTimeout: 15000, keepAliveTimeout: 5000 }, async (incoming, outgoing) => {
    try {
      if (incoming.url === '/healthz' && ['GET', 'HEAD'].includes(incoming.method)) {
        database.prepare('SELECT 1').get();
        outgoing.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        outgoing.end(incoming.method === 'HEAD' ? undefined : '{"ok":true}');
        return;
      }
      const request = toWorkerRequest(incoming, server.address().port);
      const response = await worker.fetch(request, env, context);
      await forwardWorkerResponse(response, outgoing, incoming.method);
    } catch {
      // Do not print requests, bearer credentials, cookies, or submitted player data.
      if (incoming.aborted || outgoing.destroyed) return;
      console.error('A request could not be completed.');
      if (outgoing.headersSent) outgoing.destroy();
      else {
        outgoing.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        outgoing.end('Service unavailable. Please try again.');
      }
    }
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  try {
    await new Promise((accept, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); accept(); });
    });
  } catch (error) { database.close(); throw error; }
  let closing;
  function close() {
    if (closing) return closing;
    closing = (async () => {
      const force = setTimeout(() => server.closeAllConnections(), 8000);
      force.unref();
      try {
        await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
        await Promise.allSettled([...backgroundTasks]);
        database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally { clearTimeout(force); database.close(); }
    })();
    return closing;
  }
  return { server, url: `http://${host.includes(':') ? '[' + host + ']' : host}:${server.address().port}`, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const application = await startServer();
    console.log('Borrowed Moon listening on ' + application.url);
    const shutdown = () => application.close().then(() => { process.exitCode = 0; }).catch(() => { console.error('Server shutdown failed.'); process.exitCode = 1; });
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch {
    console.error('Server startup failed. Check Node.js 24, built files, and database write access.');
    process.exitCode = 1;
  }
}
