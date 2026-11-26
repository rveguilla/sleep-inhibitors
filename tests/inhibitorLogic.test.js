import assert from 'node:assert/strict';
import test from 'node:test';

import {
    GSM_INHIBITOR_FLAGS,
    filterAndSortInhibitors,
    formatSessionFlags,
    parseLogindInhibitor,
    parseSessionInhibitor,
} from '../inhibitorLogic.js';

test('parseLogindInhibitor identifies sleep/idle block locks as active sleep blockers', () => {
    const item = parseLogindInhibitor([
        'sleep:idle',
        'systemd-inhibit',
        'Downloading ISO image',
        'block',
        1000,
        4242,
    ]);

    assert.equal(item.source, 'logind');
    assert.equal(item.name, 'systemd-inhibit');
    assert.equal(item.reason, 'Downloading ISO image');
    assert.equal(item.pid, 4242);
    assert.equal(item.isSleepBlocker, true);
    assert.equal(item.detailLabel, 'Sleep, Idle (Block)');
});

test('parseLogindInhibitor marks delay locks and non-sleep locks as non-blockers', () => {
    const delayLock = parseLogindInhibitor([
        'sleep',
        'NetworkManager',
        'NetworkManager needs to turn off networks',
        'delay',
        0,
        901,
    ]);
    assert.equal(delayLock.isSleepBlocker, false);
    assert.equal(delayLock.detailLabel, 'Sleep (Delay)');

    const lidLock = parseLogindInhibitor([
        'handle-lid-switch',
        'GNOME Shell',
        'External monitor attached',
        'block',
        1000,
        2001,
    ]);
    assert.equal(lidLock.isSleepBlocker, false);
    assert.equal(lidLock.detailLabel, 'Lid Switch (Block)');
});

test('parseLogindInhibitor handles empty who/why fields gracefully', () => {
    const item = parseLogindInhibitor(['sleep', '', '', 'block', 1000, 1234]);
    assert.equal(item.name, 'PID 1234');
    assert.equal(item.reason, 'No reason provided');
    assert.equal(item.isSleepBlocker, true);
});

test('formatSessionFlags decodes GNOME Session Manager bitmask', () => {
    const flags = GSM_INHIBITOR_FLAGS.SUSPEND | GSM_INHIBITOR_FLAGS.IDLE;
    assert.deepEqual(formatSessionFlags(flags), ['Suspend', 'Idle']);

    const logoutOnly = GSM_INHIBITOR_FLAGS.LOGOUT;
    assert.deepEqual(formatSessionFlags(logoutOnly), ['Logout']);
});

test('parseSessionInhibitor classifies suspend/idle flags and cleans appId', () => {
    const blocker = parseSessionInhibitor({
        objectPath: '/org/gnome/SessionManager/Inhibitor1',
        appId: 'org.mozilla.firefox.desktop',
        reason: 'Playing video',
        flags: GSM_INHIBITOR_FLAGS.IDLE,
        displayName: 'Firefox',
    });

    assert.equal(blocker.name, 'Firefox');
    assert.equal(blocker.isSleepBlocker, true);
    assert.equal(blocker.detailLabel, 'Idle');

    const fallbackName = parseSessionInhibitor({
        objectPath: '/org/gnome/SessionManager/Inhibitor2',
        appId: 'vlc.desktop',
        reason: 'Playing movie',
        flags: GSM_INHIBITOR_FLAGS.SUSPEND,
    });
    assert.equal(fallbackName.name, 'vlc');
    assert.equal(fallbackName.isSleepBlocker, true);

    const logoutOnly = parseSessionInhibitor({
        objectPath: '/org/gnome/SessionManager/Inhibitor3',
        appId: 'org.gnome.TextEditor',
        reason: 'Unsaved changes',
        flags: GSM_INHIBITOR_FLAGS.LOGOUT,
    });
    assert.equal(logoutOnly.isSleepBlocker, false);
    assert.equal(logoutOnly.detailLabel, 'Logout');
});

test('filterAndSortInhibitors hides passive locks by default and sorts active blockers first', () => {
    const items = [
        parseLogindInhibitor(['sleep', 'NetworkManager', 'Delay lock', 'delay', 0, 100]),
        parseSessionInhibitor({
            objectPath: '/org/gnome/SessionManager/Inhibitor2',
            appId: 'vlc',
            reason: 'Movie',
            flags: GSM_INHIBITOR_FLAGS.IDLE,
            displayName: 'VLC',
        }),
        parseLogindInhibitor(['sleep', 'Backup Script', 'Running rsync', 'block', 1000, 500]),
    ];

    const defaultView = filterAndSortInhibitors(items, {includeAll: false});
    assert.equal(defaultView.activeCount, 2);
    assert.equal(defaultView.totalCount, 3);
    assert.deepEqual(
        defaultView.visible.map(i => i.name),
        ['Backup Script', 'VLC']
    );

    const fullView = filterAndSortInhibitors(items, {includeAll: true});
    assert.equal(fullView.activeCount, 2);
    assert.equal(fullView.totalCount, 3);
    assert.deepEqual(
        fullView.visible.map(i => i.name),
        ['Backup Script', 'VLC', 'NetworkManager']
    );
});
