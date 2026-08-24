import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const consumerRoot = path.dirname(fileURLToPath(import.meta.url))
const distRoot = path.join(consumerRoot, 'dist')
const port = Number(process.env.KAREL_CONSUMER_PORT ?? '4198')
const host = '127.0.0.1'

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob: https://cdn.jsdelivr.net https://runno.dev",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
].join('; ')

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
  ['.woff2', 'font/woff2'],
])

function setSecurityHeaders(response) {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  response.setHeader('Content-Security-Policy', contentSecurityPolicy)
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Cache-Control', 'no-store')
}

async function regularFile(candidate) {
  try {
    return (await stat(candidate)).isFile()
  } catch {
    return false
  }
}

const server = createServer(async (request, response) => {
  setSecurityHeaders(response)
  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' })
    response.end('Method not allowed')
    return
  }

  let pathname
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', `http://${host}`).pathname)
  } catch {
    response.writeHead(400)
    response.end('Bad request')
    return
  }
  const relative = pathname.replace(/^\/+/, '')
  const requested = path.resolve(distRoot, relative)
  const insideDist = requested === distRoot || requested.startsWith(`${distRoot}${path.sep}`)
  let selected = insideDist && await regularFile(requested)
    ? requested
    : undefined

  if (selected === undefined && path.extname(relative) === '') {
    selected = path.join(distRoot, 'index.html')
  }
  if (selected === undefined || !await regularFile(selected)) {
    response.writeHead(404)
    response.end('Not found')
    return
  }

  response.setHeader(
    'Content-Type',
    contentTypes.get(path.extname(selected)) ?? 'application/octet-stream',
  )
  response.writeHead(200)
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  createReadStream(selected).pipe(response)
})

server.listen(port, host, () => {
  process.stdout.write(`Packed Karel consumer listening at http://${host}:${port}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
