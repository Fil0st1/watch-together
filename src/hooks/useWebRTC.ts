import { useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

type SignalMessage =
  | { type: "offer"; sdp: RTCSessionDescriptionInit; from: string; to?: string }
  | { type: "answer"; sdp: RTCSessionDescriptionInit; from: string; to?: string }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit; from: string; to?: string }
  | { type: "host-stopped"; from: string; to?: string }
  | { type: "host-started"; from: string; to?: string }
  | { type: "viewer-ready"; from: string; to?: string };

interface UseWebRTCOptions {
  roomId: string;
  peerId: string;
  isHost: boolean;
  onStreamReceived: (stream: MediaStream) => void;
  onHostStopped: () => void;
}

// ICE servers (STUN only — free, no TURN needed for same-network / most cases)
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export function useWebRTC({
  roomId,
  peerId,
  isHost,
  onStreamReceived,
  onHostStopped,
}: UseWebRTCOptions) {
  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  const sendSignal = useCallback(
    (payload: object) => {
      channelRef.current?.send({
        type: "broadcast",
        event: "signal",
        payload,
      });
    },
    []
  );

  const createPeerConnection = useCallback(
    (remotePeerId: string): RTCPeerConnection => {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          sendSignal({
            type: "ice-candidate",
            candidate: e.candidate.toJSON(),
            from: peerId,
            to: remotePeerId,
          });
        }
      };

      pc.ontrack = (e) => {
        if (!isHost && e.streams[0]) {
          onStreamReceived(e.streams[0]);
        }
      };

      peerConnections.current.set(remotePeerId, pc);
      return pc;
    },
    [isHost, peerId, sendSignal, onStreamReceived]
  );

  // Start sharing — called by host
  const startSharing = useCallback(async (): Promise<MediaStream | null> => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: true,
      });
      localStreamRef.current = stream;

      // Send offer to all existing viewers by broadcasting
      sendSignal({ type: "host-started", from: peerId });

      return stream;
    } catch {
      return null;
    }
  }, [peerId, sendSignal]);

  // Called when a viewer joins and host is already sharing
  const sendOfferToViewer = useCallback(
    async (viewerId: string) => {
      if (!localStreamRef.current) return;
      const pc = createPeerConnection(viewerId);

      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current!);
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      sendSignal({ type: "offer", sdp: pc.localDescription!, from: peerId, to: viewerId });
    },
    [createPeerConnection, peerId, sendSignal]
  );

  // Stop sharing
  const stopSharing = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    peerConnections.current.forEach((pc) => pc.close());
    peerConnections.current.clear();
    sendSignal({ type: "host-stopped", from: peerId });
  }, [peerId, sendSignal]);

  // Handle incoming signals
  const handleSignal = useCallback(
    async (payload: SignalMessage) => {
      if (payload.from === peerId) return; // ignore self
      if (payload.to && payload.to !== peerId) return; // not for us

      if (payload.type === "host-started" && !isHost) {
        // Viewer: request stream by announcing presence
        sendSignal({ type: "viewer-ready", from: peerId });
        return;
      }

      if (payload.type === "viewer-ready" && isHost) {
        await sendOfferToViewer(payload.from);
        return;
      }

      if (payload.type === "offer" && !isHost) {
        const pc = createPeerConnection(payload.from);
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal({ type: "answer", sdp: pc.localDescription!, from: peerId, to: payload.from });
        return;
      }

      if (payload.type === "answer" && isHost) {
        const pc = peerConnections.current.get(payload.from);
        if (pc) await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        return;
      }

      if (payload.type === "ice-candidate") {
        const pc = peerConnections.current.get(payload.from);
        if (pc && payload.candidate) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
          } catch {
            // ignore
          }
        }
        return;
      }

      if (payload.type === "host-stopped" && !isHost) {
        onHostStopped();
        peerConnections.current.forEach((pc) => pc.close());
        peerConnections.current.clear();
        return;
      }
    },
    [isHost, peerId, createPeerConnection, sendSignal, sendOfferToViewer, onHostStopped]
  );

  // Setup Supabase Realtime channel for signaling
  useEffect(() => {
    const channel = supabase
      .channel(`room:${roomId}`, {
        config: { broadcast: { self: false } },
      })
      .on("broadcast", { event: "signal" }, ({ payload }) => {
        handleSignal(payload as SignalMessage & { to?: string });
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED" && !isHost) {
          // Announce viewer is ready in case host is already sharing
          sendSignal({ type: "viewer-ready", from: peerId });
        }
      });

    channelRef.current = channel;

    return () => {
      channel.unsubscribe();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      peerConnections.current.forEach((pc) => pc.close());
      peerConnections.current.clear();
    };
  }, [roomId, isHost, peerId, handleSignal, sendSignal]);

  return { startSharing, stopSharing, localStreamRef };
}
