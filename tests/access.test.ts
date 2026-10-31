import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { App } from "../src/App";
import { DEMO_USER, authenticateDemo } from "../src/domain/auth";
import { availableBooks } from "../src/domain/catalog";
import {
  advance,
  continueGuestReading,
  defaults,
  guestReadingTarget,
  migrate,
  startSession,
} from "../src/domain/reading";
import {
  entryRoute,
  parseLocation,
  protectedRoutes,
  resolveLocation,
  routeHref,
} from "../src/app/routes";

test("only the fixed demo credentials can create a login", () => {
  const state = defaults();
  for (const [id, password] of [
    ["other@example.com", DEMO_USER.password],
    [DEMO_USER.id, "wrongpass"],
    [DEMO_USER.id, ""],
    ["", DEMO_USER.password],
    [DEMO_USER.id, DEMO_USER.password + " "],
  ])
    assert.equal(authenticateDemo(state, id, password), null);
  const signedIn = authenticateDemo(state, DEMO_USER.id, DEMO_USER.password)!;
  assert.equal(signedIn.demoAccountComplete, true);
  assert.equal(migrate(signedIn).demoAccountComplete, true);
  assert.equal(entryRoute(signedIn), "home");
  assert.equal(state.demoAccountComplete, false);
  assert.ok(!JSON.stringify(signedIn).includes(DEMO_USER.password));
});

test("previous unrestricted demo sessions expire without losing reading records", () => {
  const state = migrate({
    ...defaults(),
    demoAccountComplete: true,
    saved: ["waiting"],
  });
  assert.equal(state.demoAccountComplete, false);
  assert.equal(state.demoUserId, null);
  assert.deepEqual(state.saved, ["waiting"]);
});

test("guests cannot open member screens by path, hash or navigation", () => {
  const guest = defaults();
  const signedIn = authenticateDemo(guest, DEMO_USER.id, DEMO_USER.password)!;
  for (const page of protectedRoutes) {
    for (const address of [
      `http://127.0.0.1:5173/${page}.html`,
      `http://127.0.0.1:5173/#${page}`,
    ]) {
      assert.equal(
        resolveLocation(guest, parseLocation(new URL(address))).page,
        "trial",
      );
    }
    assert.equal(resolveLocation(guest, { page }).page, "trial");
    assert.equal(resolveLocation(signedIn, { page }).page, page);
  }
  for (const page of ["home", "search", "library"] as const) {
    const html = renderToString(
      createElement(App, { initialLocation: { page }, initialState: guest }),
    );
    assert.ok(!html.includes('aria-label="주요 메뉴"'));
    assert.ok(!html.includes('class="book-home"'));
    assert.ok(!html.includes('class="search-form"'));
    assert.ok(!html.includes('class="shelf-link"'));
  }
});

test("declining the invitation resumes at page three and survives reload without another prompt", () => {
  const book = availableBooks.find((b) => b.totalPages > 3)!;
  let state = startSession(defaults(), book.id, { start: 0, mode: "trial" });
  state = advance(advance(state));
  assert.equal(entryRoute(state), "trial-done");
  state = continueGuestReading(state);
  assert.equal(state.demoAccountComplete, false);
  assert.equal(state.active?.cursor, 2);
  assert.equal(state.active?.end, book.totalPages);
  state = migrate(JSON.parse(JSON.stringify(advance(state))));
  assert.equal(state.active?.cursor, 3);
  assert.equal(entryRoute(state), "reader");
  for (const page of ["home", "search", "library", "trial-done"] as const) {
    const location = resolveLocation(state, { page });
    assert.deepEqual(location, { page: "reader", book: book.id });
    assert.ok(
      routeHref(location, new URL("http://127.0.0.1:5173/")).includes(
        "reader.html?book=",
      ),
    );
  }
  while (state.active) state = advance(state);
  assert.equal(entryRoute(migrate(state)), "reader");
  const next = continueGuestReading(state);
  assert.notEqual(next.active?.id, book.id);
  assert.equal(next.active?.cursor, 0);
});

test("returning from an account page preserves the unread page and scroll", () => {
  const book = availableBooks[0];
  let state = advance(
    startSession(defaults(), book.id, { start: 0, mode: "trial" }),
  );
  const active = { ...state.active!, scrollY: 251 };
  state = {
    ...state,
    active,
    progress: { ...state.progress, [book.id]: active },
  };
  const continued = continueGuestReading(state);
  assert.equal(continued.active?.cursor, 1);
  assert.equal(continued.active?.scrollY, 251);
  assert.equal(continued.active?.mode, "book");
  assert.equal(continued.active?.end, book.totalPages);
});

test("guest completion distinguishes finished pages from a complete book and previews the actual next book", () => {
  const book = availableBooks.find((b) => b.totalPages > 3)!;
  let state = startSession({ ...defaults(), guestContinue: true }, book.id, {
    start: book.totalPages - 1,
  });
  state = advance(state);
  const render = (initialState: typeof state) =>
    renderToString(
      createElement(App, {
        initialLocation: { page: "reader", book: book.id },
        initialState,
      }),
    );
  assert.ok(!render(state).includes("한 권의 마지막 장까지"));
  assert.ok(render(state).includes("여기까지 읽었어요."));
  state = startSession(state, book.id, { start: 0 });
  while (state.active) state = advance(state);
  while (state.progress[book.id].end < book.totalPages) {
    state = continueGuestReading(state);
    while (state.active) state = advance(state);
  }
  const html = render(state);
  assert.ok(html.includes("한 권의 마지막 장까지"));
  assert.ok(html.includes(book.book));
  const target = guestReadingTarget(state);
  assert.ok(html.includes(target.book.book));
  assert.equal(continueGuestReading(state).active?.id, target.book.id);
  assert.equal(continueGuestReading(state).active?.cursor, target.start);
});
