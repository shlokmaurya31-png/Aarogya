"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Neural Access ("Mercury") login — a self-contained, secure entry point for the
 * patient-access flow. It is NOT wired into the Hospital OS shell.
 *
 * Two stages:
 *   1. AUTH  — the clinician signs in with their own credentials (real login,
 *              sets the httpOnly session cookie). Patients are rejected here.
 *   2. CODE  — they enter the patient's one-time access code to open the record.
 *
 * If a valid clinician session already exists (`authed`), it skips straight to
 * the CODE stage.
 */

const CLINICIAN_ROLES = new Set([
  "DOCTOR", "NURSE", "HOSPITAL_ADMIN", "AAROGYA_ADMIN",
  "LAB_TECHNICIAN", "RADIOLOGY_TECH", "PHARMACIST", "BILLING_STAFF", "FRONT_DESK",
]);

export const NeuralAccessLogin: React.FC<{ authed?: boolean; displayName?: string }> = ({ authed = false, displayName }) => {
  const router = useRouter();
  const [stage, setStage] = useState<"auth" | "code">(authed ? "code" : "auth");
  const [who, setWho] = useState<string | undefined>(displayName);

  // Auth fields
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Code field
  const [code, setCode] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blobsData = useMemo(
    () =>
      Array.from({ length: 6 }).map(() => ({
        size: Math.random() * 200 + 150,
        left: Math.random() * 80 + 10,
        top: Math.random() * 80 + 10,
        animationDelay: Math.random() * -20,
        animationDuration: Math.random() * 15 + 15,
      })),
    []
  );
  const blobRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const x = e.clientX / window.innerWidth;
      const y = e.clientY / window.innerHeight;
      blobRefs.current.forEach((blob, index) => {
        if (blob) {
          const speed = (index + 1) * 20;
          blob.style.marginLeft = `${x * speed}px`;
          blob.style.marginTop = `${y * speed}px`;
        }
      });
    };
    document.addEventListener("mousemove", handleMouseMove);
    return () => document.removeEventListener("mousemove", handleMouseMove);
  }, []);

  async function handleAuth(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/scholar-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError((data?.error ?? "Access denied.").toString().toUpperCase()); return; }
      if (!CLINICIAN_ROLES.has(data.role)) {
        // A patient (or other non-clinician) may not open records here.
        await fetch("/api/scholar-auth/logout", { method: "POST" }).catch(() => {});
        setError("CLINICIAN ACCESS ONLY.");
        return;
      }
      setWho(data.displayName);
      setPassword("");
      setStage("code");
    } finally {
      setLoading(false);
    }
  }

  async function handleCode(e: React.FormEvent) {
    e.preventDefault();
    const clean = code.replace(/[^a-zA-Z0-9]/g, "");
    if (!clean || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/hospital/patient-access/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: clean }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError((data?.error ?? "Access denied.").toString().toUpperCase()); return; }
      router.push(`/consult/${data.sessionId}`);
    } finally {
      setLoading(false);
    }
  }

  async function signOut() {
    await fetch("/api/scholar-auth/logout", { method: "POST" }).catch(() => {});
    setStage("auth");
    setWho(undefined);
    setEmail("");
    setCode("");
    setError(null);
  }

  const isAuth = stage === "auth";

  return (
    <div className="mercury-wrapper">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;800&family=Space+Mono&display=swap');

        .mercury-wrapper {
          --bg: #050505;
          --mercury: #12b8b0;
          --accent: #ffffff;
          --text-dim: rgba(255, 255, 255, 0.5);
          --filter-goo: url('#gooey');
          background-color: var(--bg);
          color: var(--accent);
          font-family: 'Inter', sans-serif;
          height: 100vh; width: 100vw; overflow: hidden;
          display: flex; align-items: center; justify-content: center; position: relative;
        }
        .mercury-wrapper * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
        .mercury-wrapper .stage { position: absolute; width: 100%; height: 100%; z-index: 0; filter: var(--filter-goo); opacity: 0.55; }
        .mercury-wrapper .blob {
          position: absolute; background: linear-gradient(135deg, var(--mercury), #0a5f5b);
          border-radius: 50%; filter: blur(20px); animation: mercuryFloat 20s infinite alternate ease-in-out;
          box-shadow: inset -10px -10px 20px rgba(0,0,0,0.5), 10px 10px 30px rgba(18,184,176,0.2);
          transition: margin 0.1s ease-out;
        }
        @keyframes mercuryFloat {
          0% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(10vw, 20vh) scale(1.2); }
          66% { transform: translate(-5vw, 10vh) scale(0.8); }
          100% { transform: translate(5vw, -10vh) scale(1.1); }
        }
        .mercury-wrapper .auth-container { position: relative; z-index: 10; width: 100%; max-width: 440px; padding: 40px; }
        .mercury-wrapper .header { margin-bottom: 48px; text-align: left; }
        .mercury-wrapper .brand-id {
          font-family: 'Space Mono', monospace; font-size: 10px; letter-spacing: 4px;
          text-transform: uppercase; color: var(--text-dim); margin-bottom: 8px; display: block;
        }
        .mercury-wrapper .header h1 { font-weight: 800; font-size: 3rem; line-height: 0.9; letter-spacing: -2px; margin-left: -4px; margin-top: 0; }
        .mercury-wrapper .form-group { position: relative; margin-bottom: 30px; transition: transform 0.4s cubic-bezier(0.2, 1, 0.3, 1); }
        .mercury-wrapper .form-group:focus-within { transform: translateX(10px); }
        .mercury-wrapper .form-group label {
          display: block; font-family: 'Space Mono', monospace; font-size: 11px;
          color: var(--text-dim); margin-bottom: 12px; text-transform: uppercase;
        }
        .mercury-wrapper .form-group input {
          width: 100%; background: transparent; border: none; border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          color: var(--accent); padding: 12px 0; font-size: 18px; outline: none; transition: border-color 0.4s;
        }
        .mercury-wrapper .form-group input.code-input {
          font-family: 'Space Mono', monospace; font-size: 22px; letter-spacing: 6px; text-transform: uppercase;
        }
        .mercury-wrapper .input-glow {
          position: absolute; bottom: 0; left: 0; width: 0%; height: 2px; background: var(--mercury);
          transition: width 0.6s cubic-bezier(0.2, 1, 0.3, 1); box-shadow: 0 0 15px var(--mercury);
        }
        .mercury-wrapper .form-group input:focus + .input-glow { width: 100%; }
        .mercury-wrapper .error-line { font-family: 'Space Mono', monospace; font-size: 11px; color: #ff8a8a; margin: -14px 0 20px; letter-spacing: 1px; }
        .mercury-wrapper .who-line { font-family: 'Space Mono', monospace; font-size: 11px; color: var(--mercury); margin: -18px 0 24px; letter-spacing: 1px; }
        .mercury-wrapper .submit-wrap { margin-top: 44px; position: relative; filter: var(--filter-goo); }
        .mercury-wrapper .btn-base {
          background: var(--accent); color: #000; border: none; padding: 20px 40px; font-size: 14px; font-weight: 800;
          text-transform: uppercase; letter-spacing: 2px; cursor: pointer; width: 100%; position: relative; z-index: 2; transition: letter-spacing 0.3s;
        }
        .mercury-wrapper .btn-base:hover { letter-spacing: 4px; }
        .mercury-wrapper .btn-base:disabled { cursor: not-allowed; opacity: 0.7; }
        .mercury-wrapper .mercury-drop {
          position: absolute; top: 50%; left: 50%; width: 100%; height: 100%; background: var(--mercury);
          transform: translate(-50%, -50%); z-index: 1; border-radius: 50px; transition: all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }
        .mercury-wrapper .submit-wrap:hover .mercury-drop { transform: translate(-50%, -50%) scale(1.05, 1.2); filter: brightness(1.2); }
        .mercury-wrapper .footer-nav { margin-top: 40px; display: flex; justify-content: space-between; font-family: 'Space Mono', monospace; font-size: 10px; }
        .mercury-wrapper .footer-nav a { color: var(--text-dim); text-decoration: none; transition: color 0.3s; cursor: pointer; }
        .mercury-wrapper .footer-nav a:hover { color: var(--mercury); }
        .mercury-wrapper .svg-filter-hidden { position: absolute; width: 0; height: 0; }
      `}</style>

      <svg className="svg-filter-hidden">
        <defs>
          <filter id="gooey">
            <feGaussianBlur in="SourceGraphic" stdDeviation="12" result="blur" />
            <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 19 -9" result="goo" />
            <feComposite in="SourceGraphic" in2="goo" operator="atop" />
          </filter>
        </defs>
      </svg>

      <div className="stage">
        {blobsData.map((data, index) => (
          <div
            key={index}
            ref={(el) => { blobRefs.current[index] = el; }}
            className="blob"
            style={{
              width: `${data.size}px`, height: `${data.size}px`,
              left: `${data.left}%`, top: `${data.top}%`,
              animationDelay: `${data.animationDelay}s`, animationDuration: `${data.animationDuration}s`,
            }}
          />
        ))}
      </div>

      <main className="auth-container">
        <header className="header">
          <span className="brand-id">Aarogya // {isAuth ? "Clinician Access" : "Patient Record"}</span>
          <h1>{isAuth ? <>NEURAL<br />ACCESS</> : <>PATIENT<br />CODE</>}</h1>
        </header>

        {isAuth ? (
          <form autoComplete="off" onSubmit={handleAuth}>
            <div className="form-group">
              <label>Clinician Identity</label>
              <input type="email" value={email} onChange={(e) => { setError(null); setEmail(e.target.value); }} placeholder="you@facility" autoComplete="username" required autoFocus />
              <div className="input-glow" />
            </div>
            <div className="form-group">
              <label>Sequence Key</label>
              <input type="password" value={password} onChange={(e) => { setError(null); setPassword(e.target.value); }} placeholder="••••••••" autoComplete="current-password" required />
              <div className="input-glow" />
            </div>
            {error && <p className="error-line">// {error}</p>}
            <div className="submit-wrap">
              <div className="mercury-drop" />
              <button type="submit" className="btn-base" disabled={loading}>{loading ? "Authenticating…" : "Authenticate"}</button>
            </div>
          </form>
        ) : (
          <form autoComplete="off" onSubmit={handleCode}>
            {who && <p className="who-line">// SIGNED IN AS {who.toUpperCase()}</p>}
            <div className="form-group">
              <label>Patient Access Code</label>
              <input className="code-input" type="text" value={code} onChange={(e) => { setError(null); setCode(e.target.value.toUpperCase()); }} placeholder="ABCD-EF23" maxLength={9} required autoFocus />
              <div className="input-glow" />
            </div>
            {error && <p className="error-line">// {error}</p>}
            <div className="submit-wrap">
              <div className="mercury-drop" />
              <button type="submit" className="btn-base" disabled={loading}>{loading ? "Establishing…" : "Initialize Stream"}</button>
            </div>
          </form>
        )}

        <footer className="footer-nav">
          {isAuth ? (
            <>
              <span style={{ color: "var(--text-dim)" }}>ENCRYPTED · CONSENT-BASED</span>
              <span style={{ color: "var(--text-dim)" }}>15-MIN SESSION</span>
            </>
          ) : (
            <>
              <a onClick={signOut}>← SIGN OUT</a>
              <span style={{ color: "var(--text-dim)" }}>15-MIN SESSION</span>
            </>
          )}
        </footer>
      </main>
    </div>
  );
};

export default NeuralAccessLogin;
