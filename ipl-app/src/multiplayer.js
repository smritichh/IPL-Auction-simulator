// Multiplayer room service (host-authoritative, Supabase Realtime).
//
// A "room" is just a Realtime channel named by its share code — no database
// table needed. The LOBBY (who's here, which team each player claimed, ready
// state) rides on Realtime *Presence*, which merges every client's own state
// and syncs it to everyone, so the lobby needs no host authority. The AUCTION
// (next stage) rides on Realtime *Broadcast*: the host's browser is the single
// source of truth and broadcasts STATE/SOLD; other players send BID intents.
//
// Identity: a stable per-browser id (logged-in user id when available, else a
// localStorage UUID) + a display name. No forced login for multiplayer.
import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./supabase";

// ── message protocol ──────────────────────────────────────────────────────
// Lobby is carried in the Presence payload: { playerId, name, teamId, ready }.
// Auction messages are Broadcast events (used from Stage 2 onward):
export const EVENTS = {
  // player → host
  BID_INTENT:  "bid_intent",   // { lotIndex, bidSeq }
  SKIP_INTENT: "skip_intent",  // { lotIndex }
  // host → everyone
  LOT_OPEN:    "lot_open",     // { lotIndex, player, basePrice, deadlineTs, bidSeq }
  STATE:       "state",        // { lotIndex, askingPrice, leaderId, bidSeq, deadlineTs }
  SOLD:        "sold",         // { lotIndex, winnerId, price }
  UNSOLD:      "unsold",       // { lotIndex }
  AUCTION_DONE:"auction_done", // { squads }
  // host → a late/rejoining player (full resync)
  SNAPSHOT:    "snapshot",     // { ...authoritative game state }
};

// ── identity ────────────────────────────────────────────────────────────────
const PID_KEY = "ipl_player_id";
export function getPlayerId() {
  try {
    let id = localStorage.getItem(PID_KEY);
    if (!id) {
      id = (crypto?.randomUUID?.() ?? `p_${Math.random().toString(36).slice(2)}_${Date.now()}`);
      localStorage.setItem(PID_KEY, id);
    }
    return id;
  } catch {
    // localStorage unavailable (private mode) → ephemeral id for this session
    return `p_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  }
}

// ── share codes: unambiguous (no 0/O/1/I), 5 chars ──────────────────────────
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function genRoomCode(len = 5) {
  let c = "";
  for (let i = 0; i < len; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return c;
}
export const normalizeCode = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
const channelName = (code) => `mp-room-${code}`;

// Flatten Supabase presence state ({ key: [meta, ...] }) into a de-duped member
// list, newest meta per player wins.
function membersFromPresence(state) {
  const byId = new Map();
  for (const key of Object.keys(state || {})) {
    for (const meta of state[key] || []) {
      if (meta?.playerId) byId.set(meta.playerId, meta);
    }
  }
  return Array.from(byId.values());
}

// ── room hook ────────────────────────────────────────────────────────────────
// useRoom({ code, name, isHost }) → live lobby state + a channel handle the
// auction layer (Stage 2) will use for Broadcast. Returns null-safe values when
// Supabase isn't configured so the rest of the app never crashes.
export function useRoom({ code, name, isHost }) {
  const [playerId] = useState(getPlayerId);
  const channelRef = useRef(null);
  const [status, setStatus]   = useState(() => (supabase ? "connecting" : "disabled"));
  const [members, setMembers] = useState([]);            // [{ playerId, name, teamId, ready, isHost }]
  const [self, setSelf]       = useState(() => ({ playerId, name, teamId: null, ready: false, isHost: !!isHost }));

  // keep the latest self payload available to the (re)track calls
  const selfRef = useRef(self);
  useEffect(() => { selfRef.current = self; }, [self]);

  useEffect(() => {
    if (!supabase || !code) return;

    const channel = supabase.channel(channelName(code), {
      config: { presence: { key: playerId }, broadcast: { self: true } },
    });
    channelRef.current = channel;

    channel.on("presence", { event: "sync" }, () => {
      setMembers(membersFromPresence(channel.presenceState()));
    });

    channel.subscribe((s) => {
      if (s === "SUBSCRIBED") {
        channel.track(selfRef.current);
        setStatus("joined");
      } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") {
        setStatus("error");
      }
    });

    return () => { try { supabase.removeChannel(channel); } catch { /* ignore */ } channelRef.current = null; };
    // re-subscribe only when the room code changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // push an update to my own presence (team claim, ready toggle, name change)
  const updateSelf = useCallback((patch) => {
    setSelf((prev) => {
      const next = { ...prev, ...patch };
      selfRef.current = next;
      channelRef.current?.track(next);
      return next;
    });
  }, []);

  const claimTeam = useCallback((teamId) => updateSelf({ teamId }), [updateSelf]);
  const setReady  = useCallback((ready) => updateSelf({ ready }), [updateSelf]);

  // ── auction transport (used from Stage 2): host broadcasts, players send
  //    intents. Kept here so the channel ref never leaks into render. ──
  const send = useCallback((event, payload) => {
    channelRef.current?.send({ type: "broadcast", event, payload });
  }, []);
  const onEvent = useCallback((event, handler) => {
    const ch = channelRef.current;
    if (!ch) return () => {};
    ch.on("broadcast", { event }, ({ payload }) => handler(payload));
    return () => {}; // channel teardown removes all listeners
  }, []);

  return { playerId, status, members, self, claimTeam, setReady, updateSelf, send, onEvent };
}
