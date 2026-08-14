export interface TwitterFollowingUser {
  id: string;
  userName: string;
  name: string;
  url: string;
  profilePicture?: string;
}

interface TwitterAPIPage {
  followings: unknown[];
  has_next_page: boolean;
  next_cursor?: string;
  status: "success" | "error";
  message?: string;
}

export class TwitterFollowingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const maximumTwitterFollowings = 5_000;

const twitterFollowingPageSize = 200;
const maximumPages = maximumTwitterFollowings / twitterFollowingPageSize;
const twitterFollowingTimeoutMilliseconds = 10 * 60 * 1_000;
const twitterFollowingLimitMessage =
  "This X account follows more than 5,000 people. ComiNavi can import up to 5,000 accounts.";

export function normalizeTwitterUserName(value: string): string | null {
  const normalized = value.trim().replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(normalized)
    ? normalized.toLowerCase()
    : null;
}

export async function fetchTwitterFollowings(
  userName: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<TwitterFollowingUser[]> {
  const normalizedUserName = normalizeTwitterUserName(userName);
  if (!normalizedUserName) {
    throw new TwitterFollowingError(
      "invalid_twitter_username",
      "Enter a valid X username.",
    );
  }
  if (!apiKey) {
    throw new TwitterFollowingError(
      "twitter_api_unavailable",
      "Twitter importing is not configured.",
    );
  }

  const usersByID = new Map<string, TwitterFollowingUser>();
  const seenCursors = new Set<string>();
  let cursor = "";

  for (let pageNumber = 0; pageNumber < maximumPages; pageNumber += 1) {
    if (seenCursors.has(cursor)) {
      throw new TwitterFollowingError(
        "twitter_api_pagination_error",
        "TwitterAPI.io returned a repeated pagination cursor.",
      );
    }
    seenCursors.add(cursor);

    const url = new URL(
      "/twitter/user/followings",
      "https://api.twitterapi.io",
    );
    url.searchParams.set("userName", normalizedUserName);
    url.searchParams.set("cursor", cursor);
    url.searchParams.set("pageSize", String(twitterFollowingPageSize));

    let response: Response;
    try {
      response = await fetcher(url, {
        headers: {
          Accept: "application/json",
          "X-API-Key": apiKey,
        },
        signal: AbortSignal.timeout(twitterFollowingTimeoutMilliseconds),
      });
    } catch {
      throw new TwitterFollowingError(
        "twitter_api_unavailable",
        "TwitterAPI.io is temporarily unavailable.",
      );
    }

    const body = await readJSON(response);
    if (!response.ok || !isTwitterAPIPage(body) || body.status !== "success") {
      throw new TwitterFollowingError(
        "twitter_api_error",
        isTwitterAPIPage(body) && body.message
          ? body.message
          : "TwitterAPI.io rejected the followings request.",
      );
    }

    if (pageNumber === maximumPages - 1 && body.has_next_page) {
      throw twitterFollowingLimitError();
    }

    for (const rawUser of body.followings) {
      const user = parseFollowingUser(rawUser);
      if (user && !usersByID.has(user.id)) {
        usersByID.set(user.id, user);
        if (usersByID.size > maximumTwitterFollowings) {
          throw twitterFollowingLimitError();
        }
      }
    }

    if (!body.has_next_page) {
      return Array.from(usersByID.values());
    }
    if (!body.next_cursor) {
      throw new TwitterFollowingError(
        "twitter_api_pagination_error",
        "TwitterAPI.io omitted the next pagination cursor.",
      );
    }
    cursor = body.next_cursor;
  }

  throw twitterFollowingLimitError();
}

function twitterFollowingLimitError(): TwitterFollowingError {
  return new TwitterFollowingError(
    "twitter_following_limit_exceeded",
    twitterFollowingLimitMessage,
  );
}

function parseFollowingUser(value: unknown): TwitterFollowingUser | null {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    typeof value.userName !== "string"
  ) {
    return null;
  }
  const normalizedUserName = normalizeTwitterUserName(value.userName);
  if (!value.id || !normalizedUserName) return null;

  const profilePicture =
    typeof value.profilePicture === "string" &&
    value.profilePicture.startsWith("https://")
      ? value.profilePicture
      : undefined;
  return {
    id: value.id,
    userName: normalizedUserName,
    name: typeof value.name === "string" ? value.name : normalizedUserName,
    url: `https://x.com/${normalizedUserName}`,
    ...(profilePicture ? { profilePicture } : {}),
  };
}

function isTwitterAPIPage(value: unknown): value is TwitterAPIPage {
  return (
    isObject(value) &&
    Array.isArray(value.followings) &&
    typeof value.has_next_page === "boolean" &&
    (value.status === "success" || value.status === "error") &&
    (value.next_cursor === undefined ||
      typeof value.next_cursor === "string") &&
    (value.message === undefined || typeof value.message === "string")
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readJSON(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
