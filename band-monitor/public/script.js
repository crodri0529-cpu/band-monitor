const socket = io();

let role = "director";
let roomId = "";
let localStream = null;
let peers = new Map();
let remoteStream = null;
let pendingCandidates = new Map();

const ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

const $ = id => document.getElementById(id);
const joinScreen = $("joinScreen"), roomScreen = $("roomScreen");
const nameInput = $("nameInput"), roomInput = $("roomInput");
const joinBtn = $("joinBtn"), randomRoom = $("randomRoom");
const micBtn = $("micBtn"), testMicBtn = $("testMicBtn");
const remoteAudio = $("remoteAudio"), volumeInput = $("volumeInput");

document.querySelectorAll(".role").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".role").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    role = btn.dataset.role;
  });
});

randomRoom.onclick = () => {
  roomInput.value = Math.random().toString(36).slice(2, 8).toUpperCase();
};

joinBtn.onclick = () => {
  const name = nameInput.value.trim();
  roomId = roomInput.value.trim().toUpperCase();
  if (!name || !roomId) return toast("Escribe tu nombre y el código de sala.");
  socket.emit("join-room", { roomId, name, role });
};

$("leaveBtn").onclick = () => location.reload();

socket.on("connect", () => setConnection(true));
socket.on("disconnect", () => setConnection(false));
socket.on("app-error", msg => toast(msg));

socket.on("joined-room", ({ roomId: id, users, directorId }) => {
  roomId = id;
  $("roomTitle").textContent = roomId;
  $("roleText").textContent = role === "director" ? "Director" : "Músico";
  joinScreen.classList.remove("active");
  roomScreen.classList.add("active");
  $("directorPanel").classList.toggle("hidden", role !== "director");
  $("musicianPanel").classList.toggle("hidden", role !== "musician");
  renderUsers(users);

  if (role === "director") {
    users.filter(u => u.id !== socket.id).forEach(u => {
      if (u.role === "musician" && localStream) createOffer(u.id);
    });
  } else if (directorId) {
    $("directorState").textContent = "Director conectado";
  }
});

socket.on("room-users", ({ users, directorId }) => {
  renderUsers(users);
  if (role === "musician") {
    $("directorState").textContent = directorId ? "Director conectado" : "Esperando al director";
  }
});

socket.on("user-joined", async user => {
  if (role === "director" && localStream && user.role === "musician") {
    await createOffer(user.id);
  }
});

socket.on("user-left", ({ id }) => {
  closePeer(id);
});

async function getMic() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      },
      video: false
    });
    return localStream;
  } catch (err) {
    toast("No se pudo acceder al micrófono. Revisa los permisos.");
    throw err;
  }
}

testMicBtn.onclick = async () => {
  try { await getMic(); toast("Micrófono listo."); } catch {}
};

micBtn.onclick = async () => {
  if (role !== "director") return;
  if (localStream) {
    stopBroadcast();
  } else {
    await startBroadcast();
  }
};

async function startBroadcast() {
  try {
    await getMic();
    socket.emit("director-status", { speaking: true });
    $("broadcastText").textContent = "TRANSMITIENDO AUDIO";
    micBtn.classList.add("live");
    $("micVisual").classList.add("live");
    micBtn.querySelector("b").textContent = "DETENER TRANSMISIÓN";

    document.querySelectorAll(".user").forEach(() => {});
    const users = [...document.querySelectorAll(".user")];
    // La creación real de peers se hace al recibir la lista del servidor.
    socket.emit("signal", { type: "director-started", payload: {} });
    toast("Transmisión iniciada.");
  } catch {}
}

function stopBroadcast() {
  socket.emit("director-status", { speaking: false });
  for (const id of [...peers.keys()]) closePeer(id);
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  $("broadcastText").textContent = "Listo para transmitir";
  micBtn.classList.remove("live");
  $("micVisual").classList.remove("live");
  micBtn.querySelector("b").textContent = "INICIAR TRANSMISIÓN";
  socket.emit("signal", { type: "director-stopped", payload: {} });
}

socket.on("signal", ({ type, payload }) => {
  if (type === "director-started" && role === "musician") {
    $("directorState").textContent = "Director transmitiendo";
    $("listenerVisual").classList.add("live");
    $("listenerMessage").textContent = "Conectando audio del director...";
    // El director crea las conexiones cuando recibe usuarios nuevos.
    // Para usuarios ya conectados solicitamos una oferta.
    socket.emit("signal", { type: "request-offer", payload: { target: socket.id } });
  }
  if (type === "request-offer" && role === "director" && payload?.target && localStream) {
    createOffer(payload.target);
  }
  if (type === "director-stopped" && role === "musician") {
    $("directorState").textContent = "Director detenido";
    $("listenerVisual").classList.remove("live");
    $("listenerMessage").textContent = "Esperando nueva transmisión.";
    for (const id of [...peers.keys()]) closePeer(id);
  }
  if (type === "quick-signal") showSignal(payload);
});

socket.on("director-status", ({ speaking }) => {
  if (role === "musician") {
    $("directorState").textContent = speaking ? "🎤 EL DIRECTOR ESTÁ HABLANDO" : "Director conectado";
  }
});

function makePeer(target) {
  if (peers.has(target)) return peers.get(target);
  const pc = new RTCPeerConnection(ICE);
  peers.set(target, pc);

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit("webrtc-ice-candidate", { target, candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
      if (pc.connectionState === "failed") toast("Reconectando audio...");
    }
  };

  pc.ontrack = e => {
    remoteStream = e.streams[0];
    remoteAudio.srcObject = remoteStream;
    remoteAudio.volume = volumeInput.value;
    remoteAudio.play().catch(() => {
      $("listenerMessage").textContent = "Toca la pantalla para activar el audio.";
    });
    $("listenerMessage").textContent = "Escuchando al director.";
  };

  if (role === "director" && localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }
  return pc;
}

async function createOffer(target) {
  const pc = makePeer(target);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("webrtc-offer", { target, sdp: pc.localDescription });
}

socket.on("webrtc-offer", async ({ from, sdp }) => {
  try {
    const pc = makePeer(from);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await flushCandidates(from, pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("webrtc-answer", { target: from, sdp: pc.localDescription });
  } catch (e) { console.error(e); toast("Error conectando audio."); }
});

socket.on("webrtc-answer", async ({ from, sdp }) => {
  const pc = peers.get(from);
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  await flushCandidates(from, pc);
});

socket.on("webrtc-ice-candidate", async ({ from, candidate }) => {
  const pc = peers.get(from);
  if (!pc || !pc.remoteDescription) {
    const list = pendingCandidates.get(from) || [];
    list.push(candidate);
    pendingCandidates.set(from, list);
    return;
  }
  try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e) { console.warn(e); }
});

async function flushCandidates(id, pc) {
  const list = pendingCandidates.get(id) || [];
  for (const c of list) {
    try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
  }
  pendingCandidates.delete(id);
}

function closePeer(id) {
  const pc = peers.get(id);
  if (pc) { pc.close(); peers.delete(id); }
}

volumeInput.oninput = () => {
  remoteAudio.volume = volumeInput.value;
};

document.querySelectorAll("[data-signal]").forEach(btn => {
  btn.onclick = () => {
    if (role !== "director") return;
    socket.emit("signal", { type: "quick-signal", payload: btn.dataset.signal });
    showSignal(btn.dataset.signal);
  };
});

function showSignal(text) {
  const box = $("signalBox");
  box.textContent = text;
  box.classList.remove("flash");
  void box.offsetWidth;
  box.classList.add("flash");
}

function renderUsers(users) {
  $("userCount").textContent = users.length;
  $("usersList").innerHTML = users.map(u => `
    <div class="user">
      <span>${escapeHtml(u.name)} ${u.role === "director" ? "🎼" : "🎧"}</span>
      <span class="badge">${u.role === "director" ? "Director" : "Músico"}</span>
    </div>`).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

function setConnection(ok) {
  $("connectionDot").className = "dot " + (ok ? "ok" : "bad");
  $("connectionText").textContent = ok ? "Conectado al servidor" : "Sin conexión";
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
}

document.addEventListener("click", () => {
  if (remoteAudio.srcObject) remoteAudio.play().catch(()=>{});
});
