import { expect, test } from 'bun:test'
import { findMeetingLink, joinLink, meetingLink, meetingProvider } from './meeting'

test('a link says which meeting service it is on', () => {
  expect(meetingProvider('https://acme.zoom.us/j/123?pwd=abc')).toEqual({ id: 'zoom', label: 'Zoom' })
  expect(meetingProvider('https://meet.google.com/abc-defg-hij')?.id).toBe('meet')
  expect(meetingProvider('https://teams.microsoft.com/l/meetup-join/19%3a')?.id).toBe('teams')
  expect(meetingProvider('https://teams.live.com/meet/9876')?.id).toBe('teams')
  expect(meetingProvider('https://acme.webex.com/meet/ada')?.id).toBe('webex')
  expect(meetingProvider('https://meet.jit.si/planning')?.id).toBe('jitsi')
  // Look-alikes and other links aren't meetings.
  expect(meetingProvider('https://zoom.us.evil.example/j/1')).toBeNull()
  expect(meetingProvider('https://docs.example.com')).toBeNull()
  expect(meetingProvider('not a link')).toBeNull()
  expect(meetingProvider(null)).toBeNull()
})

test('the meeting-link field takes what people paste', () => {
  expect(meetingLink('zoom.us/j/123')).toBe('https://zoom.us/j/123')
  expect(meetingLink('  https://meet.google.com/abc-defg-hij  ')).toBe('https://meet.google.com/abc-defg-hij')
  expect(meetingLink('')).toBeNull()
  expect(meetingLink('call me')).toBeNull()
  expect(meetingLink('localhost')).toBeNull()
  expect(meetingLink('javascript:alert(1)')).toBeNull()
})

test('joining: a meeting service anywhere on the event; any other link only on our own events', () => {
  const own = { url: null, location: 'Room 4', description: 'Dial in: https://docs.example.com/x or https://acme.zoom.us/j/1.', invite: null }
  expect(findMeetingLink(own.location, own.description)).toBe('https://acme.zoom.us/j/1')
  expect(joinLink(own)).toBe('https://acme.zoom.us/j/1')
  expect(joinLink({ ...own, url: 'https://meet.google.com/abc-defg-hij' })).toBe('https://meet.google.com/abc-defg-hij')
  expect(joinLink({ ...own, description: null, url: 'https://calls.example.com/room' })).toBe('https://calls.example.com/room')
  expect(joinLink({ ...own, description: null, url: 'https://calls.example.com/room', invite: { messageId: 'm' } })).toBeNull()
})
