# Contributing to Filesystem MCP Server

Thank you for contributing! Here's how to get started.

## Setup

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/filesystem-mcp.git`
3. Add upstream remote: `git remote add upstream https://github.com/j0hanz/filesystem-mcp.git`
4. Install dependencies: `npm install`

## Branch Workflow

1. Create a feature branch from `main`: `git checkout -b feat/your-feature`
2. Make commits with clear messages.
3. Push to your fork: `git push origin feat/your-feature`
4. Open a pull request against the upstream repository.

## Running Tests Locally

This project uses a thin task wrapper around the npm scripts and Node test runner:

```bash
# Run tests only
node scripts/tasks.mjs test
```

Tests must pass before your PR is merged.

## PR Checklist

- [ ] Tests pass locally (`node scripts/tasks.mjs`)
- [ ] No new console warnings or errors
- [ ] Commit messages are clear and descriptive
- [ ] Code follows the project's style guide (run `node scripts/tasks.mjs fix`)
- [ ] Related issues are referenced in the PR description

## Code Style

Use the task runner to check formatting and apply auto-fixes:

```bash
# Fix linting and formatting issues
node scripts/tasks.mjs fix

# Full static analysis check without tests
node scripts/tasks.mjs --quick
```

## Commit Messages

We use free-form commit messages. However, when making breaking changes, clearly note this in your commit message. Ensure your message describes both what the commit does and why.
