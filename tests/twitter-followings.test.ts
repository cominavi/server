import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchTwitterFollowings,
  normalizeTwitterUserName,
  TwitterFollowingError,
} from "../src/lib/server/twitter-followings";

test("normalizes X usernames without accepting profile URLs", () => {
  assert.equal(normalizeTwitterUserName(" @Comi_Navi "), "comi_navi");
  assert.equal(normalizeTwitterUserName("https://x.com/cominavi"), null);
  assert.equal(normalizeTwitterUserName("too-long-for-x-users"), null);
});

test("paginates followings and deduplicates stable user IDs", async () => {
  const cursors: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const cursor = new URL(request.url).searchParams.get("cursor") ?? "";
    cursors.push(cursor);
    assert.equal(request.headers.get("X-API-Key"), "api-key");
    if (!cursor) {
      return Response.json({
        status: "success",
        followings: [
          {
            id: "1",
            userName: "Circle_A",
            name: "Circle A",
            url: "https://twitter.com/Circle_A",
          },
        ],
        has_next_page: true,
        next_cursor: "next",
      });
    }
    return Response.json({
      status: "success",
      followings: [
        { id: "1", userName: "circle_a", name: "Duplicate" },
        {
          id: "2",
          userName: "circle_b",
          profilePicture: "https://pbs.twimg.com/b.jpg",
        },
      ],
      has_next_page: false,
      next_cursor: "",
    });
  };

  const users = await fetchTwitterFollowings("Owner", "api-key", fetcher);
  assert.deepEqual(cursors, ["", "next"]);
  assert.deepEqual(users, [
    {
      id: "1",
      userName: "circle_a",
      name: "Circle A",
      url: "https://x.com/circle_a",
    },
    {
      id: "2",
      userName: "circle_b",
      name: "circle_b",
      url: "https://x.com/circle_b",
      profilePicture: "https://pbs.twimg.com/b.jpg",
    },
  ]);
});

test("fails closed on an HTTP 200 TwitterAPI.io error payload", async () => {
  const fetcher: typeof fetch = async () =>
    Response.json({
      status: "error",
      message: "private account",
      followings: [],
      has_next_page: false,
    });

  await assert.rejects(
    fetchTwitterFollowings("owner", "api-key", fetcher),
    (error: unknown) =>
      error instanceof TwitterFollowingError &&
      error.code === "twitter_api_error" &&
      error.message === "private account",
  );
});

test("fails closed when TwitterAPI.io repeats a cursor", async () => {
  const fetcher: typeof fetch = async () =>
    Response.json({
      status: "success",
      followings: [],
      has_next_page: true,
      next_cursor: "same",
    });

  await assert.rejects(
    fetchTwitterFollowings("owner", "api-key", fetcher),
    (error: unknown) =>
      error instanceof TwitterFollowingError &&
      error.code === "twitter_api_pagination_error",
  );
});

test("stops after page 25 when TwitterAPI.io reports another following page", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests += 1;
    return Response.json({
      status: "success",
      followings: Array.from({ length: 200 }, (_, index) => ({
        id: String((requests - 1) * 200 + index),
        userName: `circle_${(requests - 1) * 200 + index}`,
      })),
      has_next_page: true,
      next_cursor: String(requests),
    });
  };

  await assert.rejects(
    fetchTwitterFollowings("owner", "api-key", fetcher),
    (error: unknown) =>
      error instanceof TwitterFollowingError &&
      error.code === "twitter_following_limit_exceeded" &&
      error.message ===
        "This X account follows more than 5,000 people. ComiNavi can import up to 5,000 accounts.",
  );
  assert.equal(requests, 25);
});
