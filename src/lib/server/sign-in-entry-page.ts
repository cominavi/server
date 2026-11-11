import { issueAppleEntryGrant, validateAppleNonce } from "./apple-entry-grants";
import {
  issueGoogleEntryGrant,
  validateGoogleNonce,
} from "./google-entry-grants";
import {
  findRedeemableInvite,
  type AllowlistProvider,
} from "./sign-in-allowlist";

// The hidden Google/Apple entry page. The app opens it in an ephemeral
// ASWebAuthenticationSession with a nonce. The page asks for an optional
// invite code, then returns a nonce-bound entry grant to the app. An
// allowlisted person leaves the code empty; the backend decides at sign-in.

const providers = {
  google: {
    name: "Google",
    validateNonce: validateGoogleNonce,
    issue: issueGoogleEntryGrant,
  },
  apple: {
    name: "Apple",
    validateNonce: validateAppleNonce,
    issue: issueAppleEntryGrant,
  },
} as const;

export interface EntryPageBindings {
  COMINAVI_DB: D1Database;
  COMINAVI_INVITE_RATE_LIMITER: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
}

export async function handleEntryPageGET(
  provider: AllowlistProvider,
  request: Request,
  env: EntryPageBindings,
): Promise<Response> {
  try {
    if (!(await allowedByRateLimit(request, env))) return redirect("/");
    const nonce = providers[provider].validateNonce(
      new URL(request.url).searchParams.get("nonce"),
    );
    return entryForm(provider, nonce, false);
  } catch {
    return redirect("/");
  }
}

export async function handleEntryPagePOST(
  provider: AllowlistProvider,
  request: Request,
  env: EntryPageBindings,
): Promise<Response> {
  try {
    if (!(await allowedByRateLimit(request, env))) return redirect("/");
    const form = await request.formData();
    const nonce = providers[provider].validateNonce(form.get("nonce"));
    const typed = form.get("inviteCode");
    const code = typeof typed === "string" ? typed.trim() : "";
    const now = Date.now();
    let entryID: string | null = null;
    if (code) {
      entryID = await findRedeemableInvite(
        env.COMINAVI_DB,
        code,
        Math.floor(now / 1_000),
      );
      if (!entryID) return entryForm(provider, nonce, true);
    }
    const grant = await providers[provider].issue(
      env.COMINAVI_DB,
      nonce,
      now,
      entryID,
    );
    const callback = new URL(`cominavi://auth/${provider}/grant`);
    callback.searchParams.set("entryGrant", grant.entryGrant);
    callback.searchParams.set("expiresAt", grant.expiresAt);
    callback.searchParams.set("nonce", nonce);
    return redirect(callback.toString());
  } catch {
    return redirect("/");
  }
}

async function allowedByRateLimit(
  request: Request,
  env: EntryPageBindings,
): Promise<boolean> {
  const key = request.headers.get("CF-Connecting-IP") ?? "local";
  return (await env.COMINAVI_INVITE_RATE_LIMITER.limit({ key })).success;
}

const securityHeaders = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, ...securityHeaders },
  });
}

export function entryForm(
  provider: AllowlistProvider,
  nonce: string,
  rejected: boolean,
): Response {
  const name = providers[provider].name;
  // `nonce` passed validateNonce, so it is [A-Za-z0-9_-] only.
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ComiNavi ${name} sign-in</title>
<style>
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --bg: #fff; --line: #d2d2d7; --accent: #0a66d8; --bad: #c4291c; }
@media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6; --bg: #000; --line: #424245; --accent: #4c9bff; --bad: #ff6b5e; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "PingFang SC", sans-serif; }
main { max-width: 420px; margin: 0 auto; padding: 32px 16px; }
h1 { font-size: 22px; margin: 0 0 12px; }
p { margin: 0 0 8px; color: var(--muted); font-size: 14px; }
label { display: block; margin: 20px 0 6px; font-weight: 600; }
input[type=text] { box-sizing: border-box; width: 100%; padding: 12px; font: 18px ui-monospace, SFMono-Regular, monospace; letter-spacing: 0.04em; border: 1px solid var(--line); border-radius: 10px; background: transparent; color: var(--fg); }
button { width: 100%; margin-top: 16px; padding: 12px; font: inherit; font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: 10px; }
.error { color: var(--bad); font-weight: 600; }
</style>
</head>
<body>
<main>
<h1>${name} でサインイン / Sign in with ${name}</h1>
<p>${name} サインインは招待された方のみ利用できます。招待コードをお持ちの場合は入力してください。登録済みの方は空欄のまま続けてください。</p>
<p>${name} sign-in is for invited people only. Enter your invite code if you have one; if you are already on the list, leave it empty.</p>
<p>${name} 登录仅限受邀用户。如有邀请码请输入；已在名单中的用户请留空继续。</p>
${rejected ? `<p class="error" role="alert">招待コードが無効か、すでに使用されています。/ This invite code is invalid or already used. / 邀请码无效或已被使用。</p>` : ""}
<form method="post">
<input type="hidden" name="nonce" value="${nonce}">
<label for="inviteCode">招待コード / Invite code / 邀请码</label>
<input type="text" id="inviteCode" name="inviteCode" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" maxlength="64">
<button type="submit">続ける / Continue / 继续</button>
</form>
</main>
</body>
</html>`;
  return new Response(html, {
    status: rejected ? 400 : 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      ...securityHeaders,
    },
  });
}
