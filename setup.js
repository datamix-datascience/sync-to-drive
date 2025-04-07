const { execSync } = require("child_process");
const path = require("path");

try {
  console.log("Installing additional dependencies...");
  execSync("npm install @actions/exec @octokit/rest", {
    stdio: "inherit",
    cwd: path.resolve(__dirname),
  });
  console.log("Dependencies installed successfully.");
} catch (error) {
  console.error("Failed to install dependencies:", error.message);
  process.exit(1);
}
