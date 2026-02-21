import { useState, useRef, useCallback, useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { MonitorPlay, MonitorX, Copy, Check, Upload, FileVideo } from "lucide-react";
import { useWebRTC } from "@/hooks/useWebRTC";
import { supabase } from "@/integrations/supabase/client";

// Generate a stable peer ID for this session
const SESSION_PEER_ID = `peer_${Math.random().toString(36).slice(2, 10)}`;

const Room = () => {
  const { roomId } = useParams<{ roomId: string }>();
  const [searchParams] = useSearchParams();
  const isHost = searchParams.get("host") === "true";

  const [isSharing, setIsSharing] = useState(false);
  const [hasStream, setHasStream] = useState(false);
  const [copied, setCopied] = useState(false);
  const [videoFileUrl, setVideoFileUrl] = useState<string | null>(null);

  // Dual Media Mode
  const [streamMode, setStreamMode] = useState<"screen" | "file">("screen");
  const [isUploading, setIsUploading] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const syncIntervalRef = useRef<number | null>(null);
  const onViewerReadyRef = useRef<(viewerId: string) => void>();

  const handleControlReceived = useCallback((action: string, payload: any) => {
    if (isHost) return; // Admin is source of truth

    const vid = videoRef.current;
    if (!vid) return;

    if (action === "file-url") {
      setStreamMode("file");
      setVideoFileUrl(payload.url);
      setHasStream(true);
      if (vid.srcObject) vid.srcObject = null;
      vid.src = payload.url;
      vid.muted = false;
      vid.controls = false;
    } else if (action === "play") {
      vid.play().catch(() => { });
    } else if (action === "pause") {
      vid.pause();
    } else if (action === "seek") {
      vid.currentTime = payload.time;
    } else if (action === "sync") {
      // Drift detection: resync if > 300ms drift
      const adminTime = payload.time;
      const drift = Math.abs(vid.currentTime - adminTime);
      if (drift > 0.3 && !vid.paused) {
        vid.currentTime = adminTime;
      }
    }
  }, [isHost]);

  const onStreamReceived = useCallback((stream: MediaStream) => {
    setStreamMode("screen");
    setHasStream(true);
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.src = "";
      videoRef.current.play().catch(() => { });
    }
  }, []);

  const onHostStopped = useCallback(() => {
    setHasStream(false);
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const { startSharing, stopSharing, sendControlSignal } = useWebRTC({
    roomId: roomId!,
    peerId: SESSION_PEER_ID,
    isHost,
    onStreamReceived,
    onHostStopped,
    onControlReceived: handleControlReceived,
    onViewerReady: (vid) => onViewerReadyRef.current?.(vid),
  });

  useEffect(() => {
    onViewerReadyRef.current = (viewerId: string) => {
      if (streamMode === "file" && isSharing && videoFileUrl) {
        sendControlSignal("file-url", { url: videoFileUrl }, viewerId);
        sendControlSignal("seek", { time: localVideoRef.current?.currentTime || 0 }, viewerId);
        if (localVideoRef.current && !localVideoRef.current.paused) {
          sendControlSignal("play", undefined, viewerId);
        }
      }
    };
  }, [streamMode, isSharing, videoFileUrl, sendControlSignal]);

  const handleStopShare = useCallback(() => {
    stopSharing();
    setIsSharing(false);
    setHasStream(false);
    setVideoFileUrl(null);
    if (syncIntervalRef.current) {
      window.clearInterval(syncIntervalRef.current);
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
      localVideoRef.current.src = "";
      localVideoRef.current.controls = false;
      localVideoRef.current.muted = true;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
      videoRef.current.src = "";
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [stopSharing]);

  const handleStartShare = useCallback(async () => {
    setVideoFileUrl(null);
    if (localVideoRef.current) {
      localVideoRef.current.src = "";
      localVideoRef.current.controls = false;
      localVideoRef.current.muted = true;
    }

    const stream = await startSharing();
    if (!stream) return;
    setIsSharing(true);
    setHasStream(true);

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
      localVideoRef.current.play().catch(() => { });
    }

    // Handle user stopping via browser's stop-sharing button
    const track = stream.getVideoTracks()[0];
    if (track) {
      track.onended = () => {
        handleStopShare();
      };
    }
  }, [startSharing, handleStopShare]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (isSharing) {
      handleStopShare();
    }

    try {
      setIsUploading(true);
      // Upload to supabase storage bucket "room-media"
      const fileName = `${roomId}_${Date.now()}_${file.name}`;
      const { data, error } = await supabase.storage.from("room-media").upload(fileName, file);

      if (error) {
        console.error("Upload failed", error);
        setIsUploading(false);
        return;
      }

      const { data: { publicUrl } } = supabase.storage.from("room-media").getPublicUrl(fileName);

      setVideoFileUrl(publicUrl);
      setIsSharing(true);
      setHasStream(true);

      // Notify viewers of the new file
      sendControlSignal("file-url", { url: publicUrl });

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = null;
        localVideoRef.current.src = publicUrl;
        localVideoRef.current.controls = true;
        localVideoRef.current.muted = false;

        // Bind control events for admin to emit
        localVideoRef.current.onplay = () => sendControlSignal("play");
        localVideoRef.current.onpause = () => sendControlSignal("pause");
        localVideoRef.current.onseeked = () => sendControlSignal("seek", { time: localVideoRef.current?.currentTime });

        // Start 5-second sync polling
        if (syncIntervalRef.current) window.clearInterval(syncIntervalRef.current);
        syncIntervalRef.current = window.setInterval(() => {
          if (localVideoRef.current && !localVideoRef.current.paused) {
            sendControlSignal("sync", { time: localVideoRef.current.currentTime });
          }
        }, 5000);

        localVideoRef.current.play().catch(() => { });
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsUploading(false);
    }
  }, [sendControlSignal, isSharing, handleStopShare, roomId]);

  const copyRoomId = useCallback(() => {
    navigator.clipboard.writeText(roomId!);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [roomId]);

  const showVideo = isHost ? isSharing : hasStream;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top bar */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-4">
          {/* Logo */}
          <div className="flex items-center gap-2 mr-2">
            <MonitorPlay className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium text-foreground">screenparty</span>
          </div>

          {/* Room ID */}
          <button
            onClick={copyRoomId}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-secondary hover:bg-accent transition-colors group"
          >
            <span className="text-xs text-muted-foreground">Room</span>
            <span className="font-mono text-sm font-medium text-foreground tracking-widest">
              {roomId}
            </span>
            {copied ? (
              <Check className="w-3.5 h-3.5 text-primary" />
            ) : (
              <Copy className="w-3.5 h-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />
            )}
          </button>
        </div>

        <div className="flex items-center gap-3">
          {/* Role badge */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-secondary">
            {isHost ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                <span className="text-xs font-medium text-foreground">Admin</span>
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">Viewer</span>
              </>
            )}
          </div>

          {/* Admin controls */}
          {isHost && (
            <>
              <input
                type="file"
                accept="video/mp4,video/webm,video/x-matroska,video/*"
                ref={fileInputRef}
                className="hidden"
                onChange={handleFileUpload}
              />
              {!isSharing ? (
                <div className="flex items-center gap-2">
                  <div className="bg-secondary p-1 rounded-md flex gap-1 mr-2">
                    <button
                      onClick={() => setStreamMode("screen")}
                      className={`px-3 py-1 text-xs font-medium rounded-sm transition-colors ${streamMode === "screen" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      Screen
                    </button>
                    <button
                      onClick={() => setStreamMode("file")}
                      className={`px-3 py-1 text-xs font-medium rounded-sm transition-colors ${streamMode === "file" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      File
                    </button>
                  </div>

                  {streamMode === "file" ? (
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isUploading}
                      className="flex items-center gap-2 px-4 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                    >
                      <FileVideo className="w-3.5 h-3.5" />
                      {isUploading ? "Uploading..." : "Upload & Stream"}
                    </button>
                  ) : (
                    <button
                      onClick={handleStartShare}
                      className="flex items-center gap-2 px-4 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
                    >
                      <MonitorPlay className="w-3.5 h-3.5" />
                      Start Share
                    </button>
                  )}
                </div>
              ) : (
                <button
                  onClick={handleStopShare}
                  className="flex items-center gap-2 px-4 py-1.5 rounded-md bg-destructive text-destructive-foreground text-xs font-medium hover:opacity-90 transition-opacity"
                >
                  <MonitorX className="w-3.5 h-3.5" />
                  Stop Share
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {/* Video area */}
      <main className="flex-1 flex items-center justify-center p-6">
        {/* Always render both video elements so refs stay attached */}
        <div className={`relative w-full max-w-6xl fade-in ${showVideo ? "" : "hidden"}`}>
          {/* Live indicator */}
          {isSharing && isHost && (
            <div className="absolute top-4 left-4 z-10 flex items-center gap-1.5 px-2.5 py-1 rounded bg-background/80 backdrop-blur-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-live pulse-live" />
              <span className="text-xs font-medium text-live tracking-widest uppercase">Live</span>
            </div>
          )}
          {/* Host preview */}
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className={`w-full rounded-lg bg-card ${isHost ? "" : "hidden"}`}
            style={{ aspectRatio: "16/9", objectFit: "contain" }}
          />
          {/* Viewer stream */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className={`w-full rounded-lg bg-card ${isHost ? "hidden" : ""}`}
            style={{ aspectRatio: "16/9", objectFit: "contain" }}
          />
        </div>

        {!showVideo && (
          <div className="flex flex-col items-center gap-4 text-center fade-in">
            <div className="w-16 h-16 rounded-2xl bg-secondary flex items-center justify-center">
              <MonitorPlay className="w-7 h-7 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-base font-medium text-foreground">
                {isHost ? "Ready to share" : "Waiting for host to start sharing"}
              </p>
              <p className="text-sm text-muted-foreground">
                {isHost
                  ? 'Click "Start Share" to begin broadcasting your screen'
                  : `Room ${roomId} · Your host hasn't started yet`}
              </p>
            </div>
            {isHost && (
              <div className="mt-4 px-4 py-3 rounded-lg bg-secondary text-sm text-muted-foreground">
                Share room ID{" "}
                <button
                  onClick={copyRoomId}
                  className="font-mono font-medium text-foreground hover:text-primary transition-colors"
                >
                  {roomId}
                </button>{" "}
                with viewers
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
};

export default Room;

