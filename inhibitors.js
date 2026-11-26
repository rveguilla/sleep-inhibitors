import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {
    parseLogindInhibitor,
    parseSessionInhibitor,
} from './inhibitorLogic.js';

const LOGIND_BUS_NAME = 'org.freedesktop.login1';
const LOGIND_OBJECT_PATH = '/org/freedesktop/login1';
const LOGIND_INTERFACE = 'org.freedesktop.login1.Manager';

const SESSION_BUS_NAME = 'org.gnome.SessionManager';
const SESSION_OBJECT_PATH = '/org/gnome/SessionManager';
const SESSION_INTERFACE = 'org.gnome.SessionManager';
const SESSION_INHIBITOR_INTERFACE = 'org.gnome.SessionManager.Inhibitor';

const DBUS_PROPS_INTERFACE = 'org.freedesktop.DBus.Properties';
const POLL_INTERVAL_SECONDS = 10;

/**
 * Promise wrapper around Gio.DBusConnection.call() without mutating global prototypes.
 */
function dbusCall(connection, busName, objectPath, interfaceName, methodName, parameters, replyType, cancellable) {
    return new Promise((resolve, reject) => {
        connection.call(
            busName,
            objectPath,
            interfaceName,
            methodName,
            parameters,
            replyType,
            Gio.DBusCallFlags.NONE,
            5000,
            cancellable,
            (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (err) {
                    reject(err);
                }
            }
        );
    });
}

/**
 * Try to resolve a GNOME Session appId to a human-readable name and Gio.Icon.
 */
function resolveDesktopApp(appId) {
    if (!appId)
        return {displayName: null, gicon: null};

    try {
        const appSystem = Shell.AppSystem.get_default();
        const candidates = appId.endsWith('.desktop')
            ? [appId]
            : [`${appId}.desktop`, appId];

        for (const candidate of candidates) {
            const app = appSystem.lookup_app(candidate);
            if (app) {
                const appInfo = app.get_app_info?.();
                return {
                    displayName: app.get_name() || null,
                    gicon: appInfo ? appInfo.get_icon() : null,
                };
            }
        }
    } catch (_err) {
        // Fallback to raw appId if Shell.AppSystem lookup fails
    }

    return {displayName: null, gicon: null};
}

/**
 * Monitors sleep/idle inhibitors from both systemd-logind and GNOME Session Manager.
 */
export class InhibitorMonitor {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._cancellable = new Gio.Cancellable();
        this._destroyed = false;
        this._refreshInFlight = false;
        this._refreshQueued = false;

        this._logindSignalId = 0;
        this._sessionAddedSignalId = 0;
        this._sessionRemovedSignalId = 0;
        this._pollTimeoutId = 0;

        this._subscribeSignals();
        this._startPolling();
        this.refresh();
    }

    _subscribeSignals() {
        this._logindSignalId = Gio.DBus.system.signal_subscribe(
            LOGIND_BUS_NAME,
            DBUS_PROPS_INTERFACE,
            'PropertiesChanged',
            LOGIND_OBJECT_PATH,
            LOGIND_INTERFACE,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [, changedProps] = params.deepUnpack();
                if ('BlockInhibited' in changedProps || 'DelayInhibited' in changedProps)
                    this.refresh();
            }
        );

        this._sessionAddedSignalId = Gio.DBus.session.signal_subscribe(
            SESSION_BUS_NAME,
            SESSION_INTERFACE,
            'InhibitorAdded',
            SESSION_OBJECT_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            () => this.refresh()
        );

        this._sessionRemovedSignalId = Gio.DBus.session.signal_subscribe(
            SESSION_BUS_NAME,
            SESSION_INTERFACE,
            'InhibitorRemoved',
            SESSION_OBJECT_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            () => this.refresh()
        );
    }

    _startPolling() {
        this._pollTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            POLL_INTERVAL_SECONDS,
            () => {
                if (this._destroyed)
                    return GLib.SOURCE_REMOVE;
                this.refresh();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    async refresh() {
        if (this._destroyed)
            return;

        if (this._refreshInFlight) {
            this._refreshQueued = true;
            return;
        }

        this._refreshInFlight = true;
        try {
            const [logindItems, sessionItems] = await Promise.all([
                this._fetchLogindInhibitors(),
                this._fetchSessionInhibitors(),
            ]);

            if (!this._destroyed)
                this._onChanged([...sessionItems, ...logindItems]);
        } catch (err) {
            if (!err.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error('[sleep-inhibitors] Failed to refresh inhibitors:', err);
        } finally {
            this._refreshInFlight = false;
            if (this._refreshQueued && !this._destroyed) {
                this._refreshQueued = false;
                this.refresh();
            }
        }
    }

    async _fetchLogindInhibitors() {
        try {
            const reply = await dbusCall(
                Gio.DBus.system,
                LOGIND_BUS_NAME,
                LOGIND_OBJECT_PATH,
                LOGIND_INTERFACE,
                'ListInhibitors',
                null,
                new GLib.VariantType('(a(ssssuu))'),
                this._cancellable
            );

            const [tuples] = reply.deepUnpack();
            return tuples.map(tuple => parseLogindInhibitor(tuple));
        } catch (err) {
            if (!err.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn('[sleep-inhibitors] Could not query systemd-logind:', err.message);
            return [];
        }
    }

    async _fetchSessionInhibitors() {
        try {
            const reply = await dbusCall(
                Gio.DBus.session,
                SESSION_BUS_NAME,
                SESSION_OBJECT_PATH,
                SESSION_INTERFACE,
                'GetInhibitors',
                null,
                new GLib.VariantType('(ao)'),
                this._cancellable
            );

            const [objectPaths] = reply.deepUnpack();
            const results = await Promise.all(
                objectPaths.map(path => this._fetchSingleSessionInhibitor(path))
            );
            return results.filter(Boolean);
        } catch (err) {
            if (!err.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn('[sleep-inhibitors] Could not query GNOME SessionManager:', err.message);
            return [];
        }
    }

    async _fetchSingleSessionInhibitor(objectPath) {
        try {
            const [appIdReply, reasonReply, flagsReply] = await Promise.all([
                dbusCall(
                    Gio.DBus.session,
                    SESSION_BUS_NAME,
                    objectPath,
                    SESSION_INHIBITOR_INTERFACE,
                    'GetAppId',
                    null,
                    new GLib.VariantType('(s)'),
                    this._cancellable
                ),
                dbusCall(
                    Gio.DBus.session,
                    SESSION_BUS_NAME,
                    objectPath,
                    SESSION_INHIBITOR_INTERFACE,
                    'GetReason',
                    null,
                    new GLib.VariantType('(s)'),
                    this._cancellable
                ),
                dbusCall(
                    Gio.DBus.session,
                    SESSION_BUS_NAME,
                    objectPath,
                    SESSION_INHIBITOR_INTERFACE,
                    'GetFlags',
                    null,
                    new GLib.VariantType('(u)'),
                    this._cancellable
                ),
            ]);

            const [appId] = appIdReply.deepUnpack();
            const [reason] = reasonReply.deepUnpack();
            const [flags] = flagsReply.deepUnpack();
            const {displayName, gicon} = resolveDesktopApp(appId);

            const item = parseSessionInhibitor({
                objectPath,
                appId,
                reason,
                flags,
                displayName,
            });
            item.gicon = gicon;
            return item;
        } catch (err) {
            // Inhibitor may have disappeared between GetInhibitors and querying its properties
            if (!err.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug?.(`[sleep-inhibitors] Skipped vanished inhibitor ${objectPath}: ${err.message}`);
            return null;
        }
    }

    destroy() {
        this._destroyed = true;

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._logindSignalId) {
            Gio.DBus.system.signal_unsubscribe(this._logindSignalId);
            this._logindSignalId = 0;
        }

        if (this._sessionAddedSignalId) {
            Gio.DBus.session.signal_unsubscribe(this._sessionAddedSignalId);
            this._sessionAddedSignalId = 0;
        }

        if (this._sessionRemovedSignalId) {
            Gio.DBus.session.signal_unsubscribe(this._sessionRemovedSignalId);
            this._sessionRemovedSignalId = 0;
        }

        if (this._pollTimeoutId) {
            GLib.Source.remove(this._pollTimeoutId);
            this._pollTimeoutId = 0;
        }
    }
}
