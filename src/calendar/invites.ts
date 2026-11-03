import type { CalendarEvent } from '../engine'

// ---------------------------------------------------------------------------
// The hook the iTIP work plugs into (registered in mail.tsx Shell). The editor saves attendees on the event; once a
// sender is registered here, it also offers "Save and send invites" and calls it with the stored
// event ('request' for a new or changed event, 'cancel' when one with attendees is deleted). Until
// then the editor only saves, and says the invitations aren't sent yet.
// ---------------------------------------------------------------------------

export type InviteSender = (event: CalendarEvent, method: 'request' | 'cancel') => Promise<void>

let sender: InviteSender | null = null

/** Called once by the invites module at startup. */
export function registerInviteSender(next: InviteSender | null) {
  sender = next
}

export const inviteSender = () => sender
