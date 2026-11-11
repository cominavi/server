// Owner tool for the Google/Apple sign-in allowlist (cominavi/cominavi
// AGENTS.md, 2026-11-11). It talks to D1 through wrangler, so it uses the
// operator's own Cloudflare login.
//
//   pnpm exec tsx tools/sign-in-allowlist.ts invite --remote --label "Alice (testing)" [--expires-days 14]
//   pnpm exec tsx tools/sign-in-allowlist.ts list --remote
//   pnpm exec tsx tools/sign-in-allowlist.ts revoke --remote <entry-id>
//
// Pass --local for the local dev database, or --env staging with --remote for
// staging. The invite code is printed once and stored only as a hash.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const inviteAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const entryIDPattern = /^[0-9a-f]{32}$/;

export interface Target {
  location: "--remote" | "--local";
  environment?: string;
}

export function generateInviteCode(): string {
  const bytes = randomBytes(20);
  let code = "";
  for (const byte of bytes) code += inviteAlphabet[byte & 31];
  return code.match(/.{5}/g)!.join("-");
}

/** Must match `inviteCodeHash(normalizeInviteCode(code))` in the Worker. */
export function inviteCodeHash(code: string): string {
  const canonical = code.toUpperCase().replace(/[\s-]/g, "");
  return createHash("sha256")
    .update(`cominavi-sign-in-invite:v1:${canonical}`)
    .digest("hex");
}

export function sqlString(value: string): string {
  if (value.includes("\0")) throw new Error("NUL is not allowed.");
  return `'${value.replaceAll("'", "''")}'`;
}

export function inviteSQL(input: {
  entryID: string;
  label: string;
  codeHash: string;
  now: number;
  expiresAt: number | null;
}): string {
  if (!entryIDPattern.test(input.entryID)) throw new Error("Bad entry ID.");
  const label = input.label.trim();
  if (label.length < 1 || label.length > 200)
    throw new Error("--label must be 1–200 characters.");
  if (!/^[0-9a-f]{64}$/.test(input.codeHash)) throw new Error("Bad hash.");
  return `INSERT INTO sign_in_allowlist (
  entry_id, label, invite_code_hash, invite_expires_at, provider,
  provider_subject, bound_at, created_at, revoked_at
) VALUES (
  '${input.entryID}', ${sqlString(label)}, '${input.codeHash}',
  ${input.expiresAt ?? "NULL"}, NULL, NULL, NULL, ${input.now}, NULL
);`;
}

export const listSQL = `SELECT entry.entry_id, entry.label, entry.provider,
  entry.bound_at, entry.created_at, entry.invite_expires_at, entry.revoked_at,
  (SELECT user.public_id FROM user_identities AS identity
     JOIN users AS user ON user.id = identity.user_id
     WHERE identity.provider = entry.provider
       AND identity.provider_environment = ''
       AND identity.provider_subject = entry.provider_subject) AS user_public_id
FROM sign_in_allowlist AS entry
ORDER BY entry.revoked_at IS NOT NULL, entry.created_at;`;

/**
 * Revokes one entry and ends the bound user's sessions, unless that user can
 * still sign in another way (a production Circle.ms identity, or another
 * active entry). Statements run in order; the entry is marked last because
 * the earlier ones select users through it.
 */
export function revokeSQL(entryID: string, now: number): string {
  if (!entryIDPattern.test(entryID)) throw new Error("Bad entry ID.");
  const affectedUsers = `SELECT identity.user_id
    FROM user_identities AS identity
    JOIN sign_in_allowlist AS entry
      ON entry.provider = identity.provider
     AND entry.provider_subject = identity.provider_subject
    WHERE entry.entry_id = '${entryID}' AND entry.revoked_at IS NULL
      AND identity.provider_environment = ''
      AND NOT EXISTS (
        SELECT 1 FROM user_identities AS circlems
        WHERE circlems.user_id = identity.user_id
          AND circlems.provider = 'circlems'
          AND circlems.provider_environment = 'production'
      )
      AND NOT EXISTS (
        SELECT 1 FROM user_identities AS other_identity
        JOIN sign_in_allowlist AS other_entry
          ON other_entry.provider = other_identity.provider
         AND other_entry.provider_subject = other_identity.provider_subject
        WHERE other_identity.user_id = identity.user_id
          AND other_identity.provider_environment = ''
          AND other_entry.entry_id <> '${entryID}'
          AND other_entry.revoked_at IS NULL
      )`;
  return `UPDATE auth_refresh_tokens SET consumed_at = coalesce(consumed_at, ${now})
  WHERE user_id IN (${affectedUsers});
UPDATE users SET auth_version = auth_version + 1,
  last_auth_fenced_at = ${now}, updated_at = ${now}
  WHERE deletion_pending_at IS NULL AND id IN (${affectedUsers});
UPDATE sign_in_allowlist SET revoked_at = ${now}
  WHERE entry_id = '${entryID}' AND revoked_at IS NULL;`;
}

function parseArguments(argv: string[]): {
  command: string;
  target: Target;
  label?: string;
  expiresDays?: number;
  entryID?: string;
} {
  const [command, ...rest] = argv;
  let location: Target["location"] | undefined;
  let environment: string | undefined;
  let label: string | undefined;
  let expiresDays: number | undefined;
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === "--remote" || argument === "--local") {
      location = argument;
    } else if (argument === "--env") {
      environment = rest[++index];
    } else if (argument === "--label") {
      label = rest[++index];
    } else if (argument === "--expires-days") {
      expiresDays = Number(rest[++index]);
      if (!Number.isInteger(expiresDays) || expiresDays < 1)
        throw new Error("--expires-days must be a positive integer.");
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option ${argument}.`);
    } else positional.push(argument);
  }
  if (!command || !["invite", "list", "revoke"].includes(command))
    throw new Error("Usage: sign-in-allowlist invite|list|revoke ...");
  if (!location) throw new Error("Choose --remote or --local explicitly.");
  if (environment !== undefined && !/^[a-z][a-z0-9-]*$/.test(environment))
    throw new Error("--env must be a wrangler environment name.");
  return {
    command,
    target: { location, environment },
    label,
    expiresDays,
    entryID: positional[0],
  };
}

function wrangler(target: Target, sql: string): unknown {
  const arguments_ = [
    "exec",
    "wrangler",
    "d1",
    "execute",
    "COMINAVI_DB",
    target.location,
    "--json",
    "--command",
    sql,
  ];
  if (target.environment) arguments_.push("--env", target.environment);
  const output = execFileSync("pnpm", arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(output);
}

function main(): void {
  const options = parseArguments(process.argv.slice(2));
  const now = Math.floor(Date.now() / 1_000);
  if (options.command === "invite") {
    if (!options.label) throw new Error("invite needs --label.");
    const code = generateInviteCode();
    const entryID = randomBytes(16).toString("hex");
    wrangler(
      options.target,
      inviteSQL({
        entryID,
        label: options.label,
        codeHash: inviteCodeHash(code),
        now,
        expiresAt: options.expiresDays
          ? now + options.expiresDays * 24 * 60 * 60
          : null,
      }),
    );
    console.log(`entry ${entryID}`);
    console.log(`invite code (shown once): ${code}`);
    console.log(
      "Send the code privately. The person opens the Google or Apple special entry link and types it on the entry page.",
    );
  } else if (options.command === "list") {
    const result = wrangler(options.target, listSQL) as Array<{
      results: Record<string, unknown>[];
    }>;
    console.table(result[0]?.results ?? []);
  } else {
    if (!options.entryID) throw new Error("revoke needs an entry ID.");
    wrangler(options.target, revokeSQL(options.entryID, now));
    console.log(`revoked ${options.entryID}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
