const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const webpush = require("web-push");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI || "YOUR_MONGODB_CONNECTION_STRING";
mongoose.connect(MONGO_URI).then(() => console.log("✅ MongoDB connected")).catch(err => console.error("MongoDB error:", err));

// VAPID keys for push notifications
const VAPID_PUBLIC = "BEdA2-S2vGqjhhGkYTjl8xMFeSDbJnrHCwWjdWsS9xgzAWRyOKHwViX3uTbaF4-ak9J6onMxldX5QIJDz4i7dxY";
const VAPID_PRIVATE = "8t6oLavlyg6oT4Yur4iU53gMXVZ4mc01dSxwMyUU-IQ";
webpush.setVapidDetails("mailto:youremail@gmail.com", VAPID_PUBLIC, VAPID_PRIVATE);

// ========== SCHEMAS ==========

const PlayerSchema = new mongoose.Schema({
  name: String,
  inviteCode: String,
  avatar: { color: String, initial: String },
  stats: {
    played: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    winRate: { type: Number, default: 0 },
    currentStreak: { type: Number, default: 0 },
    bestStreak: { type: Number, default: 0 },
    totalPoints: { type: Number, default: 0 }
  },
  badges: [String],
  createdAt: { type: Date, default: Date.now }
});

const SessionSchema = new mongoose.Schema({
  sessionName: { type: String, default: "Americano Session" },
  format: { type: String, default: "Americano" },
  courts: Number,
  pointsPerGame: Number,
  rounds: Number,
  players: [String],
  matches: [{
    round: Number,
    court: Number,
    team1: [String],
    team2: [String],
    score1: Number,
    score2: Number,
    completed: Boolean
  }],
  status: { type: String, default: "active" },
  createdAt: { type: Date, default: Date.now }
});

const InviteCodeSchema = new mongoose.Schema({
  code: { type: String, unique: true },
  used: { type: Boolean, default: false },
  usedBy: String,
  createdAt: { type: Date, default: Date.now }
});

const PushSubscriptionSchema = new mongoose.Schema({
  subscription: { type: Object, required: true },
  createdAt: { type: Date, default: Date.now }
});

const Player = mongoose.model("Player", PlayerSchema);
const Session = mongoose.model("Session", SessionSchema);
const InviteCode = mongoose.model("InviteCode", InviteCodeSchema);
const PushSubscription = mongoose.model("PushSubscription", PushSubscriptionSchema);

// ========== ROUTES ==========

app.get("/", (req, res) => {
  res.json({ status: "Smash Padel API running" });
});

app.get("/api/vapid-public-key", (req, res) => {
  res.json({ key: VAPID_PUBLIC });
});

app.post("/api/subscribe", async (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: "Subscription required" });
  const doc = new PushSubscription({ subscription });
  await doc.save();
  res.json({ success: true });
});

app.post("/api/verify-invite", async (req, res) => {
  const { code } = req.body;
  const invite = await InviteCode.findOne({ code, used: false });
  if (!invite) return res.status(400).json({ error: "Invalid or used code" });
  res.json({ valid: true });
});

app.post("/api/players", async (req, res) => {
  const { name, inviteCode } = req.body;
  
  const invite = await InviteCode.findOne({ code: inviteCode, used: false });
  if (!invite) return res.status(400).json({ error: "Invalid invite code" });
  
  const colors = ["#00C9A7", "#FFB300", "#74b9ff", "#a29bfe", "#fd79a8", "#ff7675"];
  const avatar = {
    color: colors[Math.floor(Math.random() * colors.length)],
    initial: name.charAt(0).toUpperCase()
  };
  
  const player = new Player({ name, inviteCode, avatar });
  await player.save();
  
  invite.used = true;
  invite.usedBy = player._id;
  await invite.save();
  
  res.json({ player });
});

app.get("/api/players/:id", async (req, res) => {
  const player = await Player.findById(req.params.id);
  if (!player) return res.status(404).json({ error: "Player not found" });
  res.json(player);
});

app.get("/api/players", async (req, res) => {
  const players = await Player.find().sort({ "stats.totalPoints": -1 });
  res.json(players);
});

app.post("/api/sessions", async (req, res) => {
  const { sessionName, format, courts, pointsPerGame, rounds, playerIds } = req.body;
  
  const matches = generateAmericanoPairings(playerIds, rounds, courts);
  
  const session = new Session({
    sessionName: sessionName || "Americano Session",
    format,
    courts,
    pointsPerGame,
    rounds,
    players: playerIds,
    matches
  });
  
  await session.save();
  res.json({ session });
});

app.post("/api/sessions/:id/match/:matchIndex", async (req, res) => {
  const { score1, score2 } = req.body;
  const session = await Session.findById(req.params.id);
  
  session.matches[req.params.matchIndex].score1 = score1;
  session.matches[req.params.matchIndex].score2 = score2;
  session.matches[req.params.matchIndex].completed = true;
  
  await session.save();
  
  const match = session.matches[req.params.matchIndex];
  const team1Won = score1 > score2;
  
  for (const playerId of match.team1) {
    const player = await Player.findById(playerId);
    player.stats.played++;
    if (team1Won) player.stats.wins++; else player.stats.losses++;
    player.stats.totalPoints += score1;
    player.stats.winRate = Math.round((player.stats.wins / player.stats.played) * 100);
    await player.save();
  }
  
  for (const playerId of match.team2) {
    const player = await Player.findById(playerId);
    player.stats.played++;
    if (!team1Won) player.stats.wins++; else player.stats.losses++;
    player.stats.totalPoints += score2;
    player.stats.winRate = Math.round((player.stats.wins / player.stats.played) * 100);
    await player.save();
  }

  // Check if all matches are completed
  const allDone = session.matches.every(m => m.completed);
  let winner = null;

  if (allDone) {
    session.status = "completed";
    await session.save();

    // Find the player with the most total points among session participants
    const sessionPlayers = await Player.find({ _id: { $in: session.players } });
    winner = sessionPlayers.reduce((best, p) =>
      p.stats.totalPoints > (best ? best.stats.totalPoints : -1) ? p : best, null
    );

    // Send push notification to all subscribers
    const payload = JSON.stringify({
      title: "Session Complete!",
      body: `Winner: ${winner.name} with ${winner.stats.totalPoints} points!`,
      winner: { id: winner._id, name: winner.name, avatar: winner.avatar, stats: winner.stats }
    });

    const subscribers = await PushSubscription.find();
    await Promise.allSettled(
      subscribers.map(s => webpush.sendNotification(s.subscription, payload))
    );
  }

  res.json({ session, winner, sessionComplete: allDone });
});

app.get("/api/sessions/active", async (req, res) => {
  const sessions = await Session.find({ status: "active" }).populate("players");
  res.json(sessions);
});

app.get("/api/sessions/:id", async (req, res) => {
  const session = await Session.findById(req.params.id).populate("players");
  res.json(session);
});

function generateAmericanoPairings(playerIds, rounds, courts) {
  const matches = [];
  const n = playerIds.length;
  
  for (let round = 0; round < rounds; round++) {
    for (let court = 0; court < courts; court++) {
      const idx = (round * courts + court) % n;
      const team1 = [
        playerIds[(idx) % n],
        playerIds[(idx + 1) % n]
      ];
      const team2 = [
        playerIds[(idx + 2) % n],
        playerIds[(idx + 3) % n]
      ];
      
      matches.push({
        round: round + 1,
        court: court + 1,
        team1,
        team2,
        score1: 0,
        score2: 0,
        completed: false
      });
    }
  }
  
  return matches;
}

app.post("/api/admin/generate-codes", async (req, res) => {
  const { count } = req.body;
  const codes = [];
  
  for (let i = 0; i < count; i++) {
    const code = `SMASH-${Math.random().toString(36).substr(2, 4).toUpperCase()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
    const inviteCode = new InviteCode({ code });
    await inviteCode.save();
    codes.push(code);
  }
  
  res.json({ codes });
});

app.get("/api/admin/codes", async (req, res) => {
  const codes = await InviteCode.find().sort({ createdAt: -1 });
  res.json(codes);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🎾 Smash API running on port ${PORT}`));
