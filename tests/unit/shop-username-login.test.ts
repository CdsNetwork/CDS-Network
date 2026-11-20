/**
 * Username logins for shops (Ashley, 2026-11-19): shops with several locations share one email,
 * so CDS gives each location a username ("CDS Allentown") and a recovery email that several
 * locations may share. The auth user gets an internal address under login.invalid that can
 * never receive mail. Sign in and Forgot password take an email or a username and never say
 * whether a username exists.
 */
import { describe, expect, it, vi } from "vitest";
import {
  authLinkBase,
  buildShopPasswordEmail,
  INTERNAL_LOGIN_DOMAIN,
  internalLoginEmail,
  isInternalLoginEmail,
  looksLikeEmail,
  normalizeUsername,
  passwordLink,
  suggestUsername,
  usernameError,
  usernameLoginsEnabled,
  USERNAME_LOGINS_SETTING_KEY,
} from "@/lib/shop-login";
import {
  OFF_RESET_MESSAGE,
  OFF_SIGN_IN_ERROR,
  passwordResetFlow,
  RATE_LIMITED_ERROR,
  RESET_MESSAGE,
  SIGN_IN_ERROR,
  signInFlow,
  type RateLimiter,
  type UsernameLogin,
} from "@/lib/login-flow";
import { sendAuthEmail } from "@/lib/auth-email";

describe("username rules", () => {
  it("trims and collapses spaces", () => {
    expect(normalizeUsername("  CDS   Allentown ")).toBe("CDS Allentown");
    expect(normalizeUsername("CDS\tAllentown")).toBe("CDS Allentown");
  });

  it("allows letters, digits, spaces, dot, dash and underscore", () => {
    expect(usernameError("CDS Allentown")).toBeNull();
    expect(usernameError("cds.allentown_2-b")).toBeNull();
    expect(usernameError("abc")).toBeNull();
  });

  it("refuses other characters, an @, and lengths outside 3 to 60", () => {
    expect(usernameError("ab")).toMatch(/3/);
    expect(usernameError("a".repeat(61))).toMatch(/60/);
    expect(usernameError("cds@allentown")).not.toBeNull();
    expect(usernameError("CDS & Sons")).not.toBeNull();
    expect(usernameError("Allentöwn")).not.toBeNull();
    expect(usernameError("")).not.toBeNull();
  });

  it("suggests the shop name with characters a username cannot hold removed", () => {
    expect(suggestUsername("CDS Allentown")).toBe("CDS Allentown");
    expect(suggestUsername("Smith & Sons (East)")).toBe("Smith Sons East");
    expect(usernameError(suggestUsername("Smith & Sons (East)"))).toBeNull();
    expect(suggestUsername("x".repeat(80))).toHaveLength(60);
  });

  it("treats a value with @ as an email and anything else as a username", () => {
    expect(looksLikeEmail("shop@example.com")).toBe(true);
    expect(looksLikeEmail("CDS Allentown")).toBe(false);
  });
});

describe("internal login email", () => {
  it("is under login.invalid (RFC 2606: never resolves, never delivered)", () => {
    expect(INTERNAL_LOGIN_DOMAIN).toBe("login.invalid");
    const email = internalLoginEmail("ALN", "3f9a0c1b2d4e");
    expect(email).toBe("shop-aln-3f9a0c1b2d4e@login.invalid");
    expect(isInternalLoginEmail(email)).toBe(true);
    expect(isInternalLoginEmail("SHOP-ALN-1@LOGIN.INVALID")).toBe(true);
    expect(isInternalLoginEmail("shop@example.com")).toBe(false);
    expect(isInternalLoginEmail("x@login.invalid.example.com")).toBe(false);
  });

  it("keeps only safe characters of the short code", () => {
    expect(internalLoginEmail("A B/&c", "00ff")).toBe("shop-abc-00ff@login.invalid");
    expect(internalLoginEmail("", "00ff")).toBe("shop-00ff@login.invalid");
  });
});

describe("password link", () => {
  it("never takes the host from the request: an env setting, Vercel's own URL, or production", () => {
    expect(authLinkBase({ PORTAL_PUBLIC_URL: "https://portal.example/" })).toBe("https://portal.example");
    expect(authLinkBase({ VERCEL_ENV: "production" })).toBe("https://platform.cds.direct");
    expect(authLinkBase({ VERCEL_ENV: "preview", VERCEL_URL: "cds-x.vercel.app" })).toBe("https://cds-x.vercel.app");
    expect(authLinkBase({})).toBe("http://localhost:3000");
  });

  it("goes through /auth/confirm to the set password page", () => {
    expect(passwordLink("https://p.example", "abc+/=")).toBe(
      "https://p.example/auth/confirm?token_hash=abc%2B%2F%3D&type=recovery&next=%2Faccount%2Fpassword",
    );
  });

  it("names the username and the shop so a shared inbox knows which location it is for", () => {
    const reset = buildShopPasswordEmail("reset", { username: "CDS Allentown", shopName: "CDS Allentown <PA>", link: "https://p.example/x" });
    expect(reset.subject).toBe("Reset your CDS portal password: CDS Allentown");
    expect(reset.text).toContain("Username: CDS Allentown");
    expect(reset.text).toContain("Shop: CDS Allentown <PA>");
    expect(reset.text).toContain("https://p.example/x");
    expect(reset.html).toContain("CDS Allentown &lt;PA&gt;");
    expect(reset.html).not.toContain("<PA>");
    const welcome = buildShopPasswordEmail("welcome", { username: "CDS Allentown", shopName: null, link: "https://p.example/x" });
    expect(welcome.subject).toBe("Set your CDS portal password: CDS Allentown");
    expect(welcome.text).toContain("Username: CDS Allentown");
  });
});

// ---------------------------------------------------------------- flows

const allentown: UsernameLogin = {
  email: "shop-aln-1@login.invalid",
  username: "CDS Allentown",
  recoveryEmail: "owner@example.com",
  shopName: "CDS Allentown",
  active: true,
};

function limiter(over: Partial<{ blocked: boolean; fails: boolean }> = {}) {
  const calls: { key: string; limit: number; windowSeconds: number; record: boolean }[] = [];
  const l: RateLimiter = {
    check: async (key, limit, windowSeconds, record) => {
      calls.push({ key, limit, windowSeconds, record });
      if (over.fails) throw new Error("db down");
      return over.blocked ?? false;
    },
  };
  return { l, calls };
}

function signInDeps(opts: { password?: string; blocked?: boolean; limiterFails?: boolean; off?: boolean } = {}) {
  const { l, calls } = limiter({ blocked: opts.blocked, fails: opts.limiterFails });
  const signedInWith: string[] = [];
  const lookups: string[] = [];
  return {
    calls,
    signedInWith,
    lookups,
    deps: {
      usernameLogins: !opts.off,
      limiter: l,
      findUsernameLogin: async (u: string) => {
        lookups.push(u);
        return u.toLowerCase() === "cds allentown" ? allentown : null;
      },
      signInWithPassword: async (email: string, password: string) => {
        signedInWith.push(email);
        return email === allentown.email && password === (opts.password ?? "right-password");
      },
    },
  };
}

describe("signInFlow", () => {
  it("signs a username in with its internal email, case and spaces ignored", async () => {
    const d = signInDeps();
    expect(await signInFlow({ login: "  cds   allentown ", password: "right-password", ip: "1.2.3.4" }, d.deps)).toEqual({ ok: true });
    expect(d.lookups).toEqual(["cds allentown"]);
    expect(d.signedInWith).toEqual([allentown.email]);
  });

  it("gives the same error for an unknown username and a wrong password, and still asks Supabase", async () => {
    const unknown = signInDeps();
    const wrong = signInDeps();
    const a = await signInFlow({ login: "No Such Shop", password: "right-password", ip: "1.2.3.4" }, unknown.deps);
    const b = await signInFlow({ login: "CDS Allentown", password: "wrong", ip: "1.2.3.4" }, wrong.deps);
    expect(a).toEqual({ error: SIGN_IN_ERROR });
    expect(b).toEqual({ error: SIGN_IN_ERROR });
    expect(unknown.signedInWith).toHaveLength(1);
    expect(isInternalLoginEmail(unknown.signedInWith[0])).toBe(true);
  });

  it("signs an email in unchanged, without a username lookup", async () => {
    const d = signInDeps();
    await signInFlow({ login: "Shop@Example.com", password: "x", ip: "1.2.3.4" }, d.deps);
    expect(d.lookups).toEqual([]);
    expect(d.signedInWith).toEqual(["Shop@Example.com"]);
  });

  it("records a failure against the login and the IP, never in clear text", async () => {
    const d = signInDeps();
    await signInFlow({ login: "CDS Allentown", password: "wrong", ip: "1.2.3.4" }, d.deps);
    const recorded = d.calls.filter((c) => c.record);
    expect(recorded).toHaveLength(2);
    for (const c of recorded) {
      expect(c.key).not.toContain("allentown");
      expect(c.key).not.toContain("1.2.3.4");
    }
  });

  it("refuses without asking Supabase once the limit is reached", async () => {
    const d = signInDeps({ blocked: true });
    expect(await signInFlow({ login: "CDS Allentown", password: "right-password", ip: "1.2.3.4" }, d.deps)).toEqual({
      error: RATE_LIMITED_ERROR,
    });
    expect(d.signedInWith).toEqual([]);
  });

  it("is limited the same for a username that does not exist", async () => {
    const d = signInDeps({ blocked: true });
    expect(await signInFlow({ login: "No Such Shop", password: "x", ip: "1.2.3.4" }, d.deps)).toEqual({ error: RATE_LIMITED_ERROR });
  });

  it("still signs in when the limiter is down", async () => {
    const d = signInDeps({ limiterFails: true });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await signInFlow({ login: "CDS Allentown", password: "right-password", ip: "1.2.3.4" }, d.deps)).toEqual({ ok: true });
    log.mockRestore();
  });
});

function resetDeps(opts: { blocked?: boolean; off?: boolean } = {}) {
  const { l, calls } = limiter({ blocked: opts.blocked });
  const supabaseResets: string[] = [];
  const usernameResets: UsernameLogin[] = [];
  return {
    calls,
    supabaseResets,
    usernameResets,
    deps: {
      usernameLogins: !opts.off,
      limiter: l,
      findUsernameLogin: async (u: string) => (u.toLowerCase() === "cds allentown" ? allentown : null),
      sendSupabaseReset: async (email: string) => {
        supabaseResets.push(email);
      },
      sendUsernameReset: async (login: UsernameLogin) => {
        usernameResets.push(login);
      },
    },
  };
}

describe("passwordResetFlow", () => {
  it("sends a username's link to its recovery email", async () => {
    const d = resetDeps();
    expect(await passwordResetFlow({ login: "cds allentown", ip: "1.2.3.4" }, d.deps)).toEqual({ message: RESET_MESSAGE });
    expect(d.usernameResets).toEqual([allentown]);
    expect(d.supabaseResets).toEqual([]);
  });

  it("answers the same and sends nothing for an unknown username", async () => {
    const d = resetDeps();
    expect(await passwordResetFlow({ login: "No Such Shop", ip: "1.2.3.4" }, d.deps)).toEqual({ message: RESET_MESSAGE });
    expect(d.usernameResets).toEqual([]);
    expect(d.supabaseResets).toEqual([]);
  });

  it("sends nothing for a deactivated username login", async () => {
    const d = resetDeps();
    d.deps.findUsernameLogin = async () => ({ ...allentown, active: false });
    expect(await passwordResetFlow({ login: "CDS Allentown", ip: "1.2.3.4" }, d.deps)).toEqual({ message: RESET_MESSAGE });
    expect(d.usernameResets).toEqual([]);
  });

  it("passes an email to Supabase as today", async () => {
    const d = resetDeps();
    expect(await passwordResetFlow({ login: "shop@example.com", ip: "1.2.3.4" }, d.deps)).toEqual({ message: RESET_MESSAGE });
    expect(d.supabaseResets).toEqual(["shop@example.com"]);
  });

  it("never asks Supabase to mail an internal login address", async () => {
    const d = resetDeps();
    expect(await passwordResetFlow({ login: allentown.email, ip: "1.2.3.4" }, d.deps)).toEqual({ message: RESET_MESSAGE });
    expect(d.supabaseResets).toEqual([]);
    expect(d.usernameResets).toEqual([]);
  });

  it("answers the same and sends nothing once the limit is reached", async () => {
    const d = resetDeps({ blocked: true });
    expect(await passwordResetFlow({ login: "CDS Allentown", ip: "1.2.3.4" }, d.deps)).toEqual({ message: RESET_MESSAGE });
    expect(d.usernameResets).toEqual([]);
  });

  it("counts every request", async () => {
    const d = resetDeps();
    await passwordResetFlow({ login: "No Such Shop", ip: "1.2.3.4" }, d.deps);
    expect(d.calls.filter((c) => c.record).length).toBeGreaterThan(0);
  });

  it("asks for an email or username when empty", async () => {
    const d = resetDeps();
    expect(await passwordResetFlow({ login: "  ", ip: null }, d.deps)).toEqual({ error: "Enter your email or username." });
  });
});

describe("sendAuthEmail", () => {
  const email = { subject: "s", text: "t", html: "<p>t</p>" };

  it("sends one email to the recovery address through Resend from the portal sender", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 }));
    await sendAuthEmail("owner@example.com", email, { env: { RESEND_SEND_API_KEY: "k" }, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(String(init.body));
    expect(body.to).toEqual(["owner@example.com"]);
    expect(body.from).toBe("CDS Portal <portal@in.cds.direct>");
  });

  it("throws without a Resend key and when Resend refuses", async () => {
    await expect(sendAuthEmail("o@example.com", email, { env: {}, fetchImpl: vi.fn() })).rejects.toThrow(/RESEND/);
    const refused = vi.fn(async () => new Response(JSON.stringify({ message: "bad" }), { status: 422 }));
    await expect(sendAuthEmail("o@example.com", email, { env: { RESEND_SEND_API_KEY: "k" }, fetchImpl: refused })).rejects.toThrow(/422/);
  });

  it("never mails an internal login address", async () => {
    const fetchImpl = vi.fn();
    await expect(sendAuthEmail("shop-a-1@login.invalid", email, { env: { RESEND_SEND_API_KEY: "k" }, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- off switch

describe("the shop_username_logins switch (off until CDS turns it on, Ashley 2026-11-19)", () => {
  it("is on only for exactly {\"enabled\": true}", () => {
    expect(USERNAME_LOGINS_SETTING_KEY).toBe("shop_username_logins");
    expect(usernameLoginsEnabled({ enabled: true })).toBe(true);
    expect(usernameLoginsEnabled({ enabled: false })).toBe(false);
    expect(usernameLoginsEnabled({ enabled: "true" })).toBe(false);
    expect(usernameLoginsEnabled(true)).toBe(false);
    expect(usernameLoginsEnabled(null)).toBe(false);
    expect(usernameLoginsEnabled(undefined)).toBe(false);
  });

  it("off: sign in is today's email sign in, with no username lookup and no limiter", async () => {
    const d = signInDeps({ off: true });
    expect(await signInFlow({ login: "CDS Allentown", password: "right-password", ip: "1.2.3.4" }, d.deps)).toEqual({
      error: OFF_SIGN_IN_ERROR,
    });
    expect(OFF_SIGN_IN_ERROR).toBe("Email or password is not correct.");
    expect(d.lookups).toEqual([]);
    expect(d.calls).toEqual([]);
    expect(d.signedInWith).toEqual(["CDS Allentown"]);
    expect(await signInFlow({ login: " ", password: "", ip: null }, d.deps)).toEqual({ error: "Enter your email and password." });
  });

  it("off: an email still signs in", async () => {
    const d = signInDeps({ off: true });
    d.deps.signInWithPassword = async (email: string) => {
      d.signedInWith.push(email);
      return email === "shop@example.com";
    };
    expect(await signInFlow({ login: " shop@example.com ", password: "x", ip: "1.2.3.4" }, d.deps)).toEqual({ ok: true });
    expect(d.signedInWith).toEqual(["shop@example.com"]);
  });

  it("off: forgot password is today's: everything goes to Supabase, today's message, no limiter", async () => {
    const d = resetDeps({ off: true });
    expect(await passwordResetFlow({ login: " CDS Allentown ", ip: "1.2.3.4" }, d.deps)).toEqual({ message: OFF_RESET_MESSAGE });
    expect(OFF_RESET_MESSAGE).toBe("If that email has a login, a reset link is on its way.");
    expect(d.supabaseResets).toEqual(["CDS Allentown"]);
    expect(d.usernameResets).toEqual([]);
    expect(d.calls).toEqual([]);
    expect(await passwordResetFlow({ login: "", ip: null }, d.deps)).toEqual({ error: "Enter your email." });
  });
});
