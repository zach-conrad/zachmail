import { serve } from '@hono/node-server'
import { createApp } from './app'
import { readEnv } from './env'

const port = Number(process.env.PORT ?? 8787)
serve({ fetch: createApp(readEnv()).fetch, port })
console.log(`api on http://localhost:${port}/api`)
