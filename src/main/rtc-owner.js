export function normalizeRtcOwner(owner = {}, roomId = null, generation = null) {
    const callEpoch = owner?.callEpoch ?? null;
    const ownerId = owner?.ownerId || (callEpoch != null ? `call-${callEpoch}` : null);
    return {
        ownerId: ownerId ? String(ownerId) : null,
        callEpoch,
        callId: owner?.callId ? String(owner.callId) : null,
        roomId: roomId || owner?.roomId || null,
        generation
    };
}

export function rtcOwnerMatches(owner = {}, requestedOwner = null) {
    if (!requestedOwner) return true;
    const hasOwnerIdentity = owner?.ownerId != null || owner?.callEpoch != null;
    if (!hasOwnerIdentity) return false;
    if (owner.ownerId != null && String(owner.ownerId) !== requestedOwner.ownerId) return false;
    if (owner.callEpoch != null && Number(owner.callEpoch) !== Number(requestedOwner.callEpoch)) return false;
    return true;
}
