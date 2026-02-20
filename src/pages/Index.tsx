import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { MonitorPlay } from "lucide-react";

const generateRoomId = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
};

const Index = () => {
  const navigate = useNavigate();
  const [joinId, setJoinId] = useState("");
  const [error, setError] = useState("");

  const handleCreate = () => {
    const roomId = generateRoomId();
    navigate(`/room/${roomId}?host=true`);
  };

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const id = joinId.trim().toUpperCase();
    if (id.length < 4) {
      setError("Enter a valid room ID");
      return;
    }
    navigate(`/room/${id}`);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background fade-in">
      {/* Logo */}
      <div className="flex items-center gap-3 mb-16">
        <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
          <MonitorPlay className="w-5 h-5 text-primary-foreground" />
        </div>
        <span className="text-xl font-semibold tracking-tight text-foreground">screenparty</span>
      </div>

      {/* Card */}
      <div className="glass rounded-xl p-8 w-full max-w-sm space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">Watch together</h1>
          <p className="text-sm text-muted-foreground">Share your screen. Anyone can join.</p>
        </div>

        {/* Create Room */}
        <button
          onClick={handleCreate}
          className="w-full py-3 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
        >
          Create a room
        </button>

        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-border" />
          <span className="text-xs text-muted-foreground">or join</span>
          <div className="flex-1 h-px bg-border" />
        </div>

        {/* Join Room */}
        <form onSubmit={handleJoin} className="space-y-3">
          <input
            type="text"
            placeholder="Room ID (e.g. AB3X7K)"
            value={joinId}
            onChange={(e) => {
              setJoinId(e.target.value.toUpperCase());
              setError("");
            }}
            maxLength={8}
            className="w-full px-4 py-3 rounded-lg bg-input border border-border text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring font-mono tracking-widest"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <button
            type="submit"
            className="w-full py-3 px-4 rounded-lg bg-secondary text-secondary-foreground text-sm font-medium hover:bg-accent transition-colors"
          >
            Join room
          </button>
        </form>
      </div>

      <p className="mt-8 text-xs text-muted-foreground">
        First person to create a room becomes the host
      </p>
    </div>
  );
};

export default Index;
