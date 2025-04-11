import * as core from "@actions/core";
import { google } from "googleapis";

const credentials_input = core.getInput("credentials", { required: true });
let credentials_json: { client_email: string; private_key: string };
try {
  credentials_json = JSON.parse(Buffer.from(credentials_input, "base64").toString());
  if (!credentials_json.client_email || !credentials_json.private_key) {
    throw new Error("Credentials JSON must contain 'client_email' and 'private_key'");
  }
} catch (error) {
  core.setFailed("Failed to parse credentials JSON: " + (error as Error).message);
  throw new Error("Credentials parsing failed"); // Re-throw
}

const auth = new google.auth.JWT(
  credentials_json.client_email,
  undefined,
  credentials_json.private_key,
  ["https://www.googleapis.com/auth/drive"]
);

const drive = google.drive({ version: "v3", auth });

export { drive, credentials_json, auth };
