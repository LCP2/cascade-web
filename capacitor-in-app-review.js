/* CAS-969: vendored verbatim from node_modules/@capacitor-community/in-app-review/dist/plugin.js (v8.0.0).
   Loading this after capacitor-core.js registers Capacitor.Plugins.InAppReview as a side effect. */
var capacitorInAppReview = (function (exports, core) {
	'use strict';

	const InAppReview = core.registerPlugin('InAppReview', {
	    web: () => Promise.resolve().then(function () { return web; }).then((m) => new m.InAppReviewWeb()),
	});

	class InAppReviewWeb extends core.WebPlugin {
	    async requestReview() {
	        throw this.unimplemented('Not implemented on web.');
	    }
	}

	var web = /*#__PURE__*/Object.freeze({
	    __proto__: null,
	    InAppReviewWeb: InAppReviewWeb
	});

	exports.InAppReview = InAppReview;

	return exports;

})({}, capacitorExports);
