import { execSync } from "child_process";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

try {
  console.log("Installing additional dependencies...");
  execSync("cat package.json", {
    stdio: "inherit",
    cwd: resolve(__dirname),
  });
  execSync("npm install", {
    stdio: "inherit",
    cwd: resolve(__dirname),
  });
  execSync("ls -R dist", {
    stdio: "inherit",
    cwd: resolve(__dirname),
  });
  console.log("Dependencies installed successfully.");
} catch (error) {
  console.error("Failed to install dependencies:", error.message);
  process.exit(1);
}
