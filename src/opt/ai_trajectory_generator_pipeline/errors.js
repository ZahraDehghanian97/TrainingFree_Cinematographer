"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getErrorMessage = getErrorMessage;
var zod_1 = require("zod");
/**
 * TypeScript types caught exceptions as `unknown` (not `Error`) under
 * strict mode, since JS allows throwing any value. This safely extracts a
 * readable message without an unchecked `as Error` cast: Zod validation
 * errors get their own readable formatting, real Errors use `.message`,
 * and anything else falls back to a best-effort string conversion.
 */
function getErrorMessage(e) {
    if (e instanceof zod_1.z.ZodError) {
        return e.issues.map(function (i) { return "".concat(i.path.join("."), ": ").concat(i.message); }).join("; ");
    }
    if (e instanceof Error) {
        return e.message;
    }
    return String(e);
}
