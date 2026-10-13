// Vercel Function entry: adapts the Hono app to Node's (req, res) handler.
import { getRequestListener } from '@hono/node-server'
import { createApp } from './app'
import { readEnv } from './env'

const app = createApp(readEnv())

export default getRequestListener(app.fetch)
