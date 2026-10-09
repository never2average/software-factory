#!/usr/bin/env node
/**
 * The sign-in command's file under its pre-rename name, kept so an engineer's
 * `node setup/fde-login.mjs` (or an MCP config naming this path) still works.
 * The code is in workspace-login.mjs; this re-exports it, and runs the command
 * when this file is the one node was asked to run.
 */
import { isEntrypointFile, runLoginCommand } from "./workspace-login.mjs";

export * from "./workspace-login.mjs";

if (isEntrypointFile(import.meta.url)) runLoginCommand();
