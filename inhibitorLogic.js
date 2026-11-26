/**
 * Pure parsing, classification, and formatting helpers for sleep/idle inhibitors.
 * Kept free of GI/GNOME imports so it can be unit-tested directly with Node.js.
 */

export const GSM_INHIBITOR_FLAGS = Object.freeze({
    LOGOUT: 1 << 0,      // 1
    SWITCH_USER: 1 << 1, // 2
    SUSPEND: 1 << 2,     // 4
    IDLE: 1 << 3,        // 8
    AUTOMOUNT: 1 << 4,   // 16
});

const LOGIND_WHAT_LABELS = Object.freeze({
    'sleep': 'Sleep',
    'idle': 'Idle',
    'shutdown': 'Shutdown',
    'handle-power-key': 'Power Key',
    'handle-suspend-key': 'Suspend Key',
    'handle-hibernate-key': 'Hibernate Key',
    'handle-lid-switch': 'Lid Switch',
});

const LOGIND_SLEEP_WHAT = new Set(['sleep', 'idle']);

/**
 * Parse a single tuple from org.freedesktop.login1.Manager.ListInhibitors().
 * Tuple format: [what, who, why, mode, uid, pid]
 *
 * @param {Array} tuple
 * @returns {object} Normalized inhibitor object
 */
export function parseLogindInhibitor(tuple) {
    const [whatRaw = '', who = '', why = '', mode = '', uid = 0, pid = 0] = tuple;
    const whatList = String(whatRaw)
        .split(':')
        .map(s => s.trim())
        .filter(Boolean);

    const blocksSleepOrIdle =
        mode === 'block' && whatList.some(item => LOGIND_SLEEP_WHAT.has(item));

    const whatLabels = whatList.map(item => LOGIND_WHAT_LABELS[item] ?? item);
    const modeLabel = mode === 'block' ? 'Block' : mode === 'delay' ? 'Delay' : mode;

    return {
        id: `logind:${pid}:${who}:${whatRaw}:${mode}`,
        source: 'logind',
        sourceLabel: 'systemd-logind',
        name: who || (pid ? `PID ${pid}` : 'Unknown Process'),
        appId: null,
        reason: why || 'No reason provided',
        what: whatList,
        mode,
        uid: Number(uid),
        pid: Number(pid),
        isSleepBlocker: blocksSleepOrIdle,
        detailLabel: `${whatLabels.join(', ')}${modeLabel ? ` (${modeLabel})` : ''}`,
    };
}

/**
 * Format GNOME Session Manager inhibitor bitmask flags into human-readable labels.
 *
 * @param {number} flags
 * @returns {string[]}
 */
export function formatSessionFlags(flags) {
    const labels = [];
    if (flags & GSM_INHIBITOR_FLAGS.SUSPEND)
        labels.push('Suspend');
    if (flags & GSM_INHIBITOR_FLAGS.IDLE)
        labels.push('Idle');
    if (flags & GSM_INHIBITOR_FLAGS.LOGOUT)
        labels.push('Logout');
    if (flags & GSM_INHIBITOR_FLAGS.SWITCH_USER)
        labels.push('Switch User');
    if (flags & GSM_INHIBITOR_FLAGS.AUTOMOUNT)
        labels.push('Automount');
    return labels;
}

/**
 * Parse a GNOME Session Manager inhibitor record.
 *
 * @param {object} record
 * @param {string} record.objectPath
 * @param {string} record.appId
 * @param {string} record.reason
 * @param {number} record.flags
 * @param {string|null} [record.displayName]
 * @returns {object} Normalized inhibitor object
 */
export function parseSessionInhibitor({
    objectPath = '',
    appId = '',
    reason = '',
    flags = 0,
    displayName = null,
}) {
    const numericFlags = Number(flags) || 0;
    const flagLabels = formatSessionFlags(numericFlags);
    const isSleepBlocker = Boolean(
        numericFlags & (GSM_INHIBITOR_FLAGS.SUSPEND | GSM_INHIBITOR_FLAGS.IDLE)
    );

    const cleanedAppId = String(appId || '').replace(/\.desktop$/i, '');
    const name = displayName || cleanedAppId || 'Unknown Application';

    return {
        id: `session:${objectPath}`,
        source: 'session',
        sourceLabel: 'GNOME Session',
        name,
        appId: appId || null,
        reason: reason || 'No reason provided',
        flags: numericFlags,
        pid: null,
        uid: null,
        isSleepBlocker,
        detailLabel: flagLabels.length > 0 ? flagLabels.join(', ') : 'Inhibiting',
    };
}

/**
 * Filter and sort inhibitors for display.
 * Active sleep/idle blockers are always sorted first, then alphabetically by name.
 *
 * @param {object[]} inhibitors
 * @param {object} [options]
 * @param {boolean} [options.includeAll=false] Include delay/system/non-sleep locks
 * @returns {{ visible: object[], activeCount: number, totalCount: number }}
 */
export function filterAndSortInhibitors(inhibitors, {includeAll = false} = {}) {
    const activeCount = inhibitors.filter(item => item.isSleepBlocker).length;
    const filtered = includeAll
        ? [...inhibitors]
        : inhibitors.filter(item => item.isSleepBlocker);

    filtered.sort((a, b) => {
        if (a.isSleepBlocker !== b.isSleepBlocker)
            return a.isSleepBlocker ? -1 : 1;
        const nameCmp = a.name.localeCompare(b.name, undefined, {sensitivity: 'base'});
        if (nameCmp !== 0)
            return nameCmp;
        return a.reason.localeCompare(b.reason, undefined, {sensitivity: 'base'});
    });

    return {
        visible: filtered,
        activeCount,
        totalCount: inhibitors.length,
    };
}
