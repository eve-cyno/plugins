"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listingAdmit = listingAdmit;
const names_1 = require("./names");
const zipread_1 = require("./zipread");
/**
 * parseCatalog's `admit` (R27, R26): a listing whose id starts with a Windows device name (its folder could not exist there) or whose name or
 * author reads as the host's (unless the listing is first-party) is dropped from the catalog, for plugins and theme packages alike.
 */
function listingAdmit(l) {
    return !(0, zipread_1.isDeviceNameId)(l.id) && (0, names_1.nameAllowed)({ name: l.name, author: l.author }, 'market', l.firstParty === true) === true;
}
