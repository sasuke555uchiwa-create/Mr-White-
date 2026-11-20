"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENFORCE_APP_CHECK = void 0;
exports.getCallableOptions = getCallableOptions;
/**
 * Enable strict Firebase App Check enforcement in production by setting
 * ENFORCE_APP_CHECK=true in Cloud Functions environment configuration once
 * VITE_FIREBASE_APPCHECK_SITE_KEY is configured on the web client.
 */
exports.ENFORCE_APP_CHECK = process.env.ENFORCE_APP_CHECK === 'true';
function getCallableOptions(overrides = {}) {
    return {
        enforceAppCheck: exports.ENFORCE_APP_CHECK,
        consumeAppCheckToken: false,
        ...overrides,
    };
}
//# sourceMappingURL=callableConfig.js.map