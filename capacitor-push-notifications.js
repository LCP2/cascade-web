/* CAS-463: vendored verbatim from node_modules/@capacitor/push-notifications/dist/plugin.js (v8.1.2).
   Loading this after capacitor-core.js registers Capacitor.Plugins.PushNotifications as a side effect. */
var capacitorPushNotifications = (function (exports, core) {
	'use strict';

	const PushNotifications = core.registerPlugin('PushNotifications', {});

	exports.PushNotifications = PushNotifications;

	return exports;

})({}, capacitorExports);
