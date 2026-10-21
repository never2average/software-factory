// A validator that accepts a workspace holding notes.txt (argv[2] is the workspace directory).
import { existsSync } from "node:fs";
import path from "node:path";

process.exit(existsSync(path.join(process.argv[2], "notes.txt")) ? 0 : 1);
