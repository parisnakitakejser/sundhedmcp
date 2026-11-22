// The sundhed.dk session lives in one real browser that this process owns.
// The person logs in with MitID in its window; every API call then runs as a
// fetch() inside that browser, so cookies and headers are exactly the site's own.
// Nothing is written to disk: the context is in-memory and dies with the process.
// Hosted, the owner of a session can keep its login (persistLogin): the
// browser's cookies are handed over after each login and keep-alive, to be
// stored encrypted, and resume() starts a new browser with them after a restart.
//
// Hosted with several people, each has their own SundhedSession (their own
// browser). The functions below act on the session of whoever the current
// call runs for (withSession), or on the one default session otherwise.
import { AsyncLocalStorage } from "node:async_hooks";
import { metrics, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

export const ORIGIN = "https://www.sundhed.dk";
// What sundhed.dk's own "Log på" button opens: it redirects through
// login.sundhed.dk and NemLog-in to MitID, and returns to Min Side after.
const LOGIN_URL = `${ORIGIN}/login/unsecure/logon.ashx?ReturnUrl=/borger/min-side/`;
// Each Min Side app has its own backend, and its page sets up that backend's
// auth when it loads. Before calling an app's API, its page is loaded once.
const APP_PAGES: Record<string, string> = {
  minsideportal: "/borger/min-side/",
  medicinkort2borger: "/borger/min-side/min-sundhedsjournal/medicinkortet/",
  vaccination: "/borger/min-side/min-sundhedsjournal/vaccinationer/",
  proevesvarportal: "/borger/min-side/min-sundhedsjournal/laboratoriesvar/",
  dennationalehenvisningsformidling: "/borger/min-side/min-sundhedsjournal/henvisninger/",
  aftalerborger: "/borger/min-side/min-sundhedsjournal/aftaler/",
};
// Headers the browser sets itself (and HTTP/2 pseudo-headers like :path); anything else an app's page sends is the app's own.
const BROWSER_HEADERS = /^(:.*|accept|accept-encoding|accept-language|user-agent|referer|origin|cookie|host|connection|content-length|content-type|priority|sec-.*)$/i;
const BOOT_WAIT_MS = 30_000;
const LOGIN_WAIT_MS = 3 * 60_000;
const POLL_MS = 2_000;
const KEEPALIVE_MS = Number(process.env.SUNDHEDMCP_KEEPALIVE_MS ?? 4 * 60_000);

/** The person is not logged in, or sundhed.dk ended the session. */
/**
 * The browser's cookies and storage for sundhed.dk, as Playwright exports them
 * (with IndexedDB), plus the sundhed.dk tab's sessionStorage, which Playwright
 * leaves out.
 */
export type LoginState = Awaited<ReturnType<BrowserContext["storageState"]>> & { sessionStorage?: Record<string, string> };

/** The API that says whether sundhed.dk really accepts the login; the keep-alive calls it too. */
const PROBE_PATH = "/app/minsideportal/api/v1/GetLoginInfo";

export class SessionGone extends Error {
  constructor() {
    super("Not logged in to sundhed.dk. Call connect_sundhed and approve the login in MitID.");
  }
}

interface State {
  browser: Browser;
  context: BrowserContext;
  /** The visible window where MitID happens. */
  login: Page;
  /** A background tab on sundhed.dk that runs the API calls. */
  api: Page | null;
  /** Per app: the extra headers its own page sends to its API, learned by loading that page. */
  apps: Map<string, Record<string, string>>;
  connectedAt: Date | null;
  lastConfirmedAt: Date | null;
  endedAt: Date | null;
  /** How long the previous session lasted, for learning sundhed.dk's timeout. */
  lastSessionMinutes: number | null;
  keepAlive: NodeJS.Timeout | null;
  lastKeepAliveAt: Date | null;
  /** This login came from one kept before a restart (resume), not from MitID here. */
  resumed: boolean;
}


// Hosted mode: the browser runs headless on a server, and the person logs in
// through the /connect page, which shows it as screenshots and forwards input.
let hostedBaseUrl: string | null = null;
const VIEWPORT = { width: 1000, height: 760 };

export function configureHosted(baseUrl: string): void {
  hostedBaseUrl = baseUrl;
}

/** Where to log in when hosted, or null when running locally with a real window. */
export const hostedLoginUrl = () => (hostedBaseUrl ? `${hostedBaseUrl}/connect` : null);

const log = (msg: string) => console.error(`[sundhed] ${msg}`);

/** Installed browsers first (MitID treats them like any other), bundled Chromium last. */
async function launchBrowser(): Promise<Browser> {
  const preferred = process.env.SUNDHEDMCP_BROWSER;
  const channels = preferred ? [preferred] : ["chrome", "msedge", "chrome-beta", "chrome-canary", "chromium"];
  const errors: string[] = [];
  for (const channel of channels) {
    try {
      const browser = await chromium.launch({ headless: hostedBaseUrl !== null, channel, args: ["--window-size=1100,900"] });
      log(`using browser channel "${channel}"`);
      return browser;
    } catch (err) {
      errors.push(`${channel}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(
    "No Chromium-based browser found. Install Google Chrome or Microsoft Edge, or run `npx playwright-core install chromium`. Tried: " +
      errors.join("; "),
  );
}

async function setWindow(page: Page, windowState: "minimized" | "normal"): Promise<void> {
  if (hostedBaseUrl) return;
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState } });
    await cdp.detach();
    if (windowState === "normal") await page.bringToFront();
  } catch {
    // Window management is a nicety; the session works either way.
  }
}

/** Asks sundhed.dk directly, using the context's cookies. Needs no page. */
async function checkLoggedIn(s: State): Promise<boolean> {
  try {
    const res = await s.context.request.get(`${ORIGIN}/api/login/isloggedin`, { headers: { Accept: "application/json" } });
    if (!res.ok()) return false;
    const body = (await res.json()) as { IsLoggedIn?: boolean };
    return body.IsLoggedIn === true;
  } catch {
    return false;
  }
}

async function apiPage(s: State): Promise<Page> {
  if (s.api && !s.api.isClosed()) return s.api;
  s.api = await s.context.newPage();
  s.apps.clear();
  return s.api;
}

const appOf = (path: string) => (path.match(/^\/app\/([^/]+)\//)?.[1] ?? "").toLowerCase();

/**
 * Loads the app's own page in the background tab and records the extra headers
 * its scripts send to the app's API (an auth token, an anti-forgery header).
 * Only the header names are logged.
 */
async function bootApp(s: State, app: string): Promise<void> {
  const page = await apiPage(s);
  const pagePath = APP_PAGES[app];
  if (!pagePath) {
    s.apps.set(app, {});
    return;
  }
  let captured: Record<string, string> | null = null;
  const seen = new Promise<void>((resolve) => {
    const onRequest = async (req: import("playwright-core").Request) => {
      if (appOf(new URL(req.url()).pathname) !== app || !new URL(req.url()).pathname.includes("/api/")) return;
      const headers = await req.allHeaders().catch(() => ({}) as Record<string, string>);
      captured = Object.fromEntries(Object.entries(headers).filter(([k]) => !BROWSER_HEADERS.test(k)));
      page.off("request", onRequest);
      resolve();
    };
    page.on("request", onRequest);
  });
  await page.goto(`${ORIGIN}${pagePath}`, { waitUntil: "domcontentloaded" });
  await Promise.race([seen, page.waitForLoadState("networkidle", { timeout: BOOT_WAIT_MS }).catch(() => {})]);
  await Promise.race([seen, new Promise((r) => setTimeout(r, 2_000))]);
  const headers: Record<string, string> = captured ?? {};
  s.apps.set(app, headers);
  log(`${app}: page loaded, ${captured ? `extra headers: ${Object.keys(headers).join(", ") || "none"}` : "no API call seen"}`);
}

const loginListeners: ((session: SundhedSession) => void)[] = [];

/** Runs after each new MitID login (not on every confirmation of a live one), with the session that logged in. */
export function onLogin(listener: (session: SundhedSession) => void): void {
  loginListeners.push(listener);
}

/**
 * Goes straight to the MitID step: the login redirect, then NemLog-in's
 * "Fortsæt til login" button, so the person lands on the user ID field.
 */
async function openMitId(page: Page): Promise<void> {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  try {
    await page.locator("#mitIDConfirmation").click({ timeout: 15_000 });
  } catch {
    // NemLog-in changed or skipped the step; the person can click on from here.
  }
}

const minutesBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 60_000);

export type ConnectResult = { connected: true; since: Date } | { connected: false; reason: string };

export interface Status {
  browserOpen: boolean;
  loggedIn: boolean;
  connectedMinutes?: number;
  lastSessionLastedMinutes?: number;
  /** ISO times; present while logged in. */
  since?: string;
  lastKeepAliveAt?: string;
  nextKeepAliveAt?: string;
  keepAliveEveryMinutes?: number;
  /** This login was resumed after a restart. */
  resumed?: boolean;
  /** The login is kept for restarts (hosted, with storage); keptAt is when it was last stored. */
  keepsLogin?: boolean;
  keptAt?: string;
  /** When sundhed.dk last ended a session here, and how long it had lasted. */
  lastEnded?: { at: string; minutes: number };
}

export type LoginInput =
  | { type: "click"; x: number; y: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string }
  | { type: "wheel"; dy: number };

// Only the keys a login form needs. Everything else arrives as text.
const KEYS = new Set(["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"]);

/** One person's sundhed.dk session: their own browser, login and API tab. */
export class SundhedSession {
  /** Who this session belongs to, for logs. Never a CPR number or a name. */
  readonly label: string;
  private state: State | null = null;
  private launching: Promise<State> | null = null;
  private watching = false;
  // Calls share one background tab, and loading an app's page navigates it, so
  // calls run one at a time.
  private queue: Promise<unknown> = Promise.resolve();
  private keeper: ((login: LoginState | null) => Promise<void>) | null = null;
  private keptAt: Date | null = null;
  private lastEnded: { at: Date; minutes: number } | null = null;

  constructor(label = "default") {
    this.label = label;
  }

  private log(msg: string): void {
    log(this.label === "default" ? msg : `${this.label}: ${msg}`);
  }

  /**
   * Keep the login: `keep` gets the browser's cookies after each login and
   * keep-alive, and null when the login ends (sundhed.dk ended it, or a logout).
   * Closing the browser at shutdown (close) leaves what was kept.
   */
  persistLogin(keep: (login: LoginState | null) => Promise<void>): void {
    this.keeper = keep;
  }

  private keep(s: State | null): void {
    const keeper = this.keeper;
    if (!keeper) return;
    const login = s ? loginState(s) : Promise.resolve(null);
    void login
      .then(async (state) => {
        if (s && this.state !== s) return;
        await keeper(state);
        this.keptAt = state ? new Date() : null;
      })
      .catch((err: unknown) => this.log(`could not keep the login: ${(err as Error).message}`));
  }

  /**
   * Opens a browser with a login kept before a restart. Resolves to whether
   * sundhed.dk still accepts it; if it does, this counts as a new login
   * (onLogin), and if not the kept login is dropped.
   */
  async resume(login: LoginState): Promise<boolean> {
    if (this.state || this.launching) return false;
    const s = await this.ensureBrowser(login);
    // isloggedin alone is not enough: it has said yes to a kept login whose
    // every API call sundhed.dk then refused (403). Ask a real API too.
    const status = (await checkLoggedIn(s)) ? await probe(s).catch(() => 0) : 0;
    if (status >= 200 && status < 300) {
      this.log("resumed the login kept before the restart");
      s.resumed = true;
      this.markConnected(s);
      return true;
    }
    if (status) this.log(`sundhed.dk refused the login kept before the restart (${status}); log in again with MitID. ${await cookieDiff(s, login)}`);
    else this.log("the login kept before the restart has ended");
    this.keep(null);
    this.reset("kept login ended");
    await s.browser.close().catch(() => {});
    return false;
  }

  private async ensureBrowser(kept?: LoginState): Promise<State> {
    if (this.state) return this.state;
    this.launching ??= (async () => {
      const browser = await launchBrowser();
      const context = await browser.newContext({ locale: "da-DK", viewport: hostedBaseUrl ? VIEWPORT : null, ...(kept ? { storageState: kept } : {}) });
      if (kept?.sessionStorage) {
        // Put the kept sessionStorage back once, before sundhed.dk's own scripts run.
        await context.addInitScript(
          ({ origin, items }) => {
            // Runs in the page, where location exists; this package has no DOM types.
            const { location } = globalThis as unknown as { location: { origin: string } };
            if (location.origin !== origin || sessionStorage.getItem("__sundhedmcp_restored")) return;
            for (const [k, v] of Object.entries(items)) sessionStorage.setItem(k, v);
            sessionStorage.setItem("__sundhedmcp_restored", "1");
          },
          { origin: ORIGIN, items: kept.sessionStorage },
        );
      }
      const login = await context.newPage();
      const s: State = { browser, context, login, api: null, apps: new Map(), connectedAt: null, lastConfirmedAt: null, endedAt: null, lastSessionMinutes: null, keepAlive: null, lastKeepAliveAt: null, resumed: false };
      browser.on("disconnected", () => {
        if (this.state === s) this.reset("browser closed");
      });
      // Closing the login window is how a person says "stop": take the browser down with it.
      login.on("close", () => {
        if (this.state === s) void browser.close().catch(() => {});
      });
      this.state = s;
      return s;
    })().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  private reset(reason: string): void {
    if (!this.state) return;
    if (this.state.keepAlive) clearInterval(this.state.keepAlive);
    this.log(`session gone (${reason})`);
    this.state = null;
  }

  private markConnected(s: State): void {
    const now = new Date();
    const fresh = s.connectedAt === null;
    s.connectedAt ??= now;
    s.lastConfirmedAt = now;
    s.endedAt = null;
    if (!s.keepAlive && KEEPALIVE_MS > 0) {
      s.keepAlive = setInterval(() => void this.keepAlive(s), KEEPALIVE_MS);
      s.keepAlive.unref();
    }
    if (fresh) {
      this.keep(s);
      for (const listener of loginListeners) setImmediate(() => listener(this));
    }
  }

  private markEnded(s: State): void {
    if (s.keepAlive) clearInterval(s.keepAlive);
    s.keepAlive = null;
    if (s.connectedAt) {
      s.endedAt = new Date();
      s.lastSessionMinutes = minutesBetween(s.connectedAt, s.endedAt);
      this.log(`sundhed.dk ended the session after ${s.lastSessionMinutes} min`);
      this.lastEnded = { at: s.endedAt, minutes: s.lastSessionMinutes };
      s.resumed = false;
      this.keep(null);
    }
    s.connectedAt = null;
  }

  /** Touches an authenticated page so sundhed.dk sees activity and keeps the session. */
  private async keepAlive(s: State): Promise<void> {
    if (this.state !== s) return;
    s.lastKeepAliveAt = new Date();
    try {
      await this.apiGet(PROBE_PATH);
      if (!(await checkLoggedIn(s))) this.markEnded(s);
      // sundhed.dk may have renewed its cookies; keep the newest.
      else this.keep(s);
    } catch (err) {
      if (err instanceof SessionGone) return;
      this.log(`keep-alive failed: ${(err as Error).message}`);
    }
  }

  /**
   * Opens (or re-shows) the browser window on sundhed.dk and waits for the person
   * to log in with MitID. Returns once logged in or after LOGIN_WAIT_MS.
   */
  async connect(): Promise<ConnectResult> {
    const s = await this.ensureBrowser();
    if (await checkLoggedIn(s)) {
      this.markConnected(s);
      return { connected: true, since: s.connectedAt! };
    }
    this.markEnded(s);
    await setWindow(s.login, "normal");
    // Leave the window alone if the person is already partway through MitID.
    if (!s.login.url().includes("mitid") && !s.login.url().includes("nemlog-in")) {
      await openMitId(s.login);
    }
    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < deadline) {
      if (this.state !== s) return { connected: false, reason: "The browser window was closed before the login finished." };
      if (await checkLoggedIn(s)) {
        this.markConnected(s);
        await apiPage(s);
        await setWindow(s.login, "minimized");
        return { connected: true, since: s.connectedAt! };
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return { connected: false, reason: "Still waiting for the MitID login. The window stays open; log in there, then ask again." };
  }

  async status(): Promise<Status> {
    const s = this.state;
    const common = {
      ...(this.keeper ? { keepsLogin: true } : {}),
      ...(this.keptAt ? { keptAt: this.keptAt.toISOString() } : {}),
      ...(this.lastEnded ? { lastEnded: { at: this.lastEnded.at.toISOString(), minutes: this.lastEnded.minutes } } : {}),
    };
    if (!s) return { browserOpen: false, loggedIn: false, ...common };
    const loggedIn = await checkLoggedIn(s);
    if (loggedIn) this.markConnected(s);
    else if (s.connectedAt) this.markEnded(s);
    const now = new Date();
    const live = loggedIn && s.connectedAt;
    const next = live && s.keepAlive ? new Date((s.lastKeepAliveAt ?? s.connectedAt ?? now).getTime() + KEEPALIVE_MS) : null;
    return {
      browserOpen: true,
      loggedIn,
      ...(live ? { connectedMinutes: minutesBetween(s.connectedAt as Date, now), since: (s.connectedAt as Date).toISOString() } : {}),
      ...(live && s.lastKeepAliveAt ? { lastKeepAliveAt: s.lastKeepAliveAt.toISOString() } : {}),
      ...(next ? { nextKeepAliveAt: next.toISOString(), keepAliveEveryMinutes: Math.round(KEEPALIVE_MS / 60_000) } : {}),
      ...(live && s.resumed ? { resumed: true } : {}),
      ...(!loggedIn && s.lastSessionMinutes !== null ? { lastSessionLastedMinutes: s.lastSessionMinutes } : {}),
      ...common,
    };
  }

  /** Logs out here: closes the browser and drops a kept login. */
  async disconnect(): Promise<void> {
    this.keep(null);
    await this.close("disconnected");
  }

  /** Closes the browser at shutdown, leaving a kept login for resume(). */
  async close(reason = "shutting down"): Promise<void> {
    const s = this.state;
    if (!s) return;
    this.reset(reason);
    await s.browser.close().catch(() => {});
  }

  /** GET a sundhed.dk path (e.g. "/app/vaccination/api/v1/overview") as JSON, inside the logged-in browser. */
  apiGet(path: string): Promise<unknown> {
    return this.call(path);
  }

  /**
   * POST JSON to a sundhed.dk path, inside the logged-in browser. Prescription
   * renewal uses it to change something on sundhed.dk, and only when the
   * server allows renewal (SUNDHEDMCP_ALLOW_RENEWAL). The Aftaler app asks for
   * its list of appointments with a POST too; that one only reads.
   */
  apiPost(path: string, body: unknown): Promise<unknown> {
    return this.call(path, JSON.stringify(body));
  }

  private call(path: string, body?: string): Promise<unknown> {
    const run = this.queue.then(() => traced(appOf(path), () => this.callNow(path, body)));
    this.queue = run.catch(() => {});
    return run;
  }

  private async callNow(path: string, body?: string): Promise<unknown> {
    const s = this.state;
    if (!s) throw new SessionGone();
    if (!s.connectedAt) {
      // The login may have finished on the /connect page since the last call.
      if (!(await checkLoggedIn(s))) throw new SessionGone();
      this.markConnected(s);
    }
    const app = appOf(path);
    let res = await fetchInPage(s, app, path, body);
    if (res.status === 401 || res.status === 403) {
      // The app's own auth may have expired: load its page again and retry once.
      // A refused POST changed nothing, so sending it again is safe.
      s.apps.delete(app);
      res = await fetchInPage(s, app, path, body);
    }
    trace.getActiveSpan()?.setAttribute("http.response.status_code", res.status);
    if (res.status === 401 || res.status === 403) {
      if (!(await checkLoggedIn(s))) {
        this.markEnded(s);
        throw new SessionGone();
      }
      // isloggedin says yes, but if Min Side's own API refuses too, the login
      // is only half alive. Throw it away: as long as this browser keeps it,
      // isloggedin keeps saying yes and a new MitID login cannot start.
      const portal = app === "minsideportal" ? res.status : await probe(s).catch(() => 0);
      if (portal === 401 || portal === 403) {
        this.log(`sundhed.dk refuses its API (${portal}) although isloggedin says yes; closing the browser so a new MitID login can start`);
        this.markEnded(s);
        await this.close("login refused by the API");
        throw new SessionGone();
      }
      throw new Error(`sundhed.dk refused ${app || "this"} data (${res.status}) although you are logged in. The site may have changed how this app signs in.`);
    }
    if (res.status >= 400) throw new Error(`sundhed.dk answered ${res.status} for ${path.split("?")[0]}${body === undefined ? "" : reason(res.text)}`);
    // A POST may answer with no body at all.
    if (body !== undefined && !res.text) {
      s.lastConfirmedAt = new Date();
      return null;
    }
    if (!res.type.includes("json")) throw new Error(`sundhed.dk did not answer with JSON for ${path.split("?")[0]}; the site may have changed.`);
    s.lastConfirmedAt = new Date();
    return res.text ? JSON.parse(res.text) : null;
  }

  // --- Hosted login: the /connect page drives the login tab from afar ---

  /** Notices when the login finishes, so the session is ready before the next tool call. */
  private watchForLogin(s: State): void {
    if (this.watching) return;
    this.watching = true;
    const deadline = Date.now() + 15 * 60_000;
    const tick = async () => {
      if (this.state !== s || Date.now() > deadline) return void (this.watching = false);
      if (await checkLoggedIn(s)) {
        this.watching = false;
        this.markConnected(s);
        this.log("logged in through the /connect page");
        return;
      }
      setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
  }

  /** Starts the browser on sundhed.dk's login page if needed. True when already logged in. */
  async startLogin(): Promise<boolean> {
    const s = await this.ensureBrowser();
    if (await checkLoggedIn(s)) {
      this.markConnected(s);
      return true;
    }
    if (!s.login.url().startsWith("http")) await openMitId(s.login);
    this.watchForLogin(s);
    return false;
  }

  /**
   * Starts the MitID login over in a fresh browser. Reusing the old one fails:
   * NemLog-in remembers the half-finished login and answers "Du er allerede
   * logget ind" (you cannot run two login flows at once).
   */
  async restartLogin(): Promise<void> {
    await this.disconnect();
    this.watching = false;
    await this.startLogin();
  }

  async loginScreenshot(): Promise<Buffer | null> {
    const s = this.state;
    if (!s || s.login.isClosed()) return null;
    return s.login.screenshot({ type: "jpeg", quality: 70 });
  }

  async loginInput(input: LoginInput): Promise<void> {
    const s = this.state;
    if (!s || s.login.isClosed()) return;
    const page = s.login;
    switch (input.type) {
      case "click": {
        const x = Math.max(0, Math.min(VIEWPORT.width, input.x));
        const y = Math.max(0, Math.min(VIEWPORT.height, input.y));
        await page.mouse.click(x, y);
        break;
      }
      case "text":
        await page.keyboard.insertText(input.text.slice(0, 200));
        break;
      case "key":
        if (KEYS.has(input.key)) await page.keyboard.press(input.key === "Space" ? " " : input.key);
        break;
      case "wheel":
        await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, input.dy)));
        break;
    }
  }

  /**
   * True when MitID asks for its QR code. MitID does that when the login comes
   * from a browser it does not recognise, such as this server's; the code has to
   * be scanned from a screen the person can point their phone at.
   */
  async loginWantsQr(): Promise<boolean> {
    const s = this.state;
    if (!s || s.login.isClosed()) return false;
    // A string expression: it runs in the page, and this project has no DOM types.
    const text = await s.login.evaluate<string>("document.body ? document.body.innerText : ''").catch(() => "");
    return /scan qr/i.test(text);
  }
}

// --- Telemetry: a no-op unless the server set up OpenTelemetry (hosted mode) ---

const requestDuration = (() => {
  let made: { provider: unknown; histogram: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> } | null = null;
  return () => {
    const provider = metrics.getMeterProvider();
    if (made?.provider !== provider) {
      made = {
        provider,
        histogram: metrics.getMeter("sundhedmcp").createHistogram("sundhedmcp.sundhed.request.duration", {
          unit: "s",
          description: "Calls to sundhed.dk's APIs from the logged-in browser, by app and outcome.",
          advice: { explicitBucketBoundaries: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60] },
        }),
      };
    }
    return made.histogram;
  };
})();

/**
 * A client span and the request-duration histogram around one API call. Only
 * the app's name is recorded (one of APP_PAGES), never the path: paths hold
 * ids from the record.
 */
async function traced<T>(appName: string, run: () => Promise<T>): Promise<T> {
  const app = appName in APP_PAGES ? appName : "other";
  const started = performance.now();
  let outcome = "error";
  try {
    return await trace.getTracer("sundhedmcp").startActiveSpan(`GET sundhed.dk ${app}`, { kind: SpanKind.CLIENT, attributes: { "sundhed.app": app } }, async (span) => {
      try {
        const result = await run();
        outcome = "ok";
        return result;
      } catch (err) {
        outcome = err instanceof SessionGone ? "session_gone" : "error";
        span.setStatus({ code: SpanStatusCode.ERROR, message: outcome });
        throw err;
      } finally {
        span.end();
      }
    });
  } finally {
    requestDuration().record((performance.now() - started) / 1000, { "sundhed.app": app, outcome });
  }
}

/** sundhed.dk's own explanation in an error answer, such as why a renewal was refused. */
function reason(text: string): string {
  try {
    const message = (JSON.parse(text) as { Message?: unknown }).Message;
    return typeof message === "string" && message.trim() ? `: ${message.trim().slice(0, 200)}` : "";
  } catch {
    return "";
  }
}

/** A GET, or a POST of `body` (JSON) when given. */
/** Calls the probe API in the background tab; resolves to its HTTP status. */
async function probe(s: State): Promise<number> {
  return (await fetchInPage(s, "minsideportal", PROBE_PATH)).status;
}

async function loginState(s: State): Promise<LoginState> {
  const state: LoginState = await s.context.storageState({ indexedDB: true });
  const page = s.api && !s.api.isClosed() ? s.api : null;
  if (page?.url().startsWith(ORIGIN)) {
    const stored = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage))).catch(() => ({}));
    delete (stored as Record<string, string>).__sundhedmcp_restored;
    if (Object.keys(stored).length) state.sessionStorage = stored;
  }
  return state;
}

/**
 * Which cookies (names only, never values) the kept login had that the browser
 * now lacks, and the other way round, for learning why sundhed.dk refused it.
 */
async function cookieDiff(s: State, kept: LoginState): Promise<string> {
  const key = (c: { name: string; domain: string; path: string }) => `${c.name}@${c.domain}${c.path}`;
  const before = new Set(kept.cookies.map(key));
  const now = new Set((await s.context.cookies().catch(() => [])).map(key));
  const gone = [...before].filter((k) => !now.has(k));
  const added = [...now].filter((k) => !before.has(k));
  return `Cookies kept: ${before.size}, now: ${now.size}, gone: ${gone.join(" ") || "none"}, new: ${added.join(" ") || "none"}.`;
}

async function fetchInPage(s: State, app: string, path: string, body?: string) {
  if (!s.apps.has(app)) await bootApp(s, app);
  const page = await apiPage(s);
  return page.evaluate(
    async ({ url, headers, body }) => {
      const init: RequestInit = body === undefined
        ? { headers: { Accept: "application/json", ...headers }, credentials: "include" }
        : { method: "POST", body, headers: { Accept: "application/json", "Content-Type": "application/json", ...headers }, credentials: "include" };
      const r = await fetch(url, init);
      return { status: r.status, type: r.headers.get("content-type") ?? "", text: await r.text() };
    },
    { url: path, headers: s.apps.get(app) ?? {}, body },
  );
}

export const loginViewport = () => VIEWPORT;

// --- The current session: the caller's own when hosted for several people ---

/** The session used outside withSession: local mode, and hosted for one person. */
export const defaultSession = new SundhedSession();
const current = new AsyncLocalStorage<SundhedSession>();

/** Runs `fn` (and everything it starts) against `session`. */
export const withSession = <T>(session: SundhedSession, fn: () => T): T => current.run(session, fn);
export const currentSession = (): SundhedSession => current.getStore() ?? defaultSession;

export const connect = () => currentSession().connect();
export const status = () => currentSession().status();
export const disconnect = () => currentSession().disconnect();
export const closeBrowser = () => currentSession().close();
export const apiGet = (path: string) => currentSession().apiGet(path);
export const apiPost = (path: string, body: unknown) => currentSession().apiPost(path, body);
export const startLogin = () => currentSession().startLogin();
export const restartLogin = () => currentSession().restartLogin();
export const loginScreenshot = () => currentSession().loginScreenshot();
export const loginInput = (input: LoginInput) => currentSession().loginInput(input);
export const loginWantsQr = () => currentSession().loginWantsQr();
