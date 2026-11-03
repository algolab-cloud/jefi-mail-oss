import { expect, test } from 'bun:test'
import { openDatabase } from './db'
import { storeBody } from './mail-store'
import { seedMailbox } from './testing/seed'
import { loadThreads } from './threads'

test('a sign-in code is found when the body is stored and offered on its conversation', () => {
  const db = openDatabase(':memory:')
  const [code, plain] = seedMailbox(db, 'a', 'me@example.com', { path: 'INBOX', specialUse: '\\Inbox' }, { count: 2, subject: 'Message' })
  db.run("UPDATE messages SET subject = 'Your Acme sign-in code' WHERE id = ?", [code!])
  storeBody(db, code!, { text: 'Use this code to sign in:\n\n739201\n', html: null, snippet: 'Use this code', attachments: [] })
  storeBody(db, plain!, { text: 'Lunch at 1230?', html: null, snippet: 'Lunch', attachments: [] })
  const threads = loadThreads(db, 'a')
  expect(threads.find((t) => t.subject === 'Your Acme sign-in code')?.signIn).toEqual({ kind: 'code', code: '739201' })
  expect(threads.find((t) => t.subject !== 'Your Acme sign-in code')?.signIn).toBeUndefined()
  db.close()
})
