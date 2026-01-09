// ystorage-trystero.mjs
// localStorage-like API backed by Yjs, synced P2P over WebRTC via Trystero (Nostr signaling).
//
// Dependencies are loaded from CDNs (ESM). Drop this file on any static host/CDN.
//
// Notes:
// - Trystero uses Nostr only for signaling; payload goes over WebRTC. :contentReference[oaicite:0]{index=0}
// - Yjs sync is done with state vectors + diffs. :contentReference[oaicite:1]{index=1}

import * as Y from "https://esm.sh/yjs@13.6.19";
import { joinRoom, selfId } from "https://esm.run/trystero/nostr"; // Nostr signaling strategy :contentReference[oaicite:2]{index=2}

export function createYStorage({
  appId,          // required by Trystero
  roomId,         // room namespace
  relayUrls,      // optional custom Nostr relays (Trystero config)
  password,       // optional (Trystero encryption for signaling)
  name = "ystorage",
  maxPeers,       // optional (Trystero doesn't enforce; you can gate join events yourself)
} = {}) {
  if (!appId) throw new Error("createYStorage: appId is required");
  if (!roomId) throw new Error("createYStorage: roomId is required");

  // ---- Yjs state ----
  const doc = new Y.Doc();
  const map = doc.getMap(name);

  // ---- Trystero room (WebRTC mesh, Nostr signaling) ----
  const cfg = { appId };
  if (relayUrls) cfg.relayUrls = relayUrls;
  if (password) cfg.password = password;

  const room = joinRoom(cfg, roomId); // :contentReference[oaicite:3]{index=3}

  // Actions:
  // - sync1: send stateVector (Uint8Array)
  // - sync2: send missing update for received stateVector (Uint8Array)
  // - upd: push incremental updates (Uint8Array)
  const [sendSync1, onSync1] = room.makeAction("yjs:sync1");
  const [sendSync2, onSync2] = room.makeAction("yjs:sync2");
  const [sendUpd,  onUpd ]  = room.makeAction("yjs:upd");

  // Initial sync when a peer joins:
  // 1) we send our state vector
  // 2) peer replies with the diff update we miss (sync2)
  // 3) we reply with the diff update they miss (sync2) when we receive their sync1
  room.onPeerJoin((peerId) => {
    if (maxPeers && room.getPeers && room.getPeers().length > maxPeers) return;
    const sv = Y.encodeStateVector(doc);
    sendSync1(sv, peerId);
  });

  onSync1((svBuf, peerId) => {
    const sv = toU8(svBuf);
    const diff = Y.encodeStateAsUpdate(doc, sv); // compute what they miss :contentReference[oaicite:4]{index=4}
    sendSync2(diff, peerId);
  });

  onSync2((updateBuf) => {
    Y.applyUpdate(doc, toU8(updateBuf));
  });

  // Broadcast incremental updates as they happen
  doc.on("update", (update) => {
    sendUpd(update); // Trystero handles chunking/serialization :contentReference[oaicite:5]{index=5}
  });

  onUpd((updateBuf) => {
    Y.applyUpdate(doc, toU8(updateBuf));
  });

  // ---- localStorage-like API + “storage” event ----
  const bus = new EventTarget();

  let snap = snapshot(map);
  map.observe(() => {
    const next = snapshot(map);
    // changed/added
    for (const [k, newValue] of next) {
      const oldValue = snap.has(k) ? snap.get(k) : null;
      if (oldValue !== newValue) bus.dispatchEvent(evt(k, oldValue, newValue));
    }
    // removed
    for (const [k, oldValue] of snap) {
      if (!next.has(k)) bus.dispatchEvent(evt(k, oldValue, null));
    }
    snap = next;
  });

  function evt(key, oldValue, newValue) {
    return new CustomEvent("storage", {
      detail: {
        key,
        oldValue,
        newValue,
        storageArea: api,
        url: typeof location !== "undefined" ? location.href : "",
      },
    });
  }

  const api = {
    // localStorage surface
    get length() {
      return map.size;
    },
    key(n) {
      return Array.from(map.keys())[n] ?? null;
    },
    getItem(key) {
      const v = map.get(String(key));
      return v === undefined ? null : String(v);
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    clear() {
      map.clear();
    },

    // events
    addEventListener(type, fn, opts) {
      bus.addEventListener(type, fn, opts);
    },
    removeEventListener(type, fn, opts) {
      bus.removeEventListener(type, fn, opts);
    },

    // lifecycle
    destroy() {
      try { room.leave(); } catch {}
      try { doc.destroy(); } catch {}
    },

    // debug/escape hatches
    _doc: doc,
    _map: map,
    _room: room,
    _selfId: selfId,
    Y,
  };

  return api;
}

function toU8(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  // Trystero may deliver raw ArrayBuffer for binary; handle common cases
  if (x?.buffer instanceof ArrayBuffer) return new Uint8Array(x.buffer);
  throw new Error("Unexpected binary type");
}

function snapshot(map) {
  const m = new Map();
  map.forEach((v, k) => m.set(k, String(v)));
  return m;
}
