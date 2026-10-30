(() => {
  const socket = io();
  const $ = (id) => document.getElementById(id);
  const SHAPES = ["▲", "◆", "●", "■"];
  const TIME_MS = 15000;
  const PLAYER_COLORS = ["#E21B3C", "#1368CE", "#FFA602", "#26890C", "#E83E9B", "#6D35C7",
                         "#0EA5A4", "#F97316", "#2563EB", "#BE185D", "#4D7C0F", "#7C3AED"];

  const state = {
    code: null,
    myId: null,
    isHost: false,
    phase: "join",
    players: [],
    question: null,
    answered: false,
    timerRaf: null,
    myScore: 0,
  };

  // ---------- Pantallas y utilidades ----------
  function show(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
    window.scrollTo({ top: 0 });
  }
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2200);
  }
  function setError(msg) { $("join-error").textContent = msg || ""; }
  function colorFor(index) { return PLAYER_COLORS[index % PLAYER_COLORS.length]; }
  function escape(text) {
    const d = document.createElement("div");
    d.textContent = text;
    return d.innerHTML;
  }

  // ---------- Pestañas de entrada ----------
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `form-${tab.dataset.tab}`));
      setError("");
    });
  });

  $("join-code").addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
  });

  // ---------- Entrar / crear ----------
  $("form-join").addEventListener("submit", (e) => {
    e.preventDefault();
    setError("");
    const code = $("join-code").value.trim();
    const name = $("join-name").value.trim();
    if (code.length !== 6) return setError("El código tiene 6 números.");
    socket.emit("joinRoom", { code, name }, (res) => {
      if (!res.ok) return setError(res.error);
      state.isHost = false;
      enterRoom(res.code);
    });
  });

  $("form-host").addEventListener("submit", (e) => {
    e.preventDefault();
    setError("");
    const name = $("host-name").value.trim();
    socket.emit("createRoom", { name }, (res) => {
      if (!res.ok) return setError(res.error);
      state.isHost = true;
      enterRoom(res.code);
    });
  });

  function enterRoom(code) {
    state.code = code;
    $("room-code").textContent = code;
    show("screen-lobby");
  }

  $("btn-leave").addEventListener("click", () => {
    socket.emit("leaveRoom");
    resetLocal();
    show("screen-join");
  });

  $("btn-exit").addEventListener("click", () => {
    socket.emit("leaveRoom");
    resetLocal();
    show("screen-join");
  });

  $("btn-start").addEventListener("click", () => {
    $("btn-start").disabled = true;
    socket.emit("startGame", null, (res) => {
      $("btn-start").disabled = false;
      if (!res.ok) toast(res.error);
    });
  });

  $("btn-again").addEventListener("click", () => {
    socket.emit("restart", null, (res) => {
      if (!res.ok) toast(res.error || "No se pudo reiniciar");
    });
  });

  function resetLocal() {
    cancelAnimationFrame(state.timerRaf);
    state.code = null;
    state.players = [];
    state.isHost = false;
    state.phase = "join";
    state.myScore = 0;
  }

  // ---------- Sala de espera ----------
  socket.on("roomState", (room) => {
    if (!state.code || room.code !== state.code) return;
    state.myId = state.myId || socket.id;
    state.players = room.players;
    state.phase = room.phase;
    state.isHost = room.hostId === socket.id;

    $("player-count").textContent = `${room.players.length}/${room.max}`;
    const list = $("lobby-players");
    list.innerHTML = room.players.map((p, i) => {
      const isHost = p.id === room.hostId ? " host" : "";
      const me = p.id === socket.id ? " (tú)" : "";
      return `<li class="${isHost.trim()}" style="--c:${colorFor(i)}">${escape(p.name)}${me}</li>`;
    }).join("");

    $("btn-start").hidden = !state.isHost;
    $("lobby-wait").hidden = state.isHost;
    $("lobby-wait").textContent = room.players.length < 1
      ? "Esperando jugadores…"
      : "Esperando a que el anfitrión empiece…";

    if (room.phase === "lobby" && $("screen-final").classList.contains("active")) {
      $("btn-again").hidden = !state.isHost;
    }
    if (room.phase === "lobby" && !$("screen-game").classList.contains("active")
        && !$("screen-final").classList.contains("active") && state.code) {
      show("screen-lobby");
    }
  });

  // ---------- Pregunta ----------
  socket.on("question", (q) => {
    state.phase = "question";
    state.question = q;
    state.answered = false;
    show("screen-game");

    $("q-counter").textContent = `${q.index + 1} / ${q.total}`;
    $("q-text").textContent = q.text;
    $("reveal-box").hidden = true;
    $("mini-rank").hidden = true;
    $("mini-rank").innerHTML = "";
    $("answer-count").textContent = "0 contestaron";

    const opts = $("options");
    opts.innerHTML = q.options.map((text, i) => `
      <button class="option" data-i="${i}">
        <span class="shape">${SHAPES[i]}</span>
        <span>${escape(text)}</span>
      </button>`).join("");

    opts.querySelectorAll(".option").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.answered) return;
        state.answered = true;
        socket.emit("answer", { choice: Number(btn.dataset.i) });
      });
    });

    // Temporizador sincronizado con el servidor.
    startTimer(q.startedAt, q.timeMs);
  });

  socket.on("answerAck", ({ choice }) => {
    document.querySelectorAll(".option").forEach((btn) => {
      const i = Number(btn.dataset.i);
      btn.disabled = true;
      if (i === choice) btn.classList.add("picked");
      else btn.classList.add("dim");
    });
    $("reveal-msg").textContent = "¡Respuesta enviada! Esperando a los demás…";
    $("reveal-box").className = "reveal-box";
    $("reveal-box").hidden = false;
  });

  socket.on("answerCount", ({ answered, total }) => {
    $("answer-count").textContent = `${answered}/${total} contestaron`;
  });

  function startTimer(startedAt, timeMs) {
    cancelAnimationFrame(state.timerRaf);
    const ring = $("ring-fg");
    const num = $("timer-num");
    const circumference = 213.6;
    const tick = () => {
      const left = Math.max(0, timeMs - (Date.now() - startedAt));
      const frac = left / timeMs;
      ring.style.strokeDashoffset = String(circumference * (1 - frac));
      ring.classList.toggle("low", frac <= 0.5 && frac > 0.2);
      ring.classList.toggle("crit", frac <= 0.2);
      num.textContent = String(Math.ceil(left / 1000));
      if (left > 0 && state.phase === "question") {
        state.timerRaf = requestAnimationFrame(tick);
      }
    };
    tick();
  }

  // ---------- Revelación ----------
  socket.on("reveal", ({ correct, options, results, ranking }) => {
    state.phase = "reveal";
    cancelAnimationFrame(state.timerRaf);
    $("timer-num").textContent = "0";
    $("ring-fg").style.strokeDashoffset = "213.6";

    document.querySelectorAll(".option").forEach((btn) => {
      const i = Number(btn.dataset.i);
      btn.disabled = true;
      if (i === correct) btn.classList.add("correct");
      else if (!btn.classList.contains("picked")) btn.classList.add("dim");
    });

    const mine = results[socket.id];
    const box = $("reveal-box");
    if (mine && mine.choice === correct) {
      box.className = "reveal-box ok";
      $("reveal-msg").textContent = `¡Correcto! 🎉 +${mine.points} puntos`;
    } else if (mine) {
      box.className = "reveal-box bad";
      $("reveal-msg").textContent = `¡Ups! La respuesta era: ${options[correct]}`;
    } else {
      box.className = "reveal-box bad";
      $("reveal-msg").textContent = `¡Tiempo agotado! La respuesta era: ${options[correct]}`;
    }
    box.hidden = false;

    const me = ranking.find((p) => p.id === socket.id);
    if (me) {
      state.myScore = me.score;
      $("q-points").textContent = `${me.score} pts`;
    }

    renderMiniRank(ranking);
  });

  function renderMiniRank(ranking) {
    const top = ranking.slice(0, 5);
    $("mini-rank").innerHTML = top.map((p, i) => `
      <div class="row" style="animation-delay:${i * 0.08}s">
        <span class="pos">${i + 1}</span>
        <span class="name">${escape(p.name)}${p.id === socket.id ? " (tú)" : ""}</span>
        <span class="pts">${p.score}</span>
      </div>`).join("");
    $("mini-rank").hidden = false;
  }

  // ---------- Final ----------
  socket.on("gameOver", ({ ranking }) => {
    state.phase = "finished";
    cancelAnimationFrame(state.timerRaf);
    show("screen-final");
    $("btn-again").hidden = !state.isHost;

    const top3 = ranking.slice(0, 3);
    const order = [top3[1], top3[0], top3[2]]; // 2º, 1º, 3º
    const classes = ["p2", "p1", "p3"];
    const medals = ["🥈", "🥇", "🥉"];
    const podiumHtml = order.map((p, idx) => {
      if (!p) return "";
      const place = idx === 1 ? 0 : idx === 0 ? 1 : 2;
      return `<div class="step ${classes[idx]}">
        <span class="medal">${medals[place]}</span>
        <span class="n">${escape(p.name)}</span>
        <span class="s">${p.score} pts</span>
      </div>`;
    }).join("");
    $("podium").innerHTML = podiumHtml;

    $("final-rank").innerHTML = ranking.map((p, i) => `
      <li><span class="n">${i + 1}. ${escape(p.name)}${p.id === socket.id ? " (tú)" : ""}</span>
          <span class="s">${p.score} pts</span></li>`).join("");
  });

  // Al reiniciar, el servidor manda roomState en fase lobby: volvemos a la sala.
  socket.on("connect", () => {
    if (state.code) {
      socket.emit("joinRoom", { code: state.code, name: "" }, () => {});
    }
  });

  socket.on("disconnect", () => toast("Se perdió la conexión, reconectando…"));
})();
