import assert from "node:assert/strict";
import test from "node:test";

import { isDeepLink, parseDeepLink, projectMatchesSlug } from "../src/lib/deepLink.ts";

test("install links carry the asset id", () => {
  assert.deepEqual(parseDeepLink("kobastudios://install/monument-airfield"), {
    kind: "install",
    assetId: "monument-airfield",
  });
});

test("open-project links decode the slug", () => {
  assert.deepEqual(parseDeepLink("kobastudios://open-project/harbor%20ridge"), {
    kind: "open-project",
    slug: "harbor ridge",
  });
});

test("auth callbacks read the token from query or hash", () => {
  assert.deepEqual(parseDeepLink("kobastudios://auth/callback?token=abc"), {
    kind: "auth",
    token: "abc",
  });
  assert.deepEqual(parseDeepLink("kobastudios://auth/callback#token=def"), {
    kind: "auth",
    token: "def",
  });
  assert.deepEqual(parseDeepLink("kobastudios://auth/callback"), { kind: "auth", token: null });
});

test("unknown schemes, actions and empty ids are rejected", () => {
  assert.equal(parseDeepLink("https://koba.games/install/1"), null);
  assert.equal(parseDeepLink("kobastudios://publish/thing"), null);
  assert.equal(parseDeepLink("kobastudios://install"), null);
  assert.equal(parseDeepLink("not a url"), null);
  assert.equal(isDeepLink("kobastudios://install/1"), true);
  assert.equal(isDeepLink("kobastudios://"), true);
  assert.equal(isDeepLink("koba://install/1"), false);
});

test("project slugs match ids, names and separator variants", () => {
  const project = { id: "project-123", name: "Harbor Ridge" };
  assert.equal(projectMatchesSlug(project, "project-123"), true);
  assert.equal(projectMatchesSlug(project, "harbor ridge"), true);
  assert.equal(projectMatchesSlug(project, "harbor-ridge"), true);
  assert.equal(projectMatchesSlug(project, "Harbor_Ridge"), true);
  assert.equal(projectMatchesSlug(project, "red-dunes"), false);
});
