import { useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

type SignalMessage =
  | { type: "offer"; sdp: RTCSessionDescriptionInit; from: string; to?: string }
  | { type: "answer"; sdp: RTCSessionDescriptionInit; from: string; to?: string }
  | { type: "ice-candidate"; candidate: RTCIceCandidateInit; from: string; to?: string }
  | { type: "host-stopped"; from: string; to?: string }
  | { type: "host-started"; from: string; to?: string }
  | { type: "viewer-ready"; from: string; to?: string }
  | { type: "control"; action: "play" | "pause" | "seek" | "sync" | "file-url"; payload?: any; from: string; to?: string };

interface UseWebRTCOptions {
  roomId: string;
  peerId: string;
  isHost: boolean;
  onStreamReceived: (stream: MediaStream) => void;
  onHostStopped: () => void;
  onControlReceived?: (action: "play" | "pause" | "seek" | "sync" | "file-url", payload?: any) => void;
  onViewerReady?: (viewerId: string) => void;
}

// ICE servers (STUN only — free, no TURN needed for same-network / most cases)
// Added Cloudflare STUN for better connection stability
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

export function useWebRTC({
  roomId,
  peerId,
  isHost,
  onStreamReceived,
  onHostStopped,
  onControlReceived,
  onViewerReady,
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

  const sendControlSignal = useCallback(
    (action: "play" | "pause" | "seek" | "sync" | "file-url", payload?: any, to?: string) => {
      sendSignal({ type: "control", action, payload, from: peerId, to });
    },
    [peerId, sendSignal]
  );

  const createPeerConnection = useCallback(
    (remotePeerId: string): RTCPeerConnection => {
      // Prepare for SFU: bundlePolicy "max-bundle" multiplexes all tracks over a single transport
      const pc = new RTCPeerConnection({
        iceServers: ICE_SERVERS,
        bundlePolicy: "max-bundle",
      });

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
          // Reduce buffering: set playout delay hint to minimize latency over quality tradeoffs
          if (e.receiver && "playoutDelayHint" in e.receiver) {
            (e.receiver as any).playoutDelayHint = 0;
          }
          onStreamReceived(e.streams[0]);
        }
      };

      peerConnections.current.set(remotePeerId, pc);
      return pc;
    },
    [isHost, peerId, sendSignal, onStreamReceived]
  );

  // Start sharing — called by host
  const startSharing = useCallback(async (customStream?: MediaStream): Promise<MediaStream | null> => {
    try {
      let stream = customStream;
      if (!stream) {
        // Configuration for high quality, high frame rate screen sharing.
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            // Prefer 30 FPS for stable streaming
            frameRate: { ideal: 30, max: 30 },
            // Cap resolution (1080p)
            width: { max: 1920, ideal: 1280 },
            height: { max: 1080, ideal: 720 },
            // Hint to the browser we are sharing a monitor/screen
            displaySurface: "monitor",
          },
          audio: {
            // Disable filters that degrade system audio quality and clear up echo/voice optimizations
            autoGainControl: false,
            echoCancellation: false,
            noiseSuppression: false,
          },
        });

        // Handle cases where audio is missing gracefully
        if (stream.getAudioTracks().length === 0) {
          console.warn("No audio track found in display media stream. Viewers won't hear system audio.");
        }
      }

      localStreamRef.current = stream;

      // Send offer to all existing viewers by broadcasting
      sendSignal({ type: "host-started", from: peerId });

      return stream;
    } catch (err) {
      console.error("Error getting display media:", err);
      return null;
    }
  }, [peerId, sendSignal]);

  // Called when a viewer joins and host is already sharing
  const sendOfferToViewer = useCallback(
    async (viewerId: string) => {
      if (!localStreamRef.current) return;
      const pc = createPeerConnection(viewerId);

      localStreamRef.current.getTracks().forEach((track) => {
        const sender = pc.addTrack(track, localStreamRef.current!);

        // Optimize WebRTC for real-time streaming, not file quality
        if (track.kind === "video") {
          const params = sender.getParameters();
          // degradationPreference controls how the browser reacts to poor network
          // maintain-framerate prioritizes playback speed over perfect resolution
          if (!params.degradationPreference) {
            params.degradationPreference = "maintain-framerate";
          }

          // Cap bitrate (approx 4 Mbps max)
          if (!params.encodings) {
            params.encodings = [{}];
          }
          params.encodings[0].maxBitrate = 4000000;

          try {
            sender.setParameters(params);
          } catch (e) {
            console.warn("Could not set sender parameters", e);
          }
        }
      });

      // Prefer VP9 codec
      const transceivers = pc.getTransceivers();
      transceivers.forEach((t) => {
        if (t.sender.track?.kind === "video" && typeof RTCRtpSender.getCapabilities !== "undefined") {
          const capabilities = RTCRtpSender.getCapabilities("video");
          if (capabilities && capabilities.codecs) {
            const sortedCodecs = capabilities.codecs.sort((a, b) => {
              const getScore = (mimeType: string) => {
                if (mimeType.includes("VP9")) return 3;
                if (mimeType.includes("VP8")) return 2;
                if (mimeType.includes("H264")) return 1;
                return 0;
              };
              return getScore(b.mimeType) - getScore(a.mimeType);
            });
            try {
              t.setCodecPreferences(sortedCodecs);
            } catch (e) {
              console.warn("Could not set codec preferences", e);
            }
          }
        }
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
        onViewerReady?.(payload.from);
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

      if (payload.type === "control" && !isHost) {
        onControlReceived?.(payload.action, payload.payload);
        return;
      }
    },
    [isHost, peerId, createPeerConnection, sendSignal, sendOfferToViewer, onHostStopped, onControlReceived, onViewerReady]
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

  return { startSharing, stopSharing, localStreamRef, sendControlSignal };
}
