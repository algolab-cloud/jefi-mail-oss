# Email invites: manual interop check

Bead lume-fwl.8. The tests cover parsing, applying, the MIME and iCalendar Jefi sends, and delivery
through a test SMTP server (`src/engine/calendar/invites*.test.ts`, `ics-write.test.ts`). Whether
Gmail, Outlook and Apple Calendar *accept* what Jefi sends can only be checked by hand. Do this before
a release that touches `src/engine/calendar/invites.ts`, `ics-write.ts` or the outbox.

You need: a Jefi build signed in to one account (call it **J**, e.g. a Fastmail or iCloud address),
a Gmail account **G** and an Outlook.com / Microsoft 365 account **O**, each open in its web app.

## 1. Receiving an invite from Gmail

1. In Google Calendar (as G), create an event tomorrow 15:00–16:00 in a zone other than yours if
   you can (Event settings → Time zone), with a location and a description, and add J as a guest.
   Save and send.
2. In Jefi, the invitation arrives in J's inbox. Open it.
   - The invite card shows the title, the time in your zone (and G's zone on a second line if it
     differs), the location, "Organizer: G", the guest summary.
   - The event is already in Jefi's calendar (default calendar), and the card shows Accept / Maybe /
     Decline with none selected.
   - The message's two calendar parts (inline and invite.ics) made **one** event.
3. Click **Accept**. A toast says Accepted with Undo. Wait out the undo window.
4. In Google Calendar, open the event's guest list: J shows **Yes** within a minute or two. In G's
   inbox there's "Accepted: <title>" from J, threaded with the invitation.
5. In Jefi, click **Change response** → **Decline**. The event disappears from Jefi's calendar views.
   Google shows J as **No**.
6. In Google Calendar, move the event an hour later and save (notify guests). In Jefi, the update
   arrives: the calendar event moves, the card says "Updated", and the response is back to
   unanswered (a changed time asks again). Accept it; Google shows Yes again.
7. In Google Calendar, delete the event (notify guests). In Jefi, the cancellation arrives: the card
   says "This event was cancelled", the event is gone from calendar views, and **Remove from
   calendar** deletes the stored row.

## 2. Receiving an invite from Outlook

Repeat section 1 from O with Outlook on the web. Also:

- Use a recurring event (weekly, 4 times). Jefi shows "Every week, 4 times" and all four occurrences.
- In Outlook, move just the second occurrence and send the update. Jefi moves that occurrence only.
- Cancel the third occurrence. Jefi removes that occurrence only.
- Accept the series in Jefi: Outlook's tracking shows J as Accepted.

## 3. Sending an invite from Jefi

1. In Jefi's calendar, create an event from J with G and O as attendees and send the invitations.
2. In Gmail (as G): the message shows Google's invitation bar (Yes / Maybe / No) and the event appears
   in Google Calendar at the right time. There is an invite.ics attachment.
3. In Outlook (as O): the message shows as a meeting request with Accept / Tentative / Decline and the
   right time.
4. Answer Yes in Gmail and Tentative in Outlook. In Jefi, both replies arrive; their cards say "G
   accepted" / "O tentatively accepted", and the event's attendees show the answers.
5. Change the event's time in Jefi and send the update. Gmail and Outlook both move it (the update's
   SEQUENCE is higher). Subject starts "Updated invitation:".
6. Make it a weekly series (3 times) and send. Check Gmail and Outlook show it at the same wall-clock
   time on both sides of a DST change if the range crosses one (Jefi sends TZID + VTIMEZONE for
   series).
7. Cancel the event in Jefi (send cancellation, then delete). Gmail and Outlook remove it.

## 4. Offline and failures

1. Disconnect from the network, Accept an invitation in Jefi. The answer waits in the Outbox (visible,
   with its retry time). Reconnect: it goes out, and the organizer sees the answer.
2. With the undo window on (Settings), Accept and press **Undo** in the toast: nothing is sent (the
   organizer never gets a reply); the local answer is kept.

## 5. Junk and blocked senders

1. Block a test sender in Jefi, then send J an invitation from that sender. It is **not** added to
   the calendar; its card says it came from Junk or an unknown sender and still offers Accept.
2. Accept it: now it's added, and the reply goes out.

## What to record

For each client, note the client and version, pass/fail per step, and for failures the raw message
(Jefi: More → Show original; Gmail: Show original; Outlook: View message source). File a bead with the
raw `text/calendar` part attached.
