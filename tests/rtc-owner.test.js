import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRtcOwner, rtcOwnerMatches } from '../src/main/rtc-owner.js';

test('RTC owner normalization derives stable ownership metadata from the call epoch', () => {
    assert.deepEqual(
        normalizeRtcOwner({ callEpoch: 7, callId: 'call-7' }, 'room-7', 11),
        {
            ownerId: 'call-7',
            callEpoch: 7,
            callId: 'call-7',
            roomId: 'room-7',
            generation: 11
        }
    );
});

test('ownerless legacy leave/disconnect is accepted only when no RTC owner exists', () => {
    assert.equal(rtcOwnerMatches({}, null), true);

    const activeOwner = normalizeRtcOwner({
        ownerId: 'call-2',
        callEpoch: 2,
        callId: 'current-call'
    }, 'room-shared', 4);

    assert.equal(rtcOwnerMatches({}, activeOwner), false);
});

test('stale owner cannot leave or disconnect an actively owned RTC connection', () => {
    const activeOwner = normalizeRtcOwner({
        ownerId: 'call-2',
        callEpoch: 2,
        callId: 'current-call'
    }, 'room-shared', 4);

    assert.equal(rtcOwnerMatches({ ownerId: 'call-1', callEpoch: 1 }, activeOwner), false);
    assert.equal(rtcOwnerMatches({ ownerId: 'call-2', callEpoch: 1 }, activeOwner), false);
});

test('valid current owner can leave or disconnect its RTC connection', () => {
    const activeOwner = normalizeRtcOwner({
        ownerId: 'call-2',
        callEpoch: 2,
        callId: 'current-call'
    }, 'room-shared', 4);

    assert.equal(rtcOwnerMatches({ ownerId: 'call-2', callEpoch: 2 }, activeOwner), true);
    assert.equal(rtcOwnerMatches({ ownerId: 'call-2' }, activeOwner), true);
    assert.equal(rtcOwnerMatches({ callEpoch: 2 }, activeOwner), true);
});
