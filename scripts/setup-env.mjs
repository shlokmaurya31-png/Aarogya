// First-run helper for `npm run setup`: creates .env from .env.example with a
// random AUTH_SECRET. Never touches an existing .env.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

if (existsSync(".env")) {
  console.log(".env already exists; leaving it unchanged.");
} else {
  copyFileSync(".env.example", ".env");
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(".env", readFileSync(".env", "utf8").replace(/^AUTH_SECRET=$/m, `AUTH_SECRET="${secret}"`));
  console.log("Created .env from .env.example with a random AUTH_SECRET.");
}
