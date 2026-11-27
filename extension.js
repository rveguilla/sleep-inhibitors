import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {filterAndSortInhibitors} from './inhibitorLogic.js';
import {InhibitorMonitor} from './inhibitors.js';

/**
 * Create a vertical St.BoxLayout compatible across GNOME Shell 45-51.
 */
function createVerticalBox(params = {}) {
    const box = new St.BoxLayout(params);
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

const SleepInhibitorsIndicator = GObject.registerClass(
class SleepInhibitorsIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Sleep Inhibitors');

        this._inhibitors = [];
        this._includeAllLocks = false;

        // Top bar button contents: icon + count badge
        this._panelBox = new St.BoxLayout({
            style_class: 'panel-status-menu-box sleep-inhibitors-panel-box',
        });

        this._icon = new St.Icon({
            icon_name: 'weather-clear-night-symbolic',
            style_class: 'system-status-icon sleep-inhibitors-icon',
        });

        this._countLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'sleep-inhibitors-count',
            visible: false,
        });

        this._panelBox.add_child(this._icon);
        this._panelBox.add_child(this._countLabel);
        this.add_child(this._panelBox);

        // Dropdown menu layout
        this._headerItem = new PopupMenu.PopupMenuItem('Checking sleep inhibitors…', {
            reactive: false,
            can_focus: false,
            style_class: 'sleep-inhibitors-header',
        });
        this.menu.addMenuItem(this._headerItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._listSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._listSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._showAllToggle = new PopupMenu.PopupSwitchMenuItem(
            'Show system & delay locks',
            this._includeAllLocks
        );
        this._showAllSignalId = this._showAllToggle.connect('toggled', (_item, state) => {
            this._includeAllLocks = state;
            this._render();
        });
        this.menu.addMenuItem(this._showAllToggle);

        this._refreshItem = new PopupMenu.PopupMenuItem('Refresh');
        this._refreshSignalId = this._refreshItem.connect('activate', () => {
            this._monitor?.refresh();
        });
        this.menu.addMenuItem(this._refreshItem);

        // Refresh immediately whenever the user opens the menu
        this._menuOpenSignalId = this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._monitor?.refresh();
        });

        this._monitor = new InhibitorMonitor(inhibitors => {
            this._inhibitors = inhibitors;
            this._render();
        });

        this._render();
    }

    _render() {
        const {visible, activeCount, totalCount} = filterAndSortInhibitors(
            this._inhibitors,
            {includeAll: this._includeAllLocks}
        );

        // Update top bar indicator appearance: dim when no apps are blocking sleep
        if (activeCount > 0) {
            this._icon.remove_style_class_name('sleep-inhibitors-inactive');
            this._icon.add_style_class_name('sleep-inhibitors-active');
            this._countLabel.text = `${activeCount}`;
            this._countLabel.visible = true;
        } else {
            this._icon.remove_style_class_name('sleep-inhibitors-active');
            this._icon.add_style_class_name('sleep-inhibitors-inactive');
            this._countLabel.text = '';
            this._countLabel.visible = false;
        }

        // Update header text
        if (activeCount === 0) {
            const hiddenNote = !this._includeAllLocks && totalCount > 0
                ? ` (${totalCount} system/delay)`
                : '';
            this._headerItem.label.text = `Nothing preventing sleep${hiddenNote}`;
        } else if (activeCount === 1) {
            this._headerItem.label.text = '1 app preventing sleep';
        } else {
            this._headerItem.label.text = `${activeCount} apps preventing sleep`;
        }

        // Rebuild inhibitor list
        this._listSection.removeAll();

        if (visible.length === 0) {
            const emptyItem = new PopupMenu.PopupMenuItem('Your computer can sleep normally.', {
                reactive: false,
                can_focus: false,
                style_class: 'sleep-inhibitors-empty',
            });
            this._listSection.addMenuItem(emptyItem);
            return;
        }

        for (const item of visible)
            this._listSection.addMenuItem(this._createInhibitorMenuItem(item));
    }

    _createInhibitorMenuItem(inhibitor) {
        const menuItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'sleep-inhibitors-item',
        });

        const icon = new St.Icon({
            icon_size: 20,
            y_align: Clutter.ActorAlign.START,
            style_class: 'sleep-inhibitors-item-icon',
        });

        if (inhibitor.gicon) {
            icon.gicon = inhibitor.gicon;
        } else if (inhibitor.source === 'session') {
            icon.icon_name = 'application-x-executable-symbolic';
        } else {
            icon.icon_name = 'utilities-terminal-symbolic';
        }

        const textBox = createVerticalBox({
            x_expand: true,
            style_class: 'sleep-inhibitors-item-body',
        });

        const titleRow = new St.BoxLayout({
            x_expand: true,
            style_class: 'sleep-inhibitors-item-title-row',
        });

        const nameLabel = new St.Label({
            text: inhibitor.name,
            x_expand: true,
            style_class: inhibitor.isSleepBlocker
                ? 'sleep-inhibitors-item-name'
                : 'sleep-inhibitors-item-name sleep-inhibitors-muted',
        });

        const badgeLabel = new St.Label({
            text: inhibitor.detailLabel,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: inhibitor.isSleepBlocker
                ? 'sleep-inhibitors-badge sleep-inhibitors-badge-active'
                : 'sleep-inhibitors-badge sleep-inhibitors-badge-passive',
        });

        titleRow.add_child(nameLabel);
        titleRow.add_child(badgeLabel);

        const reasonLabel = new St.Label({
            text: inhibitor.reason,
            style_class: 'sleep-inhibitors-item-reason',
        });
        reasonLabel.clutter_text.line_wrap = true;

        const metaParts = [inhibitor.sourceLabel];
        if (inhibitor.pid)
            metaParts.push(`PID ${inhibitor.pid}`);

        const metaLabel = new St.Label({
            text: metaParts.join(' · '),
            style_class: 'sleep-inhibitors-item-meta',
        });

        textBox.add_child(titleRow);
        textBox.add_child(reasonLabel);
        textBox.add_child(metaLabel);

        menuItem.add_child(icon);
        menuItem.add_child(textBox);

        return menuItem;
    }

    destroy() {
        if (this._showAllSignalId) {
            this._showAllToggle?.disconnect(this._showAllSignalId);
            this._showAllSignalId = 0;
        }

        if (this._refreshSignalId) {
            this._refreshItem?.disconnect(this._refreshSignalId);
            this._refreshSignalId = 0;
        }

        if (this._menuOpenSignalId) {
            this.menu.disconnect(this._menuOpenSignalId);
            this._menuOpenSignalId = 0;
        }

        if (this._monitor) {
            this._monitor.destroy();
            this._monitor = null;
        }

        super.destroy();
    }
});

export default class SleepInhibitorsExtension extends Extension {
    enable() {
        this._indicator = new SleepInhibitorsIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
