import { round2, round6 } from "../lib/nums.js";
import { sha256 } from "../lib/migrate.js";
import { signSession, verifySession } from "../lib/security.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  assert(round2(1.005) === 1, "round2 should be stable")
  assert(round2(1.015) === 1.01, "round2 should round to 2 decimals")
  assert(round6(1.0000004) === 1, "round6 should round to 6 decimals")

  const h = sha256("abc")
  assert(typeof h === "string" && h.length === 64, "sha256 should return hex")

  const jwt = signSession({ userId: "u1", orgId: "o1" })
  const claims = verifySession(jwt)
  assert(claims.userId === "u1", "session userId should match")
  assert(claims.orgId === "o1", "session orgId should match")
}

main()
  .then(() => {
    process.stdout.write("OK\n")
  })
  .catch((e) => {
    process.stderr.write(String(e?.message || e) + "\n")
    process.exit(1)
  })

