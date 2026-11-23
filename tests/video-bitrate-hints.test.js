import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { addVideoBitrateHints } from '../src/call/voice-call-manager.js';

const answer = [
  'v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1',
  'm=video 9 UDP/TLS/RTP/SAVPF 100 101 98', 'a=rtpmap:100 VP8/90000', 'a=rtpmap:101 rtx/90000', 'a=fmtp:101 apt=100',
  'a=rtpmap:98 H264/90000', 'a=fmtp:98 profile-level-id=42e01f;packetization-mode=1', ''
].join('\r\n');

describe('addVideoBitrateHints', () => {
  test('adds start/min/max bitrate to every video codec, nothing to audio or rtx', () => {
    const out = addVideoBitrateHints(answer);
    assert.match(out, /a=fmtp:100 x-google-start-bitrate=1500;x-google-min-bitrate=600;x-google-max-bitrate=2500/);
    assert.match(out, /a=fmtp:98 profile-level-id=42e01f;packetization-mode=1;x-google-start-bitrate=1500/);
    assert.doesNotMatch(out, /a=fmtp:111 .*x-google/);
    assert.doesNotMatch(out, /a=fmtp:101 .*x-google/);
    assert.ok(out.includes('\r\n'), 'keeps CRLF line endings');
  });

  test('is idempotent and leaves SDP without video untouched', () => {
    const once = addVideoBitrateHints(answer);
    assert.equal(addVideoBitrateHints(once), once);
    const audioOnly = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n';
    assert.equal(addVideoBitrateHints(audioOnly), audioOnly);
  });
});
