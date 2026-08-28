const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { directorId: null, users: new Map() });
  }
  return rooms.get(roomId);
}

function roomUsers(room) {
  return [...room.users.entries()].map(([id, user]) => ({
    id, name: user.name, role: user.role
  }));
}

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, name, role }) => {
    roomId = String(roomId || "").trim().toUpperCase();
    name = String(name || "").trim().slice(0, 40);
    role = role === "director" ? "director" : "musician";

    if (!roomId || !name) {
      socket.emit("app-error", "Debes indicar nombre y código de sala.");
      return;
    }

    const room = getRoom(roomId);

    if (role === "director") {
      if (room.directorId && room.directorId !== socket.id) {
        socket.emit("app-error", "Esta sala ya tiene un director conectado.");
        return;
      }
      room.directorId = socket.id;
    }

    room.users.set(socket.id, { name, role });
    socket.data.roomId = roomId;
    socket.data.name = name;
    socket.data.role = role;

    socket.join(roomId);
    socket.emit("joined-room", {
      roomId,
      users: roomUsers(room),
      directorId: room.directorId
    });

    socket.to(roomId).emit("user-joined", {
      id: socket.id, name, role
    });

    io.to(roomId).emit("room-users", {
      users: roomUsers(room),
      directorId: room.directorId
    });
  });

  socket.on("webrtc-offer", ({ target, sdp }) => {
    io.to(target).emit("webrtc-offer", {
      from: socket.id, sdp,
      name: socket.data.name
    });
  });

  socket.on("webrtc-answer", ({ target, sdp }) => {
    io.to(target).emit("webrtc-answer", { from: socket.id, sdp });
  });

  socket.on("webrtc-ice-candidate", ({ target, candidate }) => {
    io.to(target).emit("webrtc-ice-candidate", {
      from: socket.id, candidate
    });
  });

  socket.on("director-status", ({ speaking }) => {
    const roomId = socket.data.roomId;
    if (roomId && socket.data.role === "director") {
      socket.to(roomId).emit("director-status", { speaking: !!speaking });
    }
  });

  socket.on("signal", ({ type, payload }) => {
    const roomId = socket.data.roomId;
    if (roomId) socket.to(roomId).emit("signal", { type, payload });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    room.users.delete(socket.id);
    if (room.directorId === socket.id) room.directorId = null;

    socket.to(roomId).emit("user-left", { id: socket.id });
    io.to(roomId).emit("room-users", {
      users: roomUsers(room),
      directorId: room.directorId
    });

    if (room.users.size === 0) rooms.delete(roomId);
  });
});

app.get("*", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Band Monitor listo en http://localhost:${PORT}`);
});