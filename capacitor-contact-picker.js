/* CAS-932: hand-written local plugin — NOT vendored from an npm package, unlike the other
   capacitor-*.js files here. Two published candidates were checked against the ticket's requirement
   (a single-contact pick with no contacts permission on either platform) and neither qualified:
   - @calvinckho/capacitor-contact-picker v1.0.4 (ios/Plugin/Plugin.swift, `open()`): gates
     CNContactPickerViewController behind `Permissions.contactPermission` -> CNContactStore.requestAccess,
     and its README requires an NSContactsUsageDescription — exactly the permission dialog CAS-932 rules out.
   - @capacitor/contacts v1.0.1 (ionic-team/capacitor-contacts, `pickContact`): the iOS side presents
     CNContactPickerViewController directly with no permission call (confirmed from
     ios/Sources/ContactsPlugin/ContactsPlugin.swift), but the Android side's `pickContact` still runs
     `ensurePermission` -> requests READ_CONTACTS before presenting the picker (android/.../ContactsPlugin.kt).
   Cascade ships iOS only (no android/ platform in this repo), so only the iOS gap mattered here, but the
   ticket asks for a plugin whose pick call needs no permission on either platform, and neither did, so
   this ticket implements the pick natively instead — see ios/App/App/Plugins/ContactPicker.swift, modelled
   on the verified-safe half of @capacitor/contacts' own iOS implementation (CNContactPickerViewController,
   no CNContactStore access of any kind).
   Loading this after capacitor-core.js registers Capacitor.Plugins.ContactPicker as a side effect, the
   same as every other vendored plugin file here (see capacitor-app.js's header comment for why globals
   instead of a bundler). */
var capacitorContactPicker = (function (exports, core) {
	'use strict';

	const ContactPicker = core.registerPlugin('ContactPicker', {
	    web: () => Promise.resolve().then(function () { return web; }).then((m) => new m.ContactPickerWeb()),
	});

	class ContactPickerWeb extends core.WebPlugin {
	    async pickContact() {
	        throw this.unimplemented('Not implemented on web.');
	    }
	}

	var web = /*#__PURE__*/Object.freeze({
	    __proto__: null,
	    ContactPickerWeb: ContactPickerWeb
	});

	exports.ContactPicker = ContactPicker;

	return exports;

})({}, capacitorExports);
