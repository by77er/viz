# 14 — Identity, sign-in and invites for people

Date: 2026-11-28. Written as background for `design/proposals/accounts-and-teams.md`. The question
from the owner was to *explore individual and team setups for people, possibly with invite codes
at first*. This file collects the outside facts the proposal relies on. The proposal holds the
design and the reasoning.

**Tags.** **[V]** verified from the linked page, fetched on 2026-11-28 (the page's own
modification date is given where it had one). **[S]** secondary: a search-result summary, a vendor
blog, or a page read only in part. **[T]** training knowledge (cutoff mid-2026): a lead, not a
fact. Nothing here was measured on viz or on Cloudflare. No Cloudflare API was called.

**What could not be reached or settled.**
- Cloudflare's Zero Trust plan page (`/plans/zero-trust-services/`) and its free-plan page stated no
  seat count. The figures below come from the SASE plan page's Markdown rendering.
- The `@simplewebauthn/server` documentation names Node and Deno and does not mention Cloudflare
  Workers. Whether it runs in workerd unchanged was not tried.
- Grafana's and Honeycomb's documentation give no invitation expiry.
- The NIST page states the rule on email. It does not name passkeys; the AAL2 ceiling for synced
  passkeys is inferred from its text about exportable keys.

---

## 1. Passkeys (WebAuthn)

- **The standard is final.** WebAuthn Level 3 is a W3C Recommendation dated 25 August 2026. Its
  previous version was the Candidate Recommendation Snapshot of 26 May 2026. [V]
  ([w3.org/TR/webauthn-3](https://www.w3.org/TR/webauthn-3/))
- **A discoverable credential always returns its user handle.** The credential source's user handle
  "MUST always be populated for discoverable credentials". FIDO U2F-only authenticators return a
  null `userHandle`. [V] (same page). For viz this means a sign-in can find the account from the
  assertion alone (the user handle is the account id), with no lookup index and without asking for
  a user name first.
- **Signal methods exist** (`signalUnknownCredential`, `signalAllAcceptedCredentials`,
  `signalCurrentUserDetails`, §5.1.10), and so do related origins (§5.11). The fetch did not reach
  their body text. [V for their existence, S for their behaviour]
- **Platform support** (passkeys.dev, last updated 21 September 2026) [V]
  ([passkeys.dev/device-support](https://passkeys.dev/device-support/)):
  - Synced passkeys on Android 9+, ChromeOS 129+, iOS/iPadOS 16+, macOS 13+. Windows' sync status
    is not clear from the matrix.
  - Autofill ("conditional") UI in Chrome 108+, Edge 122+, Firefox 122+ and Safari 16.1+. On
    Windows it needs Windows 11 22H2+.
  - Cross-device ("hybrid") clients on Android 9+, ChromeOS 108+, iOS 16+, macOS 13+, Windows
    23H2+, and Ubuntu through Chrome and Edge. Native platform support on Linux is "Planned".
  - "Additional capabilities may be available when a user installs a different passkey provider"
    (third-party managers such as password managers).
- **OWASP Passkey Security Cheat Sheet** [V]
  ([cheatsheetseries.owasp.org](https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html)):
  - Challenges must come from a CSPRNG (at least 16 bytes), "expire it promptly and accept it only
    once", and be bound to the ceremony, account or session, RP ID, origin policy and expiry.
  - "Use the narrowest stable domain that covers the intended application." Keep an explicit origin
    allow-list, and never build the expected origin from a request header.
  - "Most public-facing applications should use no attestation."
  - "Do not treat UP and UV as equivalent." Require UV when the passkey has to satisfy a
    multi-factor policy.
  - Treat signature counters as a risk signal. "Do not automatically lock out every user solely
    because of a counter anomaly." Store the backup flags, but do not treat them as proof of trust.
  - "Allow users to register more than one authenticator." Require recent re-authentication
    before a passkey is added or removed. Revoke at once on the server. Confirm that a usable
    method remains before the last passkey is removed, and notify the user through an existing
    trusted channel.
  - "The effective security of a passkey account is limited by its weakest recovery route."
    Recovery codes are authentication secrets: single use, and the user can generate new ones.
    "Do not let email or SMS recovery silently bypass a stronger authentication policy."
- **NIST SP 800-63B-4** (final, July 2025; it supersedes the 2024 syncable-authenticator
  supplement) [S for the lineage, from the search summary]. The authenticators page says "Email
  **SHALL NOT** be used for out-of-band authentication". It also says the keys of syncable
  authenticators "are inherently exportable", and exportable keys are "usable at AAL2 or below".
  [V] ([pages.nist.gov/800-63-4/sp800-63b/authenticators](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/))
- **Libraries.** `@simplewebauthn/server` 14.1.0 is MIT-licensed (npm registry metadata, read
  here). Its dependencies are `@peculiar/*` ASN.1 and X.509 packages, `@levischuck/tiny-cbor`,
  `@hexagon/base64` and `reflect-metadata`. The docs list Node 22+ and Deno 2.4+ only. [V]
  ([simplewebauthn.dev](https://simplewebauthn.dev/docs/packages/server))
  - Whether it runs in Workers is unknown. Without attestation, verification needs much less: a
    small CBOR decoder for `authData`, a COSE-to-JWK conversion, and WebCrypto `verify`, with the
    DER-to-raw conversion that ECDSA signatures need. [T]
  - workerd's WebCrypto supports ECDSA P-256 and RSASSA-PKCS1-v1_5, and supports Ed25519. [T]

## 2. Account recovery

- **FIDO Alliance (2019, "Account Recovery Best Practices")** recommends two steps: first, have users
  register several authenticators; second, run identity proofing or onboarding again. FIDO does not
  recommend weaker recovery options. [S]
  ([fidoalliance.org PDF](https://fidoalliance.org/wp-content/uploads/2019/02/FIDO_Account_Recovery_Best_Practices-1.pdf))
- **FIDO, synced passkeys (2024).** Synced passkeys reduce how often recovery is needed, but they may
  still need other methods for authentication and recovery. [S]
  ([fidoalliance.org PDF](https://fidoalliance.org/wp-content/uploads/2024/05/Synced-Passkey-Deployment_-Emerging-Practices-for-Consumer-Use-Cases_2024-Final.pdf))
- **Google's passkey UX guidance** treats recovery as a moment to have the user create a passkey. [S]
  ([developers.google.com](https://developers.google.com/identity/passkeys/ux/user-journeys))
- **Vendor practice.** The common default is a second passkey backed by single-use recovery codes.
  This is vendor opinion, not FIDO or NIST guidance. [S]
  ([mojoauth.com](https://mojoauth.com/blog/passkey-recovery-and-lockout-relying-parties-guide))
- **OWASP Authentication Cheat Sheet** [V]
  ([cheatsheetseries.owasp.org](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)):
  - Answer login, recovery and registration "in a generic manner", with the same status code and
    timing whether or not the account exists.
  - "The counter of failed logins should be associated with the account itself, rather than the
    source IP address", but take care that lockout cannot be used to deny service to others.
  - "Do not use security questions."
  - Require "an authenticator already bound to the account" to re-authenticate. "Invalidate
    sessions after re-authentication and rotate tokens."
  - Help-desk staff who handle recovery need social-engineering training.

## 3. Email magic links and email on Cloudflare

- **Link scanners consume one-time links.** Corporate mail security (Microsoft Defender Safe Links
  and others) fetches links before the person clicks them. A single-use token in a GET URL is then
  spent by the scanner. [S]
  ([Stytch](https://stytch.com/docs/b2b/guides/magic-links/overview),
  [Microsoft Safe Links](https://learn.microsoft.com/en-us/defender-office-365/safe-links-about),
  [Supabase discussion](https://github.com/orgs/supabase/discussions/41618),
  [Descope](https://docs.descope.com/flows/use-cases/email-scanner))
  - The usual remedies are a code typed by the person, or a landing page that spends the token only
    after a user action. [S]
  - A token kept in the URL **fragment** is never sent to the server, so a scanner's GET cannot spend
    it. This follows from how URLs work, not from the sources. [T]
- **Email as an authenticator is weak by the standard.** NIST: email "SHALL NOT be used for
  out-of-band authentication" (§1). Anyone who can read the mailbox can sign in. [V]
- **Cloudflare Email Service** (docs modified 2026-11-24) [V]:
  - "Cloudflare Email Service sends transactional email and handles incoming email." It has two
    parts, Email Sending and Email Routing. **Email Sending is in beta.**
    ([developers.cloudflare.com/email-service](https://developers.cloudflare.com/email-service/))
  - Free plan: "Email Sending sends only to verified destination addresses in your account."
    "Sending to any other recipient requires the Workers Paid plan." There are three ways to send:
    a Workers binding, a REST API and SMTP. (same page)
  - Pricing: Workers Paid includes 3,000 emails per account per month, then $0.35 per 1,000.
    ([pricing](https://developers.cloudflare.com/email-service/platform/pricing/))
  - Limits: new accounts start on a conservative daily quota that "may be adjusted automatically as
    your reputation improves". Over the quota, the binding answers `E_DAILY_LIMIT_EXCEEDED`. A
    message has at most 50 recipients and 25 MiB. A sending domain must be onboarded, and a zone
    holds 30 domains across Routing and Sending.
    ([limits](https://developers.cloudflare.com/email-service/platform/limits/))
  - The binding can be limited to `allowed_sender_addresses` and `allowed_destination_addresses`.
    Its errors include `E_RECIPIENT_PLAN_RESTRICTED`, `E_RECIPIENT_NOT_ALLOWED` (an unverified
    recipient when the sender domain is not onboarded) and `E_SENDER_NOT_VERIFIED`.
    ([send from Workers](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/))
  - The public beta of sending to any recipient was announced on 16 April 2026: "Email Sending
    graduates from private beta to public beta today". Before that, agents "could only ... send
    emails to members of your Cloudflare account". "When you add your domain to Email Service, we
    configure all of it automatically" (SPF, DKIM, DMARC).
    ([blog](https://blog.cloudflare.com/email-for-agents))
  - Onboarding adds DNS records under a `cf-bounce` subdomain, including MX records for bounces. [S]
    ([search summary of the get-started page](https://developers.cloudflare.com/email-service/get-started/send-emails/))
    For viz this would be a DNS change in the `bitcru.sh` zone, which the owner must approve
    (AGENTS.md, "The Cloudflare account").
  - The older rule, that Email Workers' `send_email` reaches only verified destination addresses,
    still holds on the Free plan and for a sender domain that is not onboarded. [V]
- **Deliverability** is out of viz's control: reputation-ramped quotas, spam filtering, greylisting.
  [T] An email sign-in can be delayed by minutes, or never arrive.

## 4. Federated sign-in (GitHub, Google)

- **Key accounts on the provider's immutable subject.** For GitHub that is the numeric user id; for
  Google OIDC it is the `sub` claim. Never key on email: an email can change owner, and some
  providers have issued unverified or mutable email claims (the 2023 "nOAuth" issue with Microsoft
  Entra apps). [T]
- **GitHub OAuth Apps** return no ID token, so the app reads `/user` (and `/user/emails` for a
  verified address) with the access token. The client secret is a server secret. [T]
- **Google** is OIDC: the ID token is verified against its JWKS (`iss`, `aud`, `exp`, `nonce`), and
  `email_verified` is a claim. A production app with only the `openid email profile` scopes needs
  brand verification but not a sensitive-scope review. [T]
- If the provider is down, nobody can sign in, but sessions that already exist continue. An account
  taken over at the provider is taken over at viz. Recovery is the provider's. [T]

## 5. Cloudflare pieces

- **Workers Rate Limiting binding** (page modified 2026-11-12) [V]
  ([docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)):
  - The period "Must be either `10` or `60`" seconds.
  - Counts are kept per Cloudflare location and are approximate: "Requests can exceed your
    configured limit while counts update in the background". For one strict limit across all
    locations, the page recommends a Durable Object.
  - viz already uses six such bindings for OAuth (D70).
- **Cloudflare Access / Zero Trust.** The free plan covers "50 users". Pay-as-you-go is "$7" per
  user per month. [V] ([plans page](https://www.cloudflare.com/plans/sase-zero-trust.md)) Secondary
  sources say pay-as-you-go is billed annually and that the 50-user cap is enforced strictly. [S]
  ([search summary](https://zerometric.net/research/cloudflare-zero-trust-free-plan-limits-2026/))
  - Access puts a signed JWT in `Cf-Access-Jwt-Assertion`, which an application verifies against
    `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. [T, from research/02]
  - Access applications can be scoped to paths. A one-time PIN by email is one of its login methods.
    [T]
  - Access is built for one organisation's workforce. Mapping customers to their own identity
    providers is awkward. [T, research/07]
- **Turnstile** is free, with 20 widgets per account and 10 hostnames per widget. Page modified
  2026-08-14. [V] ([plans](https://developers.cloudflare.com/turnstile/plans/))
- **Durable Objects and KV prices**, from earlier research [V in research/01 and 02, 2026-11-18]:
  - Durable Objects: $0.15 per million requests. Rows written: 50 M a month included, then $1.00
    per million; `setAlarm` counts as a row. Rows read: $0.001 per million.
  - KV: reads 10 M a month included, then $0.50 per million. Writes, deletes and lists: 1 M
    included, then $5.00 per million.
  - Workers: requests are $0.30 per million past the 10 M included (D74, read 2026-11-26).
- **KV consistency.** A write may take about 60 s or more to be seen in other locations. A location
  that read a key as absent may answer from that cached result for up to 60 s. [T, as in D70;
  not measured]
- **Cookies through service bindings.** viz-gateway passes `Set-Cookie` through unchanged
  (`deploy/gateway/src/index.ts`, read here). [V, local code]

## 6. Invites in comparable products

| Product | Roles at invite | Link or email | Expiry | Other | Tag |
|---|---|---|---|---|---|
| Grafana (self-managed 13.x; Grafana Cloud similar) | Admin, Editor, Viewer, or "No basic role" | Email, or "Copy Invite" for a link | Not stated | Pending invites can be cancelled. Removing a user from an org does not delete the account | [V] [grafana.com](https://grafana.com/docs/grafana/latest/administration/user-management/manage-org-users/); Cloud onboarding [S] [grafana.com](https://grafana.com/docs/learning-paths/grafana-cloud-onboarding/invite-team-members/) |
| Datadog | Role chosen at invite | Email | "valid for 48 hours"; resend; Delete Invite before first login | Status "Invite Pending" | [S] [docs.datadoghq.com](https://docs.datadoghq.com/account_management/users/) |
| Honeycomb | Owner, Member (Enterprise adds Read-Only); Member is the default on non-Enterprise plans | Email; an invitation URL lets people *request* access, and "a Team Owner must approve" | Can expire; period not stated | Allowed email domains; otherwise any address may join | [V] [docs.honeycomb.io](https://docs.honeycomb.io/configure/teams/manage-members) |
| Linear | "Invite as…" on paid plans (Admin, Member, Guest) | Email; "Invite links are persistent and reusable", reset by "Reset invite link" | None for links | Approved domains: "anyone with the matching email domain can join ... without an invitation or approval". Only admins invite on paid plans unless allowed | [V] [linear.app](https://linear.app/docs/invite-members) |
| Vercel | Owner chooses; Member is the default; a link gives the lowest role (Viewer on Enterprise, Member on Pro) | Email; an invite link that "Reset Invite Link" invalidates | "7 days to accept" (30 for SAML-enforced teams) | More than one Owner allowed, and always at least one. Ownership moves by promoting, then demoting | [V] [vercel.com](https://vercel.com/docs/rbac/managing-team-members) (updated 2026-05-08); link details [S] |

What they share:
- three or four roles, with an owner or admin above editing and viewing;
- email invites that expire within days;
- reusable links, which give the lowest role, can be reset, or need approval;
- a guard against removing the last owner.

## 7. Sessions (OWASP Session Management Cheat Sheet) [V]

([cheatsheetseries.owasp.org](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html))

- **Entropy.** At least 64 bits of entropy, and 128 bits from a CSPRNG for custom ids.
- **Cookie attributes.**
  - `Secure`, and `HttpOnly`, which is "mandatory to prevent session ID stealing through XSS".
  - `SameSite=Strict` (preferred) or `Lax`.
  - No `Domain` attribute, and a `Path` as tight as possible.
  - The `__Host-` prefix: `Secure`, no `Domain`, `Path=/`.
- **Timeouts.** 2–5 minutes idle for high-value applications, 15–30 for low-risk ones; an absolute
  limit of 4–8 hours for an office day. Both are enforced on the server.
- **Renewal and logout.**
  - Issue a new session id "after any privilege level change", login included.
  - On logout, invalidate on the server, and revoke every id of the same logical session together.
- **No tokens in web storage.** Do not keep "authentication tokens, session IDs, JWTs, refresh
  tokens, or any credential" in `localStorage` or `sessionStorage`. Use HttpOnly cookies or a
  backend-for-frontend instead.
- **SameSite and other subdomains.** SameSite treats every subdomain of a registrable domain as the
  same site. A page on another host in `bitcru.sh` is "same-site" with `vis.bitcru.sh`, so SameSite
  alone does not stop it from forging requests. An `Origin` or `Sec-Fetch-Site: same-origin` check
  does. [T]

## 8. What this means for viz (pointers, not decisions)

- Passkeys are mature enough to be the only sign-in for people (§1). Recovery is the weak part (§2),
  and a single-person workspace has no admin who can re-invite.
- Email from Cloudflare works now but is beta. It needs Workers Paid, an onboarded sending domain (a
  DNS change in the zone) and a reputation ramp (§3). It suits notifications and invite delivery.
  It is weak as a way to sign in.
- Invite links can carry their secret in the URL fragment, out of reach of mail scanners and
  server logs (§3), and expire within days as in comparable products (§6).
- The rate-limiting pattern of D70 carries over as it is (§5). Exact limits that must hold belong
  in a Durable Object.
