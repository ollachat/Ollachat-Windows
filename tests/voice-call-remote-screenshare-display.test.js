import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceCallManager } from '../src/call/voice-call-manager.js';

// Regression: in a VOICE call the SFU offer that announces a remote screen share is handled before the video
// track arrives, so the <video> element is first bound to the audio-only remote stream. When the video track is
// added to that same MediaStream object, assigning `srcObject = sameStream` again is a no-op in Chromium and the
// receiver saw nothing. The element must be re-bound when the stream's video tracks change.

class Track { constructor(kind, id) { this.kind = kind; this.id = id; this.readyState = 'live'; } }
class Stream {
  constructor(tracks) { this.tracks = tracks; }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
  getTracks() { return this.tracks; }
  addTrack(t) { this.tracks.push(t); }
}
class VideoElement {
  constructor() { this._src = null; this.assignments = []; }
  get srcObject() { return this._src; }
  set srcObject(v) { this.assignments.push(v); this._src = v; }
  play() { return Promise.resolve(); }
}

function managerWithStream(stream, element) {
  const m = Object.create(VoiceCallManager.prototype);
  m.callEpoch = 1;
  m.peerConnection = {};
  m._remoteStream = stream;
  m.remoteVideoElement = element;
  m._playbackDiagnostics = new Set();
  m._isCurrentEpoch = (e) => e === 1;
  m._mediaLogOnce = () => {};
  m._mediaLog = () => {};
  return m;
}

describe('remote screen share in a voice call', () => {
  test('video element is re-bound when a video track is added to the same remote stream', () => {
    const stream = new Stream([new Track('audio', 'a1')]);
    const el = new VideoElement();
    const m = managerWithStream(stream, el);

    // 1. Share announced by the SFU offer: element bound while the stream is audio-only.
    m._playRemoteElement(el, 'video', 1, m.peerConnection);
    assert.equal(el.srcObject, stream);

    // 2. The screen-share video track arrives on the same stream object.
    stream.addTrack(new Track('video', 'v1'));
    const before = el.assignments.length;
    m._playRemoteElement(el, 'video', 1, m.peerConnection);

    // It must be detached (null) and re-attached, so the browser picks up the new video track.
    const after = el.assignments.slice(before);
    assert.deepEqual(after, [null, stream]);
  });

  test('no needless re-bind when the video tracks are unchanged', () => {
    const stream = new Stream([new Track('audio', 'a1'), new Track('video', 'v1')]);
    const el = new VideoElement();
    const m = managerWithStream(stream, el);
    m._playRemoteElement(el, 'video', 1, m.peerConnection);
    const before = el.assignments.length;
    m._playRemoteElement(el, 'video', 1, m.peerConnection);
    assert.deepEqual(el.assignments.slice(before), [stream]);
  });
});
