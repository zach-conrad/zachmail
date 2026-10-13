import { useSyncExternalStore } from 'react'
import { demoMailbox } from './fixture'
import { MailStore, type MailState } from './store'

/** The app's one replica. Demo data until the expo-sqlite replica and sync client land. */
const demo = demoMailbox(Date.now())
export const mail = new MailStore(demo.rows, demo.bodies)

/** Current snapshot; components derive lists with the selectors in ./store (memoized by React Compiler). */
export function useMail(): MailState {
  return useSyncExternalStore(mail.subscribe, mail.getState)
}
