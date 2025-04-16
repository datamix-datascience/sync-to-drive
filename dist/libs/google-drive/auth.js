"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.auth = exports.credentials_json = exports.drive = void 0;
const core = __importStar(require("@actions/core"));
const googleapis_1 = require("googleapis");
const credentials_input = core.getInput("credentials", { required: true });
let credentials_json;
try {
    exports.credentials_json = credentials_json = JSON.parse(Buffer.from(credentials_input, "base64").toString());
    if (!credentials_json.client_email || !credentials_json.private_key) {
        throw new Error("Credentials JSON must contain 'client_email' and 'private_key'");
    }
}
catch (error) {
    core.setFailed("Failed to parse credentials JSON: " + error.message);
    throw new Error("Credentials parsing failed"); // Re-throw
}
const auth = new googleapis_1.google.auth.JWT(credentials_json.client_email, undefined, credentials_json.private_key, ["https://www.googleapis.com/auth/drive"]);
exports.auth = auth;
const drive = googleapis_1.google.drive({ version: "v3", auth });
exports.drive = drive;
