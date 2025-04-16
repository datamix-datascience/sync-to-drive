import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
const github_token_input = core.getInput('github_token', { required: true });
const octokit = new Octokit({
    auth: github_token_input,
    // Optional: Add retries and throttling plugins for robustness
    // request: {
    //   retries: 3,
    //   retryAfter: 5,
    // },
});
export { octokit };
