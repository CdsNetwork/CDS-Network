"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Brand } from "@/components/Brand";
import { CdsNav } from "@/components/CdsNav";
import { SignOutButton } from "@/components/SignOutButton";
import { initials, sidebarCookie } from "@/lib/sidebar";

const REGION = "US operations";

// Desktop: a sidebar pinned to the viewport (its nav scrolls on its own) with the signed-in
// person always visible at the bottom, collapsible to an icon rail. Phone: a slim top bar whose
// menu button opens the same nav and account block as a drawer.
export function CdsSidebar({ fullName, initialCollapsed }: { fullName: string; initialCollapsed: boolean }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navId = useId();
  const drawerId = useId();
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  function toggleCollapsed() {
    const next = !collapsed;
    document.cookie = sidebarCookie(next);
    setCollapsed(next);
  }

  return (
    <>
      <header className="cds-phonebar">
        <button
          type="button"
          className="cds-iconbtn"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          aria-expanded={drawerOpen}
          aria-controls={drawerId}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <Brand subtitle="CDS Network Portal" />
      </header>

      {drawerOpen && (
        <Drawer id={drawerId} onClose={closeDrawer}>
          <div className="cds-side-nav">
            <CdsNav onNavigate={closeDrawer} />
          </div>
          <AccountBlock fullName={fullName} />
        </Drawer>
      )}

      <aside className={`cds-side${collapsed ? " collapsed" : ""}`}>
        <div className="cds-side-head">
          {collapsed ? (
            <div className="mark" title="CDS Network Portal">
              CDS
            </div>
          ) : (
            <Brand subtitle="CDS Network Portal" />
          )}
          <button
            type="button"
            className="cds-iconbtn"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            aria-controls={navId}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={collapsed ? "m10 7 5 5-5 5" : "m14 7-5 5 5 5"} />
            </svg>
          </button>
        </div>
        <div id={navId} className="cds-side-nav">
          <CdsNav collapsed={collapsed} />
        </div>
        {collapsed ? <CollapsedAccountMenu fullName={fullName} /> : <AccountBlock fullName={fullName} />}
      </aside>
    </>
  );
}

function Avatar({ fullName }: { fullName: string }) {
  return (
    <span className="cds-avatar" aria-hidden="true">
      {initials(fullName)}
    </span>
  );
}

function AccountBlock({ fullName }: { fullName: string }) {
  return (
    <div className="cds-account">
      <div className="cds-region">{REGION}</div>
      <div className="cds-account-name">{fullName}</div>
      <SignOutButton />
    </div>
  );
}

function CollapsedAccountMenu({ fullName }: { fullName: string }) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapper} className="cds-account collapsed">
      <button
        ref={button}
        type="button"
        className="cds-avatarbtn"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Account: ${fullName}`}
        title={fullName}
        aria-expanded={open}
        aria-controls={menuId}
      >
        <Avatar fullName={fullName} />
      </button>
      {open && (
        <div id={menuId} className="cds-account-menu">
          <div className="cds-account-name">{fullName}</div>
          <div className="cds-region">{REGION}</div>
          <SignOutButton />
        </div>
      )}
    </div>
  );
}

function Drawer({ id, onClose, children }: { id: string; onClose: () => void; children: React.ReactNode }) {
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    close.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    // The drawer is phone only: widening past the md breakpoint closes it, or the hidden
    // drawer would keep the page scroll locked.
    const desktop = window.matchMedia("(min-width: 768px)");
    function onWiden() {
      if (desktop.matches) onClose();
    }
    onWiden();
    desktop.addEventListener("change", onWiden);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      desktop.removeEventListener("change", onWiden);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return (
    <div id={id} role="dialog" aria-modal="true" aria-label="Menu" className="cds-drawer">
      <div className="cds-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="cds-drawer-panel">
        <div className="cds-side-head">
          <Brand subtitle="CDS Network Portal" />
          <button ref={close} type="button" className="cds-iconbtn" onClick={onClose} aria-label="Close menu">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
