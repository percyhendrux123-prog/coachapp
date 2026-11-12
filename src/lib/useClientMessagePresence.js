import { useCallback, useEffect, useRef, useState } from "react";
import {
  messageRequestIsCurrent,
  readMessageLastSeen,
  resolveMessagePresence,
  writeMessageLastSeen,
} from "./clientMessagePresence.js";

const EMPTY_VIEW = {
  ownerKey: null,
  rows: [],
  loadState: "idle",
  readError: null,
  unreadCount: 0,
};

function defaultPresenceError(label, error) {
  console.error(label, error);
}

function browserStorage() {
  try { return window.localStorage; } catch { return null; }
}

export function useClientMessagePresence({
  messageKey,
  enabled,
  clientId,
  activeTabRef,
  storage = undefined,
  eventWindow = typeof window !== "undefined" ? window : null,
  eventDocument = typeof document !== "undefined" ? document : null,
  listMessagesFn,
  latestCoachCursorFn,
  countUnreadFn,
  onPresenceError = defaultPresenceError,
}) {
  const [view, setView] = useState(EMPTY_VIEW);
  const ownerRef = useRef({ key: null, ownerVersion: 0 });
  const requestRef = useRef(null);
  const requestIdRef = useRef(0);
  const lastSeenRef = useRef(null);

  const applyPresence = useCallback((owner, rows, { newestCoachCursor, unreadCount }) => {
    const store = storage === undefined ? browserStorage() : storage;
    const lastSeen = lastSeenRef.current || readMessageLastSeen(store, owner.key);
    const presence = resolveMessagePresence(rows, lastSeen, {
      markSeen: activeTabRef.current === "messages",
      newestCoachCursor,
      unreadCount,
      baselineAt: new Date().toISOString(),
    });
    lastSeenRef.current = presence.lastSeenCursor;
    if (presence.lastSeenCursor) writeMessageLastSeen(store, owner.key, presence.lastSeenCursor);
    return presence;
  }, [activeTabRef, storage]);

  const refreshMessages = useCallback(({ force = false } = {}) => {
    if (!enabled || !clientId || !messageKey) return Promise.resolve([]);
    const owner = ownerRef.current;
    if (owner.key !== messageKey) return Promise.resolve([]);
    if (!force && requestRef.current?.key === messageKey) return requestRef.current.promise;

    const store = storage === undefined ? browserStorage() : storage;
    const lastSeen = lastSeenRef.current || readMessageLastSeen(store, messageKey);
    const requestId = ++requestIdRef.current;
    const requestMeta = { key: messageKey, ownerVersion: owner.ownerVersion, requestId };

    setView((current) => current.ownerKey === messageKey
      ? { ...current, loadState: current.loadState === "ready" ? "ready" : "loading", readError: null }
      : { ...EMPTY_VIEW, ownerKey: messageKey, loadState: "loading" });

    // Presence reads are ancillary. They start with the thread read, but allSettled
    // keeps an exact-count outage from hiding a successfully loaded conversation.
    const presencePromise = Promise.allSettled([
      Promise.resolve().then(() => latestCoachCursorFn({ clientId, messageKey })),
      lastSeen
        ? Promise.resolve().then(() => countUnreadFn(lastSeen, { clientId, messageKey }))
        : Promise.resolve(0),
    ]);

    const request = Promise.resolve()
      .then(() => listMessagesFn({ clientId, messageKey }))
      .then(async (rows) => {
        const [latestResult, countResult] = await presencePromise;
        const currentRequest = {
          ...ownerRef.current,
          requestId: requestIdRef.current,
        };
        if (!messageRequestIsCurrent(requestMeta, currentRequest)) return rows;

        if (latestResult.status === "rejected") onPresenceError("latest coach message cursor failed", latestResult.reason);
        if (countResult.status === "rejected") onPresenceError("exact unread count failed", countResult.reason);
        const presence = applyPresence(owner, rows, {
          newestCoachCursor: latestResult.status === "fulfilled" ? latestResult.value : null,
          unreadCount: countResult.status === "fulfilled" ? countResult.value : null,
        });
        setView({
          ownerKey: owner.key,
          rows,
          loadState: "ready",
          readError: null,
          unreadCount: presence.unreadCount,
        });
        return rows;
      })
      .catch((error) => {
        const currentRequest = {
          ...ownerRef.current,
          requestId: requestIdRef.current,
        };
        if (messageRequestIsCurrent(requestMeta, currentRequest)) {
          setView((current) => ({
            ...current,
            ownerKey: owner.key,
            loadState: "failed",
            readError: error?.message || String(error),
          }));
        }
        throw error;
      })
      .finally(() => {
        if (requestRef.current?.requestId === requestId) requestRef.current = null;
      });

    requestRef.current = { ...requestMeta, promise: request };
    return request;
  }, [
    applyPresence,
    clientId,
    countUnreadFn,
    enabled,
    latestCoachCursorFn,
    listMessagesFn,
    messageKey,
    onPresenceError,
    storage,
  ]);

  useEffect(() => {
    const owner = {
      key: messageKey,
      ownerVersion: ownerRef.current.ownerVersion + 1,
    };
    ownerRef.current = owner;
    requestIdRef.current += 1;
    requestRef.current = null;
    lastSeenRef.current = null;
    setView({ ...EMPTY_VIEW, ownerKey: messageKey });

    if (enabled && clientId && messageKey) refreshMessages().catch(() => {});
    return () => {
      if (ownerRef.current.ownerVersion === owner.ownerVersion) {
        ownerRef.current = { key: null, ownerVersion: owner.ownerVersion + 1 };
        requestIdRef.current += 1;
        requestRef.current = null;
      }
    };
  }, [clientId, enabled, messageKey, refreshMessages]);

  useEffect(() => {
    if (!enabled || !clientId || !messageKey || !eventWindow || !eventDocument) return;
    const refreshOnReturn = () => { refreshMessages().catch(() => {}); };
    const refreshWhenVisible = () => {
      if (eventDocument.visibilityState === "visible") refreshOnReturn();
    };
    eventWindow.addEventListener("focus", refreshOnReturn);
    eventDocument.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      eventWindow.removeEventListener("focus", refreshOnReturn);
      eventDocument.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [clientId, enabled, eventDocument, eventWindow, messageKey, refreshMessages]);

  const current = view.ownerKey === messageKey;
  return {
    rows: current ? view.rows : [],
    loadState: current ? view.loadState : "idle",
    readError: current ? view.readError : null,
    unreadCount: current ? view.unreadCount : 0,
    refreshMessages,
  };
}
