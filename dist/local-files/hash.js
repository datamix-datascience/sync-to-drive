import * as fs_promises from "fs/promises";
import { createHash } from "crypto";
// Compute file hash
export async function compute_hash(file_path) {
    const content = await fs_promises.readFile(file_path);
    return createHash("md5").update(content).digest("hex");
}
