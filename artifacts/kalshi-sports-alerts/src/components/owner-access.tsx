import { useEffect, useRef, type ReactNode } from "react";
import { ClerkProvider, SignIn, SignUp, useAuth, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { useQueryClient } from "@tanstack/react-query";
import { Link, Redirect, useLocation } from "wouter";

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

const appearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "#245c3b", colorForeground: "#21382b",
    colorMutedForeground: "#59685f", colorDanger: "#b42318",
    colorBackground: "#ffffff", colorInput: "#f8faf7",
    colorInputForeground: "#21382b", colorNeutral: "#68786d",
    fontFamily: "Manrope, sans-serif", borderRadius: "12px",
  },
  elements: {
    rootBox: { width: "100%", display: "flex", justifyContent: "center" },
    cardBox: { background: "#fff", borderRadius: "18px", width: "440px", maxWidth: "100%", overflow: "hidden" },
    card: { boxShadow: "none", background: "transparent" },
    footer: { background: "transparent" },
    headerTitle: { color: "#21382b" }, headerSubtitle: { color: "#59685f" },
    socialButtonsBlockButtonText: { color: "#21382b" }, formFieldLabel: { color: "#21382b" },
    footerActionLink: { color: "#245c3b" }, footerActionText: { color: "#59685f" },
    dividerText: { color: "#59685f" }, identityPreviewEditButton: { color: "#245c3b" },
    formFieldSuccessText: { color: "#245c3b" }, alertText: { color: "#b42318" },
  },
};

export function OwnerAuthProvider({ children }: { children: ReactNode }) {
  const [, setLocation] = useLocation();
  return <ClerkProvider
    publishableKey={clerkPubKey}
    proxyUrl={clerkProxyUrl}
    appearance={appearance}
    signInUrl={`${basePath}/sign-in`}
    signUpUrl={`${basePath}/sign-up`}
    signInFallbackRedirectUrl={`${basePath}/dashboard`}
    signUpFallbackRedirectUrl={`${basePath}/dashboard`}
    afterSignOutUrl={basePath || "/"}
    localization={{
      signIn: { start: { title: "Fieldnote owner access", subtitle: "Sign in to manage your Kalshi sports bot" } },
      signUp: { start: { title: "Verify your owner account", subtitle: "Only the configured owner's verified email can manage this bot" } },
    }}
    routerPush={(to) => setLocation(stripBase(to))}
    routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
  >{children}</ClerkProvider>;
}

export function ClearOwnerCache() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  const previous = useRef<string | null | undefined>(undefined);
  useEffect(() => addListener(({ user }) => {
    const id = user?.id ?? null;
    if (previous.current !== undefined && previous.current !== id) client.clear();
    previous.current = id;
  }), [addListener, client]);
  return null;
}

export function OwnerLanding() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div className="auth-page">Loading secure access…</div>;
  if (isSignedIn) return <Redirect to="/dashboard" />;
  return <div className="auth-page"><section className="auth-intro">
    <img src={`${basePath}/logo.svg`} width="240" height="52" alt="Fieldnote" />
    <p className="eyebrow">Private Kalshi sports monitor</p>
    <h1>Your sports signal.<br />One quiet dashboard.</h1>
    <p>Live Telegram charts, separate trade-value sections, and notifications for fresh individual sports trades across all tracked amounts, starting at $1,000, with comparable historical ROI of at least +7.0% and a sufficient verified sample.</p>
    <p>Monitoring runs on the server—not in this browser. Dashboard settings and Telegram pairing are restricted to the owner.</p>
    <Link className="button" href="/sign-in">Owner sign in</Link>
  </section></div>;
}

export function RequireSignIn({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div className="auth-page">Loading secure access…</div>;
  return isSignedIn ? children : <Redirect to="/" />;
}

export function OwnerSignIn() {
  return <div className="auth-page"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div>;
}

export function OwnerSignUp() {
  return <div className="auth-page"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div>;
}
