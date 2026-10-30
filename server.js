const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 12;
const QUESTION_TIME_MS = 15000; // tiempo límite por pregunta
const MAX_POINTS = 1000;
const REVEAL_TIME_MS = 4000;    // pausa para ver la respuesta correcta
const ROOM_TTL_MS = 1000 * 60 * 60 * 3; // salas vacías se borran tras 3 h

// Preguntas: "a" es el índice de la respuesta correcta.
const QUESTIONS = [
  { q: "¿Cuál es mi comida favorita?", o: ["Pizza", "Hamburguesa", "Perro caliente", "Tacos"], a: 1 },
  { q: "¿Cuál es mi color favorito?", o: ["Azul", "Rojo", "Negro", "Verde"], a: 2 },
  { q: "¿Qué hago en mi tiempo libre?", o: ["Leer", "Jugar videojuegos", "Hacer deporte", "Dibujar"], a: 1 },
  { q: "¿Cuál es mi videojuego favorito?", o: ["Minecraft", "GTA V", "Forza Horizon 5", "FIFA"], a: 2 },
  { q: "¿Cuál es mi bebida favorita?", o: ["Agua", "Coca-Cola", "Limonada", "Té frío"], a: 1 },
  { q: "¿Qué tipo de música escucho?", o: ["Solo rock", "Solo reguetón", "Música clásica", "Música diferente siempre"], a: 3 },
  { q: "¿Cuál es mi película favorita?", o: ["Son como niños", "Rápidos y furiosos", "Interestelar", "El conjuro"], a: 0 },
  { q: "¿Cuál es mi animal favorito?", o: ["Gato", "Perro", "Lobo", "Conejo"], a: 1 },
  { q: "¿Qué país me gustaría visitar?", o: ["Japón", "Inglaterra", "Italia", "Canadá"], a: 1 },
  { q: "¿Qué lugar prefiero para vacacionar?", o: ["Montaña", "Ciudad", "Playa", "Campo"], a: 2 },
  { q: "¿Cuál es mi saga de películas favorita?", o: ["Harry Potter", "Rápidos y furiosos", "No tengo una", "Los juegos del hambre"], a: 2 },
  { q: "¿Qué prefiero: frío o calor?", o: ["Calor", "Frío", "Ambos por igual", "Ninguno"], a: 1 },
  { q: "¿Cuál es mi personaje ficticio favorito?", o: ["Spider-Man", "Bruce Wayne", "Iron Man", "Joker"], a: 1 },
  { q: "¿Qué comida nunca comería?", o: ["Sushi", "Sopa de mariscos", "Brócoli", "Pizza con piña"], a: 1 },
  { q: "¿Cuál es mi marca de carros favorita?", o: ["BMW", "Audi", "Mercedes-Benz", "Porsche"], a: 2 },
  { q: "¿Qué superpoder elegiría?", o: ["Ser invisible", "Volar", "Leer mentes", "Teletransportarme"], a: 1 },
  { q: "¿Qué prefiero: videojuegos o películas?", o: ["Videojuegos", "Películas", "Anime", "Series"], a: 2 },
  { q: "¿Cuál es mi postre favorito?", o: ["Helado", "Brownie", "Pie de limón", "Cheesecake"], a: 2 },
  { q: "¿Cuál es mi anime favorito?", o: ["Naruto", "Attack on Titan", "Tokyo Ghoul", "One Piece"], a: 2 },
  { q: "¿Cuál es mi personaje de anime favorito?", o: ["Levi Ackerman", "Gojo Satoru", "Ken Kaneki", "Eren Yeager"], a: 2 },
];

const app = express();
app.use(express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const io = new Server(server);

// rooms: code -> room
const rooms = new Map();

function makeCode() {
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(code));
  return code;
}

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({ id: p.id, name: p.name, score: p.score }));
}

function ranking(room) {
  return publicPlayers(room).sort((x, y) => y.score - x.score);
}

// Puntos: 1000 si contesta al instante, baja linealmente hasta 500 al límite.
function pointsFor(elapsedMs) {
  const fraction = Math.min(Math.max(elapsedMs / QUESTION_TIME_MS, 0), 1);
  return Math.round(MAX_POINTS - fraction * (MAX_POINTS / 2));
}

function clearTimers(room) {
  clearTimeout(room.timer);
  clearTimeout(room.revealTimer);
  room.timer = null;
  room.revealTimer = null;
}

function startQuestion(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.current >= QUESTIONS.length) return finishGame(code);

  const item = QUESTIONS[room.current];
  room.phase = "question";
  room.answers = new Map(); // playerId -> { choice, points }
  room.questionStartedAt = Date.now();

  // Enviamos la pregunta SIN la respuesta correcta.
  io.to(code).emit("question", {
    index: room.current,
    total: QUESTIONS.length,
    text: item.q,
    options: item.o,
    timeMs: QUESTION_TIME_MS,
    startedAt: room.questionStartedAt,
  });
  io.to(code).emit("answerCount", { answered: 0, total: room.players.size });

  room.timer = setTimeout(() => revealAnswer(code), QUESTION_TIME_MS);
}

function revealAnswer(code) {
  const room = rooms.get(code);
  if (!room || room.phase !== "question") return;
  clearTimers(room);
  room.phase = "reveal";

  const item = QUESTIONS[room.current];
  // Quienes no contestaron reciben 0 puntos (ya están en 0 por defecto).
  const results = {};
  for (const [id, ans] of room.answers) results[id] = { choice: ans.choice, points: ans.points };

  io.to(code).emit("reveal", {
    correct: item.a,
    options: item.o,
    results, // id -> { choice, points }
    ranking: ranking(room),
  });

  room.current++;
  room.revealTimer = setTimeout(() => {
    if (!rooms.has(code)) return;
    if (room.current >= QUESTIONS.length) finishGame(code);
    else startQuestion(code);
  }, REVEAL_TIME_MS);
}

function finishGame(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimers(room);
  room.phase = "finished";
  io.to(code).emit("gameOver", { ranking: ranking(room) });
}

function resetRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearTimers(room);
  room.phase = "lobby";
  room.current = 0;
  room.answers = new Map();
  for (const p of room.players.values()) p.score = 0;
  io.to(code).emit("roomState", roomPayload(room));
}

function roomPayload(room) {
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    players: publicPlayers(room),
    max: MAX_PLAYERS,
    totalQuestions: QUESTIONS.length,
  };
}

function leaveRoom(socket) {
  const code = socket.data.room;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code);
  socket.data.room = null;
  if (!room) return;

  room.players.delete(socket.id);
  room.answers.delete(socket.id);

  if (room.players.size === 0) {
    clearTimers(room);
    rooms.delete(code);
    return;
  }
  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value; // pasa el anfitrión al siguiente
  }
  io.to(code).emit("roomState", roomPayload(room));
  // Si ya no hay nadie respondiendo, avanzamos antes del tiempo.
  if (room.phase === "question" && room.answers.size >= room.players.size) {
    revealAnswer(code);
  }
}

io.on("connection", (socket) => {
  socket.data.room = null;

  socket.on("createRoom", ({ name } = {}, ack) => {
    const cleanName = sanitizeName(name);
    if (!cleanName) return ack?.({ ok: false, error: "Escribe tu nombre." });
    leaveRoom(socket);

    const code = makeCode();
    const room = {
      code,
      phase: "lobby",
      hostId: socket.id,
      players: new Map(),
      answers: new Map(),
      current: 0,
      timer: null,
      revealTimer: null,
      questionStartedAt: 0,
      createdAt: Date.now(),
    };
    rooms.set(code, room);
    room.players.set(socket.id, { id: socket.id, name: cleanName, score: 0 });
    socket.join(code);
    socket.data.room = code;
    ack?.({ ok: true, code });
    io.to(code).emit("roomState", roomPayload(room));
  });

  socket.on("joinRoom", ({ code, name } = {}, ack) => {
    const cleanName = sanitizeName(name);
    const cleanCode = String(code || "").trim();
    const room = rooms.get(cleanCode);
    if (!room) return ack?.({ ok: false, error: "No existe una sala con ese código." });
    if (!cleanName) return ack?.({ ok: false, error: "Escribe tu nombre." });
    if (room.phase !== "lobby") return ack?.({ ok: false, error: "La partida ya empezó." });
    if (room.players.size >= MAX_PLAYERS) return ack?.({ ok: false, error: "La sala está llena (12 jugadores)." });
    if ([...room.players.values()].some((p) => p.name.toLowerCase() === cleanName.toLowerCase())) {
      return ack?.({ ok: false, error: "Ese nombre ya está en uso en la sala." });
    }

    leaveRoom(socket);
    room.players.set(socket.id, { id: socket.id, name: cleanName, score: 0 });
    socket.join(cleanCode);
    socket.data.room = cleanCode;
    ack?.({ ok: true, code: cleanCode });
    io.to(cleanCode).emit("roomState", roomPayload(room));
  });

  socket.on("startGame", (_, ack) => {
    const room = rooms.get(socket.data.room);
    if (!room) return ack?.({ ok: false, error: "No estás en una sala." });
    if (room.hostId !== socket.id) return ack?.({ ok: false, error: "Solo el anfitrión puede empezar." });
    if (room.phase !== "lobby") return ack?.({ ok: false, error: "La partida ya está en curso." });
    if (room.players.size < 1) return ack?.({ ok: false, error: "Se necesita al menos 1 jugador." });
    room.current = 0;
    for (const p of room.players.values()) p.score = 0;
    ack?.({ ok: true });
    startQuestion(room.code);
  });

  socket.on("answer", ({ choice } = {}) => {
    const code = socket.data.room;
    const room = rooms.get(code);
    if (!room || room.phase !== "question") return;
    if (room.answers.has(socket.id)) return; // solo una respuesta por pregunta
    const player = room.players.get(socket.id);
    if (!player) return;
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return;

    const item = QUESTIONS[room.current];
    const elapsed = Date.now() - room.questionStartedAt;
    const correct = choice === item.a;
    const points = correct ? pointsFor(elapsed) : 0;
    if (correct) player.score += points;

    room.answers.set(socket.id, { choice, points });
    socket.emit("answerAck", { choice });
    io.to(code).emit("answerCount", { answered: room.answers.size, total: room.players.size });

    // Si todos respondieron, mostramos la respuesta sin esperar al reloj.
    if (room.answers.size >= room.players.size) revealAnswer(code);
  });

  socket.on("restart", (_, ack) => {
    const room = rooms.get(socket.data.room);
    if (!room) return ack?.({ ok: false });
    if (room.hostId !== socket.id) return ack?.({ ok: false, error: "Solo el anfitrión." });
    resetRoom(room.code);
    ack?.({ ok: true });
  });

  socket.on("leaveRoom", () => leaveRoom(socket));

  socket.on("disconnect", () => leaveRoom(socket));
});

function sanitizeName(name) {
  return String(name || "").replace(/[<>]/g, "").trim().slice(0, 16);
}

// Limpieza de salas abandonadas.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.size === 0 || now - room.createdAt > ROOM_TTL_MS) {
      clearTimers(room);
      rooms.delete(code);
    }
  }
}, 60000);

server.listen(PORT, () => {
  console.log(`Birthday Kahoot listo en http://localhost:${PORT}`);
});
