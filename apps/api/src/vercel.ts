// Vercel Function entry: adapts the Hono app to Node's (req, res) handler.
import { getRequestListener } from '@hono/node-server'
import { createApp } from './app'
import { readEnv } from './env'
import { restorePath } from './vercel-path'

const app = createApp(readEnv())

const listener = getRequestListener(app.fetch)

export default function handler(
  req: Parameters<typeof listener>[0],
  res: Parameters<typeof listener>[1],
) {
  req.url = restorePath(req.url ?? '/')
  return listener(req, res)
}
