const { execSync } = require("child_process");
const path = require("path");

try {
  console.log("Installing additional dependencies...");
  execSync("cat package.json", {
    stdio: "inherit",
    cwd: path.resolve(__dirname),
  });
  execSync("npm install", {
    stdio: "inherit",
    cwd: path.resolve(__dirname),
  });
  execSync("ls -R dist", {
    stdio: "inherit",
    cwd: path.resolve(__dirname),
  });
  console.log("Dependencies installed successfully.");
} catch (error) {
  console.error("Failed to install dependencies:", error.message);
  process.exit(1);
}
