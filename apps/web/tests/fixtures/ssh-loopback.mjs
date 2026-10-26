/** SSH process fixture: descriptor discovery and one owned loopback TCP forward. */
import { readFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'

const args = process.argv.slice(2)
if (args.includes('unreachable-fixture')) {
  process.stderr.write('fixture SSH connection refused\n')
  process.exit(255)
}
if (!args.includes('-N')) {
  process.stdout.write(`\n--DSH-INSTANCE--\n${readFileSync(process.env.DSH_REMOTE_HOST_FIXTURE, 'utf8')}\n`)
} else {
  const spec = args[args.indexOf('-L') + 1]
  const [bind, local, host, remote] = spec.split(':')
  const sockets = new Set()
  const server = createServer(client => {
    const upstream = createConnection({ host, port: Number(remote) })
    for (const socket of [client, upstream]) {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('error', () => { client.destroy(); upstream.destroy() })
    }
    client.pipe(upstream).pipe(client)
    client.once('close', () => upstream.destroy())
    upstream.once('close', () => client.destroy())
  })
  process.once('SIGTERM', () => {
    for (const socket of sockets) socket.destroy()
    server.close(() => process.exit(0))
  })
  server.on('error', error => { process.stderr.write(`${error.message}\n`); process.exit(1) })
  server.listen(Number(local), bind)
}
