export function captureCallPresentation(manager) {
    return {
        callEpoch: manager?.callEpoch ?? null,
        callId: manager?._callIdIsSynthetic ? null : (manager?.callId == null ? null : String(manager.callId))
    };
}

export function isCurrentCallPresentation(manager, presentation) {
    if (!presentation || manager?.callEpoch !== presentation.callEpoch) return false;
    if (presentation.callId == null) return true;
    return manager?.callId != null && String(manager.callId) === presentation.callId;
}

export function runIfCurrentCallPresentation(manager, presentation, callback) {
    if (!isCurrentCallPresentation(manager, presentation)) return false;
    callback();
    return true;
}

export function scheduleCallPresentation(manager, callback, delayMs, schedule = setTimeout) {
    const presentation = captureCallPresentation(manager);
    return schedule(() => runIfCurrentCallPresentation(manager, presentation, callback), delayMs);
}
