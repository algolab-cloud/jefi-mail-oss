import { expect, test } from 'bun:test'
import { countTrackers, isTracker, withoutTrackers } from './trackers'

test('invisible remote images are trackers', () => {
  expect(isTracker('<img src="https://mail.example.com/x.gif" width="1" height="1">')).toBe(true)
  expect(isTracker('<img src="https://example.com/a.png" style="display:none">')).toBe(true)
  expect(isTracker("<img src='https://example.com/a.png' style='width:1px;height:1px'>")).toBe(true)
})

test("images from open-tracking services are trackers, whatever their size", () => {
  expect(isTracker('<img src="https://acme.list-manage.com/track/open.php?u=1">')).toBe(true)
  expect(isTracker('<img src="https://u123.ct.sendgrid.net/wf/open?upn=abc">')).toBe(true)
  expect(isTracker('<img src="https://links.example.com/e/o/eyJ">')).toBe(true)
})

test('pictures are not trackers, and nothing carried in the mail is', () => {
  expect(isTracker('<img src="https://cdn.example.com/hero.jpg" width="600" height="300">')).toBe(false)
  expect(isTracker('<img src="https://cdn.example.com/logo.png">')).toBe(false)
  expect(isTracker('<img src="cid:logo@x" width="1" height="1">')).toBe(false)
  expect(isTracker('<img src="data:image/gif;base64,R0lG" width="1">')).toBe(false)
})

test('trackers are counted and taken out; pictures stay', () => {
  const html = '<p>Hi</p><img src="https://cdn.example.com/hero.jpg"><img src="https://t.example.com/o.gif" width="1" height="1"><img src="https://acme.list-manage.com/track/open.php">'
  expect(countTrackers(html)).toBe(2)
  expect(withoutTrackers(html)).toBe('<p>Hi</p><img src="https://cdn.example.com/hero.jpg">')
})
