/**
 * Mock auth — a working sign-up / sign-in when Firebase is not configured.
 *
 * Without credentials `requireAuth()` throws and every sign-in reports "not
 * configured", so a generated app cannot be signed into at all. That matters
 * beyond convenience: `@user.id` and `@user.role` are what ownership scoping and
 * role gates resolve against, so with no viewer every "only mine" list is empty
 * and every role gate takes its negative branch — the app can only be seen as
 * nobody. Bypassed the moment real Firebase credentials are present.
 */

import {
  MOCK_PERSONAS,
  encodeDevIdentityToken,
  findMockPersona,
  isFieldValue,
  type UserContext,
} from '@almadar/core';

export interface MockUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  role?: string;
  getIdToken(): Promise<string>;
}

type Listener = (user: MockUser | null) => void;

const STORAGE_KEY = 'almadar.mockAuth.session';
const REGISTERED_KEY = 'almadar.mockAuth.registered';

/** The role a brand-new or unknown account gets — never `admin`. */
const DEFAULT_ROLE = 'member';

const listeners = new Set<Listener>();
let current: MockUser | null = null;
let registered: UserContext[] = [];

function toMockUser(p: UserContext): MockUser {
  return {
    uid: p.id,
    email: typeof p.email === 'string' ? p.email : null,
    displayName: typeof p.name === 'string' ? p.name : null,
    photoURL: null,
    role: typeof p.role === 'string' ? p.role : undefined,
    // The server trusts this only under ALLOW_DEV_AUTH_BYPASS; it carries the
    // whole persona so server-side `@user.role` matches the client's.
    getIdToken: () => Promise.resolve(encodeDevIdentityToken(p)),
  };
}

/** A stored account, validated field by field — never trust localStorage shape. */
function readPersona(raw: unknown): UserContext | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record: Record<string, unknown> = { ...raw };
  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0) return null;
  const persona: UserContext = { id };
  for (const key of ['email', 'name', 'role'] as const) {
    const value = record[key];
    if (typeof value === 'string' && isFieldValue(value)) persona[key] = value;
  }
  return persona;
}

function readRegistered(): UserContext[] {
  try {
    const raw = localStorage.getItem(REGISTERED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(readPersona).filter((p): p is UserContext => p !== null);
  } catch {
    return [];
  }
}

function writeRegistered(list: UserContext[]): void {
  registered = list;
  try {
    localStorage.setItem(REGISTERED_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable — the session stays in memory for this tab */
  }
}

function allAccounts(): UserContext[] {
  return [...MOCK_PERSONAS, ...registered];
}

function emit(): void {
  for (const fn of listeners) fn(current);
}

function persist(user: MockUser | null): void {
  try {
    if (user) localStorage.setItem(STORAGE_KEY, JSON.stringify({ uid: user.uid }));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Restore a persisted session. Safe to call more than once. */
export function initMockAuth(): void {
  registered = readRegistered();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return;
    const session: Record<string, unknown> = { ...parsed };
    const uid = session['uid'];
    if (typeof uid !== 'string') return;
    const found = allAccounts().find((a) => a.id === uid);
    if (found) current = toMockUser(found);
  } catch {
    /* ignore a corrupt session */
  }
}

/** Every persona that can be signed into — for the dev persona picker. */
export function listMockAccounts(): readonly UserContext[] {
  return allAccounts();
}

function newAccount(email: string, displayName?: string): UserContext {
  return {
    id: `user-${allAccounts().length + 1}`,
    email,
    name: displayName ?? email.split('@')[0] ?? email,
    role: DEFAULT_ROLE,
  };
}

function byEmail(email: string): UserContext | undefined {
  return allAccounts().find(
    (a) => typeof a.email === 'string' && a.email.toLowerCase() === email.toLowerCase(),
  );
}

function signInAs(account: UserContext): MockUser {
  current = toMockUser(account);
  persist(current);
  emit();
  return current;
}

export const mockAuth = {
  get currentUser(): MockUser | null {
    return current;
  },

  onAuthStateChanged(fn: Listener): () => void {
    listeners.add(fn);
    // Match Firebase: the listener fires immediately with the current state.
    fn(current);
    return () => listeners.delete(fn);
  },

  /** Any password is accepted; an unknown email signs in as a new end-user. */
  signInWithEmail(email: string, _password: string): Promise<MockUser> {
    return Promise.resolve(signInAs(byEmail(email) ?? newAccount(email)));
  },

  signUpWithEmail(email: string, _password: string, displayName?: string): Promise<MockUser> {
    if (byEmail(email)) {
      return Promise.reject(new Error('An account with that email already exists'));
    }
    const account = newAccount(email, displayName);
    writeRegistered([...registered, account]);
    return Promise.resolve(signInAs(account));
  },

  /** Sign in directly as a named persona — the dev persona switch. */
  signInAsPersona(idOrRole: string): Promise<MockUser> {
    const account =
      findMockPersona(idOrRole) ??
      registered.find((a) => a.id === idOrRole || a.role === idOrRole);
    if (!account) {
      return Promise.reject(
        new Error(
          `Unknown persona "${idOrRole}". Known: ${allAccounts().map((a) => `${a.id}/${String(a.role)}`).join(', ')}`,
        ),
      );
    }
    return Promise.resolve(signInAs(account));
  },

  signOut(): Promise<void> {
    current = null;
    persist(null);
    emit();
    return Promise.resolve();
  },
};
