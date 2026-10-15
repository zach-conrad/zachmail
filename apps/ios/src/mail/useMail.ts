import { randomUUID } from 'expo-crypto'
import { useSyncExternalStore } from 'react'
import { openExpoDriver } from '../data/expoDriver'
import { startSync, type Syncing } from '../data/sync'
import { demoMailbox } from './fixture'
import { MailStore, type MailState } from './store'

const apiUrl = process.env.EXPO_PUBLIC_API_URL

/**
 * The app's one replica. With an API configured it persists to `zachmail.db` and syncs once
 * signed in; without one it is an in-memory demo mailbox, fresh on every launch.
 */
export const mail = new MailStore(openExpoDriver(apiUrl ? 'zachmail.db' : ':memory:'), randomUUID)
if (!apiUrl) {
  const demo = demoMailbox(Date.now())
  mail.seed(demo.rows, demo.bodies)
}

let syncing: Syncing | null = null

/** Start syncing; sign-in calls this with a token source once a session exists. */
export function connectSync(token: () => Promise<string | null>) {
  if (apiUrl && !syncing) syncing = startSync(mail, { apiUrl, token })
}

/** Ask for bodies a thread is missing (no-op in the demo, where every body is local). */
export function fetchBodies(threadIds: string[]) {
  syncing?.fetchBodies(threadIds)
}

export function useMail(): MailState {
  return useSyncExternalStore(mail.subscribe, mail.getState)
}
